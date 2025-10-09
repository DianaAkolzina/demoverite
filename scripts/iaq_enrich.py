import numpy as np
import pandas as pd
import time
import math

# === CONFIGURATION ===
start_timestamp = 1672531200000  # Jan 1, 2023 in ms
step_minutes = 10
output_csv = "cafe_iaq_data.csv"

fields = [
    "ts", "temperature", "humidity", "airExchangeRate", "battery", "co2",
    "lux", "pm1", "pm25", "pressure", "rssi", "time", "virusRisk",
    "voc", "occupants", "sla", "pm10"
]


def generate_data(start_ts, step_min):
    np.random.seed(42)
    data = []
    current_ts = start_ts
    now_ms = int(time.time() * 1000)
    step_ms = step_min * 60 * 1000
    n_steps = int((now_ms - start_ts) / step_ms)

    battery_level = 100.0

    for i in range(n_steps + 1):
        # Simulate diurnal & seasonal temperature drift
        day_fraction = (i % (24 * 60 / step_min)) / (24 * 60 / step_min)
        seasonal_offset = 2 * math.sin(2 * math.pi * (i / (24 * 60 / step_min * 365)))
        temperature = 22 + 2 * math.sin(2 * math.pi * day_fraction) + seasonal_offset + np.random.normal(0, 0.5)

        # Humidity: inversely related to temperature
        humidity = np.clip(55 - (temperature - 22) * 2 + np.random.beta(2, 5) * 10, 30, 65)

        airExchangeRate = np.clip(np.random.normal(0.3, 0.05), 0.1, 0.5)

        # Gradual battery drain + small random fluctuation
        battery_level = max(85, battery_level - np.random.uniform(0.00005, 0.0002))
        battery = battery_level + np.random.normal(0, 0.05)

        # CO₂ ppm (lognormal)
        co2 = np.random.lognormal(mean=6.1, sigma=0.05)  # ≈ 450 ppm avg

        # Lux (lognormal + daily pattern)
        lux = np.random.lognormal(mean=1.5 + 1.0 * math.sin(2 * math.pi * day_fraction), sigma=0.6)

        # Particulate matter
        pm1 = np.random.lognormal(mean=1.4, sigma=0.25)
        pm25 = pm1 + np.random.lognormal(mean=1.5, sigma=0.25)
        pm10 = pm25 + np.random.lognormal(mean=1.6, sigma=0.25)

        pressure = np.random.normal(1013, 8)
        rssi = np.random.normal(-50, 4)

        # Virus risk (depends on CO₂ and humidity)
        virusRisk = 1.5 + 0.001 * (co2 - 400) / 10 + (humidity - 40) * 0.01 + np.random.normal(0, 0.1)

        voc = np.random.normal(105, 5)
        occupants = min(np.random.poisson(1.5), 5)
        sla = np.random.uniform(0.9, 1.0)

        timestamp_seconds = current_ts / 1000.0

        data.append([
            current_ts, temperature, humidity, airExchangeRate, battery, co2,
            lux, pm1, pm25, pressure, rssi, timestamp_seconds, virusRisk,
            voc, occupants, sla, pm10
        ])

        current_ts += step_ms

    return data


def save_to_csv(filename, data):
    df = pd.DataFrame(data, columns=fields)
    df.to_csv(filename, index=False, float_format="%.6f")


if __name__ == "__main__":
    data = generate_data(start_timestamp, step_minutes)
    save_to_csv(output_csv, data)
    print(f"✅ Generated {len(data)} rows in {output_csv}")
