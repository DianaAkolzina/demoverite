#!/usr/bin/env bash
set -euo pipefail

# Developer controls for running the app without Docker Compose.
# Provides convenient subcommands to build, start, seed, ingest, populate Neo4j, index Chroma, view logs, etc.
#
# Usage:
#   scripts/dev_controls.sh build
#   scripts/dev_controls.sh ensure-chroma
#   scripts/dev_controls.sh seed
#   scripts/dev_controls.sh ingest
#   scripts/dev_controls.sh populate-neo
#   scripts/dev_controls.sh index-chroma
#   scripts/dev_controls.sh start        # starts app container
#   scripts/dev_controls.sh restart      # rebuilds image and restarts app
#   scripts/dev_controls.sh logs         # tail app logs
#   scripts/dev_controls.sh chroma-logs  # tail chroma logs
#   scripts/dev_controls.sh status       # /api/status
#   scripts/dev_controls.sh graph-counts # nodes/links counts
#   scripts/dev_controls.sh rooms        # list CSV rooms as seen by API
#   scripts/dev_controls.sh stop         # stop app container
#   scripts/dev_controls.sh clean        # remove app + chroma containers

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE_NAME="avmsolutions:latest"
APP_CONTAINER="avmsolutions"
CHROMA_CONTAINER="chroma"
CHROMA_PORT=8000
APP_PORT=3000

cd "$ROOT_DIR"

if [[ ! -f .env ]]; then
  echo "[dev] Missing .env at $ROOT_DIR. Create it with your credentials." >&2
  exit 1
fi

mkdir -p "$ROOT_DIR/CSVex" "$ROOT_DIR/csvex_enriched" "$ROOT_DIR/knowledge" "$ROOT_DIR/chroma"

is_linux() { [[ "$(uname -s)" == "Linux" ]]; }
ADD_HOST_OPT=""
if is_linux; then ADD_HOST_OPT="--add-host=host.docker.internal:host-gateway"; fi

wait_for_http() {
  local url="$1"; local tries=${2:-30};
  for _ in $(seq 1 "$tries"); do curl -fsS "$url" >/dev/null 2>&1 && return 0 || sleep 2; done
  return 1
}

build() {
  echo "[dev] Building $IMAGE_NAME"; docker build -t "$IMAGE_NAME" .
}

ensure_chroma() {
  if docker ps -a --format '{{.Names}}' | grep -q "^${CHROMA_CONTAINER}$"; then
    local running; running=$(docker inspect -f '{{.State.Running}}' "$CHROMA_CONTAINER" || echo false)
    if [[ "$running" != "true" ]]; then echo "[dev] Starting existing $CHROMA_CONTAINER"; docker start "$CHROMA_CONTAINER" >/dev/null; else echo "[dev] $CHROMA_CONTAINER already running"; fi
  else
    echo "[dev] Launching new $CHROMA_CONTAINER"
    docker run -d --name "$CHROMA_CONTAINER" -p ${CHROMA_PORT}:8000 \
      -e IS_PERSISTENT=TRUE -e ALLOW_RESET=TRUE \
      -v "$ROOT_DIR/chroma:/chroma" ghcr.io/chroma-core/chroma:latest >/dev/null
  fi
  echo "[dev] Waiting for Chroma heartbeat..."
  wait_for_http "http://localhost:${CHROMA_PORT}/api/v2/heartbeat" 40 || wait_for_http "http://localhost:${CHROMA_PORT}/api/v1/heartbeat" 10 || { echo "[dev] ERROR: Chroma not reachable" >&2; exit 1; }
}

seed() {
  echo "[dev] Generating mock CSVs (2x3x2) for the last 120 days"
  docker run --rm -v "$ROOT_DIR/CSVex:/data/CSVex" -v "$ROOT_DIR/csvex_enriched:/data/CSVex_enriched" \
    --env-file "$ROOT_DIR/.env" -e DAYS=120 "$IMAGE_NAME" python3 scripts/prepare_mock_data.py
}

ingest() {
  echo "[dev] Ingesting CSVs"
  docker run --rm -v "$ROOT_DIR/CSVex:/data/CSVex" -v "$ROOT_DIR/csvex_enriched:/data/CSVex_enriched" \
    --env-file "$ROOT_DIR/.env" "$IMAGE_NAME" python3 scripts/ingest_csvex.py
}

