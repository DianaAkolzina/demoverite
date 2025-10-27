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
#   scripts/dev_controls.sh doctor       # show containers and port usage
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

# Graceful stop helper: stop with timeout, then remove if exists
docker_stop_rm() {
  local name="$1"; local timeout="${2:-10}"
  if docker ps -a --format '{{.Names}}' | grep -q "^${name}$"; then
    docker stop -t "$timeout" "$name" >/dev/null 2>&1 || true
    docker rm "$name" >/dev/null 2>&1 || true
  fi
}

wait_for_http() {
  local url="$1"; local tries=${2:-30};
  for _ in $(seq 1 "$tries"); do curl -fsS "$url" >/dev/null 2>&1 && return 0 || sleep 2; done
  return 1
}

build() {
  echo "[dev] Building $IMAGE_NAME"
  # Build toggles (override via env):
  #   DOCKER_BUILDKIT=0|1         -> enable/disable BuildKit (default 0 for stability)
  #   BUILD_NO_CACHE=1            -> pass --no-cache
  #   BUILD_PLATFORM=linux/amd64  -> pass --platform
  #   BUILD_PROGRESS=plain        -> pass --progress
  #   CHROMA_EMB_MODEL=none       -> skip model prefetch during build
  : "${DOCKER_BUILDKIT:=0}"
  if [ "${DOCKER_BUILDKIT}" = "1" ]; then
    if ! docker buildx version >/dev/null 2>&1; then
      echo "[dev] buildx not found; falling back to DOCKER_BUILDKIT=0"
      DOCKER_BUILDKIT=0
    fi
  fi
  no_cache_flag=""; [[ "${BUILD_NO_CACHE:-0}" = "1" ]] && no_cache_flag="--no-cache"
  platform_flag=""; [[ -n "${BUILD_PLATFORM:-}" ]] && platform_flag="--platform=${BUILD_PLATFORM}"
  progress_flag=""; [[ -n "${BUILD_PROGRESS:-}" ]] && progress_flag="--progress=${BUILD_PROGRESS}"
  emb_arg_flag=""; [[ -n "${CHROMA_EMB_MODEL:-}" ]] && emb_arg_flag="--build-arg CHROMA_EMB_MODEL=${CHROMA_EMB_MODEL}"

  echo "[dev] DOCKER_BUILDKIT=${DOCKER_BUILDKIT} ${no_cache_flag} ${platform_flag} ${progress_flag} ${emb_arg_flag}"
  DOCKER_BUILDKIT=${DOCKER_BUILDKIT} docker build ${no_cache_flag} ${platform_flag} ${progress_flag} \
    ${emb_arg_flag} -t "$IMAGE_NAME" .
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

ingest() {
  echo "[dev] Ingesting CSVs"
  docker run --rm -v "$ROOT_DIR/CSVex:/data/CSVex" -v "$ROOT_DIR/csvex_enriched:/data/CSVex_enriched" \
    --env-file "$ROOT_DIR/.env" "$IMAGE_NAME" python3 scripts/ingest_csvex.py
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
  # Pre-create local S3 mirror dir and optionally sync once before container starts
  mkdir -p "$ROOT_DIR/CSVex_s3"
  if grep -q '^AWS_S3_BUCKET=' "$ROOT_DIR/.env"; then
    echo "[dev] Pre-syncing S3 telemetry to CSVex_s3 (host) (prefix optional) using app image"
    docker run --rm -w /app \
      -v "$ROOT_DIR/CSVex_s3:/app/CSVex_s3" \
      --env-file "$ROOT_DIR/.env" avmsolutions:latest \
      node scripts/s3_sync_telemetry.js || true
  else
    echo "[dev] Skipping pre-sync: AWS_S3_BUCKET missing in .env"
  fi
  # Generate missing telemetry after mirror so every Device has CSV keyed by Neo4j id/cloud_id
  echo "[dev] Generating missing telemetry from LIVE Neo4j graph (ONLY_MISSING=1)"
  docker run --rm -w /app \
    -v "$ROOT_DIR/CSVex_s3:/app/CSVex_s3" \
    --env-file "$ROOT_DIR/.env" \
    -e DAYS=${DAYS:-120} -e S3_LOCAL_DIR=CSVex_s3 -e ONLY_MISSING=1 \
    avmsolutions:latest node scripts/generate_local_telemetry_from_graph.js || true
  echo "[dev] Starting app on :$APP_PORT"
  if docker ps -a --format '{{.Names}}' | grep -q "^${APP_CONTAINER}$"; then docker rm -f "$APP_CONTAINER" >/dev/null || true; fi
  docker run -d --name "$APP_CONTAINER" -p ${APP_PORT}:3000 \
    -v "$ROOT_DIR/CSVex:/data/CSVex" \
    -v "$ROOT_DIR/csvex_enriched:/data/CSVex_enriched" \
    -v "$ROOT_DIR/knowledge:/app/knowledge:ro" \
    -v "$ROOT_DIR/CSVex_s3:/app/CSVex_s3" \
    $ADD_HOST_OPT --env-file "$ROOT_DIR/.env" \
    -e CHROMA_URL=http://host.docker.internal:${CHROMA_PORT} \
    -e CHROMA_SKIP_INDEX=1 -e NEO4J_SKIP_POPULATE=1 -e NEO4J_SKIP_CHECK=1 -e NEO4J_ALLOW_DEGRADED=1 -e CSV_GENERATE_FROM_GRAPH=0 \
    -e AWS_S3_ENABLED=1 -e S3_MIRROR_ON_START=1 -e S3_LOCAL_DIR=CSVex_s3 \
    "$IMAGE_NAME" >/dev/null
}

restart() {
  build; start_app
  echo "[dev] Waiting for app health..."
  if wait_for_http "http://localhost:${APP_PORT}/api/health" 30; then
    echo "[dev] Status:"; curl -fsS "http://localhost:${APP_PORT}/api/status" || true
  else
    echo "[dev] App did not become healthy in time. Recent logs:";
    docker logs --tail 200 "$APP_CONTAINER" || true
  fi
}

logs() { docker logs -f "$APP_CONTAINER"; }
chroma_logs() { docker logs -f "$CHROMA_CONTAINER"; }
status() { curl -fsS "http://localhost:${APP_PORT}/api/status" | sed -e 's/{/\n{/' || true; }
graph_counts() { curl -fsS "http://localhost:${APP_PORT}/api/graph/full" | jq '{nodes: (.nodes|length), links: (.links|length)}' || true; }
rooms() { curl -fsS "http://localhost:${APP_PORT}/api/rooms" | sed -e 's/{/\n{/' || true; }
stop() { docker rm -f "$APP_CONTAINER" >/dev/null || true; }
clean() {
  docker_stop_rm "$APP_CONTAINER" 10
  docker_stop_rm "$CHROMA_CONTAINER" 10
}

# Show current containers and which ports are occupied that we care about
doctor() {
  echo "[dev] Containers (related):"
  docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' | grep -E "^(avmsolutions|chroma|neo4j)\b" || true
  echo
  if [ -f "$ROOT_DIR/docker-compose.yml" ]; then
    compose_cmd=""
    if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
      compose_cmd="docker compose"
    elif command -v docker-compose >/dev/null 2>&1; then
      compose_cmd="docker-compose"
    fi
    if [ -n "$compose_cmd" ]; then
      echo "[dev] $compose_cmd ps (this project):"; $compose_cmd ps || true
      echo
    else
      echo "[dev] docker compose/docker-compose not found; skipping compose ps"
      echo
    fi
  fi
  echo "[dev] Port listeners (3000,8000,7474,7687):"
  if command -v ss >/dev/null 2>&1; then
    ss -lntp | grep -E ":(3000|8000|7474|7687)\b" || true
  elif command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP -sTCP:LISTEN | grep -E ":(3000|8000|7474|7687)\b" || true
  else
    echo "[dev] Neither 'ss' nor 'lsof' found to inspect ports" >&2
  fi
}

# Stop app + infra, bring compose down (if present), and wait for ports to free
cleanup_all() {
  echo "[dev] Stopping named containers (avmsolutions, chroma, neo4j)"
  docker_stop_rm "$APP_CONTAINER" 10
  docker_stop_rm "$CHROMA_CONTAINER" 10
  docker_stop_rm neo4j 10
  if [ -f "$ROOT_DIR/docker-compose.yml" ]; then
    echo "[dev] docker compose down -v --remove-orphans"
    if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
      docker compose down -v --remove-orphans >/dev/null 2>&1 || true
    elif command -v docker-compose >/dev/null 2>&1; then
      docker-compose down -v --remove-orphans >/dev/null 2>&1 || true
    else
      echo "[dev] docker compose/docker-compose not found; skipping compose down"
    fi
  fi
  # Wait for ports to be idle
  ports=(3000 8000 7474 7687)
  for p in "${ports[@]}"; do
    echo "[dev] Waiting for port :$p to be free..."
    for _ in $(seq 1 20); do
      if command -v ss >/dev/null 2>&1; then
        ss -lnt | grep -q ":$p\b" || { echo "[dev] Port :$p is free"; break; }
      elif command -v lsof >/dev/null 2>&1; then
        lsof -nP -i :"$p" | grep -q . && sleep 1 || { echo "[dev] Port :$p is free"; break; }
      else
        break
      fi
      sleep 1
    done
  done
  echo "[dev] Cleanup complete"
}

cmd=${1:-help}
case "$cmd" in
  build) build ;;
  ensure-chroma) ensure_chroma ;;
  ingest) ingest ;;
  index-chroma) index_chroma ;;
  start) start_app ;;
  run)
    # Build, generate CSVs from Neo4j (read-only), ingest, then run app in foreground with verbose logging
  build
  echo "[dev] S3-only mode: skipping any CSV generation/ingestion"
    mkdir -p "$ROOT_DIR/CSVex_s3"
    if grep -q '^AWS_S3_BUCKET=' "$ROOT_DIR/.env"; then
      echo "[dev] Pre-syncing S3 telemetry to CSVex_s3 (host) (prefix optional)"
      npm run --silent s3:sync || true
    else
      echo "[dev] Skipping pre-sync: AWS_S3_BUCKET missing in .env"
    fi
  echo "[dev] Running app in foreground on :$APP_PORT"
    if docker ps -a --format '{{.Names}}' | grep -q "^${APP_CONTAINER}$"; then docker rm -f "$APP_CONTAINER" >/dev/null || true; fi
    docker run --rm --name "$APP_CONTAINER" -p ${APP_PORT}:3000 \
      -v "$ROOT_DIR/CSVex:/data/CSVex" \
      -v "$ROOT_DIR/csvex_enriched:/data/CSVex_enriched" \
      -v "$ROOT_DIR/knowledge:/app/knowledge:ro" \
      -v "$ROOT_DIR/CSVex_s3:/app/CSVex_s3" \
      $ADD_HOST_OPT --env-file "$ROOT_DIR/.env" \
      -e CHROMA_URL=http://host.docker.internal:${CHROMA_PORT} \
      -e CHROMA_SKIP_INDEX=1 -e NEO4J_SKIP_POPULATE=1 -e NEO4J_SKIP_CHECK=1 -e NEO4J_ALLOW_DEGRADED=1 -e CSV_GENERATE_FROM_GRAPH=0 \
      -e AWS_S3_ENABLED=1 -e S3_MIRROR_ON_START=1 -e S3_LOCAL_DIR=CSVex_s3 \
      -e HTTP_DEBUG=1 -e LOG_LEVEL=debug \
      "$IMAGE_NAME"
    ;;
  restart) restart ;;
  logs) logs ;;
  chroma-logs) chroma_logs ;;
  doctor) doctor ;;
  status) status ;;
  graph-counts) graph_counts ;;
  rooms) rooms ;;
  stop) stop ;;
  clean) clean ;;
  cleanup-all) cleanup_all ;;
  s3-sync)
    echo "[dev] Syncing S3 telemetry to CSVex_s3/"; npm run --silent s3:sync ;;
