#!/usr/bin/env python3
"""
Answer quality scoring over bench artifacts without OpenAI/RAGAS.

Computes reference-based, provider-agnostic metrics:
- Exact match (normalized)
- Token-level F1
- ROUGE-L (F1 variant)
- Numeric accuracy (pairwise numbers within tolerance)

Optional: Gemini judge (scalar 0..1) if GEMINI_API_KEY is set. This is
off by default and safely skipped if not configured or network fails.

Writes:
- docs/publication/results/answers.json (per-case + summary)
- docs/publication/results/answers.tex (LaTeX table for the paper)
"""
import os, json, re, glob, math
from typing import List, Tuple, Optional

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


def collect_dataset(artifacts_root: str):
    rows = []
    runs = sorted([p for p in glob.glob(os.path.join(artifacts_root, '*')) if os.path.isdir(p)])
    for run_dir in runs:
        for case_dir in sorted(glob.glob(os.path.join(run_dir, '*'))):
            if not os.path.isdir(case_dir):
                continue
            meta = load_json(os.path.join(case_dir, 'meta.json')) or {}
            resp = load_json(os.path.join(case_dir, 'response.json')) or {}
            q = (meta.get('question') or '').strip()
            ref = meta.get('reference')
            ans = ((resp.get('message') or {}).get('content')) or None
            if not ans:
                # some responses might have {error: ...}
                continue
            rows.append({
                'run': os.path.basename(run_dir),
                'name': meta.get('name') or os.path.basename(case_dir),
                'question': q,
                'answer': ans,
                'reference': ref
            })
    return rows


# -------- Text normalization and tokenization --------

_WS_RE = re.compile(r"\s+")
_PUNCT_RE = re.compile(r"[\s\t\n\r,;:!\?\(\)\[\]\{\}\-\_\=\+\*/\\\"']+")


def normalize_text(s: str) -> str:
    if s is None:
        return ''
    s = s.strip().lower()
    # collapse whitespace
    s = _WS_RE.sub(' ', s)
    return s


def tokenize(s: str) -> List[str]:
    s = normalize_text(s)
    # split on punctuation/whitespace boundaries
    toks = [t for t in _PUNCT_RE.split(s) if t]
    return toks


# -------- Metrics: Exact, F1, ROUGE-L --------

def exact_match(a: str, b: str) -> float:
    return 1.0 if normalize_text(a) == normalize_text(b) else 0.0


def token_f1(a: str, b: str) -> float:
    ta = tokenize(a)
    tb = tokenize(b)
    if not ta and not tb:
        return 1.0
    if not ta or not tb:
        return 0.0
    from collections import Counter
    ca = Counter(ta); cb = Counter(tb)
    common = sum((ca & cb).values())
    if common == 0:
        return 0.0
    prec = common / max(1, sum(cb.values()))
    rec = common / max(1, sum(ca.values()))
    if prec + rec == 0:
        return 0.0
    return 2 * prec * rec / (prec + rec)


def lcs_len(x: List[str], y: List[str]) -> int:
    # classic DP with O(min(n,m)) memory
    n, m = len(x), len(y)
    if n == 0 or m == 0:
        return 0
    prev = [0] * (m + 1)
    for i in range(1, n + 1):
        cur = [0] * (m + 1)
        xi = x[i - 1]
        for j in range(1, m + 1):
            if xi == y[j - 1]:
                cur[j] = prev[j - 1] + 1
            else:
                cur[j] = prev[j] if prev[j] >= cur[j - 1] else cur[j - 1]
        prev = cur
    return prev[m]


def rouge_l_f1(a: str, b: str) -> float:
    ta = tokenize(a); tb = tokenize(b)
    if not ta and not tb:
        return 1.0
    if not ta or not tb:
        return 0.0
    lcs = lcs_len(ta, tb)
    prec = lcs / len(tb)
    rec = lcs / len(ta)
    if prec + rec == 0:
        return 0.0
    return 2 * prec * rec / (prec + rec)


# -------- Numeric extraction and scoring --------

_NUM_RE = re.compile(r"[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?")


def extract_numbers(s: str) -> List[float]:
    vals = []
    if not s:
        return vals
    for m in _NUM_RE.finditer(s):
        try:
            vals.append(float(m.group(0)))
        except Exception:
            pass
    return vals


def numeric_accuracy(a: str, b: str, rel_tol: float = 0.05, abs_tol: float = 1e-2) -> Optional[float]:
    na = extract_numbers(a)
    nb = extract_numbers(b)
    if not na or not nb:
        return None
    k = min(len(na), len(nb))
    if k == 0:
        return None
    hits = 0
    for i in range(k):
        va, vb = na[i], nb[i]
        if abs(vb - va) <= max(abs_tol, rel_tol * max(1.0, abs(vb))):
            hits += 1
    return hits / k


