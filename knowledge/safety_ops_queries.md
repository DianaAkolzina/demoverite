---
title: Safety & Operations — Tool Playbook
category: safety
tags: doors, sensors, failures, gaps
---

Safety & Operations — Tool Playbook

- Emergency/Fire exit door state: if door sensors exist (e.g., `door_open`), use `latest_per_room` or `distinct_values` to inspect states; list any open states during the window.
- Fire exits closed properly: same as above; verify `door_open == 0` throughout window using `fetch_timeseries` for audit.
- Security breaches/unusual entries: if access events table exists, use `distinct_values` and `stats` count by hour/day; flag off-hours activity.
- Building unoccupied outside normal hours: use `hour_of_day_stats` on `people.people_count` to define normal hours; report after-hours samples with `people_count > 0`.
- Sensor/meter reporting correctly: use `data_gaps` to detect missing data and `detect_spikes` for outliers.
- HVAC/lighting system failure: look for `temperature` drift or `lux` anomalies vs typical using `detect_spikes`; correlate with `energy` baseload changes.
- All sensors online: run `data_gaps` per key table/field; list gaps exceeding thresholds.

Notes
- This relies on presence of door/access fields in the data. If missing, clearly state the limitation.
