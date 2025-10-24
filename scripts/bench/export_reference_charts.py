#!/usr/bin/env python3
"""
Export reference charts for tests.yaml by computing ground-truth plots from CSVs.

Outputs PNGs alongside model figures so they can be paired in the paper:
  docs/publication/figures/<latest_run>/<case>_ref.png

Covers:
- Daily averages across rooms (line, with combined)
- Hourly averages across rooms (line)
- Histogram (lux) in a room (column)
- Correlation heatmap (temp, humidity, co2)
- Scatter (lux vs outside temp)
- Threshold lines for compliance/bands (line)
- Baseline forecasts (flat extension using last bucket mean)
"""
import os, csv, glob, math, time
import yaml
from typing import List, Dict, Any, Optional, Tuple

try:
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    import matplotlib.dates as mdates
    from datetime import datetime, timedelta
except Exception as e:
    print('[ref_export] matplotlib not available:', e)
    raise SystemExit(1)

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
ART_DIR = os.path.join(ROOT, 'docs', 'publication', 'artifacts')
FIG_DIR = os.path.join(ROOT, 'docs', 'publication', 'figures')


def ensure_dir(p: str):
    os.makedirs(p, exist_ok=True)


def load_yaml(path: str):
    with open(path, 'r', encoding='utf-8') as fh:
        return yaml.safe_load(fh)


def detect_csv_root() -> Optional[str]:
    candidates = []
    env = os.environ.get('CSV_DIR')
    if env: candidates.append(env)
    candidates += [os.path.join(ROOT, 'csvex_enriched'), os.path.join(ROOT, 'CSVex_enriched')]
    for c in candidates:
        if os.path.isdir(c):
            return c
    return None


def read_csv_rows(path: str) -> List[Dict[str, Any]]:
    rows = []
    try:
        with open(path, 'r', encoding='utf-8') as fh:
            rdr = csv.DictReader(fh)
            for r in rdr:
                rows.append({k: _to_num(v) for k, v in r.items()})
    except Exception:
        pass
    rows.sort(key=lambda r: r.get('ts', 0))
    return rows


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


def load_room_tables(csv_root: str, room: str):
    tabs = {}
    rdir = os.path.join(csv_root, room)
    if not os.path.isdir(rdir):
        return tabs
    for fn in os.listdir(rdir):
        if not fn.lower().endswith('.csv'): continue
        base = os.path.splitext(fn)[0].lower()
        tabs[base] = read_csv_rows(os.path.join(rdir, fn))
    return tabs


DAY_MS = 24*3600*1000
HOUR_MS = 3600*1000


def within(ts, start, end):
    if start is not None and ts < start: return False
    if end is not None and ts > end: return False
    return True


