import numpy as np
import pandas as pd
import time
import json
import csv
import datetime
import random

# === CONFIGURATION ===
start_timestamp = 1672531200000  # Jan 1, 2023
step_minutes = 10                # sampling every 10 minutes
output_csv = "gas_sensor_data.csv"

fields = ["ts", "temperature", "humidity", "battery", "h2s", "nh3", "raw_data"]


def daily_cycle(hour, base, amplitude, phase_shift=0):
    """Generates a smooth daily sinusoidal cycle."""
    return base + amplitude * np.sin((2 * np.pi * (hour - phase_shift)) / 24)


def generate_data(start_ts, step_min):
    np.random.seed(42)
    current_ts = start_ts
    now_ms = int(time.time() * 1000)
    step_ms = step_min * 60 * 1000
    battery_level = 100.0
    data = []

    while current_ts <= now_ms:
        dt = datetime.datetime.utcfromtimestamp(current_ts / 1000)
        hour = dt.hour
        day_of_year = dt.timetuple().tm_yday

        # --- Temperature (°C): daily + seasonal variation ---
        seasonal_offset = 5 * np.sin(2 * np.pi * (day_of_year / 365.0))
        temp_daily = daily_cycle(hour, base=22 + seasonal_offset, amplitude=6, phase_shift=6)
        temperature = np.clip(temp_daily + np.random.normal(0, 0.5), 10, 40)

        # --- Humidity (%): inversely correlated with temperature ---
        humidity_base = 65 - (temperature - 20) * 1.2
        humidity = np.clip(humidity_base + np.random.normal(0, 3), 30, 95)

        # --- Battery (%): slow gradual decay + micro noise ---
        battery_level = max(85, battery_level - np.random.uniform(0.00005, 0.00015))
        battery = battery_level + np.random.normal(0, 0.05)

        # --- H₂S (ppm): low baseline + random spikes midday ---
        h2s_base = np.random.normal(0.03, 0.01)
        # Slightly higher when temperature and humidity are high
        h2s = np.clip(h2s_base + 0.001 * (temperature - 25) + 0.0005 * (humidity - 50), 0.001, 0.15)
        # Rare event: gas spike (0.5–1%)
        if random.random() < 0.005:
            h2s *= np.random.uniform(3, 8)

        # --- NH₃ (ppm): similar but more stable ---
        nh3_base = np.random.normal(0.1, 0.02)
        nh3 = np.clip(nh3_base + 0.002 * (temperature - 25) + np.random.normal(0, 0.01), 0.02, 0.5)
        # Rare ammonia spikes
        if random.random() < 0.003:
            nh3 *= np.random.uniform(2, 5)

        # --- Embedded JSON payload (raw_data) ---
        raw_data_dict = {
            "battery": int(round(battery)),
            "h2s": round(h2s, 3),
            "humidity": round(humidity, 1),
            "nh3": round(nh3, 2),
            "temperature": round(temperature, 1)
        }
        raw_data_json = json.dumps(raw_data_dict, ensure_ascii=False)

        data.append([
            int(current_ts),
            round(float(temperature), 6),
            round(float(humidity), 6),
            round(float(battery), 6),
            round(float(h2s), 6),
            round(float(nh3), 6),
            raw_data_json
        ])

        current_ts += step_ms

    return data


def save_to_csv(filename, data):
    with open(filename, mode="w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f, quoting=csv.QUOTE_MINIMAL)
        writer.writerow(fields)
        for row in data:
            writer.writerow(row)


if __name__ == "__main__":
    data = generate_data(start_timestamp, step_minutes)
    save_to_csv(output_csv, data)
    print(f"✅ Generated {len(data)} rows in {output_csv}")