reset)
    echo "[dev] Clearing caches and rebuilding...";
    rm -f "$ROOT_DIR/data/graph_snapshot.json" || true;
    mkdir -p "$ROOT_DIR/CSVex_s3"; rm -f "$ROOT_DIR/CSVex_s3"/*.csv || true;
    restart ;;
  *)
    cat <<USAGE
Usage: $0 <command>
Commands:
  build            Build the Docker image
  ensure-chroma    Start Chroma or reuse running one and wait for heartbeat
  seed             [disabled] (S3-only mode)
  ingest           Ingest CSVs into csvex_enriched
  populate-neo     Populate Neo4j Aura with mock graph
  index-chroma     Index knowledge + profiles into Chroma
  start            Ensure Chroma, index knowledge, then start the app container
  restart          Full rebuild + seed + ingest + populate + index + start
  logs             Tail app logs
  chroma-logs      Tail chroma logs
  doctor           Show related containers and port listeners
  status           Print /api/status
  graph-counts     Print counts for /api/graph/full
  rooms            List rooms from /api/rooms
  stop             Stop the app container
  clean            Remove app and chroma containers
  cleanup-all      Stop all related containers, compose down, wait for ports
  s3-sync          Mirror S3 telemetry CSVs into CSVex_s3/
  reset            Clear caches, re-sync S3 locally, and restart app
USAGE
    ;;
esac
