#!/usr/bin/env python3
import os, sys, json, time, datetime
import requests
import yaml

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

def load_yaml(path):
    with open(path, 'r', encoding='utf-8') as fh:
        return yaml.safe_load(fh)

def ensure_dir(p):
    os.makedirs(p, exist_ok=True)

def post_chat(base_url, room, start, end, question, timeout_sec=120):
    url = f"{base_url.rstrip('/')}/api/chat"
    payload = {
        "room": room,
        "range": {"start": start, "end": end},
        "messages": [{"role": "user", "content": question}]
    }
    t0 = time.time()
    r = requests.post(url, json=payload, timeout=timeout_sec)
    dt = time.time() - t0
    r.raise_for_status()
    return r.json(), dt

def wait_for_health(base_url, total_wait=60):
    url = f"{base_url.rstrip('/')}/api/health"
    t0 = time.time()
    while time.time() - t0 < total_wait:
        try:
            r = requests.get(url, timeout=5)
            if r.ok:
                return True
        except Exception:
            pass
        time.sleep(2)
    return False

def run_suite(base_url, suite_path, out_dir):
    suite = load_yaml(suite_path)
    # timezone-aware UTC timestamp
    ts = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    run_dir = os.path.join(out_dir, ts)
    ensure_dir(run_dir)
    summary = []
    # Allow overriding request timeout via env
    timeout_env = os.environ.get('BENCH_TIMEOUT_SEC')
    try:
        timeout_sec = int(timeout_env) if timeout_env else 120
    except Exception:
        timeout_sec = 120
    # Health check before starting
    if not wait_for_health(base_url, total_wait=60):
        print(f"[bench] ERROR: App healthcheck failed at {base_url}/api/health. Ensure the server is running (e.g., scripts/dev_controls.sh start) and try again.")
        return

    for case in suite.get('tests', []):
        name = case.get('name') or f"case_{len(summary)+1}"
        room = case['room']
        start = case['range']['start']
        end = case['range']['end']
        question = case['question']
        target_metric = case.get('target_metric')
        target_chart = case.get('target_chart')
        print(f"[bench] Running: {name} -> {question}")
        # Retry on transient connection issues
        attempts = 0
        res = None; latency = None
        while attempts < 3:
            attempts += 1
            try:
                res, latency = post_chat(base_url, room, start, end, question, timeout_sec=timeout_sec)
                break
            except Exception as e:
                err = str(e)
                print(f"[bench] FAILED {name} (attempt {attempts}): {err}")
                time.sleep(2)
        if res is None:
            res, latency = {"error": f"request failed after {attempts} attempts"}, None
        case_dir = os.path.join(run_dir, name.replace(' ', '_'))
        ensure_dir(case_dir)
        with open(os.path.join(case_dir, 'response.json'), 'w', encoding='utf-8') as fh:
            json.dump(res, fh, ensure_ascii=False, indent=2)
        meta = {
            'name': name,
            'room': room,
            'range': {'start': start, 'end': end},
            'question': question,
            'target_metric': target_metric,
            'target_chart': target_chart,
            'latency_sec': latency
        }
        # Optional reference for RAGAS (ground-truth answer)
        if 'reference' in case:
            meta['reference'] = case['reference']
        with open(os.path.join(case_dir, 'meta.json'), 'w', encoding='utf-8') as fh:
            json.dump(meta, fh, ensure_ascii=False, indent=2)
        summary.append({'name': name, 'latency_sec': latency})
    with open(os.path.join(run_dir, 'summary.json'), 'w', encoding='utf-8') as fh:
        json.dump({'cases': summary}, fh, ensure_ascii=False, indent=2)
    print(f"[bench] Done. Results: {run_dir}")

def main():
    base_url = os.environ.get('APP_BASE_URL', 'http://localhost:3000')
    suite_path = os.environ.get('BENCH_SUITE', os.path.join(ROOT, 'docs', 'publication', 'bench', 'tests.yaml'))
    out_dir = os.environ.get('BENCH_OUT', os.path.join(ROOT, 'docs', 'publication', 'artifacts'))
    run_suite(base_url, suite_path, out_dir)

if __name__ == '__main__':
    main()
