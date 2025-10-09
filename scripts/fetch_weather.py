#!/usr/bin/env python3
import os
import sys
import csv
import time
import pathlib
from typing import List, Dict, Any
try:
    import requests
except Exception:
    print("ERROR: requests is not installed.", file=sys.stderr)
    sys.exit(1)

CSV_TARGET_DIR = os.environ.get('CSV_TARGET_DIR', os.environ.get('CSV_DIR', 'CSVex_enriched'))
WEATHER_DIR = os.path.join(CSV_TARGET_DIR, 'weather')
WEATHER_CSV = os.path.join(WEATHER_DIR, 'weather.csv')

API_KEY = os.environ.get('OPENWEATHER_API_KEY', '').strip()
LAT = os.environ.get('OPENWEATHER_LAT')
LON = os.environ.get('OPENWEATHER_LON')
UNITS = os.environ.get('OPENWEATHER_UNITS', 'metric')
LANG = os.environ.get('OPENWEATHER_LANG', 'en')
BACKFILL_DAYS = int(os.environ.get('OPENWEATHER_BACKFILL_DAYS', '5'))
SLEEP_SEC = float(os.environ.get('OPENWEATHER_RATE_LIMIT_SLEEP', '1.0'))

def ensure_dir(p: str):
    pathlib.Path(p).mkdir(parents=True, exist_ok=True)

def read_existing_csv(path: str) -> List[Dict[str, Any]]:
    if not os.path.exists(path):
        return []
    out: List[Dict[str, Any]] = []
    with open(path, 'r', encoding='utf-8') as f:
        r = csv.DictReader(f)
        for row in r:
            try:
                out.append({
                    'ts': int(float(row.get('ts', 0))),
                    'temp': safe_float(row.get('temp')),
                    'humidity': safe_float(row.get('humidity')),
                    'pressure': safe_float(row.get('pressure')),
                    'wind_speed': safe_float(row.get('wind_speed')),
                    'wind_deg': safe_float(row.get('wind_deg')),
                    'clouds': safe_float(row.get('clouds')),
                    'weather_main': row.get('weather_main'),
                    'weather_desc': row.get('weather_desc')
                })
            except Exception:
                pass
    return out

def write_csv_atomic(path: str, rows: List[Dict[str, Any]]):
    ensure_dir(os.path.dirname(path))
    tmp = path + '.tmp'
    headers = ['ts','temp','humidity','pressure','wind_speed','wind_deg','clouds','weather_main','weather_desc']
    with open(tmp, 'w', encoding='utf-8', newline='') as f:
        w = csv.DictWriter(f, fieldnames=headers)
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k) for k in headers})
    os.replace(tmp, path)

def safe_float(v):
    try:
        return float(v) if v is not None else None
    except Exception:
        return None

def norm_hourly_item(h: Dict[str, Any]) -> Dict[str, Any]:
    ts = int(h.get('dt', 0)) * 1000
    w = h.get('weather') or []
    desc = w[0]['description'] if w and isinstance(w, list) and w[0].get('description') else None
    main = w[0]['main'] if w and isinstance(w, list) and w[0].get('main') else None
    return {
        'ts': ts,
        'temp': h.get('temp'),
        'humidity': h.get('humidity'),
        'pressure': h.get('pressure'),
        'wind_speed': h.get('wind_speed'),
        'wind_deg': h.get('wind_deg'),
        'clouds': h.get('clouds'),
        'weather_main': main,
        'weather_desc': desc
    }

def fetch_timemachine(lat: str, lon: str, dt_unix: int) -> List[Dict[str, Any]]:
    url = 'https://api.openweathermap.org/data/3.0/onecall/timemachine'
    params = {
        'lat': lat,
        'lon': lon,
        'dt': dt_unix,
        'appid': API_KEY,
        'units': UNITS,
        'lang': LANG,
    }
    r = requests.get(url, params=params, timeout=20)
    if r.status_code != 200:
        raise RuntimeError(f"HTTP {r.status_code}: {r.text[:200]}")
    data = r.json()
    hourly = data.get('hourly') or []
    return [norm_hourly_item(h) for h in hourly]

