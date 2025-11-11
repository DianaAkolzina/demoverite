# Bolton Building Scope (AVM Solutions)

## Floors
- **First Floor** – primary tenant space with collaboration zones.
- **Ground Floor** – entrance/flow monitoring.

## Zones & Devices

| Zone (First Floor) | Device | Metrics (CSV headers) | Notes |
|--------------------|--------|-----------------------|-------|
| Standup            | `64214e60-479c-11f0-bf13-bf19a72566f6` (IAQ) | `temperature`, `humidity`, `concentration`, `units`, `raw_data` | `concentration` = CO₂ ppm. Use with humidity/temperature for comfort checks. |
| Huddle             | `29436890-4798-11f0-bf13-bf19a72566f6` (People Counter) | `people_count`, `raw_data` | Sampling is sparse; aggregate per hour/day for trends. |
| Workshop           | `c27807e0-4799-11f0-bf13-bf19a72566f6` (IAQ) | `co2`, `humidity`, `lux`, `o3`, `pir`, `pm10`, `pm25`, `pressure`, `raw_data`, `temperature`, `tvoc` | Rich IAQ feed suitable for correlation charts. |
| Sitdown            | `b19aae20-479c-11f0-bf13-bf19a72566f6` (Occupancy) | `occupancy`, `is_used`, `value`, `supplyVoltage`, `raw_data`, `units` | `occupancy`/`is_used` are boolean. Convert to 0/1 for averages. |
| Comms              | `8e00d400-479a-11f0-bf13-bf19a72566f6` (Energy) | `value`, `powerFailure`, `unit`, `raw_data`, `total_kwh` | `total_kwh` is cumulative; use `energy_delta_kwh` for consumption windows. |
| Comms              | `4a829030-58b9-11f0-a19e-8f874a1c01d3` (Water Meter) | `battery`, `cubic_value`, `humidity`, `raw_data`, `temperature`, `water_total` | `water_total` is cumulative pulses (litres equivalent). |
| Cafe               | `abc73b80-4797-11f0-bf13-bf19a72566f6` (IAQ) | `airExchangeRate`, `battery`, `co2`, `humidity`, `lux`, `occupants`, `pm1`, `pm10`, `pm25`, `pressure`, `rssi`, `sla`, `temperature`, `time`, `virusRisk`, `voc` | `occupants` is vendor-estimated. Combine with people counter for utilisation. |
| Cafe               | `ab5fb660-872d-11f0-a19e-8f874a1c01d3` (People Counter) | `dwell`, `heatmap`, `line_periodic_data`, `line_total_data`, `raw` | Last reliable reading: 2025-09-08. Use September window for charts. |
| Lounge             | `7318f830-4799-11f0-bf13-bf19a72566f6` (People Counter) | `people_count`, `raw_data` | Similar cadence to Huddle. |
| Booths             | `c27807e0-4799-11f0-bf13-bf19a72566f6` (IAQ) | see Workshop | Same device ID serves Booths zone (shared IAQ feed). |
| Toilet             | `2e857e60-58b9-11f0-a19e-8f874a1c01d3` (Odor) | `battery`, `h2s`, `humidity`, `nh3`, `raw_data`, `temperature` | Use for odor anomaly tracking. |
| Toilet             | `002f9dc0-58b9-11f0-a19e-8f874a1c01d3` (Water Leak) | `battery`, `leakage_status`, `raw_data` | Boolean leak flag. |
| Brainstorm         | `6ef94be0-479b-11f0-bf13-bf19a72566f6` (Occupancy) | `is_used`, `pir`, `daylight`, `battery`, `raw_data` | Motion-derived usage signal (boolean). |
| Brainstorm         | `f22ffa70-47a2-11f0-bf13-bf19a72566f6` (Temperature) | `temperature`, `humidity`, `units`, `raw_data` | Dedicated temp probe; pair with occupancy for comfort insights. |

| Zone (Ground Floor) | Device | Metrics |
|---------------------|--------|---------|
| Entrance            | `d9b00270-4797-11f0-bf13-bf19a72566f6` (People Flow) | `flow`, `raw_data` |

## Data Coverage Notes
- Typical timestamp range **2024-08-25 → 2025-10-24** (UTC). Always confirm with `fetch_table_meta` before charting.
- Occupancy sensors provide sparse boolean readings—compute hourly/daily averages to smooth noise.
- Café people counter (`ab5fb660…`) stops reporting after **2025-09-08**; fall back to September window or IAQ `occupants` for October analysis.
- Energy meter (`8e00d400…`) exposes cumulative totals; comparisons must use deltas, not raw `total_kwh`.
- Water leak detector produces `leakage_status` values of `0`/`1` (string/number) depending on firmware—cast to boolean before aggregations.

## Tool Hints
- Device IDs double as **room identifiers** for tool calls. Match them exactly (`fetch_timeseries({ room: '64214e60-…' })`).
- For cross-room comparisons, build `compare_series_cross_room` series with the IDs above; label series using `deviceFriendlyName(...)` (already handled server-side).
- Occupancy sensors (`b19aae20…`, `6ef94be0…`) produce boolean values—`compare_rooms_on_metric` and `hour_of_day_stats` will coerce them to 0/1 automatically.
- To align IAQ with occupancy, pair IAQ room IDs with their matching occupancy sensors (e.g., Sitdown IAQ is Standup device for that zone + occupancy boolean).
- Heatmaps (`scope_heatmap`) require an explicit `rooms` array; use the ordered list above to avoid mismatched axes.
