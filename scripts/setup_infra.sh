#!/usr/bin/env bash
set -euo pipefail

# Starts local infrastructure services used by the app, with sensible defaults:
# - ChromaDB on localhost:8000 (always)
# - Neo4j: optional (USE_LOCAL_NEO4J=1) on localhost:7474/7687

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

start_chroma() {
  if docker ps -a --format '{{.Names}}' | grep -q '^chroma$'; then
    docker start chroma >/dev/null || true
  else
    docker run -d --name chroma -p 8000:8000 \
      -e IS_PERSISTENT=TRUE -e ALLOW_RESET=TRUE \
      -v "$ROOT_DIR/chroma:/chroma" \
      ghcr.io/chroma-core/chroma:latest >/dev/null
  fi
  echo "[infra] Waiting for Chroma heartbeat..."
  until curl -sf http://localhost:8000/api/v2/heartbeat >/dev/null 2>&1 || \
        curl -sf http://localhost:8000/api/v1/heartbeat >/dev/null 2>&1; do
    sleep 1
  done
  echo "[infra] Chroma ready on http://localhost:8000"
}

start_neo4j() {
  if docker ps -a --format '{{.Names}}' | grep -q '^neo4j$'; then
    docker start neo4j >/dev/null || true
  else
    docker run -d --name neo4j -p 7474:7474 -p 7687:7687 \
      -e NEO4J_AUTH=${NEO4J_AUTH:-neo4j/testtest} \
      -v "$ROOT_DIR/neo4j/data:/data" \
      -v "$ROOT_DIR/neo4j/logs:/logs" \
      neo4j:5-community >/dev/null
  fi
  echo "[infra] Neo4j listening on bolt://localhost:7687 (UI: http://localhost:7474)"
}

mkdir -p "$ROOT_DIR/chroma" "$ROOT_DIR/neo4j/data" "$ROOT_DIR/neo4j/logs"

start_chroma

if [[ "${USE_LOCAL_NEO4J:-0}" = "1" ]]; then
  start_neo4j
else
  echo "[infra] Skipping local Neo4j (set USE_LOCAL_NEO4J=1 to start it)"
fi

echo "[infra] Done."

