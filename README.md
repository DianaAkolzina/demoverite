# AVM Solutions Analytics

Production‑ready building analytics assistant with RAG + tool calling, Highcharts UI, Neo4j topology, Chroma vector search, and S3‑backed telemetry. Weather is fetched per building from OpenWeather using coordinates in Neo4j.

This project lets you query and visualize building metrics (CO2, VOC, lux, occupancy, energy, etc.) per room and over a selected time range.

## Quick Start (Dev Controls)

Prereqs:  
- Node.js 18+ (or Docker)  
- Python 3.10+ (for Chroma/utility scripts)  
- Neo4j database (local or hosted)  
- AWS credentials (optional, only if syncing telemetry from S3)  
- OpenWeather API key (optional but recommended — enables automatic weather backfill)

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
Snapshots: the server writes graph snapshots to `./data/graph_snapshot.json` and per-tenant files `./data/graph_snapshot.<tenant>.json` (these are volume-mounted from `/app/data`).

### Dev Controls Cheat-Sheet

`scripts/dev_controls.sh` is the preferred entrypoint; use it instead of manually composing Docker services. Built-in subcommands:

| Command | Purpose |
| --- | --- |
| `start` | Ensures Chroma (optional), seeds Neo4j, backfills weather, syncs telemetry (if enabled), and starts the app. |
| `stop` | Stops the running containers/processes. |
| `restart` | Rebuilds the image, refreshes telemetry/weather, restarts the app. |
| `sync-s3` | Mirrors the configured S3 bucket into `CSVex_s3/`. |
| `status` | Calls `/api/status` to display datastore health. |
| `logs` | Tails container/app logs. |
| `chroma-logs` | Tails Chroma logs (if running). |
| `ensure-chroma` | Launches the Chroma container in isolation. |
| `graph-counts` | Summarises nodes/links via `/api/graph/full`. |
| `rooms` | Lists rooms via `/api/rooms`. |
| `clean` | Stops containers, removes them, and clears port-forward stubs (as recorded in `data/dev_ports.log`). |

For quick graph snapshot refresh during development:
```bash
curl -X POST http://localhost:3000/api/graph/snapshot
# or curl -X POST -d '{"tenant":"Acme"}' http://localhost:3000/api/graph/snapshot
```

### Running Without External Data Sources

If you do **not** have access to production S3 buckets or wish to run the UI against the sample telemetry already checked into the repo:

1. Leave the AWS variables unset (or set `AWS_S3_ENABLED=0`). The server falls back to the CSVs under `CSVex_s3/`.
2. Populate minimal Neo4j data by running `node scripts/populate_neo4j.js` (dev controls handle this automatically).
3. Provide any OpenWeather API key — on startup the server backfills historical weather for every building between **2024‑09‑01** and **2024‑10‑31** (skipping the API call if that window is already cached) and stores it in both `CSVex_s3/weather_buildings/` and `data/weather_buildings/`.  
   - To customise the backfill window, set `WEATHER_BACKFILL_START` / `WEATHER_BACKFILL_END` in `.env`.
4. Start the server: `NODE_ENV=production node server/index.js`.

With those defaults the UI will render dashboards using the bundled telemetry and the freshly cached weather data; no S3 sync is required.

### Requirements Summary

| Service / Tool | Required | Notes |
|----------------|----------|-------|
| Neo4j          | ✅        | Used for topology, tenants, scopes. Local Aura or Docker deployment works. |
| OpenWeather    | ⚠️ Recommended | Needed to prefetch / backfill weather per building. Without it, weather features are disabled. |
| AWS S3         | ⚠️ Optional | Only necessary when mirroring live telemetry. Sample CSVs in `CSVex_s3/` are enough for local development. |
| Chroma         | ⚠️ Optional | Required for vector search. Skip by omitting `CHROMA_URL` or setting `CHROMA_SKIP_INDEX=1`. |

## Architecture at a Glance

1. **Startup pipeline**
   - The Node server verifies Neo4j connectivity, optionally seeds demo data, and emits topology snapshots under `data/graph_snapshot*.json`.  
     These snapshots serve both the UI (fast load, offline fallback) and the agent (device/zone lookup without hitting Neo4j for every question).
  - When an OpenWeather API key is present the server backfills every building between `WEATHER_BACKFILL_START` and `WEATHER_BACKFILL_END` (defaults: 2024‑09‑01 → 2024‑10‑31), writing the results to both `CSVex_s3/weather_buildings/` and `data/weather_buildings/`. If the cached files already span that range, startup reuses them. Any residual gaps after ~4 s of fetching are bridged with flagged synthetic rows so tools never operate on empty ranges.

2. **Local telemetry mirror**
   - Device CSVs live in `CSVex_s3/`. When AWS variables are supplied, `scripts/dev_controls.sh sync-s3` mirrors production S3 into this directory; otherwise, the bundled CSVs keep dashboards functional in offline mode.
   - Device IDs are normalised so scope selections (building/floor/zone) consistently locate the correct telemetry file.

3. **Agent workflow**
   - The agent combines retrieval (markdown knowledge + schema hints) with tool calling (`fetch_timeseries`, `histogram`, `compare_series_cross_room`, `correlate_*`, `weather_fetch`, etc.).
   - Before plotting it binds the active scope to the right room/table/field, executes the necessary tools, and returns a themed Highcharts config plus a descriptive narrative (min/avg/max, correlations, forecasts). Correlation tools align mismatched timestamps; weather charts use the cached/backfilled data.
   - If telemetry is sparse, the agent still produces a textual summary so users never receive an empty response.

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
- Weather historical window: `WEATHER_BACKFILL_START`, `WEATHER_BACKFILL_END` (defaults: `2024-09-01` to `2024-10-31`)

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
  - Dev controls now default to a lightweight hashed embedding function to avoid long installs during `docker build`. If you prefer high-quality `sentence-transformers` embeddings, set `CHROMA_USE_SENTENCE_TRANSFORMER=1` and ensure the runtime image includes the dependency.
  - Running `scripts/dev_controls.sh stop|clean` now records port snapshots under `data/dev_ports.log` and force-closes listeners on `3000`, `8000`, `7474`, and `7687` so repeated builds don’t leak Docker proxies.

Notes:
- The app now REQUIRES Neo4j. Startup fails fast if Neo4j env is missing or the database is unreachable.
- In Docker, Node.js dependencies (including `neo4j-driver`) are installed during the image build so graph features work when env is set.
- New endpoints: `/api/status` (datastore health/metrics), `/api/graph/summary?zoneType=Cafe|Boardroom|Lab|Toilet`.
- UI: Sidebar shows datastore status and a mini graph summary (device counts per selected room type).

## Weather

- Weather is fetched per building from OpenWeather at startup if `OPENWEATHER_API_KEY` is set and stored under `CSVex_s3/weather_buildings/<building>.csv`.
- Cached weather files are inspected on each startup; if they already span `WEATHER_BACKFILL_START` → `WEATHER_BACKFILL_END` the API is skipped. Otherwise, the fetcher retries each historical day up to three times, stops after ~4 s, and generates synthetic hourly samples for any remaining gaps so charts remain continuous.
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
