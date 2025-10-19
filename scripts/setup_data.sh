#!/usr/bin/env bash
set -euo pipefail

# Generates and ingests mock CSV data (last N days) without requiring the app image.
# Also optionally populates Neo4j (external/local) and indexes Chroma.

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DAYS=${DAYS:-120}

mkdir -p "$ROOT_DIR/CSVex" "$ROOT_DIR/csvex_enriched"

echo "[data] Using python:3.11 to run data scripts in an ephemeral container"

PY_RUN=(docker run --rm -w /work -v "$ROOT_DIR:/work" python:3.11-slim bash -lc)

echo "[data] Installing requirements in ephemeral container..."
"${PY_RUN[@]}" "python -V && python -m pip install --no-cache-dir -r requirements.txt"

echo "[data] Generating mock CSVs (DAYS=$DAYS) into CSVex/"
"${PY_RUN[@]}" "DAYS=$DAYS CSV_SOURCE_DIR=/work/CSVex python scripts/prepare_mock_data.py"

echo "[data] Ingesting CSVs into csvex_enriched/"
"${PY_RUN[@]}" "CSV_SOURCE_DIR=/work/CSVex CSV_TARGET_DIR=/work/csvex_enriched python scripts/ingest_csvex.py"

if [[ -n "${NEO4J_URI:-}" ]]; then
  echo "[data] Populating Neo4j via Node 18 container"
  docker run --rm -w /work -v "$ROOT_DIR:/work" \
    -e NEO4J_URI -e NEO4J_USERNAME -e NEO4J_PASSWORD -e NEO4J_DATABASE \
    node:18-bullseye bash -lc "node scripts/populate_neo4j_mock.js"
fi

if [[ -n "${CHROMA_URL:-}" ]]; then
  echo "[data] Indexing Chroma via ephemeral python container"
  "${PY_RUN[@]}" "python scripts/index_chroma_http.py"
else
  echo "[data] Skipping Chroma indexing (CHROMA_URL empty)"
fi

echo "[data] Done. CSVex/ and csvex_enriched/ are ready."

