#!/usr/bin/env python3
import os, json, glob
from math import isfinite
try:
    from fastdtw import fastdtw
except Exception:
    fastdtw = None

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

def load_json(p):
    try:
        with open(p, 'r', encoding='utf-8') as fh:
            return json.load(fh)
    except:
        return None

def chart_success(resp):
    ch = resp.get('chart')
    if not isinstance(ch, dict):
        return False
    series = ch.get('series')
    if not isinstance(series, list) or not series:
        return False
    for s in series:
        data = s.get('data')
        if isinstance(data, list) and len(data) > 0:
            return True
    return False

def intent_metric_ok(resp, target_metric):
    if not target_metric:
        return None
    ch = resp.get('chart')
    if not isinstance(ch, dict):
        return False
    title = (ch.get('title') or {}).get('text') or ''
    if target_metric.lower() in title.lower():
        return True
    # peek into series names
    for s in ch.get('series', []):
        nm = s.get('name') or ''
        if target_metric.lower() in nm.lower():
            return True
    return False

def series_fidelity_dtw(full, down):
    # expects list of [x,y]
    if not full or not down or fastdtw is None:
        return None
    y_full = [p[1] for p in full if p and len(p)==2 and isfinite(p[1])]
    y_down = [p[1] for p in down if p and len(p)==2 and isfinite(p[1])]
    if len(y_full) < 4 or len(y_down) < 4:
        return None
    dist, _ = fastdtw(y_full, y_down)
    return float(dist)

def score_artifacts(run_dir):
    cases = []
    for case_dir in sorted(glob.glob(os.path.join(run_dir, '*'))):
        if not os.path.isdir(case_dir):
            continue
        resp = load_json(os.path.join(case_dir, 'response.json')) or {}
        meta = load_json(os.path.join(case_dir, 'meta.json')) or {}
        ok = chart_success(resp)
        metric_ok = intent_metric_ok(resp, meta.get('target_metric'))
        cases.append({
            'name': meta.get('name'),
            'latency_sec': meta.get('latency_sec'),
            'chart_success': ok,
            'metric_ok': metric_ok
        })
    return {'cases': cases}

def main():
    out_root = os.environ.get('BENCH_OUT', os.path.join(ROOT, 'docs', 'publication', 'artifacts'))
    runs = sorted([p for p in glob.glob(os.path.join(out_root, '*')) if os.path.isdir(p)])
    if not runs:
        print('[score] No runs found in', out_root)
        return
    for run_dir in runs:
        scores = score_artifacts(run_dir)
        with open(os.path.join(run_dir, 'scores.json'), 'w', encoding='utf-8') as fh:
            json.dump(scores, fh, ensure_ascii=False, indent=2)
        print('[score] Wrote', os.path.join(run_dir, 'scores.json'))

if __name__ == '__main__':
    main()
