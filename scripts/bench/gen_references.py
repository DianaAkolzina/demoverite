#!/usr/bin/env python3
"""
Generate references (ground-truth answers) for selected tests by directly reading local CSV data.
Writes an updated tests.yaml with 'reference' fields where applicable.

Notes:
- Focuses on L1-type queries (latest values) and simple aggregates where clear single answers exist.
- CSV root is detected via env CSV_DIR or defaults to ./csvex_enriched.
"""
import os, sys, csv, time
import yaml
from collections import defaultdict

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

def load_yaml(path):
    with open(path, 'r', encoding='utf-8') as fh:
        return yaml.safe_load(fh)

def save_yaml(path, obj):
    with open(path, 'w', encoding='utf-8') as fh:
        yaml.safe_dump(obj, fh, sort_keys=False, allow_unicode=True)

def detect_csv_root():
    candidates = []
    env = os.environ.get('CSV_DIR')
    if env: candidates.append(env)
    candidates += [os.path.join(ROOT, 'csvex_enriched'), os.path.join(ROOT, 'CSVex_enriched')]
    for c in candidates:
        if os.path.isdir(c):
            return c
    return None

def read_csv_rows(path):
    rows = []
    try:
        with open(path, 'r', encoding='utf-8') as fh:
            rdr = csv.DictReader(fh)
            for r in rdr:
                rr = {k: _to_num(v) for k, v in r.items()}
                rows.append(rr)
        return rows
    except Exception:
        return []

def _to_num(v):
    if v is None: return None
    s = str(v).strip()
    if s == '': return s
    try:
        return int(s)
    except:
        try:
            return float(s)
        except:
            return v

def load_room_tables(csv_root, room):
    room_dir = os.path.join(csv_root, room)
    tables = {}
    if not os.path.isdir(room_dir):
        return tables
    for fn in os.listdir(room_dir):
        if not fn.lower().endswith('.csv'): continue
        base = os.path.splitext(fn)[0].lower()
        rows = read_csv_rows(os.path.join(room_dir, fn))
        if rows:
            rows.sort(key=lambda r: r.get('ts', 0))
            tables[base] = rows
    return tables

def load_weather(csv_root):
    # try csvex_enriched/weather/weather.csv
    candidates = [
        os.path.join(csv_root, 'weather', 'weather.csv'),
        os.path.join(csv_root, 'weather.csv')
    ]
    for p in candidates:
        if os.path.isfile(p):
            rows = read_csv_rows(p)
            rows.sort(key=lambda r: r.get('ts', 0))
            return rows
    return []

def within(ts, start, end):
    if start is not None and ts < start: return False
    if end is not None and ts > end: return False
    return True

def latest_value(rows, field, start=None, end=None):
    latest = None
    for r in rows:
        ts = r.get('ts')
        if ts is None: continue
        if not within(ts, start, end): continue
        latest = r
    if latest is None: return None, None
    return latest.get(field), latest.get('ts')

DAY_MS = 24*3600*1000
HOUR_MS = 3600*1000

def bucket_avg(rows, field, start_ts, end_ts):
    vals = [r.get(field) for r in rows if isinstance(r.get('ts'), (int,float)) and start_ts <= r.get('ts') <= end_ts and isinstance(r.get(field),(int,float))]
    if not vals:
        return None
    return sum(vals)/len(vals)

def format_ts(ts):
    try:
        return time.strftime('%Y-%m-%d %H:%M', time.gmtime(ts/1000.0))
    except Exception:
        return str(ts)

def _fmt_intish(x):
    try:
        xi = int(round(float(x)))
        if abs(float(x) - xi) < 1e-9:
            return str(xi)
    except Exception:
        pass
    try:
        return str(float(x))
    except Exception:
        return str(x)

