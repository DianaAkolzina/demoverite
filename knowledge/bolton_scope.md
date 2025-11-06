# Bolton Building Scope (AVM Solutions)

## Floors
- **First Floor** – primary tenant space with collaboration zones.
- **Ground Floor** – entrance/flow monitoring.

## Zones & Devices

| Zone (First Floor) | Device | Metrics (CSV headers) |
|--------------------|--------|-----------------------|
| Standup            | `64214e60-479c-11f0-bf13-bf19a72566f6` (IAQ) | `temperature`, `humidity`, `concentration`, `units`, `raw_data` |
| Huddle             | `29436890-4798-11f0-bf13-bf19a72566f6` (People Counter) | `people_count`, `raw_data` |
| Workshop           | `c27807e0-4799-11f0-bf13-bf19a72566f6` (IAQ) | `co2`, `humidity`, `lux`, `o3`, `pir`, `pm10`, `pm25`, `pressure`, `raw_data`, `temperature`, `tvoc` |
| Sitdown            | `b19aae20-479c-11f0-bf13-bf19a72566f6` (Occupancy) | `is_used`, `occupancy`, `raw_data`, `supplyVoltage`, `units`, `value` |
| Comms              | `8e00d400-479a-11f0-bf13-bf19a72566f6` (Energy) | `value`, `powerFailure`, `unit`, `raw_data`, `total_kwh` |
| Comms              | `4a829030-58b9-11f0-a19e-8f874a1c01d3` (Water Meter) | `battery`, `cubic_value`, `humidity`, `raw_data`, `temperature`, `water_total` |
| Cafe               | `abc73b80-4797-11f0-bf13-bf19a72566f6` (IAQ) | `airExchangeRate`, `battery`, `co2`, `humidity`, `lux`, `occupants`, `pm1`, `pm10`, `pm25`, `pressure`, `rssi`, `sla`, `temperature`, `time`, `virusRisk`, `voc` |
| Cafe               | `ab5fb660-872d-11f0-a19e-8f874a1c01d3` (People Counter) | `dwell`, `heatmap`, `line_periodic_data`, `line_total_data`, `raw` *(data through 2025-09-08)* |
| Lounge             | `7318f830-4799-11f0-bf13-bf19a72566f6` (People Counter) | `people_count`, `raw_data` |
| Toilet             | `2e857e60-58b9-11f0-a19e-8f874a1c01d3` (Odor) | `battery`, `h2s`, `humidity`, `nh3`, `raw_data`, `temperature` |
| Toilet             | `002f9dc0-58b9-11f0-a19e-8f874a1c01d3` (Water Leak) | `battery`, `leakage_status`, `raw_data` |
| Brainstorm         | `6ef94be0-479b-11f0-bf13-bf19a72566f6` (Occupancy) | `battery`, `daylight`, `is_used`, `pir`, `raw_data` |
| Brainstorm         | `f22ffa70-47a2-11f0-bf13-bf19a72566f6` (Temperature) | `temperature`, `humidity`, `units`, `raw_data` |

| Zone (Ground Floor) | Device | Metrics |
|---------------------|--------|---------|
| Entrance            | `d9b00270-4797-11f0-bf13-bf19a72566f6` (People Flow) | `flow`, `raw_data` |

## Data Coverage Notes
- CSV timestamps range **2024-08-25 → 2025-10-24** for most sensors (see `scripts/check_csv_date_ranges.js`).
- Café people counter (`ab5fb660-872d-11f0-a19e-8f874a1c01d3`) has data through **2025-09-08**; October queries must use the available September window.
- Energy meter `8e00d400-...` exposes cumulative `total_kwh` alongside instantaneous `value`; use `energy_delta_kwh` to compute consumption deltas.

## Tool Hints
- Use device IDs above when selecting rooms or calling tools (e.g., `fetch_timeseries`).
- For occupancy comparisons, pair `b19aae20-...` (Sitdown) with `6ef94be0-...` (Brainstorm) and use `pair_timeseries` / `compare_series_cross_room`.
- For IAQ vs occupancy correlations, pair IAQ devices (e.g., `abc73b80-...`) with room occupancy sensors (`b19aae20-...`).
