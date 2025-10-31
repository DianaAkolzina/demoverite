#!/usr/bin/env python3
"""
HTTP-only Chroma indexer that avoids chromadb local client (and sqlite).

Indexes:
- knowledge collection from knowledge/**/*.md|.txt
- profiles collection with synthetic summaries

Env:
- CHROMA_URL (e.g., http://localhost:8000 or http://chroma:8000)
- CHROMA_EMB_MODEL (default sentence-transformers/all-MiniLM-L6-v2)
"""
import os
import sys
import glob
import json
import time
import hashlib
import re

import numpy as np
import requests

CHROMA_URL = os.environ.get('CHROMA_URL', 'http://localhost:8000').rstrip('/')
EMB_MODEL = os.environ.get('CHROMA_EMB_MODEL', 'sentence-transformers/all-MiniLM-L6-v2')

def raise_for_status(r: requests.Response):
    try:
        r.raise_for_status()
    except Exception:
        print('HTTP', r.status_code, 'body:', r.text[:400], file=sys.stderr)
        raise

def get_or_create_collection(name: str):
    """Be tolerant of Chroma API variants.
    Strategy:
    - Try create on v2: POST /api/v2/collections {name}
    - Fallback create on v1: POST /api/v1/collections {name}
    - If creation not supported, try list on v2 then v1 and match by name.
    """
    # Try create v2
    try:
        rc = requests.post(f"{CHROMA_URL}/api/v2/collections", json={'name': name})
        if 200 <= rc.status_code < 300:
            return rc.json()
    except Exception:
        pass
    # Try create v2 (default database path)
    try:
        rc = requests.post(f"{CHROMA_URL}/api/v2/databases/default/collections", json={'name': name})
        if 200 <= rc.status_code < 300:
            return rc.json()
    except Exception:
        pass
    # Try create v1
    try:
        rc = requests.post(f"{CHROMA_URL}/api/v1/collections", json={'name': name})
        if 200 <= rc.status_code < 300:
            return rc.json()
    except Exception:
        pass
    # Try list v2
    try:
        r = requests.get(f"{CHROMA_URL}/api/v2/collections")
        if r.ok:
            data = r.json()
            for c in data.get('collections') or []:
                if c.get('name') == name:
                    return c
    except Exception:
        pass
    # Try list v2 (default database path)
    try:
        r = requests.get(f"{CHROMA_URL}/api/v2/databases/default/collections")
        if r.ok:
            data = r.json()
            # Some servers may return a list of objects with 'name' or 'collection'
            items = data.get('collections') or data.get('data') or []
            for c in items:
                if (isinstance(c, dict) and (c.get('name') == name or c.get('collection', {}).get('name') == name)):
                    return c
    except Exception:
        pass
    # Try list v1
    r = requests.get(f"{CHROMA_URL}/api/v1/collections")
    raise_for_status(r)
    data = r.json()
    for c in data.get('collections') or []:
        if c.get('name') == name:
            return c
    raise RuntimeError('Unable to create or find collection: ' + name)

def add_batch(collection_id: str, ids, documents=None, metadatas=None, embeddings=None):
    payload = { 'ids': ids }
    if documents is not None:
        payload['documents'] = documents
    if metadatas is not None:
        payload['metadatas'] = metadatas
    if embeddings is not None:
        payload['embeddings'] = embeddings
    # Try v2 then v1
    try:
        r = requests.post(f"{CHROMA_URL}/api/v2/collections/{collection_id}/add", json=payload)
        raise_for_status(r)
        return r.json()
    except Exception:
        r = requests.post(f"{CHROMA_URL}/api/v1/collections/{collection_id}/add", json=payload)
        raise_for_status(r)
        return r.json()

def chunked(iterable, n):
    it = list(iterable)
    for i in range(0, len(it), n):
        yield it[i:i+n]


class HashEncoder:
    """Deterministic, lightweight encoder that hashes tokens into vectors."""

    def __init__(self, dim: int = 384):
        self.dim = dim
        self._token_re = re.compile(r"\w+")

    def encode(self, texts, convert_to_numpy=False):
        vectors = []
        for text in texts:
            vec = np.zeros(self.dim, dtype=np.float32)
            if text:
                tokens = self._token_re.findall(text.lower())
                for tok in tokens:
                    digest = hashlib.blake2b(tok.encode("utf-8"), digest_size=4).digest()
                    idx = int.from_bytes(digest, "big") % self.dim
                    vec[idx] += 1.0
            norm = np.linalg.norm(vec)
            if norm > 0:
                vec /= norm
            vectors.append(vec)
        arr = np.stack(vectors) if vectors else np.zeros((0, self.dim), dtype=np.float32)
        return arr if convert_to_numpy else arr.tolist()


