# AVM Solutions Analytics

Production‑ready building analytics assistant with RAG + tool calling, Highcharts UI, Python ingestion, and optional OpenWeather backfill.

This project lets you query and visualize building metrics (CO2, VOC, lux, occupancy, energy, etc.) per room and over a selected time range.

## Quick Start (Docker Compose)

Prereqs: Docker + Docker Compose (v1 or v2)

1) Clone
```bash
git clone <repo-url>
cd avmsolutions
```

2) Prepare data dirs (on host)
- Create input folder (optional if you don’t have data yet): `mkdir -p CSVex`
- Create normalized output folder: `mkdir -p csvex_enriched`


3) (Optional) Weather backfill via .env
Create `.env` next to docker-compose.yml:
```
OPENWEATHER_API_KEY=your_key
OPENWEATHER_LAT=51.5072
OPENWEATHER_LON=0.1276
OPENWEATHER_BACKFILL_DAYS=5
```

4) Start
- Compose v2: `docker compose up --build`
- Compose v1: `docker-compose up --build`

On startup the container will:
- Normalize CSVs from `/data/CSVex` → `/data/CSVex_enriched` (sorted by ts, numeric typing, atomic writes)
- Backfill weather to `/data/CSVex_enriched/weather/weather.csv` if OpenWeather API is configured
- Launch the server at `http://localhost:3000`

Generate sample CSVs (optional)
- Create quick demo data directly in `CSVex`:
```
CSV_SOURCE_DIR=CSVex ROOM=cafe START=2025-10-01T00:00:00Z DAYS=2   python3 scripts/generate_sample_csvex.py
```
- Then rebuild/start: `docker compose up --build`

## Running Without CSV Data

You can run the app even if `CSVex` is empty or missing.
- The Python ingester logs a warning and continues.
- The app starts and the chat UI works; room charts will be empty until CSVs are provided.
- Weather (if configured) is still fetched and used by the agent.

To add data later:
1) Drop CSVs into `./CSVex/<room>/*.csv` (e.g., `CSVex/cafe/cafe_iaq_data.csv`, `CSVex/cafe/people_count.csv`, `CSVex/cafe/energy_clamp.csv`).
2) Restart containers to re‑ingest: `docker compose up --build` (or `docker-compose up --build`).

## Directory Layout (volumes)

- `./CSVex` → mounted read‑only at `/data/CSVex` (raw input)
- `./csvex_enriched` → mounted read‑write at `/data/CSVex_enriched` (normalized output; server reads from here)

- `./knowledge` → mounted read‑only at `/app/knowledge` (RAG notes)

## Raw vs Enriched (CSVex vs csvex_enriched)

- Purpose: the app reads normalized data so tools/charts always operate on clean timeseries.
- Source (`CSVex`): raw files as exported by sensors/tools (could have seconds vs. ms timestamps, numeric fields as strings, unsorted rows, or malformed lines).
- Target (`csvex_enriched`): normalized copy with the same columns, but with:
  - `ts` guaranteed integer epoch milliseconds (seconds are converted to ms)
  - numeric columns parsed to numbers
  - rows missing valid `ts` dropped
  - data sorted by `ts` ascending
  - atomic writes (`.tmp` then replace)
- Defaults in compose:
  - Ingestion reads from `/data/CSVex` and writes to `/data/CSVex_enriched` on startup.
  - The server reads from `CSV_DIR=/data/CSVex_enriched` to ensure consistency.
- If you delete `csvex_enriched`:
  - It is recreated at startup by the ingester, unless `SKIP_INGEST=1`.
- To read raw CSVs directly (not recommended):
  - Set `CSV_DIR=/data/CSVex` and either `SKIP_INGEST=1`, or set `CSV_TARGET_DIR=/data/CSVex` to write in place.

## Environment Variables (compose service)

