// Simple query router to classify queries into L1–L4 and suggest pipeline options.

export function classifyQuery(question) {
  const q = String(question || '').toLowerCase();

  const has = (kw) => q.includes(kw);

  // Heuristic signals
  const signals = {
    l1: [
      'what is', 'latest', 'current', 'value of', 'show', 'list', 'how many', 'count', 'sum', 'average', 'avg', 'min', 'max'
    ].some(has),
    l2: [
      'which has', 'highest', 'lowest', 'top', 'compare', 'correlat', 'per ', 'ratio', 'trend', 'vs ', 'over time'
    ].some(has),
    l3: [
      'comply', 'compliance', 'standard', 'code', 'regulation', 'rule', 'policy', 'threshold', 'limit', 'according to'
    ].some(has),
    l4: [
      'why ', ' root cause', 'cause', 'explain', 'explanation', 'forecast', 'predict', 'anomaly', 'outlier'
    ].some(has)
  };

  let level = 'L1';
  if (signals.l4) level = 'L4';
  else if (signals.l3) level = 'L3';
  else if (signals.l2) level = 'L2';
  else if (signals.l1) level = 'L1';

  // Suggested pipeline knobs
  const pipeline = {
    L1: { retrieval: { mode: 'hybrid', k: 6 }, reasoning: 'direct' },
    L2: { retrieval: { mode: 'hybrid-iterative', k: 8, hops: 2 }, reasoning: 'iterative' },
    L3: { retrieval: { mode: 'hybrid+rules', k: 10, focus: ['norms', 'iaq_guidelines'] }, reasoning: 'workflow' },
    L4: { retrieval: { mode: 'broad-hybrid', k: 12 }, reasoning: 'cot' }
  }[level];

  return { level, pipeline };
}

export function suggestRetrievalFilters(level) {
  // For compliance/rules questions, bias to knowledge categories
  if (level === 'L3') {
    return { preferCategories: ['norms', 'iaq_guidelines'] };
  }
  return {};
}

