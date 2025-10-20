// Simple query router to classify queries into L1–L4 and suggest pipeline options.

export function classifyQuery(question) {
  const q = String(question || '').toLowerCase();

  const has = (kw) => q.includes(kw);
  

  const signals = {
    // L1 — Descriptive / factual / simple lookups
    l1: [
      'what is', 'show', 'display', 'list', 'give me', 'show me', 'provide',
      'latest', 'current', 'value of', 'status', 'state', 'reading', 'measurement',
      'how many', 'number of', 'count', 'sum', 'average', 'avg', 'mean', 'min', 'max',
      'minimum', 'maximum', 'total', 'median', 'mode', 'range', 'variance', 'std dev',
      'standard deviation', 'today', 'this hour', 'this day', 'this week', 'now', 'recent',
      'recently', 'recorded', 'data for', 'report', 'show data', 'chart of', 'graph of',
      'dataset', 'table', 'log', 'history of', 'time series', 'trendline', 'summary of'
    ].some(has),

    // L2 — Comparative / correlation / trend analysis
    l2: [
      'compare', 'comparison', 'difference', 'difference between', 'vs ', 'versus',
      'relative to', 'relation', 'relationship', 'correlat', 'association',
      'ratio', 'proportion', 'per ', 'percentage', 'fraction',
      'higher than', 'lower than', 'more than', 'less than',
      'which has', 'who has', 'where has', 'top', 'bottom', 'ranked', 'ranking',
      'highest', 'lowest', 'most', 'least', 'better', 'worse', 'improve', 'decline',
      'increase', 'decrease', 'rise', 'fall', 'growth', 'drop', 'change over', 'over time',
      'across rooms', 'cross room', 'cross building', 'across zones',
      'variation', 'fluctuation', 'delta', 'trend', 'trajectory', 'moving average',
      'seasonal', 'periodic', 'pattern of change', 'comparing', 'contrast', 'difference in'
    ].some(has),

    // L3 — Compliance / standard / rule-based reasoning
    l3: [
      'comply', 'compliance', 'standard', 'code', 'regulation', 'rule', 'policy', 'guideline',
      'requirement', 'must meet', 'should meet', 'acceptable', 'tolerable', 'required',
      'threshold', 'limit', 'target', 'setpoint', 'boundary', 'constraint', 'ceiling', 'floor',
      'above limit', 'beyond limit', 'below limit', 'exceed', 'exceeded', 'exceeds',
      'within range', 'outside range', 'under range', 'over range',
      'violate', 'violation', 'noncompliant', 'breach', 'non-conformance',
      'satisfy', 'meet criteria', 'pass', 'fail', 'inspection', 'audit', 'safety check',
      'according to', 'aligned with', 'under standard', 'per guideline', 'required by',
      'regulatory', 'mandated', 'compliant with', 'policy compliance', 'rule adherence'
    ].some(has),

    // L4 — Explanatory / diagnostic / predictive reasoning
    l4: [
      'why', 'reason', 'cause', 'causing', 'root cause', 'underlying cause', 'due to',
      'explain', 'explanation', 'explain why', 'what led to', 'because', 'result of',
      'how come', 'trigger', 'reason for', 'source of', 'derived from',
      'predict', 'forecast', 'projection', 'expected', 'expectation', 'anticipate', 'anticipation',
      'estimate', 'future', 'next', 'upcoming', 'in advance', 'what will happen',
      'forecasting', 'trend forecast', 'projection of', 'likely to', 'probable', 'expected to',
      'anomaly', 'anomalous', 'outlier', 'pattern', 'deviation', 'unexpected', 'surprising',
      'fluctuation cause', 'abnormal', 'error cause', 'drift', 'variance cause', 'diagnose',
      'diagnostic', 'investigate', 'investigation', 'root analysis', 'failure reason', 'fault detection'
    ].some(has)
  };


  let level = 'L1';
  if (signals.l4) level = 'L4';
  else if (signals.l3) level = 'L3';
  else if (signals.l2) level = 'L2';
  else if (signals.l1) level = 'L1';

  // Suggested pipeline knobs
  const pipeline = {
    L1: { retrieval: { mode: 'hybrid', k: 8 }, reasoning: 'direct' },
    L2: { retrieval: { mode: 'hybrid-iterative', k: 12, hops: 2 }, reasoning: 'iterative' },
    L3: { retrieval: { mode: 'hybrid+rules', k: 18, focus: ['norms', 'iaq_guidelines'] }, reasoning: 'workflow' },
    L4: { retrieval: { mode: 'broad-hybrid', k: 24 }, reasoning: 'cot' }
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
