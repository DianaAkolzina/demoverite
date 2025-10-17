---
title: Performance, Trends & Correlations — Tool Playbook
category: performance
tags: correlations, trends, outliers, stability
---

Performance, Trends & Correlations — Tool Playbook

- Occupancy vs CO₂: use `correlate` on `people.people_count` vs `co2`; include scatter chart via `pair_timeseries` and set `chart.type='scatter'`.
- Outside temperature vs energy: `correlate_weather_room` with `field_weather='temp'` and room energy metric.
- Humidity vs virus risk: `correlate` `humidity` vs `virusrisk` (if present); note non-linearities around 40–60%.
- Drivers of energy use: test correlations with `people_count`, `temp`, `humidity`, `clouds`; compare weekday/weekend via `weekday_weekend_comparison`.
- Occupancy change since last month: compare `avg_occupancy` across two windows; show percent change.
- Most stable rooms: rank by low range (max-min) or low SD using `stats` on `temperature`/`co2`.
- Outliers/anomalies: use `detect_spikes` on key fields; also detect data gaps via `data_gaps`.
- Top 5 energy-consuming days: compute daily deltas from `total_kwh` or sum `energy.value` grouped by day; present table/chart.
- Weather impact magnitude: provide correlation values with confidence hints; include scatter plots for high-signal pairs.
- Weekend vs weekday performance: `weekday_weekend_comparison` for `energy`, `temperature`, `co2`, or `people_count`.
