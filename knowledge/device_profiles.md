# Device Profiles and Telemetry Keys (Glossary)

This glossary explains the types of devices deployed and what their telemetry keys mean in practice. The keys listed are those most commonly encountered across the data and Neo4j graph. Use this to interpret metrics in charts and answers.

## Profiles

- Digispace Gateway: Network/ingestion gateway. May expose line_total_data/line_periodic_data/raw for transport diagnostics (counts, batches). Not a physical sensor in the space.
- People Counter: Over-door or area counters. Keys include people_count or periodic totals (period_in/period_out/total_in/total_out), and sometimes heatmap/dwell for advanced counters.
- Occupancy Sensors: PIR/motion and derived occupancy. Keys like pir, motion, occupancy, is_used, daylight; sometimes battery/supplyVoltage.
- Control Devices: Switching/relay channels. Keys like channel_1, channel_total, raw_data indicating state or actuator telemetry.
- Energy Clamps: Electrical energy/power. Keys like total_kwh, raw_data, powerFailure, unit/units, value. May also expose per-line totals (line_total_data/line_periodic_data).
- Air Quality Sensors: Environmental + IAQ. Keys include temperature, humidity, airExchangeRate, co2, voc/tvoc, pm1/pm2_5/pm25/pm10, pressure, lux/light_level, virusRisk, radonShortTermAvg, mold, o3, hcho, rssi, sla, occupants/occupantsLower/occupantsUpper.
- Leak Detector: Leak presence. Keys include leakage_status, battery; sometimes raw_data.
- Water Management: Water pulse/volume/flow. Keys include water, water_total, flow, pulse_conv/water_conv, cubic_value; sometimes battery/raw_data.

## Telemetry Keys (by theme)

Environment/IAQ
- temperature: °C ambient temperature.
- humidity: % relative humidity.
- airExchangeRate / ach: Air changes per hour (ACH) estimate.
- co2: CO₂ concentration in ppm.
- voc / tvoc: Total volatile organic compounds (ppb or mg/m³ depending on device; unit may appear in units).
- pm1 / pm2_5 / pm25 / pm10: Particulate matter concentrations (µg/m³) at respective sizes.
- pressure: hPa/barometric pressure.
- lux / light_level: Illuminance (lux).
- o3: Ozone concentration (ppb/µg/m³).
- hcho: Formaldehyde concentration (ppm/µg/m³).
- radonShortTermAvg: Short-term average radon level (Bq/m³ or pCi/L depending on device).
- virusRisk: Vendor-derived index estimating viral transmission risk (unitless index).
- mold: Vendor index or probability of mold risk (unitless index 0–1 or 0–100).

Occupancy/People
- pir / motion: Binary or intensity motion detection.
- occupancy / occupants: Current estimated occupants count. occupantsLower/occupantsUpper give interval bounds.
- people_count: Instantaneous or sampled people count from counters.
- period_in / period_out / total_in / total_out: Counter totals during a time window or cumulative.
- dwell / heatmap: Spatial metrics from advanced counters; dwell time at locations.

Energy/Power
- total_kwh: Cumulative energy consumed (kWh).
- value: Current power/reading used in some devices; check unit/units.
- powerFailure: Boolean flag or counter for power loss events.
- unit / units: Unit label for value (e.g., kW, kWh).
- line_total_data / line_periodic_data: Per-line aggregates or periodic summaries from gateways/clamps.
- channel_1 / channel_total: Per-channel states or totals for control devices.
- sla: Service/Signal level agreement indicator (vendor-specific; often % uptime or link quality proxy).

Water/Leak
- water / water_total: Instantaneous pulse-derived water value or cumulative total (liters/m³ depending on conversion).
- flow: Instantaneous flow rate (L/min or m³/h).
- pulse_conv / water_conv: Conversion factors from pulses to volume units.
- leakage_status: Leak detected flag/status.

Common/Device Health
- battery: Battery level (% or voltage depending on device).
- rssi: Received Signal Strength Indicator (dBm) for wireless link.
- raw / raw_data: Vendor raw payload or unprocessed reading; use cautiously.
- time: Timestamp included by some devices (usually redundant to ts in CSV).
- is_used: Device/reading used flag (boolean) in some control/occupancy devices.
- supplyVoltage: Device supply voltage (V).

## Typical Keys by Profile

- People Counter: people_count, period_in, period_out, total_in, total_out, [heatmap, dwell].
- Occupancy Sensors: pir/motion, occupancy, is_used, daylight, battery, supplyVoltage.
- Energy Clamps: total_kwh, value, powerFailure, unit/units, [line_total_data, line_periodic_data].
- Air Quality Sensors: temperature, humidity, co2, tvoc/voc, pm1/pm2_5/pm25/pm10, pressure, lux/light_level, virusRisk, radonShortTermAvg, mold, o3, hcho, airExchangeRate, rssi, sla, occupants.*
- Leak Detector: leakage_status, battery.
- Water Management: water, water_total, flow, pulse_conv, water_conv, cubic_value, battery.
- Control Devices: channel_1, channel_total, raw_data; sometimes occupancy/usage flags.
- Digispace Gateway: line_total_data, line_periodic_data, raw.

## How to analyze

- Always check units (unit/units) and sampling cadence before aggregating.
- When correlating across metrics, align by time and use nearest-neighbor within a window to handle different sampling rates.
- For energy and counts, prefer rates or normalized values (e.g., kWh per hour, per occupant) when comparing across rooms.
- For IAQ thresholds (typical guidance): CO₂ < 1000 ppm, PM2.5 < 15 µg/m³ (daily), RH 30–60%, temp ~20–24°C (office comfort). Use as heuristics; site-specific policies may differ.

