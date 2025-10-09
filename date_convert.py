import os
import pandas as pd
from datetime import datetime

# === CONFIGURATION ===
CSV_FOLDER = "CSVex/toilet"  # Path to folder with CSV files (use '.' for current folder)

def convert_ts_to_date(ts):
    """Convert timestamp (ms or s) to human-readable date string."""
    try:
        ts = float(ts)
        if ts > 1e12:  # milliseconds
            ts /= 1000.0
        dt = datetime.utcfromtimestamp(ts)
        return dt.strftime("%Y-%m-%d %H:%M")
    except Exception:
        return None

def process_csv_file(file_path):
    try:
        df = pd.read_csv(file_path)
        if 'ts' not in df.columns:
            print(f"⏭️  Skipping {file_path} — no 'ts' column found.")
            return

        # Create 'date' column from 'ts'
        df['date'] = df['ts'].apply(convert_ts_to_date)

        # Save back to same file (safe overwrite)
        df.to_csv(file_path, index=False, float_format="%.6f")
        print(f"✅ Updated {os.path.basename(file_path)} with 'date' column.")
    except Exception as e:
        print(f"❌ Error processing {file_path}: {e}")

def main():
    csv_files = [f for f in os.listdir(CSV_FOLDER) if f.lower().endswith('.csv')]
    if not csv_files:
        print("⚠️ No CSV files found in folder:", os.path.abspath(CSV_FOLDER))
        return

    for f in csv_files:
        file_path = os.path.join(CSV_FOLDER, f)
        process_csv_file(file_path)

if __name__ == "__main__":
    main()
