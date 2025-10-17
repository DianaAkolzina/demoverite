---
title: Predictive & Planning — Tool Playbook
category: planning
tags: forecast, scheduling, cleaning, hvac
---

Predictive & Planning — Tool Playbook

- Next week energy peak (day/time): use `forecast_hourly_linear` or `forecast_seasonal_hourly` on `energy` hourly averages; report top forecasted hour and explain driver (temp/occupancy) via recent correlations.
- Expected people tomorrow/next week: use `forecast_from_profile` on `people.people_count` (days=7) to capture weekly seasonality.
- Rooms needing cleaning tomorrow: forecast occupancy profile per room (`forecast_from_profile` on `people_count`) and prioritize rooms with higher expected usage today; alternatively flag rooms with low recent usage for deep clean.
- Best time for maintenance: use `forecast_from_profile` minima for `people_count`; cross-check with energy baseload for planned shutdowns.
- Optimize HVAC schedules for next week: align `forecast_from_profile` for `people_count` with setpoint times; simulate energy via historical `hour_of_day_stats`.
- Predict tomorrow’s energy peak: `forecast_hourly_linear` on `energy` hourly deltas; corroborate with `weather_fetch` (temp forecast proxy if available) and recent occupancy patterns.
- When will air quality exceed limits: if consistent pattern exists, use `forecast_from_profile` on `co2` during known high-usage hours; set alert threshold and expected exceedance times.

Tool selection guidance
- Seasonal patterns → `forecast_from_profile`, `forecast_seasonal_hourly`.
- Trending series → `forecast_hourly_linear`.
- Baseline checks → `forecast_hourly_naive`.
