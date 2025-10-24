#!/usr/bin/env python3
"""
Reference-free answer evaluation using only question + tool traces.

Metrics (all provider-agnostic, no OpenAI):
- Grounding precision: fraction of numbers in the answer that are supported by numeric evidence in the tool trace (within tolerance).
- Intent coverage: fraction of key entities (metrics/rooms/ops) from the question mentioned in the answer.
- Plausibility: penalty for numbers outside domain-plausible ranges given the metric context.

Optional: Gemini evidence-judge (0..1) if GEMINI_API_KEY is set to score
"Is the answer supported by the provided tool outputs?". Skips silently if unset.

Outputs:
- docs/publication/results/answers_noref.json
- docs/publication/results/answers_noref.tex
"""
import os, json, glob, re, math
from typing import Any, Dict, List, Optional, Tuple

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
RES_DIR = os.path.join(ROOT, 'docs', 'publication', 'results')
ART_DIR = os.path.join(ROOT, 'docs', 'publication', 'artifacts')


def ensure_dir(p: str):
    os.makedirs(p, exist_ok=True)


def load_json(p: str):
    try:
        with open(p, 'r', encoding='utf-8') as fh:
            return json.load(fh)
    except Exception:
        return None


def collect_cases(root: str):
    rows = []
    runs = sorted([p for p in glob.glob(os.path.join(root, '*')) if os.path.isdir(p)])
    for run_dir in runs:
        for case_dir in sorted(glob.glob(os.path.join(run_dir, '*'))):
            if not os.path.isdir(case_dir):
                continue
            meta = load_json(os.path.join(case_dir, 'meta.json')) or {}
            resp = load_json(os.path.join(case_dir, 'response.json')) or {}
            ans = ((resp.get('message') or {}).get('content')) or None
            if not ans:
                continue
            rows.append({
                'run': os.path.basename(run_dir),
                'name': meta.get('name') or os.path.basename(case_dir),
                'question': (meta.get('question') or '').strip(),
                'answer': ans,
                'trace': resp.get('trace') or [],
            })
    return rows


# --------- Utilities ---------

_NUM_RE = re.compile(r"[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?")


def extract_numbers(s: str) -> List[Tuple[float, int, int]]:
    out = []
    if not s:
        return out
    for m in _NUM_RE.finditer(s):
        try:
            out.append((float(m.group(0)), m.start(), m.end()))
        except Exception:
            pass
    return out


def normalize(s: str) -> str:
    return (s or '').lower().strip()


def tokens(s: str) -> List[str]:
    return [t for t in re.split(r"[^a-zA-Z0-9_]+", normalize(s)) if t]


def gather_numeric_evidence(obj: Any, vals: List[float]):
    if obj is None:
        return
    if isinstance(obj, (int, float)):
        vals.append(float(obj))
    elif isinstance(obj, dict):
        for v in obj.values():
            gather_numeric_evidence(v, vals)
    elif isinstance(obj, list):
        for v in obj:
            gather_numeric_evidence(v, vals)


def summarize_evidence(trace: List[Dict[str, Any]]) -> List[float]:
    vals: List[float] = []
    for item in trace or []:
        res = item.get('result')
        gather_numeric_evidence(res, vals)
    # deduplicate approximately
    uniq: List[float] = []
    for v in vals:
        if not any(abs(v - u) <= max(1e-6, 1e-3 * max(1.0, abs(u))) for u in uniq):
            uniq.append(v)
    return uniq


def grounding_precision(answer: str, evidence_vals: List[float], rel_tol: float = 0.02, abs_tol: float = 1e-2) -> Optional[float]:
    nums = extract_numbers(answer)
    if not nums:
        return None
    hits = 0
    for v, _, _ in nums:
        ok = any(abs(v - ev) <= max(abs_tol, rel_tol * max(1.0, abs(ev))) for ev in evidence_vals)
        if ok:
            hits += 1
    return hits / len(nums)


METRICS = ['temperature','humidity','co2','lux','pm25','pm10','voc','people','people_count','energy','kwh']
OPS = ['latest','average','avg','daily','hourly','correlation','heatmap','histogram','increase','decrease','compare','forecast']


def intent_coverage(question: str, answer: str) -> Optional[float]:
    qtok = set(tokens(question))
    atok = set(tokens(answer))
    keys = set([t for t in qtok if (t in METRICS or t in OPS or t.startswith('b_'))])
    if not keys:
        return None
    covered = sum(1 for k in keys if k in atok)
    return covered / len(keys)


# Plausibility ranges by metric/unit
RANGES = {
    'co2': (250, 10000),
    'humidity': (0, 100),
    'temperature': (-30, 60),
    'lux': (0, 200000),
    'pm25': (0, 1000),
    'pm10': (0, 2000),
    'voc': (0, 10000),
    'people': (0, 100000),
    'energy': (0, 1e9),
}

UNIT_HINTS = {
    'ppm': 'co2',
    '%': 'humidity',
    '°c': 'temperature',
    'c': 'temperature',  # plain C
    'lux': 'lux',
    'kwh': 'energy',
}


