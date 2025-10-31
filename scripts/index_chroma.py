#!/usr/bin/env python3
"""
Populate Chroma with:
- knowledge collection: contents of knowledge/*.md|.txt (recursively)
- profiles collection: mock telemetry profiles per building/room/metric/horizon

Env:
- CHROMA_URL (default http://localhost:8000)
"""
import glob
import hashlib
import os
import re
import time

import chromadb
import numpy as np
from chromadb.config import Settings

CHROMA_URL = os.environ.get('CHROMA_URL', 'http://localhost:8000')
EMB_MODEL = os.environ.get('CHROMA_EMB_MODEL', 'sentence-transformers/all-MiniLM-L6-v2')


class HashEmbeddingFunction:
    """Lightweight embedding that hashes tokens into a fixed-length vector.
    Provides deterministic embeddings without heavyweight ML dependencies.
    """

    def __init__(self, dim: int = 384):
        self.dim = dim
        self._token_re = re.compile(r"\w+")

    def name(self) -> str:
        """Identifier so Chroma can detect embedding-function compatibility."""
        return f"hash-embedding-{self.dim}"

    def __call__(self, input):
        texts = input
        embeddings = []
        for text in texts:
            vec = np.zeros(self.dim, dtype=np.float32)
            if not text:
                embeddings.append(vec.tolist())
                continue
            tokens = self._token_re.findall(text.lower())
            if not tokens:
                embeddings.append(vec.tolist())
                continue
            for tok in tokens:
                # Blake2b digest keeps runtime low and deterministic
                digest = hashlib.blake2b(tok.encode("utf-8"), digest_size=4).digest()
                idx = int.from_bytes(digest, "big") % self.dim
                vec[idx] += 1.0
            norm = np.linalg.norm(vec)
            if norm > 0:
                vec /= norm
            embeddings.append(vec.tolist())
        return embeddings


def create_embedding_function():
    prefer_transformer = os.environ.get("CHROMA_USE_SENTENCE_TRANSFORMER", "").lower() in ("1", "true", "yes")
    hash_dim = int(os.environ.get("CHROMA_HASH_DIM", "384"))
    if prefer_transformer:
        try:
            from chromadb.utils.embedding_functions import SentenceTransformerEmbeddingFunction

            print(f"[index] Using sentence-transformer model: {EMB_MODEL}")
            return SentenceTransformerEmbeddingFunction(model_name=EMB_MODEL)
        except Exception as exc:
            print(f"[index] sentence-transformers unavailable ({exc}); falling back to hash embeddings")
    return HashEmbeddingFunction(dim=hash_dim)


EF = create_embedding_function()

def get_client():
    """HTTP client to the running Chroma server.
    Supports CHROMA_URL like http://localhost:8000 or http://chroma:8000
    """
    url = CHROMA_URL
    host = 'localhost'
    port = 8000
    try:
        if url.startswith('http://'):
            url_ = url[len('http://') : ]
        elif url.startswith('https://'):
            url_ = url[len('https://') : ]
        else:
            url_ = url
        if ':' in url_:
            host, port_s = url_.split(':', 1)
            port = int(port_s.split('/')[0])
        else:
            host = url_
    except Exception:
        pass
    return chromadb.HttpClient(host=host, port=port, settings=Settings(allow_reset=True))

def index_knowledge(client):
    name = os.environ.get('CHROMA_COLLECTION', 'knowledge')
    coll = client.get_or_create_collection(name=name, embedding_function=EF)
    files = [f for f in glob.glob('knowledge/**/*.*', recursive=True) if f.lower().endswith(('.md','.txt'))]
    docs, ids, metas = [], [], []
    for i, f in enumerate(files):
        with open(f, 'r', encoding='utf-8') as fh:
            txt = fh.read()
        ids.append(f"kn-{i}-{int(time.time())}")
        docs.append(txt)
        metas.append({"path": f})
    if docs:
        coll.add(documents=docs, ids=ids, metadatas=metas)
    print(f"Indexed {len(docs)} knowledge docs")

def make_profile_doc(building, room, metric, horizon, summary):
    return {
        'id': f"pf-{building}-{room}-{metric}-{horizon}",
        'text': f"[Profile] building={building} room={room} metric={metric} horizon={horizon}\n{summary}",
        'metadata': {'building': building, 'room': room, 'metric': metric, 'horizon': horizon}
    }

def index_profiles(client):
    name = os.environ.get('CHROMA_COLLECTION_PROFILES', 'profiles')
    coll = client.get_or_create_collection(name=name, embedding_function=EF)
    buildings = ['Alpha Tower','Alpha Annex','Beta Plaza','Beta Lofts']
    base_rooms = ['Cafe 1','Boardroom 1','Lab 1','Toilet 1','Cafe 2','Boardroom 2']
    metrics = ['co2','people_count','total_kwh','lux','temperature','humidity']
    horizons = ['7d','30d','90d']
    templates = {
      'co2': "CO2 peaks around 10–11am and 2–3pm on weekdays; returns to baseline by 6pm; spikes indicate ventilation shortfalls.",
      'people_count': "Occupancy highest during lunch and mid-afternoon; low after 7pm; weekends ~40% of weekdays.",
      'total_kwh': "Energy usage rises during arrival hours and remains elevated until late afternoon; clear weekday/weekend pattern.",
      'lux': "Lux tracks daylight; baseline artificial lighting persists in evening; lights-on-while-empty observed occasionally.",
      'temperature': "Temperature stable 20–22°C; gradual warm-up mornings; minor afternoon drift tied to occupancy.",
      'humidity': "Humidity hovers 40–60%; occasional drops with heat events; rises after cleaning in toilets/cafes."
    }
    docs, ids, metas = [], [], []
    for b in buildings:
        for r in base_rooms:
            for m in metrics:
                for h in horizons:
                    prof = make_profile_doc(b, r, m, h, templates[m])
                    ids.append(prof['id'])
                    docs.append(prof['text'])
                    metas.append(prof['metadata'])
    if docs:
        coll.add(documents=docs, ids=ids, metadatas=metas)
    print(f"Indexed {len(docs)} profiles")

if __name__ == '__main__':
    client = get_client()
    index_knowledge(client)
    index_profiles(client)
