#!/usr/bin/env python3
"""
Simple SBERT reranker for top-k documents.

Reads JSON from stdin: {"query": str, "texts": [str, ...]}
Outputs JSON: {"scores": [float, ...]} where scores[i] is similarity with texts[i].

Model is taken from env CHROMA_EMB_MODEL or defaults to a SciBERT ST variant.
"""
import sys, json, os
import numpy as np
from sentence_transformers import SentenceTransformer, util

def main():
    data = sys.stdin.read()
    try:
        obj = json.loads(data)
    except Exception:
        print(json.dumps({"scores": []}))
        return
    query = obj.get("query") or ""
    texts = obj.get("texts") or []
    if not texts:
        print(json.dumps({"scores": []}))
        return
    model_name = os.environ.get('CHROMA_EMB_MODEL', 'gsarti/scibert-nli-stsb')
    try:
        model = SentenceTransformer(model_name)
        q_emb = model.encode([query], convert_to_tensor=True)
        d_emb = model.encode(texts, convert_to_tensor=True)
        sims = util.cos_sim(q_emb, d_emb).cpu().numpy()[0].tolist()
        print(json.dumps({"scores": sims}))
    except Exception:
        print(json.dumps({"scores": []}))

if __name__ == '__main__':
    main()

