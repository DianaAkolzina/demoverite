---
title: Comfort & Environmental Quality — Tool Playbook
category: comfort
tags: temperature, humidity, ventilation, hvac
---

Comfort & Environmental Quality — Tool Playbook

- Spaces within comfortable temperature: use `latest_per_room` on `temperature`; compare to comfort band (e.g., ~20–22°C office). For full window, use `stats` min/max/avg.
- Rooms too hot/cold: list rooms where `stats` min/max exceed comfort bands.
- Unoccupied and >21°C: use `unoccupied_over_temp` with `temp=21`.
- Average temp/humidity across rooms: use `latest_per_room` or `stats` avg across rooms; visualize via `compare_series_cross_room`.
- What temperature to target: use existing `knowledge/temperature.md` and `iaq_guidelines.md`; balance comfort (20–22°C) and efficiency; adjust per space type.
- Ideal temperature for [Room X]: use historical `hour_of_day_stats` for `temperature` during occupied hours to set a target near median.
- Temperature stability: use `hour_of_day_stats` min/max range or `detect_spikes` for volatility.
- Heat/cool time for a room: analyze `temperature` slope after setpoint change; compare with `energy.value` if available.
- HVAC response to occupancy: correlate `people.people_count` with `co2` and `temperature`; expect CO2 to drop and temp to stabilize when systems respond.
- Humidity variation and range: use `stats` min/max/avg for `humidity`; check 40–60% comfort band.
- CO₂ thresholds exceeded: use `detect_spikes` or `stats` max on `co2`; count hours where `co2` > threshold.
- Average CO₂ per room: use `latest_per_room` or `stats` avg on `co2`.
- Ventilation assessment in meetings: correlate `co2` decay after meetings with `people_count` decline; faster decay implies better ventilation.
- IAQ alerts: combine thresholds for `co2`, `pm25`, `pm10`, `humidity`, `temperature`; report rooms breaching limits.

Fields & tables
- IAQ table: `temperature`, `humidity`, `co2`, `pm25`, `pm10`, `lux`, `airExchangeRate` (if present).
- Occupancy table: `people.people_count`.