def plausibility_penalty(question: str, answer: str) -> Optional[float]:
    atok = tokens(answer)
    qtok = tokens(question)
    # infer dominant metric from question if one exists
    metric = None
    for m in METRICS:
        if m in qtok:
            metric = m
            break
    nums = extract_numbers(answer)
    if not nums:
        return None
    bad = 0
    for i, (v, s, e) in enumerate(nums):
        # find nearby unit within window
        window = answer[max(0, s - 8):min(len(answer), e + 8)].lower()
        unit_metric = None
        for unit, m in UNIT_HINTS.items():
            if unit in window:
                unit_metric = m
                break
        mkey = unit_metric or metric
        if mkey and mkey in RANGES:
            lo, hi = RANGES[mkey]
            if not (lo - 1e-6 <= v <= hi + 1e-6):
                bad += 1
    return bad / len(nums) if nums else None


def gemini_evidence_judge(question: str, answer: str, trace: List[Dict[str, Any]]) -> Optional[float]:
    key = os.environ.get('GEMINI_API_KEY')
    if not key:
        return None
    try:
        import requests
        model = os.environ.get('GEMINI_MODEL', 'gemini-2.5-flash')
        endpoint = f"https://generativelanguage.googleapis.com/v1beta/models/{model.replace('models/','')}:generateContent?key={key}"
        # Build a short evidence summary (truncate to keep prompt small)
        evidence_vals = summarize_evidence(trace)
        evid_snip = ', '.join(str(round(v, 3)) for v in evidence_vals[:50])
        prompt = (
            "You judge whether the assistant's answer is supported by the tool evidence. "
            "Return a JSON with 'score' 0..1 only. 1 = fully supported.\n\n"
            f"Question:\n{question}\n\nAnswer:\n{answer}\n\nEvidence (numbers extracted from tools):\n{evid_snip}\n\nOutput only JSON."
        )
        body = {"contents": [{"parts": [{"text": prompt}]}]}
        r = requests.post(endpoint, json=body, timeout=20)
        if not r.ok:
            return None
        data = r.json()
        txt = None
        try:
            txt = data['candidates'][0]['content']['parts'][0]['text']
        except Exception:
            return None
        import json as _json
        try:
            obj = _json.loads(txt)
            s = float(obj.get('score'))
            if 0.0 <= s <= 1.0:
                return s
        except Exception:
            return None
    except Exception:
        return None
    return None


def main():
    cases = collect_cases(ART_DIR)
    if not cases:
        ensure_dir(RES_DIR)
        with open(os.path.join(RES_DIR, 'answers_noref.tex'), 'w', encoding='utf-8') as fh:
            fh.write('% No artifacts to score (no-ref)\n')
        print('[answers-noref] No artifacts found; wrote placeholder')
        return

    per_case = []
    gp_scores = []; ic_scores = []; pp_scores = []; gj_scores = []
    for d in cases:
        ev = summarize_evidence(d.get('trace') or [])
        gp = grounding_precision(d['answer'], ev)
        ic = intent_coverage(d['question'], d['answer'])
        pp = plausibility_penalty(d['question'], d['answer'])
        gj = gemini_evidence_judge(d['question'], d['answer'], d.get('trace') or [])
        row = {
            'run': d['run'],
            'name': d['name'],
            'grounding_precision': gp,
            'intent_coverage': ic,
            'plausibility_penalty': pp,
        }
        if isinstance(gj, (int, float)):
            row['gemini_evidence'] = gj
            gj_scores.append(float(gj))
        per_case.append(row)
        if isinstance(gp, (int, float)):
            gp_scores.append(gp)
        if isinstance(ic, (int, float)):
            ic_scores.append(ic)
        if isinstance(pp, (int, float)):
            pp_scores.append(pp)

    summary = {
        'n_cases': len(cases),
        'grounding_precision': float(sum(gp_scores)/len(gp_scores)) if gp_scores else None,
        'intent_coverage': float(sum(ic_scores)/len(ic_scores)) if ic_scores else None,
        'plausibility_penalty': float(sum(pp_scores)/len(pp_scores)) if pp_scores else None,
        'gemini_evidence': float(sum(gj_scores)/len(gj_scores)) if gj_scores else None,
    }

    ensure_dir(RES_DIR)
    with open(os.path.join(RES_DIR, 'answers_noref.json'), 'w', encoding='utf-8') as fh:
        json.dump({'summary': summary, 'cases': per_case}, fh, ensure_ascii=False, indent=2)

    def fm(x):
        return ('{:.3f}'.format(x)) if isinstance(x, (int, float)) else '--'

    tex = [
        '% Reference-free answer faithfulness metrics',
        '\\begin{table}[h]',
        '  \\centering',
        '  \\caption{Reference-free answer evaluation: grounding precision, intent coverage, plausibility penalty.}',
        '  \\begin{tabular}{lccc' + ('c' if summary.get('gemini_evidence') is not None else '') + '}',
        '    \\toprule',
        '    Cases & Grounding & Intent & Plausibility' + (' & Gemini' if summary.get('gemini_evidence') is not None else '') + ' \\\\ \\midrule',
        f"    {summary['n_cases']} & {fm(summary['grounding_precision'])} & {fm(summary['intent_coverage'])} & {fm(summary['plausibility_penalty'])}" + (f" & {fm(summary['gemini_evidence'])}" if summary.get('gemini_evidence') is not None else '') + ' \\\\',
        '    \\bottomrule',
        '  \\end{tabular}',
        '\\end{table}'
    ]
    with open(os.path.join(RES_DIR, 'answers_noref.tex'), 'w', encoding='utf-8') as fh:
        fh.write("\n".join(tex) + "\n")
    print('[answers-noref] Wrote docs/publication/results/answers_noref.tex and answers_noref.json')


if __name__ == '__main__':
    main()

