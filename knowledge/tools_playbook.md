
# Tools Playbook (Current)

Use this playbook together with `knowledge/tools_reference.md`, which mirrors the live `toolDefs()` list. The reference tells you what each tool does; this file tells you when to reach for it.

## Core Workflow
1. Respect the server-provided scope and time window. Never invent a room/floor/building that is not in `selection`.
2. Plan → execute → final. Run at least two concrete tool steps before finalizing. If a tool returns zero rows, call `fetch_table_meta`, adapt, and explain the gap.
3. Every chart must rely on `series[].dataRef` that points at the tool you executed. Never embed raw arrays.
4. Cite the tool outputs explicitly in the "Details" section so traces remain auditable.

## Timeseries, Buckets & Stats
- `fetch_timeseries` for raw lines; `hourly_timeseries` for bucketed trends. When you need scatter or per-point ratios, pair with `pair_timeseries` or `compute_ratio`.
- `stats`, `get_time_for_value`, `detect_spikes`, `data_gaps`, `distinct_values`, `weekday_exceedance`, `hour_of_day_stats` cover the bulk of summary/explainability questions.
- When you need aligned multi-metric output, call `scope_multiline`, `grid_align_timeseries`, or `timeseries_regression_join` (which also returns regression + scatter helpers).

## Comparisons & Rankings
- Cross-room: `compare_series_cross_room` (line chart), `compare_rooms_on_metric` (ranking bar), `compare_field_across_rooms`, `aggregate_*_across_rooms`.
- Within one room: `compare_metrics_in_room`, `daypart_boxplot`, `ventilation_effectiveness`, `energy_high_when_empty`, `energy_iaq_linkage`.
- Percentile/range requests across scope: `scope_daily_percentile` (line + summary bar) and `scope_heatmap` (room vs time heatmaps).

## Occupancy, People & Energy Insight
- `occupancy_people_insight` bundles dwell vs utilisation scatter, heatmap, and peak windows—use it for “busiest hour”, “utilisation vs people count”, or sanity checks.
- `rooms_unused_since`, `current_occupied_rooms`, `occupancy_current_total`, `busiest_day_of_week`, `weekday_weekend_comparison` answer operational questions quickly.
- Energy-focused prompts should include `energy_delta_kwh`, `energy_high_when_empty`, or `energy_iaq_linkage` depending on whether the user wants totals, waste detection, or IAQ vs kWh linkage.

## Weather & IAQ Context
- Always involve `weather_fetch` or `building_temp_weather_corr` / `building_temp_weather_scatter` when weather is mentioned. Follow up with `correlate`, `correlate_cross_room`, or `correlate_weather_room` for quantifying relationships.
- `weather_correlate` is reserved for weather-only comparisons; `building_temp_weather_corr` already blends indoor temperatures across the scope and pairs them with outside data.

## Forecasting & Trend Projection
- Pick from `forecast_from_profile`, `forecast_hourly_linear`, `forecast_hourly_naive`, `forecast_moving_average`, `forecast_exponential_smoothing`, `forecast_seasonal_hourly`, or `forecast_polyfit` based on the question. Always mention the horizon and plot historical vs forecast as two series.

## Scope / Graph Utilities
- Use `scope_list_buildings`, `scope_list_floors`, `scope_list_rooms`, `graph_rooms_by_scope`, or `graph_rooms_by_tenant` when the user asks “what do you see?”
- For detector/device inventory, call `graph_zone_devices`, `graph_devices_by_scope`, `scope_schema_matrix`, or `scope_list_detectors`. These feed Markdown tables as well as context sentences.

## Diagnostics & Knowledge
- `device_health_summary`, `common_metrics_in_scope`, `vector_search_docs`, `table_sample`, and `dump_room` cover troubleshooting, schema enumeration, and doc lookups. Use them sparingly but cite their output when the user explicitly asks for raw snippets.

## Chart Patterns (dataRef shorthand)
- **Line / area**: `fetch_timeseries`, `hourly_timeseries`, `scope_multiline`, `scope_daily_percentile.series`.
- **Scatter**: `pair_timeseries`, `building_temp_weather_corr`, `timeseries_regression_join.scatter`, `occupancy_people_insight.scatter`.
- **Heatmap**: `scope_heatmap`, `grid_align_timeseries.heatmap`, `occupancy_people_insight.heatmap`.
- **Bar / ranking**: `compare_rooms_on_metric`, `compare_metrics_in_room`, `scope_daily_percentile.summary`, `daypart_boxplot.peaks`, `energy_high_when_empty`.
- **Tabular**: `table_sample`, `scope_schema_matrix`, `device_health_summary`, `graph_zone_devices` (render as Markdown tables when textual output is clearer).

Stick to this flow and the agent will stay compliant with the latest toolset.
