
# Tools Reference (auto-synced)

This reference mirrors the tool list declared in `server/agent/index.js::toolDefs()`. Each description stays in lockstep with the code. Guardrails:
- Respect the server-provided scope & time window for every tool call.
- Prefer `dataRef` charts pointing at the tool that produced the data.
- When a tool returns zero rows, run `fetch_table_meta`, adjust to available data, and explain the adaptation.

| Tool | Purpose |
| --- | --- |

| `list_rooms` | List available rooms |
| `list_tables` | List available tables in a room |
| `get_schema` | Get first row keys for a table |
| `fetch_timeseries` | Fetch timeseries points as [{ts, field1, ...}] with optional paging using after_ts |
| `compare_series_cross_room` | Compare arbitrary series across rooms. Returns an object of arrays keyed by series name: {"name": [{ts, y}], ...} |
| `pair_timeseries` | Pair two fields by nearest timestamps within a time window (default ±30min). Returns [{x, y, ts1, ts2, dt}] for scatter plots |
| `compute_ratio` | Compute ratio of field1/field2 with time-window matching. Returns [{ts, ratio}]. If zero_if_denominator_zero=true, returns 0 when denominator is 0, otherwise skips that point |
| `stats` | Compute count,min,max,avg,sum |
| `get_time_for_value` | Locate the timestamp for a metric value (or its min/max when value omitted). Returns { ts, value, mode } |
| `correlate` | Pearson correlation between two fields from room tables. Uses time-window matching (default ±30min) to handle different sampling rates |
| `correlate_cross_room` | Correlate metrics between different rooms with time-window matching |
| `correlate_weather_room` | Correlate room metric with weather metric (temp, humidity, wind_speed, clouds, etc) |
| `weather_correlate` | Pearson correlation between two weather fields (temp, humidity, wind_speed, clouds, etc) scoped to current building when available |
| `building_temp_weather_corr` | Aggregate average internal temperature across rooms and correlate it with outside weather temperature. Returns scatter-ready data and correlation stats. |
| `building_temp_weather_scatter` | Alias of building_temp_weather_corr that exposes the scatter pairing for plotting internal vs outside temperatures. |
| `weather_fetch` | Fetch weather rows scoped to the current building or provided overrides |
| `latest_value` | Latest ts and value for a field in a table within range |
| `latest_per_room` | Latest value per room for a field |
| `scope_multiline` | Multi-line plotting: for a scope (tenant/building/floor/zone), returns a series per device for the given metric. Uses S3 telemetry and graph mapping. |
| `current_occupied_rooms` | Rooms currently occupied based on latest people_count > threshold (default 0) |
| `occupancy_current_total` | Sum of latest people_count across all rooms |
| `rooms_unused_since` | Rooms with no people_count > 0 in the last duration_ms |
| `busiest_day_of_week` | Day of week with highest average or sum for field |
| `weekday_weekend_comparison` | Compare average field on weekdays vs weekends |
| `energy_delta_kwh` | Delta of total_kwh over period |
| `energy_high_when_empty` | Find times when energy was high while occupancy was zero |
| `detect_spikes` | Simple z-score spike detection, returns [{ts,value,z}] |
| `histogram` | Histogram bins [{binStart,binEnd,count}] |
| `data_gaps` | Find gaps bigger than max_gap_ms between successive points |
| `distinct_values` | List distinct values up to limit |
| `weekday_exceedance` | Counts per weekday where field > threshold. Returns [{day, total, exceed, ratio}] |
| `fetch_table_meta` | Get table size, ts range, and fields |
| `dump_room` | Return raw rows per table for the room (use carefully; may be large) |
| `hour_of_day_stats` | Aggregate a field by hour-of-day across the selected window, returning [{hour, count, avg, min, max}] |
| `hourly_timeseries` | Aggregate to hourly buckets (absolute time), returns [{ts, avg}] for plotting |
| `forecast_hourly_naive` | Naive forecast: repeat last hourly value for N hours into future. Returns [{ts, forecast}] |
| `forecast_hourly_linear` | Linear trend forecast on hourly averages for N hours. Returns [{ts, forecast}] |
| `forecast_from_profile` | Forecast next N days using hour-of-day profile from historical data. Returns [{ts, forecast}] |
| `forecast_exponential_smoothing` | Simple exponential smoothing forecast |
| `forecast_moving_average` | Moving average forecast |
| `forecast_seasonal_hourly` | Seasonal naive forecast using previous weeks |
| `forecast_polyfit` | Polynomial regression forecast (degree 2) |
| `graph_rooms_by_tenant` | List rooms permitted for a tenant from Neo4j |
| `graph_devices_by_scope` | List devices within the provided scope from Neo4j |
| `graph_rooms_by_scope` | List room IDs within a building and/or floor scope (uses graph snapshot if available, else local inference) |
| `scope_list_buildings` | List buildings from graph snapshot (fallback: infer from room IDs) |
| `scope_list_floors` | List floors for a building (graph snapshot fallback: infer from room IDs) |
| `scope_list_rooms` | List rooms filtered by building and/or floor |
| `scope_list_detectors` | List detectors/sensor types present in a room based on available tables |
| `graph_zone_devices` | List devices and measured metric types for a room (from graph snapshot) |
| `vector_search_docs` | Search documentation via vector store (fallbacks to TF-IDF if unavailable) |
| `aggregate_stats_across_rooms` | Aggregate a metric across all rooms (sum, avg, min, max) over the selected window |
| `aggregate_hourly_across_rooms` | Aggregate per-hour across rooms (sum or avg) returning [{ts, y}] |
| `compare_field_across_rooms` | Compute per-room value (avg/sum/peak) for ranking and comparison |
| `scope_heatmap` | Build a room-by-time heatmap for the given metric. Returns { rooms, timestamps, data, summary } where data items map to [x=time index, y=room index, value] |
| `compare_rooms_on_metric` | Rank rooms by metric aggregate within selection (uses selectionRooms if rooms omitted). Returns [{room, value}] sorted desc. |
| `scope_daily_percentile` | Per-room daily percentile/median stats for a multi-room scope. Returns { series: { \"Room Name\": [{ts,p95,occupied_median}] }, summary: [{room,label,avg_p95,worst_p95,occupied_median}] } for charting rankings and multi-series lines. |
| `timeseries_regression_join` | Align/aggregate multiple metrics (e.g., IAQ vs dwell) and compute regression stats plus scatter-ready arrays. |
| `occupancy_people_insight` | 15-minute utilisation vs people counter analysis with heatmaps, peak windows, and regression scatter. |
| `odor_event_monitor` | Rolling z-score detection for odor sensors with per-day counts and optional entrance-flow medians. |
| `scope_schema_matrix` | Enumerate scoped devices with the metrics/tables they expose so you can build schema maps or availability matrices. |
| `grid_align_timeseries` | Align multiple metrics on a shared time grid (default 5-minute Europe/London) with forward-fill tolerance and completeness stats for heatmaps. |
| `ventilation_effectiveness` | Joins daily airExchangeRate with CO₂ percentiles per room/day, returning scatter points plus regression (slope/intercept/R²). |
| `daypart_boxplot` | Build boxplot quartiles for 08-12 / 12-16 / 16-20 windows and companion occupancy medians for dual-axis overlays. |
| `energy_iaq_linkage` | Aggregates SmallPower/Lighting meters and IAQ sensors per area, returning aligned hourly/daily datasets for dual-axis panels. |
| `device_health_summary` | Summarise IAQ device health (latest battery/RSSI/voltage, sparklines, missingness alerts) for dashboards. |
| `weekday_weekend_pm_profile` | Compare weekday vs weekend diurnal PM profiles (median per 30-min bin) and report uplift percentages. |
| `table_sample` | Return up to N rows from a room table (ts + selected fields) respecting an optional time window. Useful for table extracts. |
| `compare_metrics_in_room` | Compare multiple metrics within one room; returns [{field, value}] |
| `common_metrics_in_scope` | List metrics common to all scoped rooms (intersection of first-row keys excluding ts) |
| `correlation_matrix` | Pairwise Pearson correlation among fields within a room/table over the window |


## Chart & Answer Patterns
- **Line / area**: `fetch_timeseries`, `hourly_timeseries`, `scope_multiline`, `scope_daily_percentile` series arrays.
- **Scatter**: `pair_timeseries`, `building_temp_weather_corr`, `timeseries_regression_join.scatter`, `occupancy_people_insight.scatter`.
- **Heatmap**: `scope_heatmap`, `grid_align_timeseries`, `occupancy_people_insight.heatmap`.
- **Ranking / bar**: `compare_rooms_on_metric`, `compare_metrics_in_room`, `scope_daily_percentile.summary`, `daypart_boxplot`, `energy_high_when_empty`.
- **Forecasts**: every `forecast_*` tool returns `historical` + `forecast`; chart them separately and mention the horizon.
- **Tabular**: `table_sample`, `scope_schema_matrix`, `device_health_summary`, `graph_zone_devices` feed Markdown tables.

## Good Practices
1. Execute at least two plan steps before finalizing so traces show evidence.
2. For comparison/ranking intents, call the dedicated compare tool instead of ad-hoc math.
3. When reporting correlations, cite coefficient + sample size from `correlate*` or `correlation_matrix`.
4. Weather questions must include `weather_fetch` or `building_temp_weather_corr` for indoor vs outdoor context.
5. Keep responses concise: start with “Overview”, follow with numbered “Details” referencing the tools you ran.
