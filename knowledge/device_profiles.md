Device Profiles and Telemetry Keys

Summary: Each Device in the Neo4j graph has a DeviceProfile and a set of TelemetryKeys (HAS_TELEMETRY_KEY). CSV files for each device contain exactly these keys (plus ts). Conceptual meanings:

- Digispace Gateway: Infrastructure device; generally not a telemetry source (no keys).
- People Counter: Measures occupancy metrics, e.g., motion presence, people_count.
- Occupancy Sensors: Motion/raw presence, often boolean or counts.
- Control Devices: Actuator/control status (e.g., value/state) depending on deployment.
- Energy Clamps: Electrical load (value in A), powerFailure flag, total_kwh; unit field denotes measurement unit.
- Air Quality Sensors: Environmental metrics (temperature, humidity, co2, pm1/pm25/pm10, lux, pressure, rssi, voc); may include virusRisk, mold index, occupants estimates.
- Leak Detector: Water/leak indicators depending on model (water/leak flags; sometimes part of Water Management).
- Water Management: Water flow/consumption totals (water_total, cubic_value), with associated temperature/humidity/battery where applicable.

Note: The authoritative set of fields per device is defined by Neo4j TelemetryKey nodes. The agent should prefer those keys; profile names provide conceptual context when keys are missing.