def create_encoder():
    prefer_transformer = os.environ.get('CHROMA_USE_SENTENCE_TRANSFORMER', '').lower() in ('1', 'true', 'yes')
    hash_dim = int(os.environ.get('CHROMA_HASH_DIM', '384'))
    if prefer_transformer:
        try:
            from sentence_transformers import SentenceTransformer

            print(f"[index] Using sentence-transformer model: {EMB_MODEL}")
            return SentenceTransformer(EMB_MODEL)
        except Exception as exc:
            print(f"[index] sentence-transformers unavailable ({exc}); falling back to hash encoder")
    return HashEncoder(dim=hash_dim)


def index_knowledge(model):
    files = [f for f in glob.glob('knowledge/**/*.*', recursive=True) if f.lower().endswith(('.md', '.txt'))]
    coll = get_or_create_collection('knowledge')
    cid = coll.get('id')
    if not cid:
        print('Failed to get/create knowledge collection', file=sys.stderr)
        return 0
    ids, docs, metas = [], [], []
    for i, f in enumerate(files):
        try:
            with open(f, 'r', encoding='utf-8') as fh:
                txt = fh.read()
        except Exception:
            continue
        ids.append(f"kn-{i}-{int(time.time())}")
        docs.append(txt)
        metas.append({'path': f})
    total = len(docs)
    if not total:
        print('No knowledge docs found.')
        return 0
    batch = 32
    done = 0
    for idxs in chunked(list(range(total)), batch):
        batch_docs = [docs[i] for i in idxs]
        batch_ids = [ids[i] for i in idxs]
        batch_metas = [metas[i] for i in idxs]
        emb = model.encode(batch_docs, convert_to_numpy=True).tolist()
        add_batch(cid, batch_ids, documents=batch_docs, metadatas=batch_metas, embeddings=emb)
        done += len(idxs)
        print(f"[knowledge] indexed {done}/{total}")
    return total

def make_profile_doc(building, room, metric, horizon, summary):
    text = f"[Profile] building={building} room={room} metric={metric} horizon={horizon}\n{summary}"
    meta = { 'building': building, 'room': room, 'metric': metric, 'horizon': horizon }
    return text, meta

def index_profiles(model):
    coll = get_or_create_collection('profiles')
    cid = coll.get('id')
    if not cid:
        print('Failed to get/create profiles collection', file=sys.stderr)
        return 0
    buildings = ['Alpha Tower','Alpha Annex','Beta Plaza','Beta Lofts']
    rooms = ['Cafe 1','Boardroom 1','Lab 1','Toilet 1','Cafe 2','Boardroom 2']
    metrics = ['co2','people_count','total_kwh','lux','temperature','humidity']
    horizons = ['7d','30d','90d']
    templates = {
        'co2': 'CO2 peaks around 10–11am and 2–3pm on weekdays; returns to baseline by 6pm; spikes indicate ventilation shortfalls.',
        'people_count': 'Occupancy highest during lunch and mid-afternoon; low after 7pm; weekends ~40% of weekdays.',
        'total_kwh': 'Energy usage rises during arrival hours and remains elevated until late afternoon; clear weekday/weekend pattern.',
        'lux': 'Lux tracks daylight; baseline artificial lighting persists in evening; lights-on-while-empty observed occasionally.',
        'temperature': 'Temperature stable 20–22°C; gradual warm-up mornings; minor afternoon drift tied to occupancy.',
        'humidity': 'Humidity hovers 40–60%; occasional drops with heat events; rises after cleaning in toilets/cafes.'
    }
    ids, docs, metas = [], [], []
    for b in buildings:
        for r in rooms:
            for m in metrics:
                for h in horizons:
                    t, meta = make_profile_doc(b, r, m, h, templates[m])
                    ids.append(f"pf-{b}-{r}-{m}-{h}")
                    docs.append(t)
                    metas.append(meta)
    total = len(docs)
    batch = 64
    done = 0
    for idxs in chunked(list(range(total)), batch):
        batch_docs = [docs[i] for i in idxs]
        batch_ids = [ids[i] for i in idxs]
        batch_metas = [metas[i] for i in idxs]
        emb = model.encode(batch_docs, convert_to_numpy=True).tolist()
        add_batch(cid, batch_ids, documents=batch_docs, metadatas=batch_metas, embeddings=emb)
        done += len(idxs)
        print(f"[profiles] indexed {done}/{total}")
    return total

def main():
    print('Chroma URL:', CHROMA_URL)
    # Heartbeat for v2 or v1
    ok = False
    for path in ['/api/v2/heartbeat', '/api/v1/heartbeat']:
        try:
            r = requests.get(f"{CHROMA_URL}{path}", timeout=5)
            if r.ok:
                ok = True
                break
        except Exception:
            pass
    if not ok:
        print('Chroma not reachable at', CHROMA_URL, file=sys.stderr)
        sys.exit(1)
    model = create_encoder()
    n1 = index_knowledge(model)
    n2 = index_profiles(model)
    print(f'Indexed {n1} knowledge docs and {n2} profiles')

if __name__ == '__main__':
    main()
