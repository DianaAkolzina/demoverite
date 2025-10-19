// Hybrid retrieval: combine sparse TF-IDF (ragIndex) with vector store (Chroma)
// using Reciprocal Rank Fusion (RRF) and a light lexical rerank.
import { spawn } from 'child_process';

function tokenize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9_\s]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function lexicalOverlapScore(query, text) {
  const qToks = new Set(tokenize(query));
  if (!qToks.size) return 0;
  let match = 0;
  for (const t of tokenize(text)) if (qToks.has(t)) match++;
  const denom = Math.sqrt(qToks.size) * Math.sqrt(Math.max(1, match));
  return denom ? match / denom : 0;
}

function toUnifiedFromRag(hit, i) {
  return {
    key: `rag:${hit.id}`,
    id: hit.id,
    source: 'rag',
    rank: i + 1,
    scoreRaw: Number(hit.score) || 0,
    meta: hit.meta || null,
    text: hit.text || ''
  };
}

function toUnifiedFromVec(hit, i) {
  const d = hit?.distance;
  const score = (d == null) ? 0 : 1 / (1 + Number(d)); // higher is better
  return {
    key: `vec:${hit.id || i}`,
    id: hit.id || String(i),
    source: 'vector',
    rank: i + 1,
    scoreRaw: Number.isFinite(score) ? score : 0,
    meta: hit.metadata || null,
    text: hit.text || ''
  };
}

function reciprocalRankFusion(lists, k0 = 60) {
  const map = new Map();
  for (const lst of lists) {
    lst.forEach((h, i) => {
      const cur = map.get(h.key) || { ...h, rrf: 0 };
      cur.rrf += 1 / (k0 + (i + 1));
      // keep best text/meta seen
      cur.text = cur.text || h.text || '';
      cur.meta = cur.meta || h.meta || null;
      map.set(h.key, cur);
    });
  }
  return Array.from(map.values());
}

export async function hybridRetrieve({ query, ragIndex, vectorClient, k = 6 }) {
  const lists = [];
  let ragHits = [];
  try {
    ragHits = ragIndex?.search ? ragIndex.search(query, Math.max(k, 10)) : [];
  } catch {}
  const ragList = (ragHits || []).map((h, i) => toUnifiedFromRag(h, i));
  if (ragList.length) lists.push(ragList);

  let vecList = [];
  try {
    if (vectorClient && vectorClient.searchDocs) {
      const res = await vectorClient.searchDocs({ query, k: Math.max(k, 10) });
      const hits = res?.hits || [];
      vecList = hits.map((h, i) => toUnifiedFromVec(h, i));
      if (vecList.length) lists.push(vecList);
    }
  } catch {}

  const fused = reciprocalRankFusion(lists);
  // Lightweight lexical rerank to bias toward explicit overlaps
  for (const it of fused) {
    it.lex = lexicalOverlapScore(query, it.text);
    // Blend: final = 0.7*rrf + 0.3*lex
    it.final = 0.7 * it.rrf + 0.3 * it.lex;
  }
  fused.sort((a, b) => b.final - a.final);

  // Optional: Python SBERT reranker (SciBERT ST) for top-M
  async function sbertRerank(query, items) {
    const enabled = String(process.env.RERANK_ENABLED || '1') === '1';
    if (!enabled || !items.length) return items;
    const topM = Math.min(Number(process.env.RERANK_TOP || 20), items.length);
    const subset = items.slice(0, topM);
    try {
      const p = spawn('python3', ['scripts/rerank.py'], { stdio: ['pipe', 'pipe', 'pipe'] });
      const payload = JSON.stringify({ query, texts: subset.map(x => x.text) });
      p.stdin.write(payload);
      p.stdin.end();
      const chunks = [];
      for await (const d of p.stdout) chunks.push(d);
      const out = Buffer.concat(chunks).toString('utf8');
      const res = JSON.parse(out);
      const scores = Array.isArray(res?.scores) ? res.scores : [];
      const scored = subset.map((it, i) => ({ ...it, rerank: Number(scores[i] || 0) }));
      scored.sort((a, b) => b.rerank - a.rerank);
      // merge back with tail
      const merged = scored.concat(items.slice(topM));
      return merged;
    } catch (e) {
      // Fall back on fused ordering
      return items;
    }
  }

  const reranked = await sbertRerank(query, fused);
  return reranked.slice(0, k);
}
