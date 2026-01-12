// Simple query router to classify queries into L1–L4 and surface richer hints for downstream planning.

const METRIC_KEYWORDS = {
  occupancy: ['occupancy', 'people count', 'people_count', 'headcount', 'footfall', 'utilization'],
  energy: ['energy', 'kwh', 'kilowatt', 'kilowatts', 'consumption', 'power', 'kw', 'meter', 'kW'],
  temperature: ['temperature', 'temp', 'thermal'],
  humidity: ['humidity', 'humid'],
  co2: ['co2', 'co₂', 'carbon dioxide'],
  voc: ['voc', 'tvoc'],
  pm: ['pm1', 'pm2.5', 'pm10', 'particulate'],
  airflow: ['air change', 'airchangerate', 'air exchange', 'ach', 'airflow', 'air flow'],
  water: ['water', 'leak', 'pipe'],
  light: ['lux', 'lighting', 'illuminance', 'light level'],
  weather: ['weather', 'outside temp', 'external temp', 'outdoor']
};

const TIME_KEYWORDS = {
  relative: ['today', 'yesterday', 'this week', 'this month', 'last week', 'last month', 'past', 'previous', 'recent', 'current'],
  future: ['next', 'upcoming', 'future', 'forecast', 'predict'],
  range: ['between', 'from', 'through', 'over the', 'during', 'across', 'since']
};

const AGGREGATION_KEYWORDS = ['average', 'avg', 'mean', 'median', 'total', 'sum', 'minimum', 'maximum', 'min', 'max', 'peak', 'lowest', 'highest', 'range'];
const TABLE_KEYWORDS = ['table', 'tabular', 'rows', 'records', 'dataset', 'data table', 'data log', 'log entries', 'sample rows'];

const CHART_KEYWORDS = {
  histogram: ['histogram', 'distribution', 'frequency', 'bins', 'bucket'],
  scatter: ['scatter', 'vs ', 'versus', 'against', 'x vs y'],
  heatmap: ['heatmap', 'matrix'],
  bar: ['bar chart', 'column chart', 'rank', 'top', 'bottom'],
  line: ['trend', 'line chart', 'timeseries', 'time series', 'plot']
};

function includesAny(text, keywords) {
  return keywords.some((kw) => text.includes(kw));
}

function detectMetrics(text) {
  const matches = new Set();
  for (const [metric, keywords] of Object.entries(METRIC_KEYWORDS)) {
    if (includesAny(text, keywords)) matches.add(metric);
  }
  return Array.from(matches);
}

function detectChartHint(text) {
  for (const [hint, keywords] of Object.entries(CHART_KEYWORDS)) {
    if (includesAny(text, keywords)) return hint;
  }
  return null;
}

function isStrictChartHint(hint, text) {
  if (!hint) return false;
  const strictTokens = {
    histogram: ['histogram'],
    scatter: ['scatter', 'scatterplot'],
    heatmap: ['heatmap'],
    bar: ['bar chart', 'column chart'],
    line: ['line chart', 'line graph']
  };
  return includesAny(text, strictTokens[hint] || []);
}

function detectTimeHints(text) {
  const hints = {};
  hints.relative = includesAny(text, TIME_KEYWORDS.relative);
  hints.future = includesAny(text, TIME_KEYWORDS.future);
  hints.explicitRange = includesAny(text, TIME_KEYWORDS.range) || /\d{4}/.test(text);
  if (text.includes('hour')) hints.granularity = 'hourly';
  else if (text.includes('day') || text.includes('daily')) hints.granularity = 'daily';
  else if (text.includes('week')) hints.granularity = 'weekly';
  return hints;
}

