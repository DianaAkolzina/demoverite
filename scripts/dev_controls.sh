#!/usr/bin/env bash
set -euo pipefail

# Developer controls for running the app without Docker Compose.
# Provides convenient subcommands to build, start, seed, ingest, populate Neo4j, index Chroma, view logs, etc.
#
# Usage:
#   scripts/dev_controls.sh build
#   scripts/dev_controls.sh ensure-chroma
#   scripts/dev_controls.sh sync-s3
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
PORTS_TO_MONITOR=(3000 8000 7474 7687)
DEV_PORT_LOG="$ROOT_DIR/data/dev_ports.log"
REMOVE_CHROMA_ON_STOP="${DEV_REMOVE_CHROMA_ON_STOP:-1}"

cd "$ROOT_DIR"

if [[ ! -f .env ]]; then
  echo "[dev] Missing .env at $ROOT_DIR. Create it with your credentials." >&2
  exit 1
fi

mkdir -p "$ROOT_DIR/CSVex_s3" "$ROOT_DIR/knowledge" "$ROOT_DIR/chroma" "$ROOT_DIR/data"

is_linux() { [[ "$(uname -s)" == "Linux" ]]; }
ADD_HOST_OPT=""
if is_linux; then ADD_HOST_OPT="--add-host=host.docker.internal:host-gateway"; fi

# Optional DNS overrides for containers (helps resolve cloud hosts like Aura)
# Set DEV_DNS1/DEV_DNS2 in your environment or .env to force specific resolvers.
DEV_DNS1="${DEV_DNS1:-}"
DEV_DNS2="${DEV_DNS2:-}"
if [[ -z "$DEV_DNS1" ]]; then
  # Auto-detect from /etc/resolv.conf (take up to two nameservers)
  # shellcheck disable=SC2207
  ns=( $(awk '/^nameserver/{print $2}' /etc/resolv.conf | head -n2) ) || ns=()
  DEV_DNS1="${ns[0]:-}"
  DEV_DNS2="${ns[1]:-}"
fi
DNS_OPTS=""
[[ -n "$DEV_DNS1" ]] && DNS_OPTS+=" --dns $DEV_DNS1"
[[ -n "$DEV_DNS2" ]] && DNS_OPTS+=" --dns $DEV_DNS2"

wait_for_http() {
  local url="$1"; local tries=${2:-30};
  for _ in $(seq 1 "$tries"); do curl -fsS "$url" >/dev/null 2>&1 && return 0 || sleep 2; done
  return 1
}

record_port_snapshot() {
  local tag="${1:-snapshot}"
  if ! command -v ss >/dev/null 2>&1; then return 0; fi
  mkdir -p "$(dirname "$DEV_PORT_LOG")"
  local regex=""
  for p in "${PORTS_TO_MONITOR[@]}"; do
    regex+=":${p}\\b|"
  done
  regex="${regex%|}"
  {
    echo "[$(date -Iseconds)] ${tag}"
    ss -lnt | awk -v re="$regex" 'NR==1 || $4 ~ re' || true
  } >> "$DEV_PORT_LOG" 2>/dev/null || true
}

