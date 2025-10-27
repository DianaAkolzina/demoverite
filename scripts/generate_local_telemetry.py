#!/usr/bin/env python3
import os, csv, math, time, json, random, hashlib
from datetime import datetime, timedelta

OUT_DIR = os.environ.get('S3_LOCAL_DIR', 'CSVex_s3')
DAYS = int(os.environ.get('DAYS', '120'))
STEP_MIN_IAQ = int(os.environ.get('STEP_MIN_IAQ', '10'))
STEP_MIN_ENERGY = int(os.environ.get('STEP_MIN_ENERGY', '5'))
STEP_MIN_PEOPLE = int(os.environ.get('STEP_MIN_PEOPLE', '15'))
STEP_MIN_WATER = int(os.environ.get('STEP_MIN_WATER', '10'))
STEP_MIN_GAS = int(os.environ.get('STEP_MIN_GAS', '10'))

DEVICES_CSV = os.path.join(os.path.dirname(__file__), '..', 'graph_gen_data', 'devices.csv')
DEVICE_FIELDS_CSV = os.path.join(os.path.dirname(__file__), '..', 'graph_gen_data', 'device_fields.csv')

now_ms = int(time.time() * 1000)
start_ms = now_ms - DAYS * 24 * 3600 * 1000

def pr(msg):
    print('[generate]', msg)

def seed_from_id(dev_id: str):
    h = hashlib.sha256(dev_id.encode('utf-8')).hexdigest()
    return int(h[:8], 16) & 0x7fffffff

def gen_iaq(seed, start_ts, step_min):
    random.seed(seed); 
    data = []
    step_ms = step_min * 60 * 1000
    ts = start_ts
    while ts <= now_ms:
        dt = datetime.utcfromtimestamp(ts/1000)
        day_frac = (dt.hour*60+dt.minute) / (24*60)
        season = 2.5*math.sin(2*math.pi*(dt.timetuple().tm_yday/365.0))
        temp = 21.5 + 2.2*math.sin(2*math.pi*day_frac) + season + random.gauss(0,0.4)
        hum = max(30,min(70, 55 - (temp-22)*1.2 + random.gauss(0,2)))
        co2 = max(380, 420 + 80*math.sin(2*math.pi*day_frac) + random.gauss(0,40))
        pm25 = max(1, abs(random.gauss(12, 6)))
        pm10 = pm25 + abs(random.gauss(4,2))
        lux = max(5, 50 + 400*max(0,math.sin(2*math.pi*(day_frac-0.1))) + abs(random.gauss(0,30)))
        voc = max(50, 100 + random.gauss(0,10))
        pressure = 1013 + random.gauss(0,6)
        row = [int(ts), round(temp,3), round(hum,3), round(co2,2), round(pm25,3), round(pm10,3), round(lux,2), round(voc,2), round(pressure,2)]
        data.append(row)
        ts += step_ms
    header = ['ts','temperature','humidity','co2','pm25','pm10','lux','voc','pressure']
    return header, data

def gen_people(seed, start_ts, step_min):
    random.seed(seed)
    data = []
    step_ms = step_min * 60 * 1000
    ts = start_ts
    while ts <= now_ms:
        dt = datetime.utcfromtimestamp(ts/1000)
        h = dt.hour
        if h < 7 or h >= 20:
            count = max(0, random.gauss(0.2, 0.3))
        elif 7 <= h < 10:
            count = max(0, random.gauss(3.5, 1.0))
        elif 10 <= h < 16:
            count = max(0, random.gauss(2.2, 0.8))
        else:
            count = max(0, random.gauss(1.2, 0.6))
        data.append([int(ts), round(count, 3)])
        ts += step_ms
    header = ['ts','people_count']
    return header, data

def gen_energy(seed, start_ts, step_min):
    random.seed(seed)
    data = []
    step_ms = step_min * 60 * 1000
    ts = start_ts
    total_kwh = 0.0
    while ts <= now_ms:
        # weekly cycle on amperage
        weekly = 10 + 6*math.sin(2*math.pi*((ts/1000)/(3600*24*7)))
        value = max(0.1, random.gauss(weekly, 2.2))
        power_failure = 1.0 if random.random() < 0.0003 else 0.0
        power_watts = value * 230
        energy_kwh = (power_watts * (step_min/60)) / 1000
        total_kwh += energy_kwh
        raw = json.dumps({"value": round(value,2), "unit":"A", "pf": bool(power_failure)})
        data.append([int(ts), round(value,3), power_failure, 'A', raw, round(total_kwh,3)])
        ts += step_ms
    header = ['ts','value','powerFailure','unit','raw_data','total_kwh']
    return header, data

