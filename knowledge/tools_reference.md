
# Tools Reference (auto-synced)

This reference mirrors the tool list declared in `server/agent/index.js::toolDefs()`. Each description stays in lockstep with the code. Guardrails:
- Respect the server-provided scope & time window for every tool call.
- Prefer `dataRef` charts pointing at the tool that produced the data.
- When a tool returns zero rows, run `fetch_table_meta`, adjust to available data, and explain the adaptation.

| Tool | Purpose |
| --- | --- |

| `list_rooms` | List available products/devices in the current scope |
| `list_tables` | List available tables for a product/device |
| `get_schema` | Get first row keys for a table |
| `fetch_timeseries` | Fetch timeseries points as [{ts, field1, ...}] with optional paging using after_ts |
| `compare_series_cross_room` | Compare arbitrary series across products/pages. Returns an object of arrays keyed by series name: {"name": [{ts, y}], ...} |
| `pair_timeseries` | Pair two fields by nearest timestamps within a time window (default ±30min). Returns [{x, y, ts1, ts2, dt}] for scatter plots |
| `compute_ratio` | Compute ratio of field1/field2 with time-window matching. Returns [{ts, ratio}]. If zero_if_denominator_zero=true, returns 0 when denominator is 0, otherwise skips that point |
| `stats` | Compute count,min,max,avg,sum |
| `get_time_for_value` | Locate the timestamp for a metric value (or its min/max when value omitted). Returns { ts, value, mode } |
| `correlate` | Pearson correlation between two fields from product tables. Uses time-window matching (default ±30min) to handle different sampling rates |
| `correlate_cross_room` | Correlate metrics between different products/pages with time-window matching |
| `correlate_weather_room` | Correlate product metric with external signal metric (temp, humidity, wind_speed, clouds, etc) |
| `weather_correlate` | Pearson correlation between two external signal fields scoped to the current shop owner when available |
| `building_temp_weather_corr` | Legacy name; correlates scoped metrics with external temperature for scatter analysis |
| `building_temp_weather_scatter` | Alias of building_temp_weather_corr that exposes scatter pairs for external signal analysis. |
| `weather_fetch` | Fetch external signal rows scoped to the current shop owner or provided overrides |
| `latest_value` | Latest ts and value for a field in a table within range |
| `latest_per_room` | Latest value per product/page for a field |
| `scope_multiline` | Multi-line plotting: for a scope (owner/shop/page), returns a series per product/device for the given metric. Uses local telemetry and snapshot mapping. |
| `current_occupied_rooms` | Not used in the commerce demo |
| `occupancy_current_total` | Not used in the commerce demo |
| `rooms_unused_since` | Not used in the commerce demo |
| `busiest_day_of_week` | Day of week with highest average or sum for field |
| `weekday_weekend_comparison` | Compare average field on weekdays vs weekends |
| `energy_delta_kwh` | Not used in the commerce demo |
| `energy_high_when_empty` | Not used in the commerce demo |
| `detect_spikes` | Simple z-score spike detection, returns [{ts,value,z}] |
| `histogram` | Histogram bins [{binStart,binEnd,count}] |
| `data_gaps` | Find gaps bigger than max_gap_ms between successive points |
| `distinct_values` | List distinct values up to limit |
| `weekday_exceedance` | Counts per weekday where field > threshold. Returns [{day, total, exceed, ratio}] |
| `fetch_table_meta` | Get table size, ts range, and fields |
| `dump_room` | Return raw rows per table for the product/device (use carefully; may be large) |
| `hour_of_day_stats` | Aggregate a field by hour-of-day across the selected window, returning [{hour, count, avg, min, max}] |
| `hourly_timeseries` | Aggregate to hourly buckets (absolute time), returns [{ts, avg}] for plotting |
| `forecast_hourly_naive` | Naive forecast: repeat last hourly value for N hours into future. Returns [{ts, forecast}] |
| `forecast_hourly_linear` | Linear trend forecast on hourly averages for N hours. Returns [{ts, forecast}] |
| `forecast_from_profile` | Forecast next N days using hour-of-day profile from historical data. Returns [{ts, forecast}] |
| `forecast_exponential_smoothing` | Simple exponential smoothing forecast |
| `forecast_moving_average` | Moving average forecast |
| `forecast_seasonal_hourly` | Seasonal naive forecast using previous weeks |
| `forecast_polyfit` | Polynomial regression forecast (degree 2) |
| `graph_rooms_by_tenant` | List products/devices permitted for a tenant from the local snapshot |
| `graph_devices_by_scope` | List devices within the provided scope from the local snapshot |
| `graph_rooms_by_scope` | List product/page IDs within an owner/shop scope (uses graph snapshot if available, else local inference) |
| `scope_list_buildings` | List shop owners from the snapshot |
| `scope_list_floors` | List shops for a shop owner from the snapshot |
| `scope_list_rooms` | List pages filtered by shop owner and/or shop |
| `scope_list_detectors` | List available metric tables for a product/device |
| `graph_zone_devices` | List products and metrics for a page (from graph snapshot) |
| `vector_search_docs` | Search documentation via vector store (fallbacks to TF-IDF if unavailable) |
| `aggregate_stats_across_rooms` | Aggregate a metric across all products (sum, avg, min, max) over the selected window |
| `aggregate_hourly_across_rooms` | Aggregate per-hour across products (sum or avg) returning [{ts, y}] |
| `compare_field_across_rooms` | Compute per-product value (avg/sum/peak) for ranking and comparison |
| `scope_heatmap` | Build a product-by-time heatmap for the given metric. Returns { items, timestamps, data, summary } where data items map to [x=time index, y=item index, value] |
| `compare_rooms_on_metric` | Rank products by metric aggregate within selection (uses selectionRooms if rooms omitted). Returns [{room, value}] sorted desc (room = product id). |
| `scope_daily_percentile` | Per-product daily percentile/median stats for a multi-product scope. Returns { series: { \"Product\": [{ts,p95,occupied_median}] }, summary: [{room,label,avg_p95,worst_p95,occupied_median}] } for charting rankings and multi-series lines (room = product id). |
| `timeseries_regression_join` | Align/aggregate multiple metrics and compute regression stats plus scatter-ready arrays. |
| `occupancy_people_insight` | Not used in the commerce demo |
| `odor_event_monitor` | Not used in the commerce demo |
| `scope_schema_matrix` | Enumerate scoped devices with the metrics/tables they expose so you can build schema maps or availability matrices. |
| `grid_align_timeseries` | Align multiple metrics on a shared time grid (default 5-minute Europe/London) with forward-fill tolerance and completeness stats for heatmaps. |
| `ventilation_effectiveness` | Not used in the commerce demo |
| `daypart_boxplot` | Build boxplot quartiles for 08-12 / 12-16 / 16-20 windows for a product or page. |
| `energy_iaq_linkage` | Not used in the commerce demo |
| `device_health_summary` | Not used in the commerce demo |
| `weekday_weekend_pm_profile` | Not used in the commerce demo |
| `table_sample` | Return up to N rows from a product table (ts + selected fields) respecting an optional time window. Useful for table extracts. |
| `compare_metrics_in_room` | Compare multiple metrics within one product; returns [{field, value}] |
| `common_metrics_in_scope` | List metrics common to all scoped products (intersection of first-row keys excluding ts) |
| `correlation_matrix` | Pairwise Pearson correlation among fields within a product/table over the window |


## Chart & Answer Patterns
- **Line / area**: `fetch_timeseries`, `hourly_timeseries`, `scope_multiline`, `scope_daily_percentile` series arrays.
- **Scatter**: `pair_timeseries`, `building_temp_weather_corr`, `timeseries_regression_join.scatter`.
- **Heatmap**: `scope_heatmap`, `grid_align_timeseries`, `occupancy_people_insight.heatmap`.
- **Ranking / bar**: `compare_rooms_on_metric`, `compare_metrics_in_room`, `scope_daily_percentile.summary`, `daypart_boxplot`.
- **Forecasts**: every `forecast_*` tool returns `historical` + `forecast`; chart them separately and mention the horizon.
- **Tabular**: `table_sample`, `scope_schema_matrix`, `graph_zone_devices` feed Markdown tables.

## Good Practices
1. Execute at least two plan steps before finalizing so traces show evidence.
2. For comparison/ranking intents, call the dedicated compare tool instead of ad-hoc math.
3. When reporting correlations, cite coefficient + sample size from `correlate*` or `correlation_matrix`.
4. External signal questions must include either the Market Signals metrics or `weather_fetch` when weather context is required.
5. Keep responses concise: start with “Overview”, follow with numbered “Details” referencing the tools you ran.

## E-commerce Usage Notes
- Use owner/shop/page/product terms consistently in responses.
- External Signals live under the Market Signals page.
- For sales forecasting, use `forecast_hourly_linear` on `sales_amount` or `order_count`.
- For marketing efficiency, compare `roas` vs `ad_spend` using `pair_timeseries` or `timeseries_regression_join`.
