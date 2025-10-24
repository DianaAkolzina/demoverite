#!/usr/bin/env python3
import os, json, glob
import math
try:
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    import matplotlib.dates as mdates
    from datetime import datetime
except Exception as e:
    print('[export] matplotlib not available:', e)
    print('[export] Install deps: pip install -r requirements.txt')
    raise SystemExit(1)

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

def load_json(p):
    try:
        with open(p, 'r', encoding='utf-8') as fh:
            return json.load(fh)
    except:
        return None

def ensure_dir(p):
    os.makedirs(p, exist_ok=True)

def _y_label(chart):
    yaxis = chart.get('yAxis')
    if isinstance(yaxis, list) and yaxis:
        yaxis = yaxis[0]
    if isinstance(yaxis, dict):
        return (yaxis.get('title') or {}).get('text') or ''
    return ''

def _x_label(chart):
    xaxis = chart.get('xAxis')
    if isinstance(xaxis, dict):
        return (xaxis.get('title') or {}).get('text') or ''
    return ''

def plot_heatmap(fig, ax, chart):
    series = (chart.get('series') or [])
    if not series:
        return False
    data = series[0].get('data') or []
    xs = chart.get('xAxis', {}).get('categories') or []
    ys = chart.get('yAxis', {}).get('categories') or []
    # Infer grid size
    max_i = 0; max_j = 0
    for d in data:
        if isinstance(d, (list, tuple)) and len(d) >= 3:
            i, j, _ = d[:3]
            max_i = max(max_i, int(i))
            max_j = max(max_j, int(j))
    grid = [[0.0 for _ in range(max_j+1)] for __ in range(max_i+1)]
    for d in data:
        if isinstance(d, (list, tuple)) and len(d) >= 3:
            i, j, v = d[:3]
            grid[int(i)][int(j)] = float(v)
    im = ax.imshow(grid, cmap='coolwarm', vmin=-1, vmax=1)
    ax.set_xticks(range(len(ys)))
    ax.set_yticks(range(len(xs)))
    if xs: ax.set_yticklabels(xs, fontsize=8)
    if ys: ax.set_xticklabels(ys, fontsize=8, rotation=45, ha='right')
    ax.grid(False)
    fig.colorbar(im, ax=ax, fraction=0.046, pad=0.04)
    return True

def _to_dates(xvals):
    dts = []
    for x in xvals:
        # treat large values as ms epoch
        try:
            if x > 1e11:
                dts.append(datetime.utcfromtimestamp(x/1000.0))
            else:
                dts.append(datetime.utcfromtimestamp(x))
        except Exception:
            # fallback: plot as is
            return None
    return dts

def plot_timeseries(fig, ax, chart):
    series = (chart.get('series') or [])
    any_plotted = False
    for s in series:
        data = s.get('data') or []
        if not data: continue
        xs = [p[0] for p in data if isinstance(p, (list, tuple)) and len(p)>=2]
        ys = [p[1] for p in data if isinstance(p, (list, tuple)) and len(p)>=2]
        if xs and ys:
            dts = _to_dates(xs)
            if dts:
                ax.plot(dts, ys, label=s.get('name') or '', linewidth=1.4)
                # Limit tick density and format date on two lines to avoid overlap
                ax.xaxis.set_major_locator(mdates.AutoDateLocator(minticks=3, maxticks=7))
                ax.xaxis.set_major_formatter(mdates.DateFormatter('%Y-%m-%d\n%H:%M'))
                # Auto-format date labels for spacing
                fig.autofmt_xdate()
            else:
                ax.plot(xs, ys, label=s.get('name') or '', linewidth=1.4)
            any_plotted = True
    if any_plotted:
        ylab = _y_label(chart)
        if ylab:
            ax.set_ylabel(ylab)
        ax.legend(fontsize=8)
        ax.grid(True, linestyle='--', alpha=0.3)
        return True
    return False

def plot_scatter(fig, ax, chart):
    series = (chart.get('series') or [])
    any_plotted = False
    for s in series:
        data = s.get('data') or []
        xs = [p[0] for p in data if isinstance(p, (list, tuple)) and len(p)>=2]
        ys = [p[1] for p in data if isinstance(p, (list, tuple)) and len(p)>=2]
        if xs and ys:
            ax.scatter(xs, ys, s=10, alpha=0.6, label=s.get('name') or '')
            any_plotted = True
    if any_plotted:
        ylab = _y_label(chart)
        if ylab:
            ax.set_ylabel(ylab)
        xlab = _x_label(chart)
        if xlab:
            ax.set_xlabel(xlab)
        ax.legend(fontsize=8)
        ax.grid(True, linestyle='--', alpha=0.3)
        return True
    return False

def plot_column(fig, ax, chart):
    series = (chart.get('series') or [])
    # For histogram series with [binStart, count]
    if not series: return False
    s = series[0]
    data = s.get('data') or []
    if not data: return False
    xs = [p[0] for p in data if isinstance(p, (list, tuple)) and len(p)>=2]
    ys = [p[1] for p in data if isinstance(p, (list, tuple)) and len(p)>=2]
    if not xs or not ys: return False
    # estimate typical bin width
    if len(xs) > 1:
        diffs = sorted([abs(xs[i+1]-xs[i]) for i in range(len(xs)-1)])
        width = 0.9 * (diffs[len(diffs)//2] if diffs else (xs[1]-xs[0]))
    else:
        width = 1.0
    ax.bar(xs, ys, width=width, align='edge', alpha=0.75, label=s.get('name') or '')
    ylab = _y_label(chart) or 'Count'
    ax.set_ylabel(ylab)
    xlab = _x_label(chart) or 'Value'
    ax.set_xlabel(xlab)
    ax.legend(fontsize=8)
    ax.grid(True, linestyle='--', alpha=0.3)
    return True

def export_images(artifacts_root, figures_root):
    runs = sorted([p for p in glob.glob(os.path.join(artifacts_root, '*')) if os.path.isdir(p)])
    if not runs:
        print('[export] No runs to export from')
        return
    for run_dir in runs:
        out_dir = os.path.join(figures_root, os.path.basename(run_dir))
        ensure_dir(out_dir)
        case_dirs = sorted([p for p in glob.glob(os.path.join(run_dir, '*')) if os.path.isdir(p)])
        for cd in case_dirs:
            resp = load_json(os.path.join(cd, 'response.json')) or {}
            chart = resp.get('chart')
            if not isinstance(chart, dict):
                continue
            fig, ax = plt.subplots(figsize=(6.0, 3.4), dpi=160)
            ctype = (chart.get('chart') or {}).get('type') or 'line'
            title = (chart.get('title') or {}).get('text') or ''
            ax.set_title(title, fontsize=10)
            ok = False
            if ctype == 'heatmap':
                ok = plot_heatmap(fig, ax, chart)
            elif ctype == 'scatter':
                ok = plot_scatter(fig, ax, chart)
            elif ctype in ('column','bar'):
                ok = plot_column(fig, ax, chart)
            else:
                ok = plot_timeseries(fig, ax, chart)
            if ok:
                name = os.path.basename(cd)
                out_path = os.path.join(out_dir, f"{name}.png")
                fig.tight_layout()
                fig.savefig(out_path)
                print('[export] Wrote', out_path)
            plt.close(fig)

def main():
    artifacts_root = os.path.join(ROOT, 'docs', 'publication', 'artifacts')
    figures_root = os.path.join(ROOT, 'docs', 'publication', 'figures')
    export_images(artifacts_root, figures_root)

if __name__ == '__main__':
    main()
