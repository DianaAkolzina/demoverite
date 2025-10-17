// Lightweight evaluation utilities for RAG answers.

function sentences(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return [];
  return s.split(/(?<=[.!?])\s+/).map(x => x.trim()).filter(Boolean);
}

function tokenize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9_\s]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function jaccard(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const uni = A.size + B.size - inter || 1;
  return inter / uni;
}

export function evaluateQA({ question, answer, retrievedDocs }) {
  const allContext = (retrievedDocs || []).map(d => d.text || d).join('\n');
  const ctxTokens = tokenize(allContext);
  const sents = sentences(answer);
  let supported = 0;
  let scores = [];
  for (const s of sents) {
    const st = tokenize(s);
    const sc = jaccard(st, ctxTokens);
    if (sc >= 0.08) supported++;
    scores.push(sc);
  }
  const grounding = sents.length ? supported / sents.length : 0;
  const mean = scores.length ? scores.reduce((a,x)=>a+x,0) / scores.length : 0;
  const variance = scores.length ? scores.reduce((a,x)=>a + (x-mean)*(x-mean), 0) / scores.length : 0;

  // Simple uncertainty proxy: low grounding or high variance in retrieval indicates low confidence
  const uncertainty = Math.max(0, 1 - grounding) * 0.7 + Math.min(1, variance * 5) * 0.3;

  return {
    grounding, // 0..1 fraction of sentences supported by retrieved text (approximate)
    meanSupport: mean,
    uncertainty
  };
}

