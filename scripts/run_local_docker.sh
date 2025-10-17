#!/usr/bin/env bash
set -euo pipefail

# One-shot runner (no Docker Compose) that:
# - Builds the app image
# - Starts/ensures Chroma on localhost:8000
# - Generates mock CSVs (2 buildings x 3 floors x 2 rooms/floor)
# - Ingests CSVs
# - Populates Neo4j Aura using credentials from .env
# - Indexes Chroma (knowledge + profiles)
# - Starts the app on localhost:3000 with LLM enabled and correct CHROMA_URL override
#
# Requirements:
# - Docker installed and running
# - A .env file at repo root with your credentials (Gemini, OpenWeather, Neo4j Aura, etc.)

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE_NAME="avmsolutions:latest"
APP_CONTAINER="avmsolutions"
CHROMA_CONTAINER="chroma"
CHROMA_PORT=8000
APP_PORT=3000

cd "$ROOT_DIR"

if [[ ! -f .env ]]; then
  echo "[run] Missing .env at $ROOT_DIR. Please create it with your credentials." >&2
  exit 1
fi

mkdir -p "$ROOT_DIR/CSVex" "$ROOT_DIR/csvex_enriched" "$ROOT_DIR/knowledge" "$ROOT_DIR/chroma"

is_linux() { [[ "$(uname -s)" == "Linux" ]]; }

ADD_HOST_OPT=""
if is_linux; then
  # Map host.docker.internal -> host gateway on Linux so containers can reach host services
  ADD_HOST_OPT="--add-host=host.docker.internal:host-gateway"
fi

wait_for_http() {
  local url="$1"; local tries=${2:-30}
  for i in $(seq 1 "$tries"); do
    if curl -fsS "$url" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

echo "[run] Building image: $IMAGE_NAME"
docker build -t "$IMAGE_NAME" .

echo "[run] Ensuring Chroma is running on :$CHROMA_PORT"
if docker ps -a --format '{{.Names}}' | grep -q "^${CHROMA_CONTAINER}$"; then
  state=$(docker inspect -f '{{.State.Running}}' "$CHROMA_CONTAINER" || echo "false")
  if [[ "$state" != "true" ]]; then
    echo "[run] Starting existing $CHROMA_CONTAINER"
    docker start "$CHROMA_CONTAINER" >/dev/null
  else
    echo "[run] $CHROMA_CONTAINER already running"
  fi
else
  echo "[run] Launching new $CHROMA_CONTAINER"
  docker run -d --name "$CHROMA_CONTAINER" -p ${CHROMA_PORT}:8000 \
    -e IS_PERSISTENT=TRUE -e ALLOW_RESET=TRUE \
    -v "$ROOT_DIR/chroma:/chroma" \
    ghcr.io/chroma-core/chroma:latest >/dev/null
fi

echo "[run] Waiting for Chroma heartbeat..."
if ! wait_for_http "http://localhost:${CHROMA_PORT}/api/v2/heartbeat" 40; then
  # try v1
  if ! wait_for_http "http://localhost:${CHROMA_PORT}/api/v1/heartbeat" 10; then
    echo "[run] ERROR: Chroma not reachable on port ${CHROMA_PORT}" >&2
    exit 1
  fi
fi

echo "[run] Generating mock CSVs (2x3x2) into CSVex/ ..."
docker run --rm \
  -v "$ROOT_DIR/CSVex:/data/CSVex" \
  -v "$ROOT_DIR/csvex_enriched:/data/CSVex_enriched" \
  --env-file "$ROOT_DIR/.env" \
  "$IMAGE_NAME" \
  python3 scripts/prepare_mock_data.py

echo "[run] Ingesting CSVs into csvex_enriched/ ..."
docker run --rm \
  -v "$ROOT_DIR/CSVex:/data/CSVex" \
  -v "$ROOT_DIR/csvex_enriched:/data/CSVex_enriched" \
  --env-file "$ROOT_DIR/.env" \
  "$IMAGE_NAME" \
  python3 scripts/ingest_csvex.py

echo "[run] Populating Neo4j Aura (using .env credentials) ..."
docker run --rm \
  --env-file "$ROOT_DIR/.env" \
  "$IMAGE_NAME" \
  node scripts/populate_neo4j_mock.js

echo "[run] Indexing Chroma (knowledge + profiles) via client ..."
docker run --rm $ADD_HOST_OPT \
  --env-file "$ROOT_DIR/.env" -e CHROMA_URL=http://host.docker.internal:${CHROMA_PORT} \
  "$IMAGE_NAME" \
  python3 scripts/index_chroma.py

echo "[run] Starting the app on :$APP_PORT ..."
if docker ps -a --format '{{.Names}}' | grep -q "^${APP_CONTAINER}$"; then
  echo "[run] Removing existing $APP_CONTAINER"
  docker rm -f "$APP_CONTAINER" >/dev/null || true
fi

docker run -d --name "$APP_CONTAINER" \
  -p ${APP_PORT}:3000 \
  -v "$ROOT_DIR/CSVex:/data/CSVex" \
  -v "$ROOT_DIR/csvex_enriched:/data/CSVex_enriched" \
  -v "$ROOT_DIR/knowledge:/app/knowledge:ro" \
  $ADD_HOST_OPT \
  --env-file "$ROOT_DIR/.env" \
  -e CHROMA_URL=http://host.docker.internal:${CHROMA_PORT} \
  -e CHROMA_SKIP_INDEX=1 \
  -e NEO4J_SKIP_POPULATE=1 \
  -e SKIP_INGEST=1 \
  "$IMAGE_NAME" >/dev/null

echo "[run] Waiting for app health..."
if ! wait_for_http "http://localhost:${APP_PORT}/api/health" 60; then
  echo "[run] WARN: /api/health check did not succeed yet. Printing recent logs:" >&2
  docker logs --tail 200 "$APP_CONTAINER" || true
else
  echo "[run] App is healthy."
fi

echo "[run] Status:"
curl -fsS "http://localhost:${APP_PORT}/api/status" || echo "(status unavailable)"

cat <<EOM

Done.

Open the app:
  http://localhost:${APP_PORT}

Useful commands:
  docker logs -f ${APP_CONTAINER}
  docker logs -f ${CHROMA_CONTAINER}
  docker rm -f ${APP_CONTAINER} ${CHROMA_CONTAINER}

Notes:
  - The script uses your .env as-is (Gemini, OpenWeather, Neo4j Aura, etc.).
  - On Linux, it maps host.docker.internal so containers can reach Chroma on the host.
  - Data generated into CSVex/ and csvex_enriched/ is owned by root (written by containers). Keep using Docker for data steps, or chown locally if needed.
EOM