def bucket_series(rows, field: str, granularity: str, start: int, end: int) -> List[Tuple[int, float]]:
    out = []
    if granularity == 'daily':
        # align to day boundaries (UTC)
        t = (start // DAY_MS) * DAY_MS
        while t <= end:
            vals = [r.get(field) for r in rows if isinstance(r.get('ts'), (int, float)) and t <= r['ts'] <= t+DAY_MS-1 and isinstance(r.get(field), (int, float))]
            if vals:
                out.append((t + DAY_MS//2, sum(vals)/len(vals)))
            t += DAY_MS
    elif granularity == 'hourly':
        t = (start // HOUR_MS) * HOUR_MS
        while t <= end:
            vals = [r.get(field) for r in rows if isinstance(r.get('ts'), (int, float)) and t <= r['ts'] <= t+HOUR_MS-1 and isinstance(r.get(field), (int, float))]
            if vals:
                out.append((t + HOUR_MS//2, sum(vals)/len(vals)))
            t += HOUR_MS
    return out


def to_dt(ms: int) -> datetime:
    return datetime.utcfromtimestamp(ms/1000.0)


def latest_run_dir() -> Optional[str]:
    runs = sorted([p for p in glob.glob(os.path.join(ART_DIR, '*')) if os.path.isdir(p)])
    return runs[-1] if runs else None


def plot_lines(out_path: str, series: List[Tuple[str, List[Tuple[int, float]]]], ylabel: str = ''):
    fig, ax = plt.subplots(figsize=(6.0, 3.4), dpi=160)
    any_plotted = False
    for name, pts in series:
        if not pts:
            continue
        xs = [to_dt(x) for x, _ in pts]
        ys = [y for _, y in pts]
        ax.plot(xs, ys, label=name, linewidth=1.4)
        any_plotted = True
    if not any_plotted:
        plt.close(fig); return
    ax.xaxis.set_major_locator(mdates.AutoDateLocator())
    ax.xaxis.set_major_formatter(mdates.DateFormatter('%Y-%m-%d\n%H:%M'))
    if ylabel:
        ax.set_ylabel(ylabel)
    ax.legend(fontsize=8)
    ax.grid(True, linestyle='--', alpha=0.3)
    fig.tight_layout(); fig.savefig(out_path); plt.close(fig)
    print('[ref_export] Wrote', out_path)


def plot_histogram(out_path: str, values: List[float], bins: int = 20, xlabel: str = 'Value', ylabel: str = 'Count'):
    if not values:
        return
    fig, ax = plt.subplots(figsize=(6.0, 3.4), dpi=160)
    ax.hist(values, bins=bins, alpha=0.8, edgecolor='black')
    ax.set_xlabel(xlabel); ax.set_ylabel(ylabel)
    ax.grid(True, linestyle='--', alpha=0.3)
    fig.tight_layout(); fig.savefig(out_path); plt.close(fig)
    print('[ref_export] Wrote', out_path)


def plot_heatmap(out_path: str, labels_x: List[str], labels_y: List[str], grid: List[List[float]]):
    if not grid:
        return
    fig, ax = plt.subplots(figsize=(5.0, 4.2), dpi=160)
    import numpy as np
    arr = np.array(grid)
    im = ax.imshow(arr, cmap='coolwarm', vmin=-1, vmax=1)
    ax.set_xticks(range(len(labels_x))); ax.set_xticklabels(labels_x, rotation=45, ha='right', fontsize=8)
    ax.set_yticks(range(len(labels_y))); ax.set_yticklabels(labels_y, fontsize=8)
    fig.colorbar(im, ax=ax, fraction=0.046, pad=0.04)
    fig.tight_layout(); fig.savefig(out_path); plt.close(fig)
    print('[ref_export] Wrote', out_path)


def plot_scatter(out_path: str, pairs: List[Tuple[float, float]], xlabel: str, ylabel: str):
    if not pairs:
        return
    xs = [p[0] for p in pairs]; ys = [p[1] for p in pairs]
    fig, ax = plt.subplots(figsize=(6.0, 3.4), dpi=160)
    ax.scatter(xs, ys, s=10, alpha=0.6)
    ax.set_xlabel(xlabel); ax.set_ylabel(ylabel)
    ax.grid(True, linestyle='--', alpha=0.3)
    fig.tight_layout(); fig.savefig(out_path); plt.close(fig)
    print('[ref_export] Wrote', out_path)


def compute_pairs_aligned(iaq_rows, weather_rows, field: str, start: int, end: int, max_dt_ms: int = 3600*1000):
    pairs = []
    for r in iaq_rows:
        ts = r.get('ts')
        if not isinstance(ts,(int,float)) or not within(ts,start,end): continue
        v = r.get(field)
        if not isinstance(v,(int,float)): continue
        # find nearest weather within max_dt
        best=None; bestdt=10**12
        for w in weather_rows:
            tw = w.get('ts')
            if not isinstance(tw,(int,float)) or not within(tw,start,end): continue
            dt=abs(tw-ts)
            if dt<bestdt:
                best=w; bestdt=dt
            if dt>max_dt_ms and tw>ts:
                break
        if best and bestdt<=max_dt_ms:
            t = best.get('temp')
            if isinstance(t,(int,float)):
                pairs.append((v,t))
    return pairs


def export_for_case(csv_root: str, case: Dict[str, Any], out_dir: str, weather_rows: List[Dict[str, Any]]):
    name = case.get('name'); room = case.get('room'); q = (case.get('question') or '').lower()
    rng = case.get('range') or {}; start = rng.get('start'); end = rng.get('end')
    target_chart = case.get('target_chart')
    if not room:
        return
    tabs = load_room_tables(csv_root, room)
    iaq = tabs.get('iaq') or tabs.get('env') or []

    out_path = os.path.join(out_dir, f"{name}_ref.png")

    # Daily/Hourly comparisons
    if target_chart == 'line' and 'daily average' in q and 'humidity' in q and 'b_f3_lab' in q and 'b_f3_toilet' in q:
        lab = load_room_tables(csv_root, 'B_F3_lab'); toilet = load_room_tables(csv_root, 'B_F3_toilet')
        s_lab = bucket_series(lab.get('iaq') or [], 'humidity', 'daily', start, end)
        s_toilet = bucket_series(toilet.get('iaq') or [], 'humidity', 'daily', start, end)
        # combined by index
        by_day = {}
        for x,y in s_lab: by_day.setdefault(x, {})['lab']=y
        for x,y in s_toilet: by_day.setdefault(x, {})['toilet']=y
        s_combined = sorted([(x, (v.get('lab', float('nan')) + v.get('toilet', float('nan'))) / 2.0) for x, v in by_day.items() if 'lab' in v and 'toilet' in v])
        plot_lines(out_path, [( 'B_F3_lab', s_lab), ('B_F3_toilet', s_toilet), ('combined', s_combined)], ylabel='%')
        return
    if target_chart == 'line' and 'daily average' in q and 'co2' in q and 'b_f3_lab' in q and 'b_f3_toilet' in q:
        lab = load_room_tables(csv_root, 'B_F3_lab'); toilet = load_room_tables(csv_root, 'B_F3_toilet')
        s_lab = bucket_series(lab.get('iaq') or [], 'co2', 'daily', start, end)
        s_toilet = bucket_series(toilet.get('iaq') or [], 'co2', 'daily', start, end)
        by_day = {}
        for x,y in s_lab: by_day.setdefault(x, {})['lab']=y
        for x,y in s_toilet: by_day.setdefault(x, {})['toilet']=y
        s_combined = sorted([(x, (v.get('lab', float('nan')) + v.get('toilet', float('nan'))) / 2.0) for x, v in by_day.items() if 'lab' in v and 'toilet' in v])
        plot_lines(out_path, [( 'B_F3_lab', s_lab), ('B_F3_toilet', s_toilet), ('combined', s_combined)], ylabel='ppm')
        return
    if target_chart == 'line' and 'hourly' in q and 'temperature' in q and 'b_f3_lab' in q and 'b_f3_toilet' in q:
        lab = load_room_tables(csv_root, 'B_F3_lab'); toilet = load_room_tables(csv_root, 'B_F3_toilet')
        s_lab = bucket_series(lab.get('iaq') or [], 'temperature', 'hourly', start, end)
        s_toilet = bucket_series(toilet.get('iaq') or [], 'temperature', 'hourly', start, end)
        plot_lines(out_path, [( 'B_F3_lab', s_lab), ('B_F3_toilet', s_toilet)], ylabel='°C')
        return

    # Histogram of lux
    if target_chart in ('column','bar') and 'histogram' in q and 'lux' in q:
        vals = [r.get('lux') for r in iaq if isinstance(r.get('ts'),(int,float)) and within(r.get('ts'), start, end) and isinstance(r.get('lux'), (int,float))]
        plot_histogram(out_path, vals, bins=20, xlabel='lux', ylabel='count')
        return

    # Heatmap correlation temp/humidity/co2
    if target_chart == 'heatmap' and 'correlation heatmap' in q:
        # Align by ts
        rows = [r for r in iaq if isinstance(r.get('ts'),(int,float)) and within(r['ts'], start, end)]
        temps=[]; hums=[]; co2s=[]
        for r in rows:
            t=r.get('temperature'); h=r.get('humidity'); c=r.get('co2')
            if all(isinstance(v,(int,float)) for v in (t,h,c)):
                temps.append(t); hums.append(h); co2s.append(c)
        import numpy as np
        def pearson(xs, ys):
            n=min(len(xs), len(ys))
            if n<3: return float('nan')
            xs=xs[:n]; ys=ys[:n]
            mx=sum(xs)/n; my=sum(ys)/n
            num=sum((xs[i]-mx)*(ys[i]-my) for i in range(n))
            den=math.sqrt(sum((xs[i]-mx)**2 for i in range(n))*sum((ys[i]-my)**2 for i in range(n)))
            return (num/den) if den else float('nan')
        labels=['temp','humidity','co2']
        arr=[[1.0, pearson(temps,hums), pearson(temps,co2s)],
             [pearson(hums,temps), 1.0, pearson(hums,co2s)],
             [pearson(co2s,temps), pearson(co2s,hums), 1.0]]
        plot_heatmap(out_path, labels, labels, arr)
        return

    # Scatter: lux vs outside temp
    if target_chart == 'scatter' and 'scatter' in q and 'lux' in q and 'outside temperature' in q:
        pairs = compute_pairs_aligned(iaq, weather_rows, 'lux', start, end)
        plot_scatter(out_path, pairs, xlabel='lux', ylabel='outside temp (°C)')
        return

    # L3 compliance/band charts
    if target_chart == 'line' and 'recommended 800 ppm' in q and 'co2' in q:
        series = bucket_series(iaq, 'co2', 'hourly', start, end)
        if series:
            fig, ax = plt.subplots(figsize=(6.0, 3.4), dpi=160)
            xs=[to_dt(x) for x,_ in series]; ys=[y for _,y in series]
            ax.plot(xs, ys, label='CO2', linewidth=1.4)
            ax.axhline(800, color='red', linestyle='--', linewidth=1.0, label='800 ppm')
            ax.xaxis.set_major_locator(mdates.AutoDateLocator())
            ax.xaxis.set_major_formatter(mdates.DateFormatter('%Y-%m-%d\n%H:%M'))
            ax.set_ylabel('ppm'); ax.legend(fontsize=8); ax.grid(True, linestyle='--', alpha=0.3)
            fig.tight_layout(); fig.savefig(out_path); plt.close(fig)
            print('[ref_export] Wrote', out_path)
        return
    if target_chart == 'line' and 'humidity' in q and '40-60%' in q:
        series = bucket_series(iaq, 'humidity', 'hourly', start, end)
        if series:
            fig, ax = plt.subplots(figsize=(6.0, 3.4), dpi=160)
            xs=[to_dt(x) for x,_ in series]; ys=[y for _,y in series]
            ax.plot(xs, ys, label='humidity', linewidth=1.4)
            ax.axhline(40, color='orange', linestyle='--', linewidth=1.0, label='40%')
            ax.axhline(60, color='orange', linestyle='--', linewidth=1.0, label='60%')
            ax.xaxis.set_major_locator(mdates.AutoDateLocator())
            ax.xaxis.set_major_formatter(mdates.DateFormatter('%Y-%m-%d\n%H:%M'))
            ax.set_ylabel('%'); ax.legend(fontsize=8); ax.grid(True, linestyle='--', alpha=0.3)
            fig.tight_layout(); fig.savefig(out_path); plt.close(fig)
            print('[ref_export] Wrote', out_path)
        return

    # Forecasts: flat extension
    if target_chart == 'line' and 'forecast' in q or ('predict' in q and target_chart == 'line'):
        if 'co2' in q and ('7' in q and 'day' in q or 'week' in q):
            daily = bucket_series(iaq, 'co2', 'daily', start, end)
            if daily:
                last = daily[-1][1]
                last_t = daily[-1][0]
                fut = [(last_t + i*DAY_MS, last) for i in range(1, 8)]
                plot_lines(out_path, [('daily avg', daily), ('forecast', fut)], ylabel='ppm')
                return
        if 'humidity' in q and ('24' in q and 'hour' in q):
            hourly = bucket_series(iaq, 'humidity', 'hourly', start, end)
            if hourly:
                last = hourly[-1][1]
                last_t = hourly[-1][0]
                fut = [(last_t + i*HOUR_MS, last) for i in range(1, 25)]
                plot_lines(out_path, [('hourly avg', hourly), ('forecast', fut)], ylabel='%')
                return


def main():
    csv_root = detect_csv_root()
    if not csv_root:
        print('[ref_export] Could not detect CSV root. Set CSV_DIR or populate csvex_enriched/.')
        raise SystemExit(1)
    suite_path = os.path.join(ROOT, 'docs', 'publication', 'bench', 'tests.yaml')
    suite = load_yaml(suite_path)
    latest_run = latest_run_dir()
    if not latest_run:
        print('[ref_export] No bench artifacts found; run the bench first.')
        raise SystemExit(1)
    out_dir = os.path.join(FIG_DIR, os.path.basename(latest_run))
    ensure_dir(out_dir)
    # load weather once
    weather_rows = []
    for p in [os.path.join(csv_root, 'weather', 'weather.csv'), os.path.join(csv_root, 'weather.csv')]:
        if os.path.isfile(p):
            weather_rows = read_csv_rows(p)
            break
    for case in suite.get('tests', []):
        try:
            export_for_case(csv_root, case, out_dir, weather_rows)
        except Exception as e:
            print(f"[ref_export] Failed for {case.get('name')}: {e}")

if __name__ == '__main__':
    main()

