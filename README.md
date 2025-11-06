 # AVM Solutions Analytics


  ---

  ## Quick Start (dev controls first)

  The project is designed to be run via the helper script `scripts/dev_controls.sh`. It wraps Docker and orchestration
  chores so you don’t have to handle them manually.

  ### Prerequisites

  | Requirement | Notes |
  | --- | --- |
  | Node.js 18+ | Needed for the server/scripts (or use Docker). |
  | Python 3.10+ | Required for Chroma tooling / reporting scripts. |
  | Neo4j | Local Docker or hosted (Aura). Mandatory for topology & scoping. |
  | OpenWeather API key | Recommended. Enables weather backfill & charts. |
  | AWS S3 credentials | Optional. Only needed if you want to mirror production telemetry. |
  | Chroma vector store | Optional. Used for semantic retrieval / agent memory. |

  ### 1. Clone
  ```bash
  git clone <repo-url>
  cd avmsolutions

  ### 2. Configure .env

  # Neo4j (required)
  NEO4J_URI=bolt://localhost:7687
  NEO4J_USERNAME=neo4j
  NEO4J_PASSWORD=test
  NEO4J_DATABASE=neo4j

  # Optional telemetry mirror
  AWS_S3_ENABLED=0

  # Weather (recommended)
  OPENWEATHER_API_KEY=<your key>
  WEATHER_BACKFILL_START=2025-09-01
  WEATHER_BACKFILL_END=2025-10-31

  # Chroma (optional)
  # CHROMA_URL=http://localhost:8000

  ### 3. Start everything
  scripts/dev_controls.sh build
  scripts/dev_controls.sh start
  scripts/dev_controls.sh logs 

  This command:

  - Ensures Neo4j is reachable, optionally seeds demo data.
  - Mirrors telemetry (if S3 enabled) into CSVex_s3/.
  - Backfills & caches historical weather for every building between WEATHER_BACKFILL_START/END. (i used September 1st 2025 - October 30th 2025)
  - Indexes knowledge into Chroma (if configured).
  - Launches the Node server on http://localhost:3000.

  The UI is immediately ready to use.

  ### Dev controls cheat sheet

  | Command | Purpose |
  | --- | --- |
  | start | Full bootstrap (Neo4j seed, weather backfill, telemetry sync, server run). |
  | stop | Stops all containers/processes started by the script. |
  | restart | Rebuilds the image, refreshes data, restarts the stack. |
  | sync-s3 | Refreshes the local telemetry mirror in CSVex_s3/. |
  | ensure-chroma | Launches the Chroma container standalone. |
  | status | Calls /api/status to check datastore health. |
  | logs / chroma-logs | Tail server or Chroma logs. |
  | graph-counts | Summarises node/link counts from /api/graph/full. |
  | rooms | Lists rooms via /api/rooms. |
  | clean | Stops containers and clears port stubs (see data/dev_ports.log). |

  To regenerate graph snapshots manually:

  curl -X POST http://localhost:3000/api/graph/snapshot
  # or tenant-specific
  curl -X POST -d '{"tenant":"Acme"}' http://localhost:3000/api/graph/snapshot

  ———

  ## Architecture at a glance

  1. Startup pipeline
      - Verifies Neo4j connectivity, seeds demo data, emits topology snapshots (data/graph_snapshot*.json). These
        snapshots let the UI/agent stay responsive even if Neo4j is briefly unavailable.
      - Backfills weather for every building if OPENWEATHER_API_KEY is configured and writes the CSVs to both host
        (data/weather_buildings/) and container (CSVex_s3/weather_buildings/).
  2. Local telemetry mirror
      - CSVex_s3/ is the canonical source for telemetry. When S3 sync is enabled, dev_controls.sh sync-s3 mirrors
        production data; otherwise, the bundled CSVs keep the app functional.
      - Device IDs are normalised so zone/floor/tenant scopes resolve to the correct CSV automatically.
  3. Agent workflow
      - Combines document retrieval with tool calling: fetch_timeseries, histogram, compare_series_cross_room,
        correlate_*, weather_fetch, etc.
      - Before plotting, the agent resolves the active scope to the specific room/table/field, executes the tool, and
        returns a themed Highcharts configuration plus a descriptive narrative (min/avg/max, correlations, forecasts).
        Correlation helpers align mismatched sampling rates; weather plots use the cached/backfilled datasets.
      - If telemetry is sparse, the agent still emits a textual summary so you’re never left with a blank panel.

  ———

  ## Environment variables

  | Variable | Description |
  | --- | --- |
  | PORT | Server port (default 3000). |
  | NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD, NEO4J_DATABASE | Neo4j connection (required). |
  | AWS_S3_ENABLED, AWS_S3_BUCKET, AWS_S3_REGION, AWS_S3_PREFIX, S3_LOCAL_DIR | Telemetry mirror settings (optional). |
  | OPENWEATHER_API_KEY | Needed for weather caching/backfill. |
  | WEATHER_BACKFILL_START, WEATHER_BACKFILL_END | Backfill window (defaults 2025-09-01 → 2025-10-31). |
  | CHROMA_URL, CHROMA_SKIP_INDEX, CHROMA_COLLECTION | Vector store configuration (optional). |
  | USE_LLM, LLM_PROVIDER, GEMINI_API_KEY, LLM_TEMPERATURE | LLM-driven agent settings (optional). |
  | WEATHER_FETCH_ALL_BUILDINGS | Set 0 to skip prefetching every building’s weather. |

  ———

  ## Telemetry & weather storage

  - Telemetry CSVs live in CSVex_s3/. Each file is <deviceId>.csv with epoch-millisecond timestamps and numeric fields.
  - Weather CSVs are stored in both CSVex_s3/weather_buildings/ and data/weather_buildings/ so tooling and containers
    stay in sync.
  - Graph snapshots (cache of nodes/links per tenant) reside under data/graph_snapshot*.json.

  ———

  ## Running directly (without dev controls)

  If you prefer a manual launch:

  npm install
  NODE_ENV=production node server/index.js

  For Chroma indexing outside Docker:

  python3 scripts/index_chroma.py
  # or HTTP-based:
  python3 scripts/index_chroma_http.py

  Make sure CHROMA_URL is set in both cases.

  ———

  ## Testing & reporting

  1. Generate scope-driven test scenarios (ensure the server is running):
     node scripts/run_avm_bolton_tests.js (tests for more tenants and scopes are coming)
     Results saved under data/tests/.
     Results saved under data/tests/.
  2. Convert traces into a LaTeX/PDF report:

     python3 scripts/traces_to_latex.py --traces-dir data/traces --output data/traces_report.tex
     pdflatex -interaction=nonstopmode -halt-on-error data/traces_report.tex

     PDF lives at data/traces_report.pdf.

  ———

  ## Strengths & areas to improve

  - Strengths
      - Scope-aware data binding: charts always pull the right room/table/field automatically.
      - Highcharts theming & tool coverage: line, column, scatter, heatmap, histogram, forecast, correlation, weather
        plots.
      - Weather backfill keeps dashboards working without live integrations.
      - Trace-to-PDF scripting for audits and manual QA.
  - Known gaps
      - Neo4j and weather still depend on external services (mock layers would strengthen CI).
      - Graph snapshot churn can make diffs noisy; consider trimming the snapshot format for tests.
      - Some scripts assume outbound network (OpenWeather, S3). Without it, fallbacks apply but manual validation is
        harder.

  ———

  ## Troubleshooting

  - Telemetry missing: ensure CSVex_s3/<device>.csv exists or run dev_controls.sh sync-s3.
  - Weather missing: check OPENWEATHER_API_KEY; files appear under CSVex_s3/weather_buildings.
  - Chroma errors: confirm CHROMA_URL points to a reachable host; skip indexing with CHROMA_SKIP_INDEX=1 if outbound
    downloads are blocked.
  - Neo4j connection issues: verify NEO4J_* variables and run scripts/dev_controls.sh status to check /api/status.

  ———
