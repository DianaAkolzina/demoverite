---
title: Lighting (Lux) — Tool Playbook
category: lighting
tags: lighting, lux, occupancy
---

Lighting (Lux) — Tool Playbook

- Average lux per room: use `stats` avg on `iaq.lux` over the window; visualize via `fetch_timeseries`.
- Comfort standards: compare `stats` avg/min against desired ranges (e.g., task ~500 lux, circulation ~100–300 lux); cite if ranges are configured, otherwise state assumption.
- Usage vs occupancy: use `correlate` on `iaq.lux` vs `people.people_count` to see alignment.
- Lights on while empty: pair `iaq.lux` with `people.people_count` using `pair_timeseries`; flag periods with lux > baseline and occupancy == 0.
- Insufficient lighting areas: use `stats` min/avg on `iaq.lux`; list rooms with low values.
- Natural vs artificial: correlate `weather.clouds` or time-of-day with `iaq.lux`; compare windowed days and nights.
- Lights off at night: use `hour_of_day_stats` on `lux` to confirm low nighttime levels.

Fields & tables
- IAQ table: typically includes `lux` along with temperature, humidity, CO2.
- Occupancy table: `people.people_count`.
