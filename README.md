# AVM Solutions Analytics

Production‑ready e-commerce analytics assistant with RAG + tool calling, Highcharts UI, Neo4j topology, Chroma vector search, and telemetry. Market signals (weather proxy) are generated synthetically for each shop owner using owner coordinates (falling back to central Manchester) so charts stay populated even offline. For demos the app now runs fully locally (no S3, no Neo4j) using the baked `data/graph_snapshot*.json` files and generated telemetry under `data/local_telemetry/`.

This project lets you query and visualize commerce KPIs (sales, conversion, traffic, marketing efficiency, etc.) per page or product over a selected time range.

## Quick Start

Prerequisites
- Node.js 18+
- Python 3.10+ (only needed for the optional Neo4j/Chroma utilities)
- Neo4j/Chroma/AWS are optional for demo mode (only required for production data sources).

1. Clone the repo  
   ```bash
   git clone <repo-url>
   cd avmsolutions
   ```
2. Local demo (no S3/Neo4j required)  
   ```bash
   npm install
   node scripts/generate_demo_meters.js   # builds local meters + telemetry
   npm start
   ```
   The UI listens on `http://localhost:3000` and serves topology from `data/graph_snapshot*.json` plus telemetry from `data/local_telemetry/`.

3. Production mode (optional, with external services)  
   ```bash
   cp .env.example .env   # fill Neo4j, Chroma, AWS if needed
   npm install
   npm run sync:s3        # optional telemetry mirror
   npm run populate:neo4j # optional graph seed
   npm run index:chroma   # optional vector index
   npm start
   ```
   To bake the Chroma indexing into the Docker image, build with `--build-arg RUN_CHROMA_INDEX=1 --build-arg CHROMA_URL=http://chroma:8000` (adjust the URL to match your vector service and ensure the build has network access to it, e.g. `docker build --network=host ...`).

### LLM Provider Chain

Set `LLM_PROVIDER_CHAIN` to try several providers in order (e.g., `gemini,openai,mock`). The server now refuses to start when `USE_LLM=true` but none of the listed providers have credentials, which prevents silent fallback to placeholder replies.

### Dev Helper Script

The repo includes a lightweight control script that mirrors the old “dev controls” workflow:

```bash
chmod +x scripts/dev.sh   # run once
./scripts/dev.sh start    # start the Node server (background)
./scripts/dev.sh status   # show PID / port usage
./scripts/dev.sh logs     # tail logs/app.log
./scripts/dev.sh stop     # stop the background server
```

Additional subcommands:

| Command | Description |
| --- | --- |
| `sync-s3` | Mirrors telemetry from S3 (`npm run sync:s3`). |
| `populate-neo4j` | Seeds Neo4j (only when you actually need to reseed). |
| `index-chroma` | Rebuilds the Chroma vector store. |
| `test` | Runs the deterministic commerce suite and the multi-shop scope tests. |
| `pipeline` | Executes the full regression pipeline (start → tests → PDF upload). |
| `docker-build` / `docker-up` / `docker-down` / `docker-logs` | Wrap Docker image/container management (volumes for `./data`, `./CSVex_s3`, and `./knowledge` are mounted automatically so traces/CSV mirrors persist on the host). |
| `clean` | Stops the app, removes the PID file, and tears down the Docker container if running. |
   
### Docker Quickstart

Use Docker when you want a reproducible environment (Node + Python + TeX) without installing toolchains locally.

1) Copy env and fill the required values (minimum for correct answers: Neo4j + Chroma; add AWS to mirror telemetry/upload PDFs):
```bash
cp .env.example .env
# Required for graph:
NEO4J_URI=bolt://neo4j:7687         # or your Aura URI (neo4j+s://...)
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=testtest             # match NEO4J_AUTH in compose if local
# Optional but recommended for vector search:
CHROMA_URL=http://chroma:8000
# Optional for live telemetry/report uploads:
AWS_S3_ENABLED=1
AWS_S3_BUCKET=your-bucket
AWS_S3_REGION=eu-west-1
```

