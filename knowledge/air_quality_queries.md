---
title: Air Quality & Health — Tool Playbook
category: air_quality
tags: co2, pm25, pm10, virusrisk, ventilation
---

Air Quality & Health — Tool Playbook

- PM2.5/PM10 per room: use `latest_per_room` or `stats` on `pm25` and `pm10`; visualize with `fetch_timeseries`.
- Above safe particulate limits: compare `stats` max vs thresholds; flag exceedances with timestamps.
- Virus risk level per room: use `virusrisk` field if available; otherwise proxy via high `co2` + low `airExchangeRate`.
- Poorest air quality today: rank rooms by high `co2`/`pm25`/`pm10` averages in the window.
- Occupancy impact on CO₂/PM: use `correlate` between `people.people_count` and `co2` or `pm25`.
- Times with highest virus risk: find hours with high `co2` and low `airExchangeRate` using `hour_of_day_stats` and/or `pair_timeseries`.
- Ventilation rate vs risk: correlate `airExchangeRate` (if present) with `virusrisk` or `co2`.
- Humidity vs risk: correlate `humidity` with `virusrisk`; look for extremes outside 40–60%.
- Air quality anomalies: use `detect_spikes` on `co2`, `pm25`, `pm10`.

Fields & tables
- IAQ table: `co2`, `pm25`, `pm10`, `humidity`, `temperature`, `airExchangeRate`, `virusrisk` (if present).
- Occupancy table: `people.people_count`.
