---
title: Energy Consumption & Efficiency — Tool Playbook
category: energy
tags: energy, kwh, efficiency, demand-response
---

Energy Consumption & Efficiency — Tool Playbook

- When is energy highest this week and why: use `energy_peak_time` per room to find peak delta; investigate drivers with `correlate_weather_room` (e.g., `temp`) and `correlate` with `people.people_count`.
- Total energy today/this week: use `energy_delta_kwh` (preferred if `total_kwh` exists). If missing, `stats` sum of `energy.value`.
- Average energy per occupant: use `compute_ratio` with numerator `energy.value` (or hourly `delta_kwh`) and denominator `people.people_count`; set `zero_if_denominator_zero=true` to avoid NaNs.
- Anomalies vs occupancy: use `energy_high_when_empty` with `energy_table='energy'`, `occupancy_table='people'` to find high energy during zero occupancy.
- Energy during demand response: filter window to DR period; compute `energy_delta_kwh` and compare to baseline period.
- Correlation occupancy vs energy: use `correlate` on `people.people_count` vs `energy.value` (or hourly deltas) for the same room.
- Savings without comfort impact: target baseload and after-hours use; check `energy_high_when_empty`, and align HVAC with `hour_of_day_stats` on occupancy.
- Which rooms consume most energy: compare `energy_delta_kwh` across rooms using `compare_series_cross_room` or list per room.
- Efficiency since last month: compare `energy_delta_kwh` across two windows; normalize by `avg_occupancy` if needed.
- Energy peak time of day: use `hour_of_day_stats` on `energy.value` (or hourly deltas) to find peak hour.
- Heating/cooling when empty: `energy_high_when_empty` plus `rooms_unused_in_window`.
- Standby overnight: compute night-hours average using `hour_of_day_stats` on `energy.value`.
- Time to heat building: `hour_of_day_stats` on `temperature` rise vs `energy.value`; use `pair_timeseries` and look at lag.
- Best heating start time: combine `forecast_from_profile` on `temperature` with `hour_of_day_stats` for arrivals.
- Outdoor temperature vs energy: use `correlate_weather_room` with room `energy.value`/`delta_kwh` vs weather `temp`.
- Renewable share and power source mix: if metered fields exist (e.g., `solar_kwh`, `grid_kwh`), compute shares via `compute_ratio`; if not present, explain data gap.

Fields & tables
- Energy table: `energy` with fields `total_kwh` (cumulative) and/or `value` (interval).
- Occupancy table: `people.people_count`.
- Weather: `weather_fetch` with `temp`, `humidity`, `wind_speed`, `clouds`.
