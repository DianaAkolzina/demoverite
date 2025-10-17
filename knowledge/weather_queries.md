---
title: Weather & External Conditions — Tool Playbook
category: weather
tags: weather, temp, humidity, wind, clouds
---

Weather & External Conditions — Tool Playbook

- Weather vs occupancy: use `correlate_weather_room` for `people.people_count` vs `weather.temp`/`humidity`.
- Outside conditions vs energy: `correlate_weather_room` for `energy.value`/hourly delta vs `temp`, `humidity`, `clouds`, `wind_speed`.
- Forecast and energy planning: overlay `weather_fetch` forecast proxy (if available) with `forecast_*` on `energy`.
- Rainy days and occupancy: restrict range to rainy periods (via `weather_fetch` `weather_main`/`weather_desc`) and compare `avg_occupancy`.
- Outside temperature vs indoor comfort: correlate `weather.temp` vs `temperature` in rooms using `correlate_weather_room`.
- Wind/solar radiation vs HVAC: correlate `wind_speed`/`clouds` with `energy` or `temperature` drift.
- Pre-heat/pre-cool decisions: use `forecast_from_profile` or `forecast_seasonal_hourly` on `temperature`/`people_count` and consider upcoming `weather.temp`.
- Outdoor averages during high energy days: select high `energy` days and compute `weather_fetch` averages for those windows.

Fields & tables
- Weather: `weather_fetch` fields include `temp`, `humidity`, `pressure`, `wind_speed`, `wind_deg`, `clouds`, `weather_main`, `weather_desc`.
