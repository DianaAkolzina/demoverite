// Hybrid retrieval: combine sparse TF-IDF (ragIndex) with vector store (Chroma)
// using Reciprocal Rank Fusion (RRF) and a light lexical rerank.
import { spawn } from 'child_process';

let rerankDisabled = false;
const MIN_FINAL_SCORE = Number(process.env.RAG_MIN_SCORE || 0.01);
const MIN_LEXICAL_SCORE = Number(process.env.RAG_MIN_LEX || 0.05);
const CATEGORY_BOOST = Number(process.env.RAG_CATEGORY_BOOST || 0.3);
const METRIC_MISS_FACTOR = Number(process.env.RAG_METRIC_MISS_FACTOR || 0.85);

function buildAugmentedQuery(base, scope = {}) {
  const parts = [String(base || '')];
  if (scope?.room && scope.room !== 'ALL') parts.push(`product:${scope.room}`);
  if (scope?.page) parts.push(`page:${scope.page}`);
  if (scope?.building) parts.push(`building:${scope.building}`);
  if (scope?.owner) parts.push(`owner:${scope.owner}`);
  if (scope?.tenant) parts.push(`tenant:${scope.tenant}`);
  if (Array.isArray(scope?.metrics) && scope.metrics.length) parts.push(`metrics:${scope.metrics.join(',')}`);
  if (scope?.timeHints?.granularity) parts.push(`granularity:${scope.timeHints.granularity}`);
  if (scope?.timeHints?.future) parts.push('forecast:true');
  if (scope?.zones && scope.zones.length) parts.push(`zones:${scope.zones.slice(0, 3).join('|')}`);
  if (scope?.pages && scope.pages.length) parts.push(`pages:${scope.pages.slice(0, 3).join('|')}`);
  if (scope?.shop) parts.push(`shop:${scope.shop}`);
  return parts.filter(Boolean).join(' | ');
}

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