populate_neo() {
  echo "[dev] Populating Neo4j Aura"; docker run --rm --env-file "$ROOT_DIR/.env" "$IMAGE_NAME" node scripts/populate_neo4j_mock.js
}

index_chroma() {
  echo "[dev] Indexing Chroma via client"
  docker run --rm $ADD_HOST_OPT --env-file "$ROOT_DIR/.env" -e CHROMA_URL=http://host.docker.internal:${CHROMA_PORT} \
    "$IMAGE_NAME" python3 scripts/index_chroma.py
}

start_app() {
  echo "[dev] Ensuring Chroma (port ${CHROMA_PORT}) before starting app..."
  ensure_chroma
  echo "[dev] Indexing knowledge/profiles into Chroma"
  index_chroma
  echo "[dev] Starting app on :$APP_PORT"
  if docker ps -a --format '{{.Names}}' | grep -q "^${APP_CONTAINER}$"; then docker rm -f "$APP_CONTAINER" >/dev/null || true; fi
  docker run -d --name "$APP_CONTAINER" -p ${APP_PORT}:3000 \
    -v "$ROOT_DIR/CSVex:/data/CSVex" \
    -v "$ROOT_DIR/csvex_enriched:/data/CSVex_enriched" \
    -v "$ROOT_DIR/knowledge:/app/knowledge:ro" \
    $ADD_HOST_OPT --env-file "$ROOT_DIR/.env" \
    -e CHROMA_URL=http://host.docker.internal:${CHROMA_PORT} \
    -e CHROMA_SKIP_INDEX=1 -e NEO4J_SKIP_POPULATE=1 -e SKIP_INGEST=1 \
    "$IMAGE_NAME" >/dev/null
}

restart() {
  build; ensure_chroma; seed; ingest; populate_neo; index_chroma; start_app
  echo "[dev] Status:"; curl -fsS "http://localhost:${APP_PORT}/api/status" || true
}

logs() { docker logs -f "$APP_CONTAINER"; }
chroma_logs() { docker logs -f "$CHROMA_CONTAINER"; }
status() { curl -fsS "http://localhost:${APP_PORT}/api/status" | sed -e 's/{/\n{/' || true; }
graph_counts() { curl -fsS "http://localhost:${APP_PORT}/api/graph/full" | jq '{nodes: (.nodes|length), links: (.links|length)}' || true; }
rooms() { curl -fsS "http://localhost:${APP_PORT}/api/rooms" | sed -e 's/{/\n{/' || true; }
stop() { docker rm -f "$APP_CONTAINER" >/dev/null || true; }
clean() { docker rm -f "$APP_CONTAINER" "$CHROMA_CONTAINER" >/dev/null || true; }

cmd=${1:-help}
case "$cmd" in
  build) build ;;
  ensure-chroma) ensure_chroma ;;
  seed) seed ;;
  ingest) ingest ;;
  populate-neo) populate_neo ;;
  index-chroma) index_chroma ;;
  start) start_app ;;
  restart) restart ;;
  logs) logs ;;
  chroma-logs) chroma_logs ;;
  status) status ;;
  graph-counts) graph_counts ;;
  rooms) rooms ;;
  stop) stop ;;
  clean) clean ;;
  *)
    cat <<USAGE
Usage: $0 <command>
Commands:
  build            Build the Docker image
  ensure-chroma    Start Chroma or reuse running one and wait for heartbeat
  seed             Generate mock CSVs (2x3x2)
  ingest           Ingest CSVs into csvex_enriched
  populate-neo     Populate Neo4j Aura with mock graph
  index-chroma     Index knowledge + profiles into Chroma
  start            Ensure Chroma, index knowledge, then start the app container
  restart          Full rebuild + seed + ingest + populate + index + start
  logs             Tail app logs
  chroma-logs      Tail chroma logs
  status           Print /api/status
  graph-counts     Print counts for /api/graph/full
  rooms            List rooms from /api/rooms
  stop             Stop the app container
  clean            Remove app and chroma containers
USAGE
    ;;
esac
