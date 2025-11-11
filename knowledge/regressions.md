# Regression Prompts & Expected Plans

Use these prompts to validate that the agent plans and executes every step before finalising. Each scenario lists the mandatory tools and chart outputs that must appear in the trace.

## 1. Cafe IAQ vs. footfall regression

**Prompt**
> Cafe IAQ vs. footfall (causality-lite check): join Cafe IAQ (co2, pm25, voc) with Cafe people counter dwell/entries. For each hour over the last 14 days compute mean IAQ metrics + hourly dwell. Fit CO₂ ~ dwell and PM2.5 ~ dwell regressions; report slope & R². Plot dual-axis hourly lines and two scatter plots with fitted lines.

**Plan checklist**
1. `timeseries_regression_join` with hourly bucket, metrics for IAQ + dwell (set `mode:"delta"` for cumulative counters), and regression definitions.
2. Use `series` for the dual-axis hourly line plots (dwell vs CO₂/PM2.5) and `regressions`/`scatter` for the scatter + LSR commentary.
3. Cite slopes/R² from the tool output explicitly.

## 2. Space utilisation sanity (occupancy vs people counters)

**Prompt**
> Compare Sitdown occupancy (`is_used`) and Lounge people counter (`people_count`). Compute 15-minute bins, utilisation share, scatter vs people counts, and identify peak hours (08–10, 12–14, 16–18). Plot a day/hour heatmap, bar chart for peak windows, and scatter with trend.

**Plan checklist**
1. `occupancy_people_insight` with occupancy + people room IDs, bucket_minutes=15, custom `peak_windows`.
2. Use `heatmap.data` for day/hour plot, `peaks` for the bar chart, `scatter` + `regression` for utilisation vs people count.
3. Describe correlation strength and peak windows in the final answer.

## 3. Odour risk monitoring

**Prompt**
> Toilet odor sensor (H₂S, NH₃, humidity, temperature) vs Entrance flow. Compute rolling z-scores (1h window), flag events where z>3 for ≥10 minutes, summarise daily counts and median Entrance flow within ±30 min of each event. Plot time series with event shading, daily event counts, and Entrance flow distribution for events vs non-events.

**Plan checklist**
1. `odor_event_monitor` with `odor_fields=['h2s','nh3']`, `people_room="People Flow_waTDvSKxFbK4"`, `window_minutes=60`, `min_duration_minutes=10`.
2. Use `series` + `events` for the time series chart, `daily_counts` for the bar chart, and `flowDuringEvents` to compare Entrance flow.
3. Mention number of events, peak z-scores, and whether flow is elevated during events.

## 4. Energy & environment linkage (Comms + Cafe IAQ)

**Prompt**
> Aggregate `Energy_BGi4Bzh1KWkJ` total_kwh to hourly/daily; left-join with Cafe IAQ hourly/daily averages (CO₂, temperature, virusRisk). Determine whether higher kWh days correspond to better/worse IAQ. Provide correlation coefficients and dual-axis plots.

**Plan checklist**
1. `energy_iaq_linkage` with links mapping energy room → Cafe IAQ, `bucket:"daily"`, `iaq_fields:['co2','temperature','virusRisk']`, `detrend:true` if needed.
2. Use returned `series` for the dual-axis daily plots and `links[].correlations` for correlation commentary (mention R, N).
3. Reference `rows_detrended`/`correlations` when discussing directionality (higher kWh vs IAQ).

## 5. Air quality differentials (weekday/weekend PM profiles)

**Prompt**
> Compare Cafe and Booths PM2.5 diurnal profiles for weekdays vs weekends (30-min bins). Quantify uplift per bin and flag >20% increases.

**Plan checklist**
1. `weekday_weekend_pm_profile` with `rooms` array and `bucket_minutes:30`.
2. Plot `weekday` vs `weekend` series for each room; render `uplift` as bars and call out bins over +20%.
3. Final answer must cite which bins/rooms see the biggest differential.

## 6. Device health & data quality

**Prompt**
> Sensors with battery or supplyVoltage: Cafe IAQ, Water Meter, Brainstorm Occupancy, Water Leak, Sitdown Occupancy. Report latest battery/voltage, 7-day sparklines, % missing data per metric. Flag battery <20%, supplyVoltage <3.0V, or missingness >10% in any day. Plot sparkline grid + table of flags.

**Plan checklist**
1. `device_health_summary({ rooms:[...], lookback_days:7 })`.
2. Use `devices[].battery/rssi/supplyVoltage` for tables and `sparkline` arrays for mini-plots; use `missingness` & `alerts` to highlight issues.
3. Mention thresholds (20% battery, -80 dBm RSSI, <3.0V, >10% missing) explicitly in conclusions.
