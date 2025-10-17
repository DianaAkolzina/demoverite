---
title: Water Usage — Tool Playbook
category: water
tags: water, leaks, usage
---

Water Usage — Tool Playbook

- Total water today/this week: use `stats` sum on `water.value` (or delta of `total_liters`/`total_m3` if cumulative present).
- Anomalies vs occupancy: compare `water.value` during hours when `people.people_count` ≈ 0 (after-hours) using `hour_of_day_stats` and/or `pair_timeseries`.
- Areas with most water use: compare per-room `stats` sum on `water.value` across the window; present a ranked list.
- Increase since last week: compare `stats` sums across two equal windows; report delta and percent.
- Leakage or unexpected spikes: use `detect_spikes` on `water.value`; also check persistent after-hours flow when occupancy is zero.
- Water use when unoccupied: compute off-hours average using `hour_of_day_stats` on `water.value` during hours with minimal occupancy.
- Peak time of day: use `hour_of_day_stats` on `water.value` to find peak hour.
- Reduce water without comfort impact: target off-hours and outliers; confirm with `detect_spikes` and occupancy overlay.

Fields & tables
- Water table: `water` with `value` (interval) or cumulative `total_*` (delta over window).
- Occupancy table: `people.people_count`.
