# AVM Solutions Analytics

Production‑ready building analytics assistant with RAG + tool calling, Highcharts UI, Neo4j topology, Chroma vector search, and S3‑backed telemetry. Weather is fetched per building from OpenWeather using coordinates in Neo4j.

This project lets you query and visualize building metrics (CO2, VOC, lux, occupancy, energy, etc.) per room and over a selected time range.

## Quick Start (Dev Controls)

Prereqs: Docker, Docker Compose (optional), AWS credentials for S3, Neo4j connection, and optionally a running Chroma.

1) Clone
```bash
git clone <repo-url>
cd avmsolutions
```

2) Configure `.env`
- Neo4j (required): `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD`, `NEO4J_DATABASE`
- S3 telemetry: `AWS_S3_BUCKET`, `AWS_S3_REGION`, optional `AWS_S3_PREFIX`, set `AWS_S3_ENABLED=1`
- Chroma (optional): `CHROMA_URL`
- OpenWeather (optional, for per‑building caching): `OPENWEATHER_API_KEY`

3) Start via dev controls
```bash
scripts/dev_controls.sh start
```
This ensures Chroma, indexes knowledge, mirrors S3 telemetry locally into `./CSVex_s3`, and starts the app on `http://localhost:3000`.

Useful commands:
- `scripts/dev_controls.sh sync-s3` to refresh local telemetry mirror
- `scripts/dev_controls.sh status` to check /api/status
- `scripts/dev_controls.sh logs` to tail app logs

## Telemetry via S3

- The server reads device timeseries from a local mirror under `./CSVex_s3` (mounted into the container), populated by `scripts/s3_sync_telemetry.js` using your AWS credentials.
- File format: one CSV per device ID, named `<deviceId>.csv`, with `ts` as epoch milliseconds and one or more numeric fields.
- The app enumerates devices by listing `./CSVex_s3/*.csv` and maps them to graph Devices in Neo4j by ID, cloud_id, deviceId, or name (best‑effort normalization).

## Environment Variables

- `PORT` (default `3000`): server port
- Neo4j (required): `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD`, `NEO4J_DATABASE`
- S3 telemetry: `AWS_S3_ENABLED=1`, `AWS_S3_BUCKET`, `AWS_S3_REGION`, optional `AWS_S3_PREFIX`, `S3_LOCAL_DIR` (default `CSVex_s3`)
- Chroma: `CHROMA_URL` (http URL)
- Weather (optional): `OPENWEATHER_API_KEY` (per‑building fetch using Building lat/lon from Neo4j)

LLM (optional):
- `USE_LLM=true`, `LLM_PROVIDER=gemini`, `GEMINI_API_KEY=...`, `LLM_TEMPERATURE`, see `server/index.js`

Graph / Vector:
- Neo4j (Graph) for topology/tenant scoping — REQUIRED
  - External (recommended, e.g. Aura over TLS):
    - `NEO4J_URI=neo4j+s://<instance>.databases.neo4j.io`
    - `NEO4J_USERNAME=neo4j`
    - `NEO4J_PASSWORD=...`
    - `NEO4J_DATABASE=neo4j`
  - Local (via docker-compose `neo4j` service):
    - Run `docker compose up` to start `neo4j:5-community`.
    - Set in `.env`: `NEO4J_URI=bolt://neo4j:7687`, `NEO4J_USERNAME=neo4j`, `NEO4J_PASSWORD` to match `NEO4J_AUTH` in compose (default `test`).
    - From host: http://localhost:7474 (Browser), `bolt://localhost:7687` (Bolt).
  - On startup, the server waits for Neo4j to be ready and runs `scripts/populate_neo4j.js` (idempotent MERGEs). To skip seeding, set `NEO4J_SKIP_POPULATE=1`.
- Chroma (Vector) for doc/profile embeddings — optional
  - Set `CHROMA_URL` based on how you run:
    - Local host: `CHROMA_URL=http://localhost:8000`
    - Docker Compose (uses the `chroma` service name): `CHROMA_URL=http://chroma:8000`
  - On startup, the server checks Chroma heartbeat and, if reachable, indexes knowledge/profiles via `scripts/index_chroma_http.py` (falls back to client indexer). To skip indexing, set `CHROMA_SKIP_INDEX=1`.

Notes:
- The app now REQUIRES Neo4j. Startup fails fast if Neo4j env is missing or the database is unreachable.
- In Docker, Node.js dependencies (including `neo4j-driver`) are installed during the image build so graph features work when env is set.
- New endpoints: `/api/status` (datastore health/metrics), `/api/graph/summary?zoneType=Cafe|Boardroom|Lab|Toilet`.
- UI: Sidebar shows datastore status and a mini graph summary (device counts per selected room type).

## Weather

- Weather is fetched per building from OpenWeather at startup if `OPENWEATHER_API_KEY` is set and stored under `CSVex_s3/weather_buildings/<building>.csv`.
- The agent’s weather tools transparently use these cached files based on the selected building.
## Local (no Docker)

You can run directly if you have Node 18+ and Python for Chroma scripts:
```bash
cp .env.example .env   # then edit Neo4j/AWS/Chroma
NODE_ENV=production PORT=3000 node server/index.js
```
For Chroma indexing from host, run: `python3 scripts/index_chroma.py` or `scripts/index_chroma_http.py` with `CHROMA_URL` set.

## Troubleshooting

- S3 mirror not found or empty:
  - Ensure `.env` has `AWS_S3_BUCKET`, `AWS_S3_REGION`, and `AWS_S3_ENABLED=1`.
  - Run `scripts/dev_controls.sh sync-s3` to populate `./CSVex_s3`.
- Weather key missing:
  - Weather fetch is skipped; app still runs.
- Empty charts:
  - Confirm your device CSVs exist in S3 and `./CSVex_s3/*.csv` after sync.
 - Chroma errors or timeouts:
   - Ensure `docker compose up chroma` is running, or run a local Chroma container exposing `8000`.
   - Set `CHROMA_URL` correctly for your mode (localhost vs docker compose).
   - The indexer downloads a SentenceTransformers model; if your environment blocks outbound network, set `CHROMA_SKIP_INDEX=1` to start the app without indexing, or pre‑bake the model into the image/mount a cache.
   - Check `/api/status` — it now reports `chroma.reachable` to confirm connectivity.
