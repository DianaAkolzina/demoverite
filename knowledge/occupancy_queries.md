---
title: Occupancy & Utilization — Tool Playbook
category: occupancy
tags: occupancy, utilization, people, cleaning, planning
---

Occupancy & Utilization — Tool Playbook

- Current people in building: use `occupancy_current_total` (sums latest `people_count` across rooms). For rooms currently occupied, use `current_occupied_rooms` (threshold default 0).
- Today/this week/this month headcount: per room, use `people_total` or `stats` on `people.people_count` within the selected window; aggregate or compare via `compare_series_cross_room` if needed.
- Busiest room today/this week: use `busiest_room` with `metric='peak'` or `'avg'` over the window.
- Average occupancy for [Room X]: use `avg_occupancy` on `people.people_count`.
- Busiest day of week: use `busiest_day_of_week` on `people.people_count` with `agg='avg'` or `'sum'`.
- Arrival/leave times: use `hour_of_day_stats` on `people.people_count`; report hours with highest average (arrivals) and lowest (departures). Optionally chart with `fetch_timeseries`.
- Best time to schedule cleaning: find low occupancy windows using `hour_of_day_stats` minima for `people.people_count`. Cross-check `rooms_unused_in_window` for idle rooms.
- Most used meeting rooms: compare `avg_occupancy` or `busiest_room` across rooms; use `latest_per_room` on `people_count` for a snapshot.
- Rooms not used today/this week: use `rooms_unused_in_window` or `rooms_unused_since` with appropriate duration.
- Lowest occupancy periods (maintenance): use `hour_of_day_stats` minima and weekend vs weekday with `weekday_weekend_comparison`.
- When do most people leave (for offers): pick hour with falling `people_count` using `hour_of_day_stats` and trend from `fetch_timeseries`.
- Consistently underused rooms: compute `avg_occupancy` per room across long window; flag rooms with low avg and peak.
- Building usually empty: hours with near-zero `hour_of_day_stats` on `people.people_count` across days; also use `rooms_unused_since` for long durations.
- Weekly occupancy vs capacity: compute peak or avg `people_count` vs known capacity (capacity is external metadata; if missing, state assumption). Chart via `fetch_timeseries`.
- Weather vs occupancy: use `correlate_weather_room` on `people_count` vs weather `temp`/`humidity`.
- Meeting room stay duration: approximate from `people.people_count` rises/falls; if door or booking data exists, pair streams via `pair_timeseries` and compute deltas.

Fields & tables
- Occupancy table: `people` with field `people_count`.
- IAQ table often contains `people_count` if `people` missing; use field synonyms.
