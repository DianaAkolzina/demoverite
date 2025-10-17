# Tools Reference (Comprehensive)

This document enumerates all agent tools, their arguments, returned shapes, and dataRef chart patterns. Always:
- Respect scope (only rooms in selection)
- Respect time window (use start/end; adapt via fetch_table_meta if needed)
- Use dataRef (never embed arrays) when returning charts

## 1) Discovery / Schema

- `list_rooms()` → `string[]`
- `list_tables({ room })` → `string[]`
- `get_schema({ room, table })` → `string[]` (first‑row keys)
- `dump_room({ room, start?, end?, max_rows_per_table? })` → `{ [table]: any[] }`
- `fetch_table_meta({ room, table })` → `{ count, fields, tsMin, tsMax, table }`
- `distinct_values({ room, table, field, limit? })` → `string[]`

## 2) Timeseries & Comparisons

- `fetch_timeseries({ room, table, fields[], start?, end?, limit?, after_ts? })` → `[{ ts, <field1>, ... }]`
  - Line chart (single field):
```
{
  "chart": {"type": "line"},
  "xAxis": {"type": "datetime"},
  "series": [{"name": "<field>", "dataRef": {"tool": "fetch_timeseries", "xField": "ts", "yField": "<field>"}}]
}
```

- `compare_series_cross_room({ series:[{ room, table, field, name? }], start?, end? })` → `{ <name>: [{ ts, y }] }`
  - Compare across rooms (line chart):
```
{
  "chart": {"type": "line"}, "xAxis": {"type": "datetime"},
  "series": [{"name": "<room field>", "dataRef": {"tool": "compare_series_cross_room", "field": "<room field>", "xField": "ts", "yField": "y"}}]
}
```

- `pair_timeseries({ room, table1, field1, table2, field2, start?, end?, time_window_ms? })` → `[{ x, y, ts1, ts2, dt }]`
  - Scatter plot:
```
{"chart":{"type":"scatter"},"series":[{"name":"f1 vs f2","dataRef":{"tool":"pair_timeseries","xField":"x","yField":"y"}}]}
```

- `compute_ratio({ room, table1, field1, table2, field2, start?, end?, time_window_ms?, zero_if_denominator_zero? })` → `[{ ts, ratio }]`

- `data_gaps({ room, table, field, max_gap_ms, start?, end? })` → `[{ from, to, gap }]`

- `histogram({ room, table, field, bins?, start?, end? })` → `[{ binStart, binEnd, count }]`
  - Column chart:
```
{"chart":{"type":"column"},"series":[{"name":"<field> histogram","dataRef":{"tool":"histogram","field":"<field>","xField":"binStart","yField":"count"}}]}
```

- `hour_of_day_stats({ room, table, field, start?, end? })` → per‑hour bins `{ h, count, sum, min, max, avg }[]`

## 3) Aggregations & Rankings

- `stats({ room, table, field, start?, end? })` → `{ count, min, max, avg, sum }`
- `aggregate_stats_across_rooms({ table, field, agg?, start?, end? })` → `{ agg, value, count, sum, avg, min, max }`
- `aggregate_hourly_across_rooms({ table, field, agg?, start?, end? })` → `[{ ts, y }]`
- `compare_field_across_rooms({ table, field, agg?, start?, end? })` → `{ [room]: value }`
- `compare_rooms_on_metric({ rooms?, table, field, agg?, start?, end? })` → `[{ room, value }]` (bar chart)
- `compare_metrics_in_room({ room, table, fields[], agg?, start?, end? })` → `[{ field, value }]` (bar chart)
- `common_metrics_in_scope({ rooms? })` → `string[]`

## 4) Correlations & Weather

- `correlate({ room, table1, field1, table2, field2, start?, end?, time_window_ms? })` → `{ corr, n }`
- `correlate_cross_room({ room1, table1, field1, room2, table2, field2, start?, end?, time_window_ms? })` → `{ corr, n }`
- `correlate_weather_room({ room, table, field_room, field_weather, start?, end?, time_window_ms? })` → `{ corr, n }`
- `correlation_matrix({ room, table, fields[], start?, end?, time_window_ms? })` → `{ fields, matrix }`
- `weather_fetch({ fields[], start?, end?, limit? })` → weather rows
- `weather_correlate({ field1, field2, start?, end? })` → `{ corr, n }`

## 5) Occupancy & Ops

- `latest_value({ room, table, field, start?, end? })` → `{ ts, value }`
- `latest_per_room({ table, field, start?, end? })` → `{ [room]: { ts, value } }`
- `current_occupied_rooms({ threshold? })` → `string[]`
- `occupancy_current_total()` → `{ total }`
- `rooms_unused_since({ duration_ms })` → `string[]`
- `busiest_day_of_week({ room, table, field, start?, end?, agg? })` → `{ day, value }`
- `weekday_weekend_comparison({ room, table, field, start?, end? })` → `{ weekdayAvg, weekendAvg }`
- `energy_delta_kwh({ room, start?, end? })` → `{ delta_kwh, count }`

## 6) Forecasting

- `forecast_seasonal_hourly({ room, table, field, start?, end?, horizon_hours? })`
- `forecast_polyfit({ room, table, field, start?, end?, degree?, horizon_hours? })`
- (If available) `forecast_from_profile` / `forecast_hourly_linear` / `forecast_hourly_naive` — use for trend/seasonality tasks; always label forecast vs historical.

## 7) Graph / Scope

- `graph_rooms_by_scope({ building?, floor? })` → `{ rooms }`
- `scope_list_buildings()` → `string[]`
- `scope_list_floors({ building })` → `string[]`
- `scope_list_rooms({ building?, floor? })` → `string[]`
- `scope_list_detectors({ room })` → `string[]`
- `graph_zone_devices({ room })` → `{ devices: [{ id, name, type, metrics[] }] }`
- `graph_devices_by_scope({ tenant?, building?, floor?, zone?, type? })` → `{ devices }`

## 8) Vector / Docs

- `vector_search_docs({ query, k? })` → `{ hits: [{ id, text, metadata, distance? }] }`
  - Use to retrieve short documentation snippets to rephrase; do not dump long passages.

## Field & Table Mapping

- IAQ fields: `iaq` → temperature, humidity, co2, lux, pm25, pm10, voc, (optionally) nh3, h2s, airExchangeRate
- Energy: `energy` → value (interval), total_kwh (cumulative)
- People: `people` → people_count
- Water (if present): `water` → value, total_liters

## Chart Patterns (dataRef only)

- Single metric line: use `fetch_timeseries` dataRef with yField=metric
- Cross-room comparison: use `compare_series_cross_room` with field=<series key>
- Scatter (paired): use `pair_timeseries` with xField=x, yField=y
- Histogram: use `histogram` with xField=binStart, yField=count
- Ranking (bar): use values directly (no dataRef), or return an auxiliary fetch for series if needed

## Good Practices

- If a tool returns no rows, run `fetch_table_meta` and adapt within available range; explain briefly.
- Don’t invent rooms or metrics; use selection and schema.
- Answer succinctly; add chart when it clarifies a trend or comparison.

