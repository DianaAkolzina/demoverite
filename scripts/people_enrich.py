import numpy as np
import pandas as pd
import time
import math
import csv
import datetime

# === CONFIGURATION ===
start_timestamp = 1672536000000  # e.g., Jan 1, 2023, 02:00 UTC
step_minutes = 60                # hourly sampling
output_csv = "people_count.csv"

fields = ["ts", "people_count"]


def generate_data(start_ts, step_min):
    np.random.seed(42)
    data = []
    current_ts = start_ts
    now_ms = int(time.time() * 1000)
    step_ms = step_min * 60 * 1000

    while current_ts <= now_ms:
        # Convert timestamp to datetime for local hour/day logic
        dt = datetime.datetime.utcfromtimestamp(current_ts / 1000)
        hour = dt.hour

        # --- Determine people_count based on time of day ---
        if hour < 8 or hour >= 19:
            # Before 8 AM or after 7 PM → empty building
            people_count = 0.0
        elif 8 <= hour <= 17:
            # 8 AM–5 PM → gradually decreasing occupancy
            # Max at 8 AM (~3–5 people), linearly drops toward 0 by 5 PM
            t = (hour - 8) / 9.0  # normalized [0,1] between 8 AM and 5 PM
            base = (1 - t) * np.random.uniform(3, 5)
            people_count = max(0, base + np.random.normal(0, 0.2))
        else:
            # 5 PM–7 PM → smooth transition to 0
            t = (hour - 17) / 2.0  # normalized [0,1] between 5 PM and 7 PM
            base = (1 - t) * np.random.uniform(0.5, 1.5)
            people_count = max(0, base + np.random.normal(0, 0.1))

        data.append([
            int(current_ts),
            round(people_count, 6)
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
