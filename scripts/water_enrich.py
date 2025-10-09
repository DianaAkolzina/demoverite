import numpy as np
import time
import json
import csv
import datetime
import random

# === CONFIGURATION ===
start_timestamp = 1672531200000  # Jan 1, 2023 (same as other scripts)
step_minutes = 10                # sampling every 10 minutes
output_csv = "water_sensor_data.csv"

fields = ["ts", "temperature", "humidity", "battery", "raw_data", "water_total", "cubic_value"]


def daily_cycle(hour, base, amplitude, phase_shift=0):
    """Generate smooth daily variation (used for temperature)."""
    return base + amplitude * np.sin((2 * np.pi * (hour - phase_shift)) / 24)


def generate_data(start_ts, step_min):
    np.random.seed(42)
    current_ts = start_ts
    now_ms = int(time.time() * 1000)
    step_ms = step_min * 60 * 1000
    battery_level = 100.0
    water_total = 290000  # starting value in liters (or cubic units)
    data = []

    while current_ts <= now_ms:
        dt = datetime.datetime.utcfromtimestamp(current_ts / 1000)
        hour = dt.hour
        day_of_year = dt.timetuple().tm_yday

        # --- Temperature (°C): daily + seasonal variation ---
        seasonal_offset = 5 * np.sin(2 * np.pi * (day_of_year / 365.0))
        temp_daily = daily_cycle(hour, base=22 + seasonal_offset, amplitude=5, phase_shift=6)
        temperature = np.clip(temp_daily + np.random.normal(0, 0.4), 10, 40)

        # --- Humidity (%) ---
        humidity_base = 60 - (temperature - 20) * 0.8
        humidity = np.clip(humidity_base + np.random.normal(0, 2), 30, 90)

        # --- Battery (%): slow decline ---
        battery_level = max(85, battery_level - np.random.uniform(0.00003, 0.00015))
        battery = battery_level + np.random.normal(0, 0.05)

        # --- Water total and flow increment ---
        # Simulate usage pattern: higher in morning/evening, lower at night
        if 6 <= hour <= 9 or 17 <= hour <= 21:
            flow_rate = np.random.uniform(2.0, 5.0)  # liters or m³ per interval
        else:
            flow_rate = np.random.uniform(0.0, 1.0)

        # Random leak event (rare)
        if random.random() < 0.001:
            flow_rate += np.random.uniform(5, 20)

        water_total += flow_rate
        cubic_value = water_total  # total consumption in same units

        # --- Embedded JSON payload ---
        raw_data_dict = {
            "battery": int(round(battery)),
            "humidity": round(humidity, 1),
            "pulse_conv": 1,
            "temperature": round(temperature, 1),
            "water": int(round(water_total)),
            "water_conv": 1
        }
        raw_data_json = json.dumps(raw_data_dict, ensure_ascii=False)

        data.append([
            int(current_ts),
            round(float(temperature), 6),
            round(float(humidity), 6),
            round(float(battery), 6),
            raw_data_json,
            round(float(water_total), 6),
            round(float(cubic_value), 6),
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