# -------- Optional Gemini judge --------

def gemini_judge(answer: str, reference: str) -> Optional[float]:
    key = os.environ.get('GEMINI_API_KEY')
    if not key:
        return None
    model = os.environ.get('GEMINI_MODEL', 'gemini-2.5-flash')
    try:
        import requests
        endpoint = f"https://generativelanguage.googleapis.com/v1beta/models/{model.replace('models/','')}:generateContent?key={key}"
        prompt = (
            "You are grading an assistant's answer against a ground-truth reference. "
            "Return a JSON object with fields 'score' (float 0..1) and 'justification' (short). "
            "Score should reflect factual correctness and alignment with the reference; 1 = fully correct, 0 = wrong.\n\n"
            f"Reference:\n{reference}\n\nAnswer:\n{answer}\n\nOutput only JSON."
        )
        body = {"contents": [{"parts": [{"text": prompt}]}]}
        r = requests.post(endpoint, json=body, timeout=20)
        if not r.ok:
            return None
        data = r.json()
        # Extract text
        txt = None
        try:
            txt = data['candidates'][0]['content']['parts'][0]['text']
        except Exception:
            return None
        # Try parse JSON from model output
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
    data = collect_dataset(ART_DIR)
    if not data:
        ensure_dir(RES_DIR)
        with open(os.path.join(RES_DIR, 'answers.tex'), 'w', encoding='utf-8') as fh:
            fh.write('% No artifacts to score\n')
        print('[answers] No artifacts found; wrote empty table placeholder')
        return

    per_case = []
    exacts = []; f1s = []; rouges = []; num_accs = []; gem_scores = []
    n_ref = 0
    for d in data:
        ans = d['answer']
        ref = d.get('reference')
        case = {
            'run': d['run'],
            'name': d['name'],
            'question': d['question'],
            'answer': ans,
            'reference': ref,
        }
        if ref:
            n_ref += 1
            em = exact_match(ans, ref)
            f1 = token_f1(ans, ref)
            rl = rouge_l_f1(ans, ref)
            na = numeric_accuracy(ans, ref)
            case.update({'exact': em, 'f1': f1, 'rougeL': rl, 'numeric_acc': na})
            exacts.append(em); f1s.append(f1); rouges.append(rl)
            if na is not None:
                num_accs.append(na)
            # Optional LLM judge (Gemini) — skip failures silently
            g = gemini_judge(ans, ref)
            if isinstance(g, (int, float)):
                case['gemini_score'] = g
                gem_scores.append(float(g))
        per_case.append(case)

    summary = {
        'n_total': len(data),
        'n_with_reference': n_ref,
        'exact_match': float(sum(exacts) / len(exacts)) if exacts else None,
        'token_f1': float(sum(f1s) / len(f1s)) if f1s else None,
        'rougeL_f1': float(sum(rouges) / len(rouges)) if rouges else None,
        'numeric_accuracy': float(sum(num_accs) / len(num_accs)) if num_accs else None,
        'gemini_score': float(sum(gem_scores) / len(gem_scores)) if gem_scores else None,
    }

    ensure_dir(RES_DIR)
    with open(os.path.join(RES_DIR, 'answers.json'), 'w', encoding='utf-8') as fh:
        json.dump({'summary': summary, 'cases': per_case}, fh, ensure_ascii=False, indent=2)

    # LaTeX: one compact table summarizing averages
    def fm(x):
        return ('{:.3f}'.format(x)) if isinstance(x, (int, float)) else '--'

    tex_lines = [
        '% Answer quality metrics (reference-based, provider-agnostic)',
        '\\begin{table}[h]',
        '  \\centering',
        '  \\caption{Answer quality over bench cases (Exact, Token F1, ROUGE-L, Numeric).}',
        '  \\begin{tabular}{lcccc' + ('c' if summary.get('gemini_score') is not None else '') + '}',
        '    \\toprule',
        '    Cases & Exact & Token F1 & ROUGE-L & Numeric' + (' & Gemini' if summary.get('gemini_score') is not None else '') + ' \\\\ \\midrule',
        f"    {summary['n_with_reference']} of {summary['n_total']} & {fm(summary['exact_match'])} & {fm(summary['token_f1'])} & {fm(summary['rougeL_f1'])} & {fm(summary['numeric_accuracy'])}" + (f" & {fm(summary['gemini_score'])}" if summary.get('gemini_score') is not None else '') + ' \\\\',
        '    \\bottomrule',
        '  \\end{tabular}',
        '\\end{table}'
    ]
    with open(os.path.join(RES_DIR, 'answers.tex'), 'w', encoding='utf-8') as fh:
        fh.write("\n".join(tex_lines) + "\n")
    print('[answers] Wrote docs/publication/results/answers.tex and answers.json')


if __name__ == '__main__':
    main()

