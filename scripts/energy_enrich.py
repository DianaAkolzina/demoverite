import numpy as np
import pandas as pd
import time
import json
import datetime
import random
import csv

# === CONFIGURATION ===
start_timestamp = 1672531200000  # Jan 1, 2023
step_minutes = 5                 # Sampling every 5 minutes
output_csv = "power_data.csv"
device_id = "8e00d400-479a-11f0-bf13-bf19a72566f6"

fields = ["ts", "value", "powerFailure", "unit", "raw_data", "total_kwh"]


def generate_data(start_ts, step_min):
    np.random.seed(42)
    current_ts = start_ts
    now_ms = int(time.time() * 1000)
    step_ms = step_min * 60 * 1000
    total_kwh = 0.0
    data = []

    while current_ts <= now_ms:
        # Simulate amperage (A)
        base_load = 10 + 5 * np.sin((current_ts / (1000 * 60 * 60 * 24)) * 2 * np.pi / 7)  # weekly cycle
        noise = np.random.normal(0, 2)
        value = np.clip(base_load + noise, 0.1, 40.0)

        # Random rare power failure
        powerFailure = 1.0 if np.random.random() < 0.0005 else 0.0

        # Total kWh accumulation
        power_watts = value * 230
        energy_kwh = (power_watts * (step_min / 60)) / 1000
        total_kwh += energy_kwh

        # Random timestamp for nested JSON
        random_days_offset = np.random.randint(0, 120)
        random_time = datetime.datetime.utcnow() - datetime.timedelta(
            days=random_days_offset,
            hours=random.randint(0, 23),
            minutes=random.randint(0, 59)
        )
        random_time_str = random_time.strftime("%Y-%m-%d %H:%M:%S")

        raw_data_dict = {
            "timestamp": random_time_str,
            "deviceName": device_id,
            "powerFailureDetected": str(powerFailure > 0).lower(),
            "channel1": {
                "value": round(value, 2),
                "unit": "A"
            }
        }
        raw_data_json = json.dumps(raw_data_dict, ensure_ascii=False)

        data.append([
            int(current_ts),
            float(value),
            float(powerFailure),
            "A",
            raw_data_json,
            float(total_kwh)
        ])

        current_ts += step_ms

    return data


def save_to_csv(filename, data):
    # Use csv.writer for explicit control over quoting
    with open(filename, mode="w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f, quoting=csv.QUOTE_MINIMAL)
        writer.writerow(fields)
        for row in data:
            # Only quote the 'unit' and 'raw_data' fields
            writer.writerow([
                row[0],               # ts (numeric)
                row[1],               # value (numeric)
                row[2],               # powerFailure (numeric)
                row[3],               # unit (string)
                row[4],               # raw_data (JSON string)
                row[5]                # total_kwh (numeric)
            ])


if __name__ == "__main__":
    data = generate_data(start_timestamp, step_minutes)
    save_to_csv(output_csv, data)
    print(f"✅ Generated {len(data)} rows in {output_csv}")
