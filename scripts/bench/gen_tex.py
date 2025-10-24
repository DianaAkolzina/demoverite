#!/usr/bin/env python3
import os, json, glob, subprocess

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
RES_DIR = os.path.join(ROOT, 'docs', 'publication', 'results')

def pct(x):
    return f"{x*100:.1f}%" if isinstance(x, float) else ("--" if x is None else str(x))

def summarize_scores(scores):
    cases = scores.get('cases', [])
    n = len(cases)
    if n == 0:
        return {'n': 0}
    succ = sum(1 for c in cases if c.get('chart_success'))
    metric_ok = [c.get('metric_ok') for c in cases]
    metric_ok_count = sum(1 for m in metric_ok if m is True)
    lat = [c.get('latency_sec') for c in cases if isinstance(c.get('latency_sec'), (int, float))]
    p95 = None
    try:
        lat_sorted = sorted(lat)
        if lat_sorted:
            idx = int(0.95 * (len(lat_sorted)-1))
            p95 = lat_sorted[idx]
    except:
        p95 = None
    return {
        'n': n,
        'chart_success_rate': succ / n if n else 0.0,
        'metric_ok_rate': metric_ok_count / n if n else 0.0,
        'p95_latency': p95
    }

def write_tables_tex(rows):
    os.makedirs(RES_DIR, exist_ok=True)
    out = []
    out.append("% Auto-generated tables from bench runs")
    out.append("\\begin{table}[h]")
    out.append("  \\centering")
    out.append("  \\caption{Chart reliability summary across runs (this system).}")
    out.append("  \\begin{tabular}{lcccc}")
    out.append("    \\toprule")
    out.append("    Run & Cases & Chart Succ. & Intent OK & p95 Latency (s)\\\\\\midrule")
    for run_name, summary in rows:
        out.append(f"    {run_name} & {summary['n']} & {summary['chart_success_rate']*100:.1f}\\% & {summary['metric_ok_rate']*100:.1f}\\% & {summary['p95_latency'] if summary['p95_latency'] is not None else '--'}\\\\")
    out.append("    \\bottomrule")
    out.append("  \\end{tabular}")
    out.append("\\end{table}")
    with open(os.path.join(RES_DIR, 'tables.tex'), 'w', encoding='utf-8') as fh:
        fh.write("\n".join(out)+"\n")
    print('[gen_tex] Wrote', os.path.join(RES_DIR, 'tables.tex'))

def main():
    artifacts = os.path.join(ROOT, 'docs', 'publication', 'artifacts')
    runs = sorted([p for p in glob.glob(os.path.join(artifacts, '*')) if os.path.isdir(p)])
    if not runs:
        print('[gen_tex] No runs found in', artifacts)
        return
    # Ensure scores exist for all runs
    subprocess.run(['python3', os.path.join(ROOT, 'scripts', 'bench', 'score_charts.py')], check=False)
    rows = []
    for run_dir in runs:
        run_name = os.path.basename(run_dir)
        scores_path = os.path.join(run_dir, 'scores.json')
        if not os.path.exists(scores_path):
            print('[gen_tex] missing scores for', run_name)
            continue
        with open(scores_path, 'r', encoding='utf-8') as fh:
            scores = json.load(fh)
        summary = summarize_scores(scores)
        rows.append((run_name, summary))
    if not rows:
        print('[gen_tex] No scored runs found')
        return
    write_tables_tex(rows)

if __name__ == '__main__':
    main()