2) Build and start the stack (app + Neo4j + Chroma):
```bash
docker compose up --build
```
   - App: http://localhost:3000  
   - Neo4j: bolt://localhost:7687 (Browser: http://localhost:7474)  
   - Chroma: http://localhost:8000

3) Populate data for “perfect performance” (from the host or inside the app container):
```bash
npm run sync:s3         # pulls telemetry to ./CSVex_s3 (requires AWS env)
npm run populate:neo4j  # seeds graph topology (idempotent)
npm run index:chroma    # builds/update embeddings for knowledge + profiles
```
These scripts are also wrapped by `./scripts/dev.sh` (`sync-s3`, `populate-neo4j`, `index-chroma`).

4) Run end-to-end regression/pipeline (optional, heavier):
```bash
npm run pipeline:regression   # start app -> regression suites -> PDF traces upload
```
If you skip AWS, the bundled CSVs under `CSVex_s3/` still populate dashboards; just omit `npm run sync:s3`.

### Running Without External Data Sources

If you do **not** have access to production S3 buckets or wish to run the UI against the sample telemetry already checked into the repo:

1. Leave the AWS variables unset (or set `AWS_S3_ENABLED=0`). The server falls back to the CSVs under `CSVex_s3/`.
2. Populate minimal Neo4j data by running `node scripts/populate_neo4j.js` (dev controls handle this automatically).
3. Synthetic market signals (weather proxy) are generated automatically for every shop owner between **2024‑09‑01** and **2024‑10‑31** and stored in both `CSVex_s3/weather_buildings/` and `data/weather_buildings/`. Owners without coordinates fall back to a Manchester centroid (`53.4808`, `-2.2426`).  
   - To customise the backfill window, set `WEATHER_BACKFILL_START` / `WEATHER_BACKFILL_END` in `.env` (hourly cadence).  
   - To change the fallback location or disable synthetic forcing, adjust `WEATHER_DEFAULT_LAT` / `WEATHER_DEFAULT_LON` / `WEATHER_USE_SYNTHETIC`.
4. Start the server: `NODE_ENV=production node server/index.js`.

With those defaults the UI will render dashboards using the bundled telemetry and the freshly cached weather data; no S3 sync is required.

### Automated Test Pipeline

Run the full validation pipeline (start the app → wait for warmup → execute scripted regression suites → render LaTeX/PDF reports → push PDFs to S3) with:
```bash
npm run pipeline:regression
```
It runs the deterministic commerce regression suite (`scripts/test_scope_runs.js`). After each suite the pipeline captures new traces, generates a LaTeX report, compiles it to PDF, and uploads the PDF to `tests/<label>/` within your S3 prefix. The Node server is left running for manual follow-up.

Requirements:
- `pdflatex` available in `PATH` (TeX Live or similar) for PDF generation.
- AWS credentials in the environment (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, optional `AWS_SESSION_TOKEN`).

### Retrieval regression

Grounding can silently drift when knowledge files or telemetry snapshots change. A lightweight guard is bundled as:

```bash
npm run test:rag
```

It rebuilds the on-disk RAG index (without starting the server) and verifies that canonical questions such as KPI definitions, conversion benchmarks, and RAG best practices still surface the correct knowledge chunks. Failures exit non‑zero with the offending question so you can refresh embeddings or inspect the docs before deploying.
- `AWS_S3_BUCKET` (and optional `AWS_S3_REGION` / `AWS_S3_PREFIX`). PDFs are pushed to the same bucket that hosts the product telemetry mirror.

### Connector Health & Evaluation Harness

- `/api/health` now returns the connector snapshots (Neo4j, telemetry cache, weather cache, Chroma) alongside the active LLM provider chain, so you can spot degraded data planes before running a suite.
- `/api/connectors` (or `/api/connectors?force=1`) exposes the same connector snapshots without the rest of the health payload—handy for dashboards.
- `npm run eval:traces` walks `data/traces/`, flags missing plans/tool calls/overview blocks, and drops a JSON report under `data/evals/`. Use `npm run eval:traces -- --dir data/traces --outdir data/evals --strict` to fail on fallback answers too.