function isFlagged(meta) {
  if (!meta) return false;
  const flag = String(meta.flagged || meta.exclude || '').toLowerCase();
  if (flag === 'true' || flag === '1') return true;
  const status = String(meta.status || '').toLowerCase();
  if (status === 'deprecated' || status === 'exclude') return true;
  return false;
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

export async function hybridRetrieve({ query, ragIndex, vectorClient, k = 6, preferCategories = [], scope = {} }) {
  const augmentedQuery = buildAugmentedQuery(query, scope);
  const preferSet = new Set((preferCategories || []).map((c) => String(c || '').toLowerCase()).filter(Boolean));
  const metricTokens = new Set((scope?.metrics || []).map((m) => String(m || '').toLowerCase()).filter(Boolean));
  const lists = [];
  let ragHits = [];
  try {
    ragHits = ragIndex?.search ? ragIndex.search(augmentedQuery, Math.max(k, 10)) : [];
  } catch {}
  const ragList = (ragHits || []).map((h, i) => toUnifiedFromRag(h, i));
  if (ragList.length) lists.push(ragList);

  let vecList = [];
  try {
    if (vectorClient && vectorClient.searchDocs) {
      const where = preferSet.size ? { category: { '$in': Array.from(preferSet) } } : null;
      const res = await vectorClient.searchDocs({ query: augmentedQuery, k: Math.max(k, 10), where });
      const hits = res?.hits || [];
      vecList = hits.map((h, i) => toUnifiedFromVec(h, i));
      if (vecList.length) lists.push(vecList);
    }
  } catch {}

  const fused = reciprocalRankFusion(lists);
  // Lightweight lexical rerank to bias toward explicit overlaps
  for (const it of fused) {
    it.lex = lexicalOverlapScore(augmentedQuery, it.text);
    const category = String(it.meta?.category || it.meta?.type || '').toLowerCase();
    const categoryBoost = preferSet.has(category) ? CATEGORY_BOOST : 0;
    let scopeBoost = 0;
    if (scope?.room && scope.room !== 'ALL') {
      const needle = String(scope.room).toLowerCase();
      if (needle && it.text.toLowerCase().includes(needle)) scopeBoost += 0.05;
    }
    let metricMultiplier = 1;
    if (metricTokens.size) {
      const textLower = it.text.toLowerCase();
      let support = 0;
      metricTokens.forEach((token) => {
        if (token && textLower.includes(token)) support += 1;
      });
      it.metricSupport = support;
      if (!support) metricMultiplier = METRIC_MISS_FACTOR;
    }
    // Blend: final = 0.7*rrf + 0.3*lex + boosts
    it.final = (0.7 * it.rrf + 0.3 * it.lex + categoryBoost + scopeBoost) * metricMultiplier;
  }
  fused.sort((a, b) => b.final - a.final);

  // Optional: Python SBERT reranker (SciBERT ST) for top-M
  async function sbertRerank(query, items) {
    const enabled = String(
      process.env.RERANK_ENABLED ||
      (process.env.RERANK_PYTHON_BIN ? '1' : '0')
    ) === '1';
    if (!enabled || rerankDisabled || !items.length) return items;
    const topM = Math.min(Number(process.env.RERANK_TOP || 20), items.length);
    const subset = items.slice(0, topM);
    const pythonCandidates = [
      process.env.RERANK_PYTHON_BIN,
      process.env.PYTHON_BIN,
      process.env.PYTHON,
      'python3',
      'python',
      'py'
    ].filter(Boolean);

    if (!pythonCandidates.length) {
      rerankDisabled = true;
      console.warn('[retrieval][rerank] Disabled: no python interpreter configured (set RERANK_PYTHON_BIN to enable).');
      return items;
    }

    async function tryRerankWith(bin) {
      return new Promise((resolve, reject) => {
        const child = spawn(bin, ['scripts/rerank.py'], { stdio: ['pipe', 'pipe', 'pipe'] });
        const payload = JSON.stringify({ query, texts: subset.map((x) => x.text) });
        child.stdin.write(payload);
        child.stdin.end();
        const chunks = [];
        child.stdout.on('data', (d) => chunks.push(d));
        child.once('error', reject);
        child.once('close', (code) => {
          if (code !== 0) {
            return reject(new Error(`${bin} exited with code ${code}`));
          }
          try {
            const out = Buffer.concat(chunks).toString('utf8');
            const res = JSON.parse(out);
            const scores = Array.isArray(res?.scores) ? res.scores : [];
            const scored = subset.map((it, i) => ({ ...it, rerank: Number(scores[i] || 0) }));
            scored.sort((a, b) => b.rerank - a.rerank);
            resolve(scored.concat(items.slice(topM)));
          } catch (err) {
            reject(err);
          }
        });
      });
    }

    let lastError = null;
    for (const bin of pythonCandidates) {
      try {
        const reranked = await tryRerankWith(bin);
        return reranked;
      } catch (err) {
        lastError = err;
        console.warn('[retrieval][rerank] Failed with', bin, String(err));
      }
    }

    rerankDisabled = true;
    if (lastError) {
      console.warn('[retrieval][rerank] Disabling SBERT reranker after repeated failures:', String(lastError));
    }
    return items;
  }

  const reranked = await sbertRerank(query, fused);
  const validated = [];
  for (let i = 0; i < reranked.length; i++) {
    const item = reranked[i];
    if (isFlagged(item.meta)) continue;
    if (i < 2) {
      validated.push(item);
      continue;
    }
    const meetsScore =
      (Number.isFinite(item.final) && item.final >= MIN_FINAL_SCORE) ||
      (Number.isFinite(item.lex) && item.lex >= MIN_LEXICAL_SCORE) ||
      (Number.isFinite(item.rerank) && item.rerank >= MIN_FINAL_SCORE);
    if (meetsScore) validated.push(item);
    if (validated.length >= k) break;
  }
  return validated.slice(0, k);
}
