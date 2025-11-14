#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$ROOT/.devserver.pid"
LOG_DIR="$ROOT/logs"
LOG_FILE="$LOG_DIR/app.log"
CONTAINER_NAME="avmsolutions-analytics"
IMAGE_NAME="avmsolutions-analytics"
CACHE_DIR="$ROOT/.devcache"
NODE_STAMP_FILE="$CACHE_DIR/node.hash"
PY_STAMP_FILE="$CACHE_DIR/python.hash"
PYTHON_VENV="${PYTHON_VENV:-$ROOT/.venv}"

hash_file() {
  local target="$1"
  if [[ -f "$target" ]]; then
    sha256sum "$target" | awk '{print $1}'
  else
    echo "missing"
  fi
}

ensure_node_deps() {
  local lock_file
  if [[ -f "$ROOT/package-lock.json" ]]; then
    lock_file="$ROOT/package-lock.json"
  else
    lock_file="$ROOT/package.json"
  fi
  local desired_hash current_hash
  desired_hash="$(hash_file "$lock_file")"
  [[ -f "$NODE_STAMP_FILE" ]] && current_hash="$(cat "$NODE_STAMP_FILE")" || current_hash=""
  if [[ ! -d "$ROOT/node_modules" ]] || [[ "$desired_hash" != "$current_hash" ]]; then
    echo "[dev] Installing npm dependencies..."
    (cd "$ROOT" && npm install)
    mkdir -p "$CACHE_DIR"
    echo "$desired_hash" >"$NODE_STAMP_FILE"
  fi
}

ensure_python_deps() {
  local req_file="$ROOT/requirements.txt"
  if [[ ! -f "$req_file" ]] || [[ "${SKIP_PY_DEPS:-0}" == "1" ]]; then
    return
  fi
  if [[ ! -x "$PYTHON_VENV/bin/python3" ]]; then
    rm -rf "$PYTHON_VENV"
    echo "[dev] Creating Python venv at $PYTHON_VENV"
    if ! python3 -m venv "$PYTHON_VENV"; then
      cat <<'EOF' >&2
[dev] Failed to create Python virtualenv (python3-venv missing?).
Install it via `sudo apt install python3-venv` (or distro equivalent), or run with SKIP_PY_DEPS=1.
EOF
      exit 1
    fi
  fi
  local desired_hash current_hash
  desired_hash="$(hash_file "$req_file")"
  [[ -f "$PY_STAMP_FILE" ]] && current_hash="$(cat "$PY_STAMP_FILE")" || current_hash=""
  if [[ "$desired_hash" != "$current_hash" ]]; then
    echo "[dev] Installing Python dependencies..."
    "$PYTHON_VENV/bin/pip" install --upgrade pip
    "$PYTHON_VENV/bin/pip" install -r "$req_file"
    mkdir -p "$CACHE_DIR"
    echo "$desired_hash" >"$PY_STAMP_FILE"
  fi
  case ":$PATH:" in
    *":$PYTHON_VENV/bin:"*) ;;
    *) export PATH="$PYTHON_VENV/bin:$PATH" ;;
  esac
}

ensure_local_deps() {
  ensure_node_deps
  ensure_python_deps
}

ensure_dirs() {
  local dirs=("$LOG_DIR" "$ROOT/data" "$ROOT/CSVex_s3" "$ROOT/CSVex_s3/weather_buildings")
  for dir in "${dirs[@]}"; do
    if [[ -d "$dir" ]]; then
      if [[ ! -w "$dir" ]]; then
        local owner
        owner="$(stat -c '%U:%G' "$dir" 2>/dev/null || echo 'unknown')"
        cat <<EOF >&2
[dev] Directory $dir is not writable (owner $owner).
[dev] Fix with: sudo chown -R $(id -un):$(id -gn) "$dir"
EOF
        exit 1
      fi
    else
      mkdir -p "$dir"
    fi
  done
}

maybe_sync_s3() {
  local should_sync="${S3_MIRROR_ON_START:-0}"
  if [[ "$should_sync" == "1" ]]; then
    ensure_dirs
    echo "[dev] Mirroring telemetry from S3 (set S3_MIRROR_ON_START=0 to skip)..."
    if ! sync_s3; then
      echo "[dev] Warning: S3 mirror failed; continuing with existing CSV cache." >&2
    fi
  else
    echo "[dev] Skipping S3 mirror (S3_MIRROR_ON_START=$should_sync)."
  fi
}

maybe_index_chroma() {
  local should_index="${INDEX_CHROMA_ON_START:-1}"
  if [[ "$should_index" == "1" ]]; then
    ensure_local_deps
    echo "[dev] Indexing Chroma before start (set INDEX_CHROMA_ON_START=0 to skip)..."
    if ! index_chroma; then
      echo "[dev] Warning: Chroma indexing failed; continuing anyway." >&2
    fi
  else
    echo "[dev] Skipping Chroma indexing (INDEX_CHROMA_ON_START=$should_index)."
  fi
}

run_npm() {
  ensure_node_deps
  (cd "$ROOT" && npm "$@")
}

start_app() {
  ensure_node_deps
  ensure_dirs
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
  maybe_sync_s3
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
  ensure_dirs
  ensure_node_deps
  run_npm run sync:s3
}

populate_neo4j() {
  ensure_node_deps
  run_npm run populate:neo4j
}

index_chroma() {
  ensure_local_deps
  run_npm run index:chroma
}

run_tests() {
  ensure_node_deps
  run_npm run test:buildings
  run_npm run test:scope
}

run_pipeline() {
  ensure_node_deps
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
  ensure_dirs
  if [[ "${AUTO_DOCKER_BUILD:-0}" == "1" ]]; then
    docker_build
  fi
  maybe_sync_s3
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
  up               Convenience alias for docker-up (honors AUTO_DOCKER_BUILD)
  docker-build     Build the Docker image
  docker-up        Run the Docker container (requires built image)
  docker-down      Stop & remove the container
  docker-logs      Tail container logs

Maintenance:
  clean            Stop app/container and remove PID file
Environment:
  INDEX_CHROMA_ON_START=0    Skip automatic `npm run index:chroma` before start/docker-up
  RUN_CHROMA_INDEX=1         Enable Docker build-time indexing (set CHROMA_BUILD_URL/CHROMA_URL accordingly)
  S3_MIRROR_ON_START=1       Mirror telemetry from S3 via `npm run sync:s3` before start/docker-up
  AUTO_DOCKER_BUILD=1        Rebuild the Docker image automatically before docker-up
  PYTHON_VENV=/path/to/.venv  Override the default local venv location used for Python deps
  SKIP_PY_DEPS=1             Skip automatic Python dependency installation
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
  up) docker_up ;;
  docker-build) docker_build ;;
  docker-up) docker_up ;;
  docker-down) docker_down ;;
  docker-logs) docker_logs ;;
  clean) clean_all ;;
  ""|-h|--help|help) usage ;;
  *) echo "Unknown command: $cmd" >&2; usage; exit 1 ;;
esac