export function classifyQuery(question) {
  const original = String(question || '');
  const q = original.toLowerCase();
  const has = (kw) => q.includes(kw);

  const signals = {
    l1: includesAny(q, [
      'what is', 'show', 'display', 'list', 'give me', 'show me', 'provide',
      'latest', 'current', 'value of', 'status', 'state', 'reading', 'measurement',
      'how many', 'number of', 'count', 'sum', 'average', 'avg', 'mean', 'min', 'max',
      'minimum', 'maximum', 'total', 'median', 'mode', 'range', 'variance', 'std dev',
      'standard deviation', 'today', 'this hour', 'this day', 'this week', 'now', 'recent',
      'recently', 'recorded', 'data for', 'report', 'show data', 'chart of', 'graph of',
      'dataset', 'table', 'log', 'history of', 'time series', 'trendline', 'summary of'
    ]),
    l2: includesAny(q, [
      'compare', 'comparison', 'difference', 'difference between', ' vs', 'versus',
      'relative to', 'relation', 'relationship', 'correlat', 'association',
      'ratio', 'proportion', ' per ', 'percentage', 'fraction',
      'higher than', 'lower than', 'more than', 'less than',
      'which has', 'who has', 'where has', 'top', 'bottom', 'ranked', 'ranking',
      'highest', 'lowest', 'most', 'least', 'better', 'worse', 'improve', 'decline',
      'increase', 'decrease', 'rise', 'fall', 'growth', 'drop', 'change over', 'over time',
      'across pages', 'cross page', 'across products', 'cross product', 'cross owner', 'across shops',
      'variation', 'fluctuation', 'delta', 'trend', 'trajectory', 'moving average',
      'seasonal', 'periodic', 'pattern of change', 'comparing', 'contrast', 'difference in'
    ]),
    l3: includesAny(q, [
      'comply', 'compliance', 'standard', 'code', 'regulation', 'rule', 'policy', 'guideline',
      'requirement', 'must meet', 'should meet', 'acceptable', 'tolerable', 'required',
      'threshold', 'limit', 'target', 'setpoint', 'boundary', 'constraint', 'ceiling', 'floor',
      'above limit', 'beyond limit', 'below limit', 'exceed', 'exceeded', 'exceeds',
      'within range', 'outside range', 'under range', 'over range',
      'violate', 'violation', 'noncompliant', 'breach', 'non-conformance',
      'satisfy', 'meet criteria', 'pass', 'fail', 'inspection', 'audit', 'safety check',
      'according to', 'aligned with', 'under standard', 'per guideline', 'required by',
      'regulatory', 'mandated', 'compliant with', 'policy compliance', 'rule adherence'
    ]),
    l4: includesAny(q, [
      'why', 'reason', 'cause', 'causing', 'root cause', 'underlying cause', 'due to',
      'explain', 'explanation', 'explain why', 'what led to', 'because', 'result of',
      'how come', 'trigger', 'reason for', 'source of', 'derived from',
      'predict', 'forecast', 'projection', 'expected', 'expectation', 'anticipate', 'anticipation',
      'estimate', 'future', 'next', 'upcoming', 'in advance', 'what will happen',
      'forecasting', 'trend forecast', 'projection of', 'likely to', 'probable', 'expected to',
      'anomaly', 'anomalous', 'outlier', 'pattern', 'deviation', 'unexpected', 'surprising',
      'fluctuation cause', 'abnormal', 'error cause', 'drift', 'variance cause', 'diagnose',
      'diagnostic', 'investigate', 'investigation', 'root analysis', 'failure reason', 'fault detection'
    ])
  };

  let level = 'L1';
  if (signals.l4) level = 'L4';
  else if (signals.l3) level = 'L3';
  else if (signals.l2) level = 'L2';
  else if (signals.l1) level = 'L1';

  const pipeline = {
    L1: { retrieval: { mode: 'hybrid', k: 8 }, reasoning: 'direct' },
    L2: { retrieval: { mode: 'hybrid-iterative', k: 12, hops: 2 }, reasoning: 'iterative' },
    L3: { retrieval: { mode: 'hybrid+rules', k: 18, focus: ['norms', 'iaq_guidelines'] }, reasoning: 'workflow' },
    L4: { retrieval: { mode: 'broad-hybrid', k: 24 }, reasoning: 'cot' }
  }[level];

  const metrics = detectMetrics(q);
  const chartHint = detectChartHint(q);
  const chartHintStrict = isStrictChartHint(chartHint, q);
  const timeHints = detectTimeHints(q);
  const intents = {
    comparison: signals.l2 || includesAny(q, ['compare', 'vs ', 'versus', 'difference between']),
    correlation: q.includes('correlation') || q.includes('corr '),
    forecast: includesAny(q, ['forecast', 'predict', 'projection', 'estimate future', 'what will happen']),
    anomaly: includesAny(q, ['anomaly', 'anomalous', 'outlier', 'unexpected', 'abnormal', 'spike']),
    compliance: signals.l3,
    explanation: signals.l4,
    weather: includesAny(q, METRIC_KEYWORDS.weather),
    occupancy: metrics.includes('occupancy'),
    energy: metrics.includes('energy'),
    histogram: chartHint === 'histogram',
    scatter: chartHint === 'scatter',
    heatmap: chartHint === 'heatmap',
    aggregate: includesAny(q, AGGREGATION_KEYWORDS),
    table: includesAny(q, TABLE_KEYWORDS),
    requiresChart: includesAny(q, ['plot', 'chart', 'graph', 'visualize']) || !!chartHint,
    wantsScope: includesAny(q, ['what scope', 'selection', 'current scope']),
    wantsLatest: includesAny(q, ['latest', 'current', 'right now']),
    mentionsTrend: includesAny(q, ['trend', 'over time', 'timeseries', 'time series'])
  };

  const keywords = {
    metrics,
    chartHint,
    timeHints
  };

  return { level, pipeline, intents, metrics, chartHint, chartHintStrict, timeHints, keywords, original };
}

export function suggestRetrievalFilters(level, context = {}) {
  const categories = new Set();
  const intents = context.intents || {};
  const metrics = context.metrics || [];

  if (level === 'L3' || intents.compliance) {
    categories.add('norms');
    categories.add('iaq_guidelines');
  }
  if (intents.weather || metrics.includes('weather')) {
    categories.add('weather_data');
    categories.add('weather_queries');
    categories.add('weather_impact');
  }
  if (metrics.includes('energy')) {
    categories.add('energy');
    categories.add('energy_queries');
    categories.add('energy_optimizations');
  }
  if (metrics.includes('occupancy')) {
    categories.add('occupancy_queries');
    categories.add('occupancy_best_practices');
  }
  if (intents.forecast) {
    categories.add('predictive_planning_queries');
  }
  if (intents.correlation || intents.comparison) {
    categories.add('performance_trends_queries');
  }

  if (!categories.size) return {};
  return { preferCategories: Array.from(categories) };
}
