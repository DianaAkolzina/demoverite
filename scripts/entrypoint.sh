#!/usr/bin/env sh
set -eu

echo "[entrypoint] Starting Node server (S3/Neo4j/Chroma mode)"
exec node server/index.js
