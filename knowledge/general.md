# AVM Solutions Dataset Overview

Use this document as the high-level reference when answering questions about the AVM Solutions deployment. It replaces legacy facilities-maintenance text.

## Site Topology
- **Tenant:** AVM Solutions.
- **Primary building:** Bolton (two floors) with collaboration zones such as Standup, Huddle, Workshop, Sitdown, Comms, Cafe, Brainstorm, Lounge, Booths, Reception, etc.
- Always honour the selection supplied by the UI (tenant → building → floor → zone/device). Do not invent additional rooms.

## Data Sources
- **Telemetry CSVs:** Mirrored locally under `CSVex_s3/` via `npm run sync:s3`. File names are device cloud IDs (e.g., `b19aae20-479c-11f0-bf13-bf19a72566f6.csv`).
  - Compulsory env vars: `AWS_S3_BUCKET`, `AWS_S3_REGION`, `AWS_S3_PREFIX`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_LOCAL_DIR`.
  - Successful sync populates both `CSVex_s3/` and cached graph snapshots under `data/graph_snapshot*.json`.
- **Graph snapshots:** `data/graph_snapshot.json` plus tenant-specific snapshots drive scope/structure tools (`graph_rooms_by_scope`, `graph_zone_devices`, etc.).
- **Knowledge base:** Markdown files in `knowledge/` indexed into Chroma via `scripts/index_chroma.py`.
- **Weather:** Synthetic hourly weather per building in `CSVex_s3/weather_buildings/<building>.csv`, surfaced through `weather_fetch`.

## Telemetry Coverage (Bolton)
- Most IAQ, energy, and occupancy feeds run **2024-08-25 → 2025-10-24** (UTC ms).
- Café people counter (`ab5fb660-872d-11f0-a19e-8f874a1c01d3`) stops after **2025-09-08** – use September windows for people-count charts.
- Device quirks:
  - Standup IAQ exposes `concentration` (CO₂) rather than `co2`.
  - Occupancy sensors emit boolean `occupancy` / `is_used`; treat them as 0/1 when averaging.
  - Energy meter `8e00d400…` exposes cumulative `total_kwh` and instantaneous `value`.

## Pipeline Expectations
- **Sync telemetry:** `npm run sync:s3`.
- **Populate Neo4j:** `npm run populate:neo4j` (idempotent MERGEs).
- **Index knowledge:** `npm run index:chroma` once Chroma is reachable (skip with `CHROMA_SKIP_INDEX=1`).
- **Regression pipeline:** `npm run pipeline:regression` runs deterministic building suites plus the multi-building scope tests, captures traces, renders LaTeX/PDF reports, and uploads them to S3.
- **Report uploads:** `npm run upload:reports` pushes PDFs under `data/tests/` with SigV4 auth.

## Answering Guidance
- Honour the provided time window; if empty, call `fetch_table_meta` and adapt to the nearest usable range, noting the change.
- When users request charts:
  - Use `fetch_timeseries`, `hourly_timeseries`, or `daily_avg` for single-series trends.
  - Use `compare_series_cross_room` for cross-room trends, `compare_rooms_on_metric` / `compare_metrics_in_room` for rankings/compositions, `scope_heatmap` for multi-room heatmaps, and `correlation_matrix` or `pair_timeseries` for correlations.
  - Always return Highcharts JSON with `series[].dataRef` pointing at executed tool names; avoid embedding raw arrays except for very small windows.
- Mention data availability, gaps, or adaptations in the text response.

## Troubleshooting
- “No data” errors usually mean `CSVex_s3/` is empty or the requested range is outside the CSV coverage.
- Chroma indexing uses `scripts/index_chroma.py`; verify `CHROMA_URL` and ensure the service is reachable before invoking.
- Neo4j Aura is the authoritative graph; keep `NEO4J_SKIP_POPULATE=1` when running against production datasets to avoid accidental overwrites.

## Metric Notes
- **PIR / PIT (Passive Infrared):** Binary occupancy/motion flags emitted by passive infrared sensors. A value of 0 means no motion; any positive pulse indicates a person moved inside the sensor’s “view cone.” Facility systems use PIR to drive lights/HVAC setbacks or to corroborate people-count data. The `pit` field is the “Passive Infrared Temperature” channel shipped alongside IAQ payloads—despite the name it is the same 0/1 motion pulse as `pir`, not a temperature reading.
- **CO₂ (Carbon Dioxide):** Directly proportional to human respiration indoors. Rising ppm indicates either increasing occupancy or insufficient ventilation; ASHRAE targets keep indoor CO₂ within ~600 ppm above outdoor baseline.