def generate_reference(csv_root, case):
    name = case.get('name','')
    q = case.get('question','').lower()
    room = case.get('room')
    rng = case.get('range') or {}
    start = rng.get('start'); end = rng.get('end')
    if not room:
        return None
    tables = load_room_tables(csv_root, room)
    iaq = tables.get('iaq') or tables.get('env') or []
    # Load weather (for some refs)
    weather = load_weather(csv_root)
    # L1 latest queries
    if 'latest' in q and 'co2' in q:
        val, ts = latest_value(iaq, 'co2', start, end)
        if isinstance(val, (int, float)) and isinstance(ts, (int, float)):
            return f"Latest CO2 is {int(round(val))} ppm at {format_ts(ts)}."
    if 'latest' in q and 'humidity' in q:
        val, ts = latest_value(iaq, 'humidity', start, end)
        if isinstance(val, (int, float)) and isinstance(ts, (int, float)):
            return f"Latest humidity is {round(float(val), 1)} % at {format_ts(ts)}."
    if 'latest' in q and 'temperature' in q:
        val, ts = latest_value(iaq, 'temperature', start, end)
        if isinstance(val, (int, float)) and isinstance(ts, (int, float)):
            return f"Latest temperature is {round(float(val), 2)} °C at {format_ts(ts)}."
        val, ts = latest_value(iaq, 'co2', start, end)
        if val is not None:
            return f"Latest CO2 is {val} ppm at {format_ts(ts)}."
    if 'latest' in q and 'humidity' in q:
        val, ts = latest_value(iaq, 'humidity', start, end)
        if val is not None:
            return f"Latest humidity is {val} % at {format_ts(ts)}."
    if 'latest' in q and ('temperature' in q or 'temp' in q):
        val, ts = latest_value(iaq, 'temperature', start, end)
        if val is not None:
            return f"Latest temperature is {val} °C at {format_ts(ts)}."
    # L2 daily/ hourly comparisons (summaries)
    if 'daily average' in q and 'humidity' in q and 'b_f3_lab' in q and 'b_f3_toilet' in q:
        # compute per-room mean over period
        def period_mean(room, field):
            tabs = load_room_tables(csv_root, room)
            rows = tabs.get('iaq') or []
            vals = [r.get(field) for r in rows if isinstance(r.get('ts'), (int,float)) and within(r.get('ts'), start, end) and isinstance(r.get(field),(int,float))]
            return round(sum(vals)/len(vals), 2) if vals else None
        lab = period_mean('B_F3_lab', 'humidity')
        toilet = period_mean('B_F3_toilet', 'humidity')
        if lab is not None and toilet is not None:
            combined = round((lab+toilet)/2.0, 2)
            return f"Daily humidity summary — B_F3_lab: {lab}%, B_F3_toilet: {toilet}%, combined: {combined}%."
    if 'daily average' in q and 'co2' in q and 'b_f3_lab' in q and 'b_f3_toilet' in q:
        def period_mean(room, field):
            tabs = load_room_tables(csv_root, room)
            rows = tabs.get('iaq') or []
            vals = [r.get(field) for r in rows if isinstance(r.get('ts'), (int,float)) and within(r.get('ts'), start, end) and isinstance(r.get(field),(int,float))]
            return round(sum(vals)/len(vals), 1) if vals else None
        lab = period_mean('B_F3_lab', 'co2')
        toilet = period_mean('B_F3_toilet', 'co2')
        if lab is not None and toilet is not None:
            combined = round((lab+toilet)/2.0, 1)
            return f"Daily CO2 summary — B_F3_lab: {lab} ppm, B_F3_toilet: {toilet} ppm, combined: {combined} ppm."
    if 'hourly' in q and 'temperature' in q and 'b_f3_lab' in q and 'b_f3_toilet' in q:
        def period_mean(room, field):
            tabs = load_room_tables(csv_root, room)
            rows = tabs.get('iaq') or []
            vals = [r.get(field) for r in rows if isinstance(r.get('ts'), (int,float)) and within(r.get('ts'), start, end) and isinstance(r.get(field),(int,float))]
            return round(sum(vals)/len(vals), 2) if vals else None
        lab = period_mean('B_F3_lab', 'temperature')
        toilet = period_mean('B_F3_toilet', 'temperature')
        if lab is not None and toilet is not None:
            return f"Hourly temperature summary — B_F3_lab: {lab} °C, B_F3_toilet: {toilet} °C."
    # Histogram of lux — report mean/min/max
    if 'histogram' in q and 'lux' in q:
        vals = [r.get('lux') for r in iaq if isinstance(r.get('ts'),(int,float)) and within(r.get('ts'), start, end) and isinstance(r.get('lux'), (int,float))]
        if vals:
            mean = round(sum(vals)/len(vals), 2)
            mn = min(vals); mx = max(vals)
            return f"Lux summary — mean: {mean}, min: {_fmt_intish(mn)}, max: {_fmt_intish(mx)}."
    # Heatmap correlation — temp, humidity, co2
    if 'correlation heatmap' in q and 'temperature' in q and 'humidity' in q and 'co2' in q:
        # simple pearson matching by same ts only
        def pearson(xs, ys):
            n = min(len(xs), len(ys))
            if n < 3: return None
            import math
            mx = sum(xs)/n; my = sum(ys)/n
            num = sum((xs[i]-mx)*(ys[i]-my) for i in range(n))
            den = math.sqrt(sum((xs[i]-mx)**2 for i in range(n))*sum((ys[i]-my)**2 for i in range(n)))
            return (num/den) if den else None
        # build aligned lists by ts
        by_ts = {}
        for r in iaq:
            ts = r.get('ts');
            if not isinstance(ts,(int,float)) or not within(ts,start,end): continue
            by_ts[ts] = {'temperature': r.get('temperature'), 'humidity': r.get('humidity'), 'co2': r.get('co2')}
        temps=[]; hums=[]; co2s=[]
        for ts,vals in by_ts.items():
            if isinstance(vals.get('temperature'),(int,float)) and isinstance(vals.get('humidity'),(int,float)) and isinstance(vals.get('co2'),(int,float)):
                temps.append(vals['temperature']); hums.append(vals['humidity']); co2s.append(vals['co2'])
        ct = pearson(temps,hums); tc = pearson(temps,co2s); hc = pearson(hums,co2s)
        def fm(x):
            return f"{x:.3f}" if isinstance(x,(int,float)) and x==x else "NA"
        return f"Correlation(temp,humidity)={fm(ct)}, Correlation(temp,co2)={fm(tc)}, Correlation(humidity,co2)={fm(hc)}."
    # Scatter: lux vs outside temp — pearson
    if 'scatter' in q and 'lux' in q and 'outside temperature' in q:
        # align nearest weather within 1 hour
        pairs=[]
        for r in iaq:
            ts=r.get('ts')
            if not isinstance(ts,(int,float)) or not within(ts,start,end): continue
            lx = r.get('lux')
            if not isinstance(lx,(int,float)): continue
            # find weather with min |dt|
            best=None; bestdt=10**12
            for w in weather:
                tw = w.get('ts')
                if not isinstance(tw,(int,float)) or not within(tw,start,end): continue
                dt=abs(tw-ts)
                if dt<bestdt:
                    best=w; bestdt=dt
                if dt>3600*1000 and tw>ts: break
            if best and bestdt<=3600*1000:
                t = best.get('temp');
                if isinstance(t,(int,float)):
                    pairs.append((lx,t))
        if len(pairs)>=5:
            xs=[p[0] for p in pairs]; ys=[p[1] for p in pairs]
            # pearson
            import math
            n=len(pairs); mx=sum(xs)/n; my=sum(ys)/n
            num=sum((xs[i]-mx)*(ys[i]-my) for i in range(n))
            den=math.sqrt(sum((xs[i]-mx)**2 for i in range(n))*sum((ys[i]-my)**2 for i in range(n)))
            r = (num/den) if den else None
            if r is not None:
                return f"Correlation(lux, outside temp)={r:.3f} (n={n})."
    # L3 ventilation compliance
    if 'within recommended 800 ppm' in q and 'co2' in q:
        vals=[r.get('co2') for r in iaq if isinstance(r.get('ts'),(int,float)) and within(r.get('ts'),start,end) and isinstance(r.get('co2'),(int,float))]
        if vals:
            under=sum(1 for v in vals if v<=800)
            pct=round(under*100.0/len(vals),1)
            ok='Yes' if pct>=80 else 'No'
            return f"{ok}. {pct}% of samples under 800 ppm."
    # L3 humidity band 40-60%
    if 'within 40-60%' in q and 'humidity' in q:
        vals=[r.get('humidity') for r in iaq if isinstance(r.get('ts'),(int,float)) and within(r.get('ts'),start,end) and isinstance(r.get('humidity'),(int,float))]
        if vals:
            within_band=sum(1 for v in vals if 40<=v<=60)
            pct=round(within_band*100.0/len(vals),1)
            ok='Mostly' if pct>=60 else 'Rarely'
            return f"{ok}. {pct}% of samples within 40-60%."
    # L4 energy reasoning — peak time and correlations
    if 'energy peak' in q or ('energy' in q and 'peak' in q):
        tabs = load_room_tables(csv_root, room)
        energy = tabs.get('energy') or []
        # compute max delta_kwh between consecutive
        best=None; bestd=-1
        for i in range(1,len(energy)):
            prev=energy[i-1]; cur=energy[i]
            if not all(isinstance(x.get('ts'),(int,float)) for x in (prev,cur)): continue
            if not (within(prev['ts'],start,end) and within(cur['ts'],start,end)): continue
            p=prev.get('total_kwh'); c=cur.get('total_kwh')
            if isinstance(p,(int,float)) and isinstance(c,(int,float)):
                d=c-p
                if d>bestd:
                    bestd=d; best=cur
        # correlations
        people = tabs.get('people') or []
        # simple average occupancy and temp over window
        occ_vals=[r.get('people_count') for r in people if isinstance(r.get('ts'),(int,float)) and within(r.get('ts'),start,end) and isinstance(r.get('people_count'),(int,float))]
        temp_vals=[w.get('temp') for w in weather if isinstance(w.get('ts'),(int,float)) and within(w.get('ts'),start,end) and isinstance(w.get('temp'),(int,float))]
        def mean(arr):
            return round(sum(arr)/len(arr),2) if arr else None
        msg=f"Energy peak summary: "
        if best:
            msg+=f"peak at {format_ts(best.get('ts'))} with delta_kwh≈{round(bestd,2)}. "
        if occ_vals:
            msg+=f"avg occupancy≈{mean(occ_vals)}. "
        if temp_vals:
            msg+=f"avg outside temp≈{mean(temp_vals)} °C."
        return msg
    # L4 humidity pattern — daily peaks and correlation
    if 'humidity peaks' in q and 'outside temperature' in q:
        # compute correlation with outside temp as above
        pairs=[]
        for r in iaq:
            ts=r.get('ts')
            if not isinstance(ts,(int,float)) or not within(ts,start,end): continue
            hu=r.get('humidity')
            if not isinstance(hu,(int,float)): continue
            best=None; bestdt=10**12
            for w in weather:
                tw=w.get('ts')
                if not isinstance(tw,(int,float)) or not within(tw,start,end): continue
                dt=abs(tw-ts)
                if dt<bestdt:
                    best=w; bestdt=dt
                if dt>3600*1000 and tw>ts: break
            if best and bestdt<=3600*1000:
                t=best.get('temp')
                if isinstance(t,(int,float)):
                    pairs.append((hu,t))
        corr=None
        if len(pairs)>=5:
            xs=[p[0] for p in pairs]; ys=[p[1] for p in pairs]
            import math
            n=len(pairs); mx=sum(xs)/n; my=sum(ys)/n
            num=sum((xs[i]-mx)*(ys[i]-my) for i in range(n))
            den=math.sqrt(sum((xs[i]-mx)**2 for i in range(n))*sum((ys[i]-my)**2 for i in range(n)))
            corr=(num/den) if den else None
        if corr is not None:
            return f"Humidity vs outside temp correlation={corr:.3f}."
    # Forecast references (baseline summaries)
    if ('forecast' in q or 'predict' in q or 'next' in q or 'tomorrow' in q or 'future' in q):
        # Daily 7 days CO2 forecast
        if ('co2' in q) and ('7' in q and 'day' in q or 'week' in q):
            # last daily average within final day of the range
            day_end = end if isinstance(end,(int,float)) else None
            if day_end is None and iaq:
                day_end = iaq[-1].get('ts')
            if day_end:
                day_start = (int(day_end / DAY_MS))*DAY_MS
                last_daily = bucket_avg(iaq, 'co2', day_start, day_start+DAY_MS-1)
            else:
                last_daily = None
            if last_daily is None:
                # fallback to window mean
                last_daily = bucket_avg(iaq, 'co2', start or -10**15, end or 10**15)
            if last_daily is not None:
                return f"Baseline forecast: last daily avg CO2 ≈ {round(last_daily,1)} ppm; forecasting next 7 days."
        # Hourly 24 hours humidity forecast
        if ('humidity' in q) and ('24' in q and 'hour' in q):
            hour_end = end if isinstance(end,(int,float)) else None
            if hour_end is None and iaq:
                hour_end = iaq[-1].get('ts')
            if hour_end:
                hour_start = hour_end - (hour_end % HOUR_MS)
                last_hour = bucket_avg(iaq, 'humidity', hour_start, hour_start+HOUR_MS-1)
            else:
                last_hour = None
            if last_hour is None:
                last_hour = bucket_avg(iaq, 'humidity', start or -10**15, end or 10**15)
            if last_hour is not None:
                return f"Baseline forecast: last hourly avg humidity ≈ {round(last_hour,2)} %; forecasting next 24 hours."
    # Default: no reference
    return None

def main():
    csv_root = detect_csv_root()
    if not csv_root:
        print('[gen_refs] Could not detect CSV root. Set CSV_DIR or populate csvex_enriched/.')
        sys.exit(1)
    suite_path = os.path.join(ROOT, 'docs', 'publication', 'bench', 'tests.yaml')
    suite = load_yaml(suite_path)
    changed = False
    for case in suite.get('tests', []):
        ref = generate_reference(csv_root, case)
        if ref:
            case['reference'] = ref
            changed = True
            print(f"[gen_refs] {case.get('name')}: reference -> {ref}")
    if changed:
        save_yaml(suite_path, suite)
        print('[gen_refs] Updated', suite_path)
    else:
        print('[gen_refs] No references generated (only L1 supported).')

if __name__ == '__main__':
    main()
