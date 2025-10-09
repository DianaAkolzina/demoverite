#!/usr/bin/env python3
import os
import csv
import sys
import json
from typing import List, Dict

CSV_SOURCE_DIR = os.environ.get('CSV_SOURCE_DIR', 'CSVex')
CSV_TARGET_DIR = os.environ.get('CSV_TARGET_DIR', os.environ.get('CSV_DIR', 'CSVex'))

def is_number(s: str) -> bool:
    try:
        float(s)
        return True
    except Exception:
        return False

def read_csv(path: str) -> List[Dict[str, str]]:
    with open(path, 'r', encoding='utf-8') as f:
        rdr = csv.DictReader(f)
        return list(rdr)

def normalize_rows(rows: List[Dict[str, str]]) -> List[Dict[str, object]]:
    out = []
    for r in rows:
        nr: Dict[str, object] = {}
        for k, v in r.items():
            if v is None:
                nr[k] = None
                continue
            vv = v.strip()
            if k == 'ts':
                try:
                    tsf = float(vv)
                    if tsf < 10_000_000_000:
                        tsf *= 1000.0
                    nr[k] = int(tsf)
                except Exception:
                    nr[k] = None
            else:
                if is_number(vv):
                    try:
                        nv = float(vv)
                        nr[k] = int(nv) if nv.is_integer() else nv
                    except Exception:
                        nr[k] = vv
                else:
                    nr[k] = vv
        if nr.get('ts') is not None:
            out.append(nr)
    out.sort(key=lambda r: r.get('ts') or 0)
    return out

def write_csv_atomic(path: str, rows: List[Dict[str, object]]):
    tmp = path + '.tmp'
    if not rows:
        with open(tmp, 'w', encoding='utf-8', newline='') as f:
            f.write('ts\n')
        os.replace(tmp, path)
        return
    headers = list(rows[0].keys())
    with open(tmp, 'w', encoding='utf-8', newline='') as f:
        w = csv.DictWriter(f, fieldnames=headers)
        w.writeheader()
        for r in rows:
            w.writerow(r)
    os.replace(tmp, path)

def ensure_dir(p: str):
    os.makedirs(p, exist_ok=True)

def ingest_room(room_dir_src: str, room_dir_dst: str) -> Dict[str, object]:
    files = [f for f in os.listdir(room_dir_src) if f.endswith('.csv')]
    result = {'room': os.path.basename(room_dir_src), 'tables': {}, 'errors': []}
    ensure_dir(room_dir_dst)
    for f in files:
        src = os.path.join(room_dir_src, f)
        dst = os.path.join(room_dir_dst, f)
        try:
            rows = read_csv(src)
            nrows = normalize_rows(rows)
            write_csv_atomic(dst, nrows)
            result['tables'][f] = {'rows': len(nrows)}
        except Exception as e:
            result['errors'].append({'file': f, 'error': str(e)})
    return result

def main():
    src_root = os.path.abspath(CSV_SOURCE_DIR)
    dst_root = os.path.abspath(CSV_TARGET_DIR)
    if not os.path.exists(src_root):
        print(f"[ingest][warn] Source dir not found: {src_root} — skipping CSV ingestion")
        ensure_dir(dst_root)
        # Still write an empty meta to indicate ingestion ran
        meta_path = os.path.join(dst_root, '_ingest_meta.json')
        with open(meta_path, 'w', encoding='utf-8') as f:
            json.dump({'summary': [], 'note': 'no source dir; skipped'}, f)
        return
    ensure_dir(dst_root)

    rooms = [d for d in os.listdir(src_root) if os.path.isdir(os.path.join(src_root, d))]
    summary = []
    for room in rooms:
        rsrc = os.path.join(src_root, room)
        rdst = os.path.join(dst_root, room)
        res = ingest_room(rsrc, rdst)
        summary.append(res)
        print(f"[ingest] {room}: " + ", ".join([f"{t}:{info['rows']} rows" for t, info in res['tables'].items()]))
        if res['errors']:
            for e in res['errors']:
                print(f"[ingest][warn] {room}/{e['file']}: {e['error']}")

    meta_path = os.path.join(dst_root, '_ingest_meta.json')
    with open(meta_path, 'w', encoding='utf-8') as f:
        json.dump({'summary': summary}, f, indent=2)
    print(f"[ingest] completed. meta: {meta_path}")

if __name__ == '__main__':
    main()