ensure_ports_closed() {
  local ports=("$@")
  if [[ ${#ports[@]} -eq 0 ]]; then
    ports=("${PORTS_TO_MONITOR[@]}")
  fi
  for p in "${ports[@]}"; do
    echo "[dev] Ensuring port :$p is closed..."
    if command -v lsof >/dev/null 2>&1; then
      local pids
      pids=$(lsof -t -iTCP:"$p" -sTCP:LISTEN 2>/dev/null | tr '\n' ' ' || true)
      if [[ -n "${pids// /}" ]]; then
        echo "[dev] Found listeners on :$p (PIDs: $pids). Sending TERM..."
        kill -TERM $pids 2>/dev/null || true
        for _ in $(seq 1 5); do
          sleep 1
          lsof -t -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1 || break
        done
        if lsof -t -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
          echo "[dev] Listeners still present on :$p. Sending KILL..."
          kill -KILL $pids 2>/dev/null || true
        fi
      fi
    elif command -v fuser >/dev/null 2>&1; then
      fuser -k -n tcp "$p" 2>/dev/null || true
    fi
    echo "[dev] Waiting for port :$p to be free..."
    for _ in $(seq 1 20); do
      if command -v ss >/dev/null 2>&1; then
        if ss -lnt | grep -q ":$p\b"; then
          sleep 1
        else
          echo "[dev] Port :$p is free"
          break
        fi
      elif command -v lsof >/dev/null 2>&1; then
        if lsof -nP -i :"$p" | grep -q .; then
          sleep 1
        else
          echo "[dev] Port :$p is free"
          break
        fi
      else
        break
      fi
    done
  done
  record_port_snapshot "ports-cleared"
}

build() {
  echo "[dev] Building $IMAGE_NAME"; docker build -t "$IMAGE_NAME" .
  echo "[dev] Pruning dangling avmsolutions image layers"
  docker image prune -f --filter label=com.avmsolutions.autoclean="true" >/dev/null 2>&1 || true
}

ensure_chroma() {
  if docker ps -a --format '{{.Names}}' | grep -q "^${CHROMA_CONTAINER}$"; then
    local running; running=$(docker inspect -f '{{.State.Running}}' "$CHROMA_CONTAINER" || echo false)
    if [[ "$running" != "true" ]]; then echo "[dev] Starting existing $CHROMA_CONTAINER"; docker start "$CHROMA_CONTAINER" >/dev/null; else echo "[dev] $CHROMA_CONTAINER already running"; fi
  else
    echo "[dev] Launching new $CHROMA_CONTAINER"
    docker run -d --name "$CHROMA_CONTAINER" -p ${CHROMA_PORT}:8000 \
      ${DNS_OPTS} \
      -e IS_PERSISTENT=TRUE -e ALLOW_RESET=TRUE \
      -v "$ROOT_DIR/chroma:/chroma" ghcr.io/chroma-core/chroma:latest >/dev/null
  fi
  echo "[dev] Waiting for Chroma heartbeat..."
  wait_for_http "http://localhost:${CHROMA_PORT}/api/v2/heartbeat" 40 || wait_for_http "http://localhost:${CHROMA_PORT}/api/v1/heartbeat" 10 || { echo "[dev] ERROR: Chroma not reachable" >&2; exit 1; }
}

sync_s3() {
  if grep -q '^AWS_S3_BUCKET=' "$ROOT_DIR/.env"; then
    echo "[dev] Syncing telemetry from S3 to ./CSVex_s3"
    docker run --rm --env-file "$ROOT_DIR/.env" -v "$ROOT_DIR/CSVex_s3:/app/CSVex_s3" "$IMAGE_NAME" node scripts/s3_sync_telemetry.js || true
  else
    echo "[dev] Skipping S3 sync (AWS_S3_BUCKET not set)"
  fi
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
    ${DNS_OPTS} \
    -v "$ROOT_DIR/CSVex_s3:/app/CSVex_s3" \
    -v "$ROOT_DIR/knowledge:/app/knowledge:ro" \
    -v "$ROOT_DIR/data:/app/data" \
    $ADD_HOST_OPT --env-file "$ROOT_DIR/.env" \
    -e CHROMA_URL=http://host.docker.internal:${CHROMA_PORT} \
    -e CHROMA_SKIP_INDEX=1 -e NEO4J_SKIP_POPULATE=1 -e AWS_S3_ENABLED=1 \
    "$IMAGE_NAME" >/dev/null
}

restart() {
  build; ensure_chroma; sync_s3; populate_neo; index_chroma; start_app
  echo "[dev] Status:"; curl -fsS "http://localhost:${APP_PORT}/api/status" || true
}

logs() { docker logs -f "$APP_CONTAINER"; }
chroma_logs() { docker logs -f "$CHROMA_CONTAINER"; }
status() { curl -fsS "http://localhost:${APP_PORT}/api/status" | sed -e 's/{/\n{/' || true; }
graph_counts() { curl -fsS "http://localhost:${APP_PORT}/api/graph/full" | jq '{nodes: (.nodes|length), links: (.links|length)}' || true; }
rooms() { curl -fsS "http://localhost:${APP_PORT}/api/rooms" | sed -e 's/{/\n{/' || true; }
stop() {
  record_port_snapshot "stop-pre"
  docker rm -f "$APP_CONTAINER" >/dev/null 2>&1 || true
  if [[ "$REMOVE_CHROMA_ON_STOP" == "1" ]]; then
    docker rm -f "$CHROMA_CONTAINER" >/dev/null 2>&1 || true
  fi
  ensure_ports_closed
}
clean() {
  record_port_snapshot "clean-pre"
  docker rm -f "$APP_CONTAINER" "$CHROMA_CONTAINER" >/dev/null 2>&1 || true
  ensure_ports_closed
}

# Stop app + infra, bring compose down (if present), and wait for ports to free
cleanup_all() {
  echo "[dev] Stopping named containers (avmsolutions, chroma, neo4j)"
  docker rm -f "$APP_CONTAINER" "$CHROMA_CONTAINER" neo4j >/dev/null 2>&1 || true
  if [ -f "$ROOT_DIR/docker-compose.yml" ]; then
    echo "[dev] docker compose down -v --remove-orphans"
    if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
      docker compose down -v --remove-orphans >/dev/null 2>&1 || true
    elif command -v docker-compose >/dev/null 2>&1; then
      docker-compose down -v --remove-orphans >/dev/null 2>&1 || true
    fi
  fi
  echo "[dev] Pruning unused Docker images, builders and volumes (may take a while)"
  if command -v docker >/dev/null 2>&1; then
    docker system prune -af >/dev/null 2>&1 || true
    docker builder prune -af >/dev/null 2>&1 || true
    docker volume prune -f >/dev/null 2>&1 || true
  fi
  echo "[dev] Cleaning workspace artifacts (traces, tests, chroma cache)"
  rm -rf "$ROOT_DIR/data/traces" "$ROOT_DIR/data/tests" 2>/dev/null || true
  mkdir -p "$ROOT_DIR/data/traces" "$ROOT_DIR/data/tests" 2>/dev/null || true
  # Clear Chroma persistent store (it can grow between runs)
  if [ -d "$ROOT_DIR/chroma" ]; then
    rm -rf "$ROOT_DIR/chroma"/* 2>/dev/null || true
  fi
  # Optional: clear cached per-building weather (uncomment if you want to reclaim space aggressively)
  # rm -rf "$ROOT_DIR/data/weather_buildings" 2>/dev/null || true
  echo "[dev] Workspace cleanup complete"
  ensure_ports_closed "${PORTS_TO_MONITOR[@]}"
  echo "[dev] Cleanup complete"
}

cmd=${1:-help}
case "$cmd" in
  build) build ;;
  ensure-chroma) ensure_chroma ;;
  sync-s3) sync_s3 ;;
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
  cleanup-all) cleanup_all ;;
  *)
    cat <<USAGE
Usage: $0 <command>
Commands:
  build            Build the Docker image
  ensure-chroma    Start Chroma or reuse running one and wait for heartbeat
  sync-s3          Mirror telemetry from S3 into ./CSVex_s3
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
  cleanup-all      Stop all related containers, compose down, wait for ports
USAGE
    ;;
esac