### Targeted Regression Suites

When you just want to replay the scripted chat suites without the warmup/PDF/upload workflow:

1. Start the app and leave it running (`npm start`). The suites call `/api/chat`, so the server must already be listening on port `3000`.
2. In a new terminal, run:
   ```bash
   npm run test:scope      # scripts/test_scope_runs.js
   ```

`npm run test:scope` focuses on scoped commerce scenarios (owner/shop/page/product), KPI summaries, anomaly detection, forecasting, and correlation checks so regressions show up instantly.  

The script writes its JSON reports to `data/tests/` and each request saves a trace under `data/traces/` for manual inspection.

### Requirements Summary

| Service / Tool | Required | Notes |
|----------------|----------|-------|
| Neo4j          | ✅        | Used for topology, owner groups, scopes. Local Aura or Docker deployment works. |
| OpenWeather    | ⚠️ Optional | Currently unused — synthetic backfill covers Sep–Oct offline. Provide a key only if you re-enable live fetches. |
| AWS S3         | ⚠️ Optional | Only necessary when mirroring live telemetry. Sample CSVs in `CSVex_s3/` are enough for local development. |
| Chroma         | ⚠️ Optional | Required for vector search. Skip by omitting `CHROMA_URL` or setting `CHROMA_SKIP_INDEX=1`. |
| Python reranker| ⚠️ Optional | Needed only if `RERANK_ENABLED=1`. Install Python 3.9+ (or use the Docker image) and set `RERANK_PYTHON_BIN` if `python3` isn’t on `PATH`. |

## Architecture at a Glance

1. **Startup pipeline**
   - The Node server verifies Neo4j connectivity, optionally seeds demo data, and emits topology snapshots under `data/graph_snapshot*.json`.  
     These snapshots serve both the UI (fast load, offline fallback) and the agent (product/page lookup without hitting Neo4j for every question).
  - At startup the server synthesises hourly market signals (weather proxy) for every shop owner between `WEATHER_BACKFILL_START` and `WEATHER_BACKFILL_END` (defaults: 2024‑09‑01 → 2024‑10‑31), writing the results to both `CSVex_s3/weather_buildings/` and `data/weather_buildings/`. Existing caches are reused, missing hours are regenerated, and owners without coordinates fall back to Manchester defaults.

2. **Local telemetry mirror**
  - Product CSVs live in `CSVex_s3/`. When AWS variables are supplied, `npm run sync:s3` mirrors production S3 into this directory; otherwise, the bundled CSVs keep dashboards functional in offline mode.
   - Product IDs are normalised so scope selections (owner/shop/page) consistently locate the correct telemetry file.

3. **Agent workflow**
   - The agent combines retrieval (markdown knowledge + schema hints) with tool calling (`fetch_timeseries`, `histogram`, `compare_series_cross_room`, `correlate_*`, `weather_fetch`, etc.).
   - Before plotting it binds the active scope to the right product/table/field, executes the necessary tools, and returns a themed Highcharts config plus a descriptive narrative (min/avg/max, correlations, forecasts). Correlation tools align mismatched timestamps; market signal charts use the cached/backfilled data.
   - If telemetry is sparse, the agent still produces a textual summary so users never receive an empty response.

## Telemetry via S3

- The server reads product timeseries from a local mirror under `./CSVex_s3` (mounted into the container), populated by `scripts/s3_sync_telemetry.js` using your AWS credentials.
- File format: one CSV per product ID, named `<productId>.csv`, with `ts` as epoch milliseconds and one or more numeric fields.
- The app enumerates products by listing `./CSVex_s3/*.csv` and maps them to graph Products in Neo4j by ID, cloud_id, deviceId, or name (best‑effort normalization).

## Environment Variables