- `PORT` (default `3000`): server port
- `CSV_DIR` (default `/data/CSVex_enriched`): where server reads tables
- `CSV_SOURCE_DIR` (default `/data/CSVex`): ingester input
- `CSV_TARGET_DIR` (default `/data/CSVex_enriched`): ingester output
- `SKIP_INGEST` (default `0`): set `1` to skip CSV ingestion on startup

Weather (optional):
- `OPENWEATHER_API_KEY` (required to fetch)
- `OPENWEATHER_LAT`, `OPENWEATHER_LON`
- `OPENWEATHER_BACKFILL_DAYS` (default `5`)
- `OPENWEATHER_UNITS` (default `metric`), `OPENWEATHER_LANG` (default `en`)

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

## Data Requirements

Per‑room CSVs with `ts` in epoch milliseconds. Examples:
- `CSVex/cafe/cafe_iaq_data.csv`: ts, temperature, humidity, co2, lux, pm25, pm10, voc, ...
- `CSVex/cafe/people_count.csv`: ts, people_count
- `CSVex/cafe/energy_clamp.csv`: ts, value, total_kwh, ...

The ingester will:
- Normalize `ts` (accepts seconds → ms)
- Parse numbers (ints/floats)
- Sort ascending by `ts`
- Write atomically

### Populate CSVex step‑by‑step

1) Create room folder(s):
```
mkdir -p CSVex/cafe
```

2) Create minimal CSVs (example for cafe):
```
cat > CSVex/cafe/cafe_iaq_data.csv <<EOF
ts,temperature,humidity,co2,lux,pm25,pm10,voc
1730419200000,21.4,45,620,150,4,8,120
1730422800000,21.7,46,640,200,3,6,130
EOF

cat > CSVex/cafe/people_count.csv <<EOF
ts,people_count
1730419200000,3
1730422800000,5
EOF

cat > CSVex/cafe/energy_clamp.csv <<EOF
ts,value,total_kwh
1730419200000,120,1000.2
1730422800000,140,1000.8
EOF
```

3) Rebuild and start to ingest and serve:
```
docker compose up --build   # or: docker-compose up --build
```

4) In the app:
- Select room: cafe
- Adjust the date range to cover your sample timestamps
- Ask questions like:
  - “plot co2”
  - “lux vs pressure”
  - “what’s the correlation between voc and co2”

## Local (no Docker)

```bash
# Python deps
pip install -r requirements.txt

# Normalize CSVs
CSV_SOURCE_DIR=CSVex CSV_TARGET_DIR=CSVex_enriched python3 scripts/ingest_csvex.py

# Optional weather
OPENWEATHER_API_KEY=... OPENWEATHER_LAT=... OPENWEATHER_LON=... \
  python3 scripts/fetch_weather.py

# Start server
PORT=3000 node server/index.js

Production build comment stripping
- The Dockerfile has an optional build arg to strip code comments repo‑wide at build time:
```
docker build --build-arg STRIP_COMMENTS=1 -t avmsolutions:prod .
```
This removes common comment patterns from .js, .ts, .py, .sh, .css, .html (excluding node_modules, data, CSVs).
```

## Troubleshooting

- Permission denied on `/data/CSVex_enriched`:
  - Container runs as root to avoid host bind‑mount UID issues. For non‑root, pre‑chown volumes or use named volumes.
- Weather key missing:
  - Weather fetch is skipped; app still runs.
- Empty charts:
  - Add CSVs to `CSVex/<room>` and restart to re‑ingest.
 - Chroma errors or timeouts:
   - Ensure `docker compose up chroma` is running, or run a local Chroma container exposing `8000`.
   - Set `CHROMA_URL` correctly for your mode (localhost vs docker compose).
   - The indexer downloads a SentenceTransformers model; if your environment blocks outbound network, set `CHROMA_SKIP_INDEX=1` to start the app without indexing, or pre‑bake the model into the image/mount a cache.
   - Check `/api/status` — it now reports `chroma.reachable` to confirm connectivity.
