COLUMN MAPPING AND EXPLANATIONS OF BUILDING SENSOR CSV DATA

--- water_meter.csv ---
ts: Timestamp in milliseconds since epoch (UNIX time).
temperature: Ambient air temperature at the meter location, in °C.
humidity: Relative humidity at the meter location, in %.
battery: Battery percentage of the meter device.
raw_data: JSON snapshot of raw sensor payload. Useful for debugging.
water_total: Cumulative total water pulses/volume recorded, typically in litres.
cubic_value: Converted cubic meter value (m³), may be NaN if not available.

--- toilet_odor_iaq.csv ---
ts: Timestamp in ms.
temperature: Ambient air temperature, °C.
humidity: Relative humidity, %.
battery: Battery level, %.
h2s: Hydrogen sulfide concentration (ppm or mg/m³ depending on calibration). Indicator of odor.
nh3: Ammonia concentration (ppm).
raw_data: JSON payload with all sensor fields.

--- brainstorm_temperature_sensor.csv ---
ts: Timestamp.
temperature: Ambient temperature, °C.
humidity: Relative humidity, %.
units: Metadata field with units [°C, %].
raw_data: Raw payload.

--- lounge_people_counter.csv / huddle_people_counter.csv ---
ts: Timestamp.
people_count: Number of people detected in the zone.
raw_data: Raw sensor data (if any).

--- cafe_iaq.csv ---
ts: Timestamp.
temperature: Ambient temperature, °C.
humidity: Relative humidity, %.
airExchangeRate: Estimated air change rate (ACH).
battery: Device battery, %.
co2: Carbon dioxide concentration, ppm.
lux: Light level, lux.
pm1: Particulate matter (PM1), µg/m³.
pm25: Particulate matter (PM2.5), µg/m³.
pressure: Air pressure, hPa.
rssi: Signal strength indicator (dBm).
sla: Service level attribute (metadata).
time: Converted UNIX timestamp.
virusRisk: Derived index estimating infection risk (unitless).
voc: Volatile organic compounds index.
pm10: PM10 concentration, µg/m³.
occupants: Estimated number of occupants from IAQ model.

--- standup_temperature_sensor.csv ---
ts: Timestamp.
temperature: Air temperature, °C.
humidity: Relative humidity, %.
concentration: Gas concentration, likely CO₂, ppm.
units: Units metadata [ppm, °C, %].
raw_data: Raw payload.

--- booths_iaq.csv ---
ts: Timestamp.
temperature: Air temperature, °C.
humidity: Relative humidity, %.
co2: Carbon dioxide concentration, ppm.
lux: Illuminance, lux.
pm25: PM2.5, µg/m³.
pressure: Barometric pressure, hPa.
pir: Passive infrared motion sensor state (active/idle).
o3: Ozone concentration, ppm.
pm10: PM10, µg/m³.
tvoc: Total volatile organic compounds index.
raw_data: Raw JSON payload.

--- energy_clamp.csv ---
ts: Timestamp.
value: Instantaneous current, amperes.
powerFailure: Boolean flag for power failure.
unit: Unit of measurement (A).
raw_data: Raw payload.
total_kwh: Cumulative energy consumption, kWh (if available).

