Reasoning Guide for Queries and Math Mapping (Updated)

- Time windows:
  - Always use the exact Start and End dates provided by the user.
  - Do not predict values for dates that are already in the past.
  - If a user asks for the “best day/time” without a historical qualifier, interpret it as future planning and use forecasting or seasonality.

- Word → Math mapping:
  - best, most, highest, peak → max
  - worst, least, lowest, minimum → min
  - total, sum → sum
  - average, avg, mean → avg
  - trend, over time → time series
  - relationship, influence → scatter/correlation
  - distribution → histogram
  - share, composition → pie/stacked

- Tool selection hints (use exact tool names; see tools_playbook.md for details):
  - max/min/sum/avg over period → `stats({ room, table, field, start, end })`
  - compare rooms on one metric (timeseries) → `compare_series_cross_room` (line chart with dataRef)
  - rank rooms by a metric → `compare_rooms_on_metric` (bar chart)
  - compare multiple metrics within a room → `compare_metrics_in_room`
  - busiest hour/day patterns → `hour_of_day_stats`
  - correlations among metrics → `correlation_matrix`
  - no rows in window → inspect `fetch_table_meta` and adapt within available range

See also: tools_playbook.md (Authoritative) for current tool list, chart patterns (prefer dataRef; small arrays allowed for short windows), and scope/time window rules.