- `PORT` (default `3000`): server port
- Neo4j (required): `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD`, `NEO4J_DATABASE`
- S3 telemetry: `AWS_S3_ENABLED=1`, `AWS_S3_BUCKET`, `AWS_S3_REGION`, optional `AWS_S3_PREFIX`, `S3_LOCAL_DIR` (default `CSVex_s3`)
- Chroma: `CHROMA_URL` (http URL)
- Market signals (weather proxy): `WEATHER_USE_SYNTHETIC` (default `1`), `WEATHER_BACKFILL_START`, `WEATHER_BACKFILL_END` (defaults: `2024-09-01` to `2024-10-31`), `WEATHER_DEFAULT_LAT`, `WEATHER_DEFAULT_LON`
- (Legacy) `OPENWEATHER_API_KEY` is currently ignored unless live fetching is re-enabled.
- Reranker (optional): `RERANK_ENABLED=1|0`, `RERANK_TOP` (default `20`), `RERANK_PYTHON_BIN` to point at your Python interpreter on Windows if `python3` isn’t available.

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
  - On startup, the server checks the Chroma heartbeat and, if reachable, runs `scripts/index_chroma.py` to refresh knowledge/profile embeddings (set `CHROMA_SKIP_INDEX=1` to skip). The script relies on SentenceTransformers; pre-download models if your environment blocks outbound network calls.

Notes:
- The app now REQUIRES Neo4j. Startup fails fast if Neo4j env is missing or the database is unreachable.
- In Docker, Node.js dependencies (including `neo4j-driver`) are installed during the image build so graph features work when env is set.
- New endpoints: `/api/status` (datastore health/KPI health), `/api/graph/summary?pageType=Home|Category|Checkout|Support` (page type is legacy `zoneType`).
- UI: Sidebar shows datastore status and a mini graph summary (product counts per selected page type).

## Market Signals (Weather Proxy)

- Hourly market signals (weather proxy) are synthesised for every shop owner between `WEATHER_BACKFILL_START` and `WEATHER_BACKFILL_END` (defaults: 2024‑09‑01 → 2024‑10‑31) and saved under `CSVex_s3/weather_buildings/<owner>.csv` plus `data/weather_buildings/<owner>.csv`.
- Owners missing coordinates fall back to `WEATHER_DEFAULT_LAT` / `WEATHER_DEFAULT_LON` (defaults to Manchester city centre).
- Startup inspects cached files: missing hours are regenerated, existing coverage is reused when `WEATHER_USE_SYNTHETIC=0`, and when `WEATHER_USE_SYNTHETIC=1` the generator refreshes the whole range to guarantee a dense hourly series.
- The agent’s market signal tools transparently use these cached files based on the selected shop owner.
## Local (no Docker)

You can run directly if you have Node 18+ and Python for Chroma scripts:
```bash
cp .env.example .env   # then edit Neo4j/AWS/Chroma
NODE_ENV=production PORT=3000 node server/index.js
```
For Chroma indexing from host, run: `npm run index:chroma` with `CHROMA_URL` set.

## Troubleshooting

- S3 mirror not found or empty:
  - Ensure `.env` has `AWS_S3_BUCKET`, `AWS_S3_REGION`, and `AWS_S3_ENABLED=1`.
  - Run `npm run sync:s3` to populate `./CSVex_s3`.
- Weather key missing:
  - Weather fetch is skipped; app still runs.
- Empty charts:
- Confirm your product CSVs exist in S3 and `./CSVex_s3/*.csv` after sync.
 - Chroma errors or timeouts:
   - Ensure `docker compose up chroma` is running, or run a local Chroma container exposing `8000`.
   - Set `CHROMA_URL` correctly for your mode (localhost vs docker compose).
   - The indexer downloads a SentenceTransformers model; if your environment blocks outbound network, set `CHROMA_SKIP_INDEX=1` to start the app without indexing, or pre‑bake the model into the image/mount a cache.
   - Check `/api/status` — it now reports `chroma.reachable` to confirm connectivity.
