#!/usr/bin/env sh
set -eu

echo "[entrypoint] Using CSV_SOURCE_DIR=${CSV_SOURCE_DIR:-CSVex} CSV_TARGET_DIR=${CSV_TARGET_DIR:-${CSV_DIR:-CSVex}}"

if [ "${SKIP_INGEST:-0}" != "1" ]; then
  echo "[entrypoint] Running Python ingestion..."
  if ! python3 scripts/ingest_csvex.py; then
    echo "[entrypoint][warn] Ingestion failed (continuing to start server)" >&2
  fi
else
  echo "[entrypoint] Skipping ingestion (SKIP_INGEST=1)"
fi

echo "[entrypoint] Starting Node server..."

# Optional: backfill weather if API key provided
if [ -n "${OPENWEATHER_API_KEY:-}" ]; then
  echo "[entrypoint] Fetching weather (OpenWeather)..."
  python3 scripts/fetch_weather.py || echo "[entrypoint] weather fetch failed"
fi

exec node server/index.js