def gen_water(seed, start_ts, step_min):
    random.seed(seed)
    data = []
    step_ms = step_min * 60 * 1000
    ts = start_ts
    water_total = float(random.randint(10000, 50000))
    while ts <= now_ms:
        dt = datetime.utcfromtimestamp(ts/1000)
        h = dt.hour
        if 6 <= h <= 9 or 17 <= h <= 21:
            flow = random.uniform(2.0,5.0)
        else:
            flow = random.uniform(0.0,1.0)
        if random.random() < 0.001:
            flow += random.uniform(5,15)
        water_total += flow
        temperature = 20 + 3*math.sin(2*math.pi*((h-6)/24)) + random.gauss(0,0.5)
        humidity = 55 - (temperature-20)*0.9 + random.gauss(0,2)
        battery = max(85, 100 - (now_ms - ts)/ (1000*3600*24*365)) + random.gauss(0,0.05)
        raw = json.dumps({"battery": int(round(battery)), "temperature": round(temperature,1), "humidity": round(humidity,1)})
        data.append([int(ts), round(temperature,3), round(humidity,3), round(battery,3), raw, round(water_total,3), round(water_total,3)])
        ts += step_ms
    header = ['ts','temperature','humidity','battery','raw_data','water_total','cubic_value']
    return header, data

def gen_gas(seed, start_ts, step_min):
    random.seed(seed)
    data = []
    step_ms = step_min * 60 * 1000
    ts = start_ts
    while ts <= now_ms:
        dt = datetime.utcfromtimestamp(ts/1000)
        h = dt.hour
        temperature = 22 + 4*math.sin(2*math.pi*(h/24)) + random.gauss(0,0.5)
        humidity = max(30, min(90, 60 - (temperature-20)*1.1 + random.gauss(0,2)))
        battery = max(85, 100 - (now_ms - ts)/ (1000*3600*24*365)) + random.gauss(0,0.05)
        h2s = max(0.001, random.gauss(0.05, 0.02))
        nh3 = max(0.02, random.gauss(0.1, 0.03))
        if random.random() < 0.004:
            h2s *= random.uniform(2,6)
        if random.random() < 0.003:
            nh3 *= random.uniform(1.5,4)
        raw = json.dumps({"battery": int(round(battery)), "h2s": round(h2s,3), "nh3": round(nh3,3)})
        data.append([int(ts), round(temperature,3), round(humidity,3), round(battery,3), round(h2s,4), round(nh3,4), raw])
        ts += step_ms
    header = ['ts','temperature','humidity','battery','h2s','nh3','raw_data']
    return header, data

def pick_generator(label: str):
    l = (label or '').lower()
    if 'iaq' in l or 'air quality' in l or 'airquality' in l:
        return gen_iaq, STEP_MIN_IAQ
    if 'people' in l or 'occupancy' in l:
        return gen_people, STEP_MIN_PEOPLE
    if 'water' in l:
        return gen_water, STEP_MIN_WATER
    if 'odor' in l or 'gas' in l:
        return gen_gas, STEP_MIN_GAS
    # default to energy/power-like
    return gen_energy, STEP_MIN_ENERGY

def parse_fields_override():
    """Return dict cloud_id -> list of fields if override CSV present."""
    out = {}
    if not os.path.exists(DEVICE_FIELDS_CSV):
        return out
    try:
        with open(DEVICE_FIELDS_CSV, newline='', encoding='utf-8') as f:
            reader = csv.DictReader(f)
            for row in reader:
                cid = (row.get('cloud_id') or '').strip()
                raw = (row.get('fields') or '').strip()
                if not cid:
                    continue
                fields = []
                if raw:
                    try:
                        # fields stored as python-like list string
                        fields = json.loads(raw.replace("'", '"'))
                    except Exception:
                        pass
                out[cid] = fields
    except Exception as e:
        pr(f"warn: failed to parse device_fields.csv: {e}")
    return out