def fetch_current(lat: str, lon: str) -> Dict[str, Any]:
    url = 'https://api.openweathermap.org/data/2.5/weather'
    params = { 'lat': lat, 'lon': lon, 'appid': API_KEY, 'units': UNITS, 'lang': LANG }
    r = requests.get(url, params=params, timeout=15)
    if r.status_code != 200:
        raise RuntimeError(f"HTTP {r.status_code}: {r.text[:200]}")
    d = r.json()
    ts = int(d.get('dt', 0))*1000
    w = d.get('weather') or []
    desc = w[0]['description'] if w else None
    main = w[0]['main'] if w else None
    return {
        'ts': ts,
        'temp': (d.get('main') or {}).get('temp'),
        'humidity': (d.get('main') or {}).get('humidity'),
        'pressure': (d.get('main') or {}).get('pressure'),
        'wind_speed': (d.get('wind') or {}).get('speed'),
        'wind_deg': (d.get('wind') or {}).get('deg'),
        'clouds': (d.get('clouds') or {}).get('all'),
        'weather_main': main,
        'weather_desc': desc
    }

def fetch_forecast(lat: str, lon: str) -> List[Dict[str, Any]]:
    url = 'https://api.openweathermap.org/data/2.5/forecast'
    params = { 'lat': lat, 'lon': lon, 'appid': API_KEY, 'units': UNITS, 'lang': LANG }
    r = requests.get(url, params=params, timeout=20)
    if r.status_code != 200:
        raise RuntimeError(f"HTTP {r.status_code}: {r.text[:200]}")
    data = r.json()
    out = []
    for it in data.get('list') or []:
        ts = int(it.get('dt', 0))*1000
        main = it.get('weather')[0]['main'] if it.get('weather') else None
        desc = it.get('weather')[0]['description'] if it.get('weather') else None
        out.append({
            'ts': ts,
            'temp': (it.get('main') or {}).get('temp'),
            'humidity': (it.get('main') or {}).get('humidity'),
            'pressure': (it.get('main') or {}).get('pressure'),
            'wind_speed': (it.get('wind') or {}).get('speed'),
            'wind_deg': (it.get('wind') or {}).get('deg'),
            'clouds': (it.get('clouds') or {}).get('all'),
            'weather_main': main,
            'weather_desc': desc
        })
    return out

def merge_and_dedupe(existing: List[Dict[str, Any]], new_rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    by_ts: Dict[int, Dict[str, Any]] = { int(r['ts']): r for r in existing if r.get('ts') is not None }
    for r in new_rows:
        ts = int(r.get('ts', 0))
        if ts:
            by_ts[ts] = r
    merged = list(by_ts.values())
    merged.sort(key=lambda r: r.get('ts') or 0)
    return merged

def main():
    if not API_KEY or not LAT or not LON:
        print('[weather] Skipping fetch: OPENWEATHER_API_KEY/LAT/LON not set')
        return
    ensure_dir(WEATHER_DIR)
    existing = read_existing_csv(WEATHER_CSV)
    latest_ts = max([r['ts'] for r in existing], default=0)
    now_ms = int(time.time()*1000)
    start_ms = max(now_ms - BACKFILL_DAYS*86400*1000, latest_ts + 3600*1000)
    new_rows: List[Dict[str, Any]] = []
    day = int(now_ms/1000) // 86400
    min_day = int(start_ms/1000) // 86400
    while day >= min_day:
        dt_unix = day*86400 + 12*3600
        try:
            rows = fetch_timemachine(LAT, LON, dt_unix)
            rows = [r for r in rows if r['ts'] >= start_ms and r['ts'] <= now_ms]
            if rows:
                print(f"[weather] fetched {len(rows)} hourly rows for day {day}")
                new_rows.extend(rows)
            time.sleep(SLEEP_SEC)
        except Exception as e:
            print(f"[weather][warn] timemachine {day}: {e}")
        day -= 1
    try:
        cur = fetch_current(LAT, LON)
        if cur.get('ts'):
            new_rows.append(cur)
    except Exception as e:
        print(f"[weather][warn] current: {e}")
    time.sleep(SLEEP_SEC)
    try:
        fut = fetch_forecast(LAT, LON)
        new_rows.extend(fut)
    except Exception as e:
        print(f"[weather][warn] forecast: {e}")
    merged = merge_and_dedupe(existing, new_rows)
    write_csv_atomic(WEATHER_CSV, merged)
    print(f"[weather] wrote {len(merged)} rows to {WEATHER_CSV}")

if __name__ == '__main__':
    main()
