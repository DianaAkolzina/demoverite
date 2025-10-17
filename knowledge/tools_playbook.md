# Tools Playbook (Authoritative)

This document supersedes older references to generic "stat" or vague comparisons. Use these exact tool names and patterns. Follow scope and time window strictly.

## Core Principles
- Scope: Only use rooms in the current selection. If room is ALL, the server passes a `Rooms in scope:` list. Do not invent rooms.
- Time window: Always use the selected Start/End (epoch ms). If the window yields no rows, adapt using `fetch_table_meta` and explain.
- Charts: Never embed data arrays. Always use `dataRef` to reference a tool result. The backend resolves dataRef to real data.
- Rephrase knowledge: Summarize concisely; do not dump long passages.

## Frequently Used Tools (Quick Guide)

- `fetch_timeseries({ room, table, fields[], start?, end? })` → `[ { ts, field } ]`
  - Use for a single metric line chart.
  - Example chart:
    - series: `[ { name: f, dataRef: { tool: 'fetch_timeseries', xField: 'ts', yField: f } } ]`

- `compare_series_cross_room({ series:[{ room, table, field, name? }], start?, end? })` → `{ name: [ { ts, y } ] }`
  - Use to compare one metric across multiple rooms (line chart).
  - Build one series entry per room. dataRef example:
    - `{ tool: 'compare_series_cross_room', field: '<series name>', xField: 'ts', yField: 'y' }`

- `compare_rooms_on_metric({ rooms?, table, field, agg?, start?, end? })` → `[ { room, value } ]`
  - Rank rooms by avg/sum/peak. Use bar/column with categories from `room`.

- `compare_metrics_in_room({ room, table, fields[], agg?, start?, end? })` → `[ { field, value } ]`
  - Compare multiple fields within a room; use bar/column.

- `stats({ room, table, field, start?, end? })` → `{ count, min, max, avg, sum }`
  - Use for numeric summaries in the selected window.

- `hour_of_day_stats({ room, table, field, start?, end? })` → per-hour bins
  - Use for arrival/leave time patterns, busiest hours.

- `correlation_matrix({ room, table, fields[], start?, end? })` → `{ fields, matrix }`
  - Use for pairwise correlations among metrics (summarize values; optional heatmap, no raw arrays).

- `fetch_table_meta({ room, table })` → `{ count, fields[], tsMin, tsMax }`
  - If a tool returns no rows, query meta and adapt within available range, explaining the adaptation.

## Graph / Scope Helpers

- `graph_rooms_by_scope({ building?, floor? })` → `{ rooms: string[] }`
  - Use to list rooms by building/floor when needed.

- `scope_list_buildings()` / `scope_list_floors({ building })` / `scope_list_rooms({ building?, floor? })`
  - Use to present available structures when the user asks.

- `scope_list_detectors({ room })` → `[ detectorType ]`
  - Summarize detectors in a room. Combine with fields from first-row schema for a clean list of metrics.

- `graph_zone_devices({ room })` → `{ devices: [{ id, name, type, metrics[] }] }`
  - Use when the user asks for device-level details.

## Field & Table Selection

- Map synonyms to fields: co2/co₂, temp/temperature, lux/light, occupancy/people/people_count, energy/value/total_kwh, odor/odour, nh3, h2s, pm25, pm10.
- For IAQ fields, table is usually `iaq`. For energy metrics, `energy`. For occupancy, `people`. Use `fetch_table_meta` if unsure.

## Chart Construction (dataRef only)

Line chart (single metric):
```
{
  "chart": {"type": "line"},
  "xAxis": {"type": "datetime"},
  "series": [{
    "name": "Temperature",
    "dataRef": {"tool": "fetch_timeseries", "xField": "ts", "yField": "temperature"}
  }]
}
```

Compare across rooms:
```
{
  "chart": {"type": "line"},
  "xAxis": {"type": "datetime"},
  "series": [{
    "name": "A_F1_cafe temperature",
    "dataRef": {"tool": "compare_series_cross_room", "field": "A_F1_cafe temperature", "xField": "ts", "yField": "y"}
  },{
    "name": "A_F1_boardroom temperature",
    "dataRef": {"tool": "compare_series_cross_room", "field": "A_F1_boardroom temperature", "xField": "ts", "yField": "y"}
  }]
}
```

## Do / Don’t

- Do: Use the exact selected time window; explain if you adapt to available data.
- Do: Use only rooms in the provided scope.
- Do: Provide concise text; add a chart when it helps.
- Don’t: Embed data arrays in chart JSON; always use dataRef.
- Don’t: Dump entire knowledge documents; rephrase relevant points.

## Full Tool Reference

For a complete list of all available tools, arguments, expected outputs, and dataRef chart patterns, see `tools_reference.md` in this folder. This reference covers discovery, timeseries, aggregations, correlations, occupancy/operations, forecasting, graph/scope, and vector-search tools with copy‑paste examples.
