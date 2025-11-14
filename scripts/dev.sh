#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$ROOT/.devserver.pid"
LOG_DIR="$ROOT/logs"
LOG_FILE="$LOG_DIR/app.log"
CONTAINER_NAME="avmsolutions-analytics"
IMAGE_NAME="avmsolutions-analytics"

maybe_index_chroma() {
  local should_index="${INDEX_CHROMA_ON_START:-1}"
  if [[ "$should_index" == "1" ]]; then
    echo "[dev] Indexing Chroma before start (set INDEX_CHROMA_ON_START=0 to skip)..."
    if ! index_chroma; then
      echo "[dev] Warning: Chroma indexing failed; continuing anyway." >&2
    fi
  else
    echo "[dev] Skipping Chroma indexing (INDEX_CHROMA_ON_START=$should_index)."
  fi
}

run_npm() {
  (cd "$ROOT" && npm "$@")
}

start_app() {
  if [[ -f "$PID_FILE" ]]; then
    local existing_pid
    existing_pid="$(cat "$PID_FILE")"
    if [[ -n "$existing_pid" ]] && kill -0 "$existing_pid" >/dev/null 2>&1; then
      echo "App already running (PID $existing_pid). Logs: $LOG_FILE"
      return
    fi
  fi
  mkdir -p "$LOG_DIR"
  echo "Starting Node server..."
  maybe_index_chroma
  (
    cd "$ROOT"
    NODE_ENV="${NODE_ENV:-development}" node server/index.js >>"$LOG_FILE" 2>&1 &
    echo $! >"$PID_FILE"
  )
  echo "App started (PID $(cat "$PID_FILE")). Logs: $LOG_FILE"
}

stop_app() {
  if [[ ! -f "$PID_FILE" ]]; then
    echo "No app PID file found. Nothing to stop."
    return
  fi
  local pid
  pid="$(cat "$PID_FILE")"
  if kill -0 "$pid" >/dev/null 2>&1; then
    echo "Stopping app (PID $pid)..."
    kill "$pid"
    wait "$pid" 2>/dev/null || true
  else
    echo "Stale PID file found; process already gone."
  fi
  rm -f "$PID_FILE"
}

app_status() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE")"
    if kill -0 "$pid" >/dev/null 2>&1; then
      echo "App running (PID $pid)"
    else
      echo "PID file exists but process $pid not running."
    fi
  else
    echo "App is not running."
  fi
  lsof -i :3000 2>/dev/null || true
}

tail_logs() {
  mkdir -p "$LOG_DIR"
  touch "$LOG_FILE"
  tail -n 50 -f "$LOG_FILE"
}

sync_s3() {
  run_npm run sync:s3
}

populate_neo4j() {
  run_npm run populate:neo4j
}

index_chroma() {
  run_npm run index:chroma
}

run_tests() {
  run_npm run test:buildings
  run_npm run test:scope
}

run_pipeline() {
  run_npm run pipeline:regression
}

docker_build() {
  local build_arg_run="${RUN_CHROMA_INDEX:-0}"
  local build_chroma_url="${CHROMA_BUILD_URL:-${CHROMA_URL:-http://localhost:8000}}"
  echo "[dev] docker build with RUN_CHROMA_INDEX=$build_arg_run CHROMA_URL=$build_chroma_url"
  (cd "$ROOT" && docker build \
    --build-arg RUN_CHROMA_INDEX="$build_arg_run" \
    --build-arg CHROMA_URL="$build_chroma_url" \
    -t "$IMAGE_NAME" .)
}

docker_up() {
  mkdir -p "$ROOT/data" "$ROOT/CSVex_s3"
  maybe_index_chroma
  docker run -d \
    --name "$CONTAINER_NAME" \
    -p "${PORT:-3000}:3000" \
    --env-file "$ROOT/.env" \
    -v "$ROOT/data:/app/data" \
    -v "$ROOT/CSVex_s3:/app/CSVex_s3" \
    -v "$ROOT/knowledge:/app/knowledge:ro" \
    "$IMAGE_NAME"
}

docker_down() {
  docker rm -f "$CONTAINER_NAME"
}

docker_logs() {
  docker logs -f "$CONTAINER_NAME"
}

clean_all() {
  stop_app || true
  docker_down || true
  rm -f "$PID_FILE"
  echo "Cleaned up local app and container state."
}

usage() {
  cat <<EOF
Usage: $(basename "$0") <command>

App lifecycle:
  start            Start the Node server (background)
  stop             Stop the Node server
  status           Show server status and port usage
  logs             Tail app logs (logs/app.log)

Data & tests:
  sync-s3          Mirror telemetry from S3 (npm run sync:s3)
  populate-neo4j   Seed Neo4j (npm run populate:neo4j)
  index-chroma     Rebuild Chroma index
  test             Run deterministic building + scope suites
  pipeline         Run full regression pipeline

Docker helpers:
  docker-build     Build the Docker image
  docker-up        Run the Docker container (requires built image)
  docker-down      Stop & remove the container
  docker-logs      Tail container logs

Maintenance:
  clean            Stop app/container and remove PID file
Environment:
  INDEX_CHROMA_ON_START=0    Skip automatic `npm run index:chroma` before start/docker-up
  RUN_CHROMA_INDEX=1         Enable Docker build-time indexing (set CHROMA_BUILD_URL/CHROMA_URL accordingly)
EOF
}

cmd="${1:-}"
case "$cmd" in
  start) start_app ;;
  stop) stop_app ;;
  status) app_status ;;
  logs) tail_logs ;;
  sync-s3) sync_s3 ;;
  populate-neo4j) populate_neo4j ;;
  index-chroma) index_chroma ;;
  test) run_tests ;;
  pipeline) run_pipeline ;;
  docker-build) docker_build ;;
  docker-up) docker_up ;;
  docker-down) docker_down ;;
  docker-logs) docker_logs ;;
  clean) clean_all ;;
  ""|-h|--help|help) usage ;;
  *) echo "Unknown command: $cmd" >&2; usage; exit 1 ;;
esac