def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    if not os.path.exists(DEVICES_CSV):
        pr(f"devices.csv not found at {DEVICES_CSV}")
        return 1
    with open(DEVICES_CSV, newline='', encoding='utf-8') as f:
        rows = list(csv.DictReader(f))
    fields_override = parse_fields_override()
    n = 0
    for row in rows:
        cloud_id = (row.get('cloud_id') or '').strip()
        label = (row.get('label') or '').strip()
        if not cloud_id:
            continue
        # If an override exists and it's empty list, skip generation
        if cloud_id in fields_override and len(fields_override[cloud_id]) == 0:
            continue
        # Generate base series by type
        gen, step = pick_generator(label)
        seed = seed_from_id(cloud_id)
        base_header, data = gen(seed, start_ms, step)
        header = list(base_header)
        # Apply override to match exact columns if provided (preserve ts)
        if cloud_id in fields_override and fields_override[cloud_id]:
            want = ['ts'] + [f for f in fields_override[cloud_id] if f != 'ts']
            header = want
            # Build a map of generator functions per field name
            def val_for(field, ts_index):
                # basic repeatable pseudo-random using seed & position
                rnd = random.Random(seed + ts_index + hash(field) % 997)
                dt = datetime.utcfromtimestamp((start_ms + ts_index*step*60*1000)/1000)
                h = dt.hour
                if field == 'temperature':
                    return round(21.5 + 3*math.sin(2*math.pi*(h/24)) + rnd.gauss(0,0.5), 3)
                if field == 'humidity':
                    return round(max(30,min(75, 55 - rnd.uniform(-1,1) - 0.8*(21.5-20))), 3)
                if field == 'airExchangeRate':
                    return round(max(0.1, min(0.8, 0.3 + rnd.gauss(0,0.05))), 3)
                if field == 'battery':
                    return round(max(85, 100 - (now_ms - (start_ms + ts_index*step*60*1000))/(1000*3600*24*365)) + rnd.gauss(0,0.05), 3)
                if field == 'co2':
                    return round(max(380, 500 + rnd.gauss(0,80)), 2)
                if field == 'lux':
                    return round(max(0, 20 + 400*max(0, math.sin(2*math.pi*((h-7)/24))) + rnd.gauss(0,20)), 2)
                if field == 'pm1':
                    return round(abs(rnd.gauss(8,3)), 3)
                if field == 'pm25':
                    return round(abs(rnd.gauss(12,4)), 3)
                if field == 'pm10':
                    return round(abs(rnd.gauss(18,6)), 3)
                if field == 'pressure':
                    return round(1013 + rnd.gauss(0, 5), 2)
                if field == 'rssi':
                    return round(-50 + rnd.gauss(0, 4), 2)
                if field == 'time':
                    return int((start_ms + ts_index*step*60*1000)/1000)
                if field == 'virusRisk':
                    return round(max(0, 1.2 + rnd.gauss(0,0.15)), 3)
                if field == 'voc':
                    return round(100 + rnd.gauss(0, 10), 3)
                if field == 'occupants':
                    return round(max(0, rnd.gauss(1.5, 0.7)), 3)
                if field == 'occupantsLower':
                    base = max(0, rnd.gauss(1.5, 0.7))
                    return round(max(0, base - abs(rnd.gauss(0.3,0.2))), 3)
                if field == 'occupantsUpper':
                    base = max(0, rnd.gauss(1.5, 0.7))
                    return round(base + abs(rnd.gauss(0.3,0.2)), 3)
                if field == 'radonShortTermAvg':
                    return round(max(10, rnd.gauss(40, 10)), 3)
                if field == 'mold':
                    return round(max(0, min(1, rnd.gauss(0.2, 0.1))), 3)
                if field == 'value':
                    return round(max(0.1, rnd.gauss(12, 3)), 3)
                if field == 'powerFailure':
                    return float(1.0 if rnd.random() < 0.0003 else 0.0)
                if field == 'unit':
                    return 'A'
                if field == 'raw_data':
                    return json.dumps({"ok": True})
                if field == 'total_kwh':
                    # approx integrator of value over time
                    return round(0.01*ts_index, 3)
                if field == 'raw':
                    return json.dumps({"motion": bool(rnd.random()<0.1)})
                if field == 'motion':
                    return float(1.0 if rnd.random() < (0.15 if 7 <= h <= 20 else 0.02) else 0.0)
                # water/gas extras if present in mapping
                if field == 'water_total' or field == 'cubic_value':
                    return round(10000 + 0.5*ts_index + rnd.gauss(0,2), 3)
                if field == 'h2s':
                    v = max(0.001, rnd.gauss(0.05, 0.02))
                    return round(v, 4)
                if field == 'nh3':
                    v = max(0.02, rnd.gauss(0.1, 0.03))
                    return round(v, 4)
                return None
            # rebuild rows with override header
            # compute number of points from base data
            num = len(data)
            step_infer_min = step
            rebuilt = []
            for i in range(num):
                row = []
                for f in header:
                    if f == 'ts':
                        row.append(data[i][0])
                    else:
                        row.append(val_for(f, i))
                rebuilt.append(row)
            data = rebuilt
        out_path = os.path.join(OUT_DIR, f"{cloud_id}.csv")
        with open(out_path, 'w', newline='', encoding='utf-8') as w:
            writer = csv.writer(w)
            writer.writerow(header)
            writer.writerows(data)
        n += 1
    pr(f"Generated {n} device CSVs in {OUT_DIR}")
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
