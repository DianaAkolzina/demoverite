import { classifyQuery, suggestRetrievalFilters } from '../router.js';
import { hybridRetrieve } from '../retrieval.js';
import { evaluateQA } from '../eval.js';

export function createAgentRunner(ctx) {
  const {
    alignRangeToTelemetry,
    applyScopeHeaderText,
    availableFieldsByTable,
    buildAnalysisDirectives,
    buildContextSnippet,
    buildDefaultAnswer,
    buildChartFromTrace,
    buildScopeSummary,
    buildToolSpec,
    chartHasRenderableSeries,
    classifyIntent,
    cloneChart,
    collectDevicesForZone,
    countTraceToolExecutions,
    describeRangeWindow,
    detectUnavailableMetricResponse,
    deviceFriendlyName,
    enforceOverviewDetails,
    ensureChartData,
    extractQuestionRooms,
    extractTimestampFromQuestion,
    formatLocal,
    deriveTimeseriesInsights,
    inferDefaultTableForMetric,
    inferFieldName,
    isPlaceholderAnswer,
    loadRoomTables,
    normalizeText,
    ensureQuestionAnswerCoverage,
    prepareToolArgs,
    questionIsScopeInquiry,
    questionRequiresChart,
    questionRequiresRoomComparison,
    questionRequiresRoomRanking,
    questionRequiresScatter,
    resolveToolName,
    runEmergencyAnalysis,
    setScopeContext,
    shortenKnowledgeSnippet,
    summarizeChart,
    summarizeConnectorStatus,
    summarizeZones,
    traceHasData,
    traceHasHistogramData,
    traceInsight,
    tryAnswerPointQuery,
    validateChart,
    formatScopeHeaderLine,
    tools,
    assistantMessage,
    log,
    DEBUG,
    ragManager,
    vector,
    callGeminiChat
  } = ctx;

  async function run(messages, {
    room,
    range,
    selectionRooms = [],
    selectionZones = [],
	    tenant = null,
	    building = null,
	    floor = null,
	    zone = null,
    scopeLabels = null,
    scopeFloors = [],
    scopeDeviceZones = {},
    attempt = 0,
    conversationSummary = ''
  }) {
    const convMemory = process.env.AGENT_ENABLE_MEMORY === '1' ? (conversationSummary || '') : '';
    const question = messages[messages.length - 1]?.content || '';
    const questionLower = String(question || '').toLowerCase();
    let scopeHeaderLine = '';
    const applyScopeHeader = (text) => applyScopeHeaderText(text, scopeHeaderLine);

    try {

    // --- ROUTING & HYBRID RETRIEVAL ---
    const routing = classifyQuery(question);
    const questionNamedRooms = extractQuestionRooms(question);
    routing.namedRooms = questionNamedRooms;
    const filters = suggestRetrievalFilters(routing.level, routing);
    const preferCategories = filters?.preferCategories || [];
    const routerDirectives = buildAnalysisDirectives(routing);
    const selectionFloors = Array.isArray(scopeFloors) ? [...scopeFloors] : [];

    const retrievalScope = {
      tenant,
      building,
      floor,
      room,
      owner: scopeLabels?.owner || building || null,
      shop: scopeLabels?.shop || floor || null,
      page: scopeLabels?.page || zone || null,
      rooms: selectionRooms,
      zones: selectionZones,
      pages: selectionZones,
      metrics: routing.metrics,
      timeHints: routing.timeHints
    };

    const ctx = await buildContextSnippet(
      question,
      room && room !== 'ALL' ? room : null,
      range,
      selectionRooms,
      {
        selectionZones,
        selectionFloors,
        scopeDeviceZones,
        scopeLabels,
        retrievalHints: {
          preferCategories,
          metrics: routing.metrics,
          timeHints: routing.timeHints,
          scope: retrievalScope,
          k: routing?.pipeline?.retrieval?.k || 4
        }
      }
    );

    scopeHeaderLine = ctx?.scopeHeaderLine || scopeHeaderLine;

    const hybridHits = (ctx && ctx._retrievedDocs && ctx._retrievedDocs.length)
      ? ctx._retrievedDocs
      : await hybridRetrieve({
          query: question,
          ragIndex: ragManager.ensure().index,
          vectorClient: vector,
          k: routing?.pipeline?.retrieval?.k || 6,
          preferCategories,
          scope: retrievalScope
        }).catch(() => []);

    // --- QUERY ENRICHMENT: Knowledge Pack ---
    let knowledgeSnippets = hybridHits
      .filter(h => h.meta?.type === 'knowledge')
      .slice(0, 3)
      .map(h => `From ${h.meta.file}: ${h.text}`)
      .join('\n---\n');
    if (knowledgeSnippets && knowledgeSnippets.length > 900) {
      knowledgeSnippets = knowledgeSnippets.slice(0, 900) + '\n…';
    }
    // --------------------------------------------

    const attemptIndex = Number.isFinite(Number(attempt)) ? Number(attempt) : 0;

    const roomFieldCache = new Map();
    function fieldsForRoom(roomId) {
      if (!roomId) return new Set();
      if (roomFieldCache.has(roomId)) return roomFieldCache.get(roomId);
      const tablesSets = availableFieldsByTable(roomId);
      const set = new Set();
      for (const val of Object.values(tablesSets || {})) {
        if (val && typeof val.forEach === 'function') {
          val.forEach((f) => { if (f && f !== 'ts') set.add(f); });
        }
      }
      roomFieldCache.set(roomId, set);
      return set;
    }

    function findSharedField(roomIds = [], preferred = [], exclude = null) {
      const candidates = [...preferred];
      const firstRoom = roomIds.find(Boolean);
      if (firstRoom) {
        fieldsForRoom(firstRoom).forEach((f) => { if (!candidates.includes(f)) candidates.push(f); });
      }
      for (const field of candidates) {
        if (!field || (exclude && String(field) === String(exclude))) continue;
        const ok = roomIds.every((rid) => !rid || fieldsForRoom(rid).has(field));
        if (ok) return field;
      }
      return null;
    }

    log('Question:', '<redacted>');
    const iterationTimings = [];
    const markTiming = (label, startHrtime) => {
      if (!startHrtime) return;
      const diff = process.hrtime.bigint() - startHrtime;
      const ms = Number(diff) / 1e6;
      iterationTimings.push({ label, ms });
    };
    if (DEBUG) log('Context snippet schema keys:', Object.keys(ctx.schema));

    const trace = [];
    let rr = (range && typeof range === 'object') ? { ...range } : {};
    const telemetryAlignment = alignRangeToTelemetry(rr, {
      selectionRooms,
      selectionZones,
      scopeLabels: scopeLabels || {},
      fallbackRoom: room
    });
    rr = telemetryAlignment.range;
    setScopeContext({ selectionRooms, selectionZones, selectionFloors, scopeDeviceZones, scopeLabels, range: rr });
    const adaptationNotes = [];
    if (telemetryAlignment.changed) {
      adaptationNotes.push(`Adjusted time window to available telemetry (${describeRangeWindow(rr)}).`);
    }
    // Inject knowledge enrichment into system prompt
    const startDate = rr.start ? new Date(rr.start) : null;
    const endDate = rr.end ? new Date(rr.end) : null;
	    const startFmt = startDate ? `${startDate.toLocaleString()} (UTC: ${startDate.toISOString().replace('T', ' ').slice(0, 16)})` : 'none';
	    const endFmt = endDate ? `${endDate.toLocaleString()} (UTC: ${endDate.toISOString().replace('T', ' ').slice(0, 16)})` : 'none';
	
    const zoneSummaries = summarizeZones(selectionRooms, selectionZones, scopeDeviceZones, { building, floor });
    const zonesLine = zoneSummaries.length ? zoneSummaries.join('; ') : '(none)';
    const devicesLine = Array.isArray(selectionRooms) && selectionRooms.length ? selectionRooms.join(', ') : '(none)';
    const namedRoomDevices = questionNamedRooms.map((label) => ({
      label,
      devices: collectDevicesForZone(label, { building, floor })
    }));
    const namedRoomDeviceHints = namedRoomDevices
      .map(({ label, devices }) => {
        if (!Array.isArray(devices) || !devices.length) return `${label}: no matching scope devices`;
        const preview = devices
          .slice(0, 3)
          .map((entry) => {
            const id = entry.cloudId || entry.primaryId || entry.id || '';
            const nm = entry.name && entry.name !== id ? ` (${entry.name})` : '';
            return id ? `${id}${nm}` : entry.name || '';
          })
          .filter(Boolean)
          .join(', ');
        return `${label}: ${preview}`;
      })
      .filter(Boolean);

    const hasAnalysisKeywords = /\b(sales|orders|order|revenue|aov|avg order|conversion|add to cart|cart|checkout|visits|sessions|traffic|bounce|roas|cpc|spend|product|category|page|shop|owner|forecast|predict|trend|compare|chart|plot|graph|correlat|analy[sz])\b/i.test(questionLower);
    const directScopeAsk = /^\s*(what['’]s|what is|show|describe|tell me)\s+(the\s+)?scope\b/i.test(questionLower) || /current scope\b/i.test(questionLower);
    const scopeOnlyQuestion =
      (directScopeAsk || questionIsScopeInquiry(question) || /\bscope\b/.test(questionLower)) &&
      !hasAnalysisKeywords;

    const unavailableMetricResponse = detectUnavailableMetricResponse(question, selectionRooms, room);
    if (unavailableMetricResponse) return unavailableMetricResponse;
    if (scopeOnlyQuestion) {
      const trace = [];
      const steps = [
        { id: 'S1', index: 1, text: 'Summarize the current selection (devices, metrics, coverage, time window).', tool: 'scope_summary', done: false, note: null }
      ];
      trace.push({ tool: 'plan', args: { steps }, result: null });
      const scopeArgs = {
        selectionRooms,
        selectionZones,
        selectionFloors,
        selectionLabels: scopeLabels,
        range: rr
      };
      const result = tools.scope_summary(scopeArgs);
      trace.push({ planStepId: 'S1', tool: 'scope_summary', args: scopeArgs, result });
      const planStatus = [{ id: 'S1', status: 'done', finding: 'Scope summarized' }];
      let scopeMessage = result?.summary || 'Scope is not defined for the current selection.';
      const headerLineFinal = scopeHeaderLine || formatScopeHeaderLine(scopeLabels, selectionFloors, selectionZones);
      if (headerLineFinal) scopeHeaderLine = headerLineFinal;
      scopeMessage = applyScopeHeader(scopeMessage);
      scopeMessage = enforceOverviewDetails(scopeMessage, { range: rr, trace, planStatus });
      return {
        message: assistantMessage(scopeMessage, { preserveWhitespace: true }),
        chart: null,
        trace,
        plan_status: planStatus
      };
    }

    const intent = classifyIntent(question);
    const histogramRequested = false;
    const heatmapRequested = false;
    const requireRoomRanking = false;
    const rankingRoomsList = '';
    const scatterRequested = questionRequiresScatter(question);
    const rankingInstruction = '';
    const needsRoomComparison = false;
    const comparisonRoomsList = '';
    const comparisonInstruction = '';

    const scopeSnapshotNote = ctx.scopeSnapshot ? `Scope snapshot notes:\n${ctx.scopeSnapshot}\n` : '';
    const connectorNote = summarizeConnectorStatus(ctx.connectors);
    const scopeSummary = tools.scope_summary();
    const scopeSchemaLine = scopeSummary && scopeSummary.schema
      ? `Scope devices and schema headers: ${JSON.stringify(scopeSummary.schema)}`
      : '';
    const sys = `You are a senior data analyst agent for e-commerce performance.
${convMemory ? `=== CONVERSATION MEMORY ===\n${convMemory}\n` : ''}
${connectorNote ? `${connectorNote}\n` : ''}
Selected product: ${room || '(none)'}.
Pages in scope: ${zonesLine}
Products in scope: ${devicesLine}
${namedRoomDeviceHints.length ? `User-named pages resolved to products: ${namedRoomDeviceHints.join(' | ')}` : ''}
${room === 'ALL' && selectionRooms && selectionRooms.length ? `IMPORTANT: Cross-page analysis MUST be limited to ONLY these products and their parent pages. Do NOT introduce other scopes.` : ''}
${scopeSnapshotNote}
${scopeSchemaLine}
Selected time window: 
- Local: ${startFmt} to ${endFmt}
- Epoch ms: start=${rr.start ?? 'none'} end=${rr.end ?? 'none'}

MANDATORY: Always use this time window for all analysis and answers. Do NOT invent or assume any other period. If the user asks "what time period are you analysing", repeat this exact window.

FREEDOM TO ANALYZE: You are encouraged to analyze the data, derive insights, and synthesize conclusions. Use tools as needed; if tools are insufficient, explain and proceed with reasoned analysis using available data. Always produce deeper analysis (min/avg/max with timestamps, gaps/missingness, notable spikes/drops, short recommendations).

DOMAIN NOTE: "Page" and legacy "Room/Zone" are synonyms in this data. Use the hierarchy Shop Owner → Shop → Page to understand placement.

${routerDirectives}

${rankingInstruction ? `${rankingInstruction}\n` : ''}${comparisonInstruction ? `${comparisonInstruction}\n` : ''}=== KNOWLEDGE PACK ENRICHMENT (REPHRASE ONLY) ===
${knowledgeSnippets || 'No extra knowledge found for this query.'}

RULE: Do NOT dump or quote long passages from knowledge. If you use it, REPHRASE concisely in your own words and keep it brief.
CONSISTENCY RULE: Build every conclusion from the tools you run—do NOT fall back to placeholder text.
AGGREGATION RULE: When comparing metrics, compute stats (count/min/max/avg) or aggregates (compare_rooms_on_metric, stats) and cite those numbers.

${intent.weatherQuestion ? 'WEATHER TASK: Use Market Signals metrics or call weather_fetch for the selected shop owner when weather context is required.' : ''}

=== CRITICAL CHART RULES ===
NEVER embed data arrays directly in chart JSON. This will ALWAYS cause truncation and failure.
ALWAYS use dataRef to reference tool results. This is MANDATORY for all charts.

WRONG (FORBIDDEN - causes truncation):
{
  "series": [{
    "name": "Temperature",
    "data": [[1759273200000,20.5],[1759273800000,21.2],...]  ← NEVER DO THIS
  }]
}

CORRECT (REQUIRED - use dataRef):
{
  "series": [{
    "name": "Temperature",
    "dataRef": {
      "tool": "fetch_timeseries",
      "xField": "ts",
      "yField": "temperature"
    }
  }]
}

The backend automatically resolves dataRef to extract data from your tool call results.
You ONLY provide the reference. The backend handles data extraction.

CHART STYLE: Pick a chart type that fits the KPI (e.g., column for order counts, line for smooth trends, area for cumulative revenue, scatter for correlations, histogram for distributions). Always explain in prose what the chart shows and why it matters.

=== CHART EXAMPLES WITH dataRef ===

Line chart (timeseries):
{
  "chart": {"type": "line"},
  "title": {"text": "Sales Amount Over Time"},
  "xAxis": {"type": "datetime"},
  "yAxis": {"title": {"text": "Sales ($)"}},
  "series": [{
    "name": "Sales Amount",
    "dataRef": {"tool": "fetch_timeseries", "xField": "ts", "yField": "sales_amount"}
  }]
}

Ratio/computed metric chart:
{
  "chart": {"type": "line"},
  "title": {"text": "Conversion Rate (Orders / Sessions)"},
  "xAxis": {"type": "datetime"},
  "yAxis": {"title": {"text": "Conversion Rate"}},
  "series": [{
    "name": "Conversion Rate",
    "dataRef": {"tool": "compute_ratio", "xField": "ts", "yField": "ratio"}
  }]
}

Forecast chart (historical + prediction):
{
  "chart": {"type": "line"},
  "title": {"text": "Orders Forecast"},
  "xAxis": {"type": "datetime"},
  "yAxis": {"title": {"text": "Orders"}},
  "series": [
    {
      "name": "Historical",
      "dataRef": {"tool": "forecast_hourly_linear", "field": "historical", "xField": "ts", "yField": "avg"}
    },
    {
      "name": "Forecast",
      "dataRef": {"tool": "forecast_hourly_linear", "field": "forecast", "xField": "ts", "yField": "forecast"},
      "dashStyle": "dash",
      "color": "#ff6b6b"
    }
  ]
}

Weather data chart:
{
  "chart": {"type": "line"},
  "title": {"text": "Outside Temperature"},
  "xAxis": {"type": "datetime"},
  "yAxis": {"title": {"text": "°C"}},
  "series": [{
    "name": "Outside Temp",
    "dataRef": {"tool": "weather_fetch", "xField": "ts", "yField": "temp"}
  }]
}

=== ANALYSIS WORKFLOW (MANDATORY) ===
1) Plan first: {"action":"plan","steps":[{"id":"S1","goal":"...","tool":"<name>","inputs":["metric"]},...]} (2–4 steps). No tools until acknowledged.
2) Execute ALL tools in a single {"action":"tool_calls","tools":[...]} covering every plan step (stats + chart source) with "planStep":"S#". Do not split into multiple tool_calls turns.
3) Final: {"action":"final","answer":"...","chart":<HighchartsOptions or null>,"plan_status":[{"id":"S1","status":"done","finding":"..."}...]} starting with "Overview:", then "Details:" per step, and explicitly comment on any chart.
4) If a step is blocked/missing data, mark plan_status accordingly and explain.
5) Charts: every series must use dataRef; do not embed arrays. If you cannot wire dataRef, return text-only.
6) Analysis: cite min/avg/max with timestamps, gaps, peaks/drops, correlations/comparisons, and concise recommendations/next checks.

If you want to answer in plain text (no chart, no structured data), respond with:
{ "action": "final_text", "answer": "<your answer>" }
=== ANALYSIS RULES ===
- Always assume the selected product/time window for analysis. Do NOT ask the user for dates; use the provided window as defaults for tools.
- When calling tools, if args omit room/start/end, fill them with the selected product and time window.
- Charts: strictly use dataRef series pointing to tool outputs. Do not embed inline data arrays.
- For every chart/metric analyzed, report min/avg/max with timestamps, latest value, any data gaps/missingness, and call out spikes/drops and trends. Add 1–2 concise recommendations or next checks when relevant.

- PREDICTION/FORECAST queries: When user asks to "predict", "forecast", "what will be", "estimate future", etc., use the appropriate forecast tool:
  * forecast_from_profile: Best for daily patterns (temperature, humidity, occupancy over days/weeks)
  * forecast_hourly_linear: For trending metrics with clear direction
  * forecast_hourly_naive: Simple baseline (last value repeated)
  * Default horizon: 168 hours (1 week) or 7 days depending on tool

- If a tool returns no rows in the selected window (e.g., fetch_timeseries or stats shows 0), call fetch_table_meta to get the available ts range and decide whether to adapt.

- PARALLEL TOOL CALLS: Prefer one {"action":"tool_calls","tools":[...]} covering all plan steps.
- Return either {"action":"tool_call",...}, {"action":"tool_calls",...}, or {"action":"final",...}.
- When presenting times, format timestamps as 'YYYY-MM-DD HH:mm' (local time) and hours of day as 'h AM/PM'.
- For "best time" style questions, prefer hour_of_day_stats (e.g., on people_count or co2) and explain the hour labels in human terms.
- ALWAYS provide final answer as properly formatted JSON with action:"final". Never just provide conversational text without the JSON structure.

=== REMEMBER ===
- Prefer dataRef in chart series; only embed small aggregate arrays when they contain a handful of points.
- The backend resolves dataRef automatically from tool results
- Avoid embedding large datasets – use dataRef for timeseries and long arrays

Tools: ${buildToolSpec()}.
Notes: 
- In market signal data, temperature field is 'temp'.
- Use 'hour_of_day_stats' for "best time" by traffic or orders.
- Use 'busiest_day_of_week' for questions about "busiest day", "which weekday", "highest orders day", etc.
- Use 'histogram' when the user asks for a distribution or histogram.
- Use 'compare_metrics_in_room' for comparing multiple KPIs within one product, and 'compare_rooms_on_metric' to rank products by an aggregate.
- Use 'scope_daily_percentile' when users request multi-product percentile/occupied-period summaries (e.g., “daily 95th percentile sales with median traffic”).
For KPI tables: common fields include visits, sessions, conversion_rate, add_to_cart_rate, order_count, sales_amount, avg_order_value, ad_spend, cpc, roas.
When user asks to COMPARE between pages/products or KPIs, prefer these tools:
- compare_series_cross_room (timeseries across products/pages)
- compare_rooms_on_metric (rank products by agg over window)
- compare_metrics_in_room (compare multiple fields within one product)
- correlation_matrix (pairwise correlations among metrics)
Context: ${JSON.stringify(ctx).slice(0, 5000)}`;

    const convo = [
      { role: 'user', content: sys },
      ...messages
    ];
    const iterationStart = process.hrtime.bigint();
    const toolResultCache = new Map();

    const qlLower = (question || '').toLowerCase();
    const explicitTimestamp = extractTimestampFromQuestion(question);
    const looksLikeRangeQuery = (() => {
      const q = String(question || '').toLowerCase();
      if (q.includes('between')) return true;
      if (q.includes('range')) return true;
      if (q.includes('over the') || q.includes('throughout')) return true;
      if (q.includes('from') && q.includes('to')) return true;
      if ((q.match(/\d{4}/g) || []).length >= 2) return true;
      return false;
    })();
    if (explicitTimestamp && !looksLikeRangeQuery) {
      const pointAnswer = tryAnswerPointQuery({
        question,
        timestamp: explicitTimestamp,
        room,
        selectionRooms,
        scopeDeviceZones,
        range: rr
      });
      if (pointAnswer) return pointAnswer;
    }


    let lastToolSig = '';
    let repeatCount = 0;
    let totalToolCalls = 0;
    let toolCallTurns = 0;
    let scatterRetryCount = 0;
    let chartRetryCount = 0;
    let planConfirmed = false;
    let planSteps = [];
    let planStatus = [];
    let planStepMap = new Map();
    let consecutivePlanReplies = 0;
    let planLoopWarnings = 0;
    let lastPlanSignature = null;
    let consecutiveJsonFailures = 0;
    let incompletePlanWarnings = 0;
    const MAX_INCOMPLETE_PLAN_WARNINGS = Math.max(1, Number(process.env.AGENT_INCOMPLETE_PLAN_MAX || 3));

    const canonicalPlanStepId = (raw, idx = null) => {
      let id = raw == null ? '' : String(raw).trim();
      if (!id && idx != null) id = `S${idx + 1}`;
      if (!id) return null;
      id = id.replace(/\s+/g, '');
      if (/^step\d+$/i.test(id)) id = `S${id.replace(/^step/i, '')}`;
      if (/^\d+$/i.test(id)) id = `S${id}`;
      if (!/^S/i.test(id)) id = `S${id}`;
      return id.toUpperCase();
    };

    const autoAssignPlanStep = (toolName) => {
      if (!planConfirmed || !planStatus.length) return null;
      const normalizedTool = toolName ? resolveToolName(toolName) : null;
      const open = planStatus.filter((step) => !step.done);
      if (!open.length) return planStatus[planStatus.length - 1] || planStatus[0] || null;
      if (normalizedTool) {
        const match = open.find((step) => resolveToolName(step.tool) === normalizedTool);
        if (match) return match;
      }
      return open[0];
    };

    const registerPlanSteps = (steps = []) => {
      planStepMap = new Map();
      steps.forEach((step, idx) => {
        if (!step || !step.id) return;
        const aliases = new Set([
          step.id,
          step.id.toLowerCase(),
          `S${step.index || idx + 1}`,
          `STEP${step.index || idx + 1}`,
          String(step.index || idx + 1)
        ]);
        aliases.forEach((key) => planStepMap.set(String(key).toUpperCase(), step));
      });
    };

    const findPlanStep = (ref) => {
      if (!ref) return null;
      const key = canonicalPlanStepId(ref);
      if (!key) return null;
      return planStepMap.get(key.toUpperCase()) || null;
    };

    const planStatusSnapshot = () => planStatus.map((step) => ({
      id: step.id,
      index: step.index,
      text: step.text,
      tool: step.tool,
      done: !!step.done,
      note: step.note || null
    }));

    const MAX_TOOL_POINTS = Math.max(200, Number(process.env.TOOL_RESULT_MAX_POINTS || 300));
    const trimResultForLLM = (val, maxPoints = MAX_TOOL_POINTS) => {
      if (Array.isArray(val)) {
        if (val.length <= maxPoints) return val;
        const step = Math.max(1, Math.floor(val.length / maxPoints));
        const out = [];
        for (let i = 0; i < val.length; i += step) out.push(val[i]);
        if (out[out.length - 1] !== val[val.length - 1]) out.push(val[val.length - 1]);
        return out;
      }
      if (val && typeof val === 'object') {
        const out = Array.isArray(val) ? [] : {};
        for (const [k, v] of Object.entries(val)) {
          out[k] = trimResultForLLM(v, maxPoints);
        }
        return out;
      }
      return val;
    };

    const findTraceEntryForPlanStep = (stepRef) => {
      if (!stepRef) return null;
      const key = canonicalPlanStepId(stepRef);
      if (!key) return null;
      for (let i = trace.length - 1; i >= 0; i -= 1) {
        const entry = trace[i];
        if (!entry || !entry.planStepId) continue;
        const entryKey = canonicalPlanStepId(entry.planStepId);
        if (entryKey && entryKey === key) return entry;
      }
      return null;
    };

    const chartFromSupportingData = (items = []) => {
      if (!Array.isArray(items) || !items.length) return null;
      const series = [];
      let chartType = null;
      let chartTitle = null;
      let axisType = null;
      let yLabel = null;
      for (const item of items) {
        if (!item) continue;
        chartType = chartType || item.chartType || 'line';
        chartTitle = chartTitle || item.title || item.name || 'Supporting Data';
        const mappings = item.mappings || {};
        if (!axisType) axisType = mappings.x ? (mappings.x === 'ts' ? 'datetime' : 'linear') : 'datetime';
        if (!yLabel && mappings.yLabel) yLabel = mappings.yLabel;
        let dataRef = null;
        if (item.dataRef && typeof item.dataRef === 'object') {
          dataRef = { ...item.dataRef };
        } else {
          const refKey = item.dataRef || item.planStep || item.plan_step || item.step;
          if (refKey) {
            const entry = findTraceEntryForPlanStep(refKey);
            if (entry) {
              const args = entry.args || {};
              const inferredY = mappings.y || args.field || (Array.isArray(args.fields) ? args.fields[0] : null);
              dataRef = {
                tool: entry.tool,
                room: args.room || null,
                table: args.table || args.table1 || args.table2 || null,
                fields: args.fields,
                xField: mappings.x || 'ts',
                yField: inferredY || 'value'
              };
            }
          }
        }
        if (!dataRef && typeof item.tool === 'string') {
          dataRef = {
            tool: resolveToolName(item.tool),
            xField: mappings.x || 'ts',
            yField: mappings.y || 'value'
          };
        }
        if (!dataRef || !dataRef.tool) continue;
        if (!dataRef.xField) dataRef.xField = 'ts';
        if (!dataRef.yField) dataRef.yField = 'value';
        const name = item.name || item.title || `Series ${series.length + 1}`;
        series.push({ name, dataRef });
      }
      if (!series.length) return null;
      const chart = {
        chart: { type: chartType || 'line' },
        title: { text: chartTitle || 'Supporting Data' },
        series
      };
      if (axisType) chart.xAxis = { type: axisType };
      if (yLabel) chart.yAxis = { title: { text: yLabel } };
      return chart;
    };

    const chartFromPlotSpec = (spec) => {
      if (!spec || typeof spec !== 'object') return null;
      const typeMap = {
        line: 'line',
        timeseries: 'line',
        area: 'area',
        column: 'column',
        bar: 'column',
        scatter: 'scatter',
        heatmap: 'heatmap',
        spline: 'spline'
      };
      const rawType = String(spec.type || '').toLowerCase();
      const chartType = typeMap[rawType] || 'line';
      const dataSpec = spec.data || {};
      const resolvePlanRef = (refKey) => {
        if (!refKey) return null;
        const entry = findTraceEntryForPlanStep(refKey);
        if (!entry) return null;
        const args = entry.args || {};
        return {
          tool: entry.tool,
          room: args.room || null,
          table: args.table || null,
          fields: args.fields,
          xField: dataSpec.x || args.xField || 'ts',
          yField: Array.isArray(args.fields) ? args.fields[0] : args.field || null
        };
      };
      const normalizeRefObject = (ref = {}) => {
        const clone = { ...ref };
        if (!clone.tool && typeof clone.planStep === 'string') {
          const planRef = resolvePlanRef(clone.planStep);
          if (planRef) return planRef;
        }
        if (!clone.xField) clone.xField = dataSpec.x || 'ts';
        return clone;
      };
      let baseRef = null;
      if (typeof dataSpec.dataRef === 'string') baseRef = resolvePlanRef(dataSpec.dataRef);
      else if (typeof dataSpec.source === 'string') baseRef = resolvePlanRef(dataSpec.source);
      if (!baseRef && dataSpec.dataRef && typeof dataSpec.dataRef === 'object') {
        baseRef = normalizeRefObject(dataSpec.dataRef);
      }
      const buildSeriesFromEntry = (entry = {}, fallbackRef = null, fallbackName = null) => {
        let ref = null;
        if (entry.dataRef && typeof entry.dataRef === 'object') ref = normalizeRefObject(entry.dataRef);
        else if (typeof entry.dataRef === 'string') ref = resolvePlanRef(entry.dataRef);
        else if (typeof entry.source === 'string') ref = resolvePlanRef(entry.source);
        if (!ref && fallbackRef) ref = { ...fallbackRef };
        if (!ref || !ref.tool) return null;
        const xField = entry.x || entry.xField || ref.xField || dataSpec.x || 'ts';
        let yField = entry.y || entry.field || entry.metric || ref.yField || (Array.isArray(ref.fields) ? ref.fields[0] : null);
        if (!yField && Array.isArray(entry.fields) && entry.fields.length) yField = entry.fields[0];
        if (!yField) return null;
        const name = entry.name || fallbackName || yField || `Series ${series.length + 1}`;
        const seriesRef = { ...ref, xField, yField };
        if (chartType === 'scatter') {
          seriesRef.xField = entry.x || entry.xField || 'x';
          seriesRef.yField = entry.y || entry.yField || yField || 'y';
        }
        return { name, dataRef: seriesRef };
      };

      const series = [];
      if (Array.isArray(dataSpec.series) && dataSpec.series.length) {
        for (const entry of dataSpec.series) {
          const built = buildSeriesFromEntry(entry, baseRef, entry.label);
          if (built) series.push(built);
        }
      }
      if (!series.length) {
        const yFields = Array.isArray(dataSpec.y)
          ? dataSpec.y
          : (dataSpec.y ? [dataSpec.y] : []);
        const fallbackFields = (yFields.length ? yFields : [
          baseRef?.yField ||
          (baseRef && Array.isArray(baseRef.fields) ? baseRef.fields[0] : null)
        ]).filter(Boolean);
        if (!baseRef && fallbackFields.length) {
          if (typeof dataSpec.room === 'string' || typeof spec.room === 'string') {
            const normalizedRoom = normalizeRoomId(dataSpec.room || spec.room);
            if (normalizedRoom) {
              baseRef = {
                tool: 'fetch_timeseries',
                room: normalizedRoom,
                table: dataSpec.table || 'telemetry',
                xField: dataSpec.x || 'ts'
              };
            }
          }
        }
        if (baseRef) {
          for (const field of fallbackFields) {
            const built = buildSeriesFromEntry({ field, name: field }, baseRef, field);
            if (built) series.push(built);
          }
        }
      }

      if (!series.length) return null;
      const xAxisType = chartType === 'scatter'
        ? (dataSpec.x === 'ts' ? 'datetime' : 'linear')
        : ((dataSpec.x || series[0]?.dataRef?.xField || 'ts') === 'ts' ? 'datetime' : 'linear');
      const yTitle = spec.layout?.yaxis?.title || spec.layout?.yaxis?.text || 'Value';
      return {
        chart: { type: chartType },
        title: { text: spec.layout?.title || 'Plot' },
        xAxis: {
          type: xAxisType,
          title: { text: spec.layout?.xaxis?.title || spec.layout?.xaxis?.text || (chartType === 'scatter' ? 'X' : 'Time') }
        },
        yAxis: {
          title: { text: yTitle }
        },
        series
      };
    };

    const chartFromVisualization = (viz, trace = []) => {
      if (!viz || typeof viz !== 'object') return null;
      const typeMap = {
        line: 'line',
        column_chart: 'column',
        column: 'column',
        bar: 'column',
        bar_chart: 'column',
        histogram: 'column',
        heatmap: 'heatmap',
        scatter: 'scatter'
      };
      const chartType = typeMap[String(viz.type || '').toLowerCase()] || 'line';
      const dataRefKey = viz.dataRef || viz.source || (viz.series && viz.series[0] && viz.series[0].dataRef);
      let baseRef = null;
      if (typeof dataRefKey === 'string') {
        const entry = findTraceEntryForPlanStep(dataRefKey);
        if (entry) {
          const args = entry.args || {};
          baseRef = {
            tool: entry.tool,
            room: args.room || null,
            table: args.table || null,
            fields: args.fields,
            xField: 'ts',
            yField: (Array.isArray(args.fields) ? args.fields[0] : args.field) || null
          };
        }
      } else if (dataRefKey && typeof dataRefKey === 'object') {
        baseRef = { ...dataRefKey };
      }
      if (!baseRef || !baseRef.tool) return null;
      if (!baseRef.xField) baseRef.xField = 'ts';

      const seriesRefs = [];
      if (Array.isArray(viz.series) && viz.series.length) {
            for (const entry of viz.series) {
              let ref = null;
              if (entry.dataRef && typeof entry.dataRef === 'object') {
                ref = { ...entry.dataRef };
                if (!ref.tool && ref.planStep) {
                  const traceEntry = findTraceEntryForPlanStep(ref.planStep);
                  if (traceEntry) {
                    const args = traceEntry.args || {};
                    ref.tool = traceEntry.tool;
                    ref.room = args.room || ref.room || null;
                    ref.table = args.table || ref.table || null;
                    ref.fields = args.fields || ref.fields;
                    ref.yField = ref.yField || (Array.isArray(ref.fields) ? ref.fields[0] : args.field);
                  }
                }
              } else {
                ref = { ...baseRef };
                if (entry.field || entry.metric) ref.yField = entry.field || entry.metric;
              }
              if (!ref || !ref.tool) continue;
              seriesRefs.push({
                name: entry.name || entry.label || ref.yField || `Series ${seriesRefs.length + 1}`,
                dataRef: ref
              });
            }
      }
      if (!seriesRefs.length) {
        const fallbackFields = Array.isArray(baseRef.fields) && baseRef.fields.length ? baseRef.fields : [baseRef.yField || 'value'];
        seriesRefs.push(...fallbackFields.filter(Boolean).map((field) => ({
          name: field,
          dataRef: { ...baseRef, yField: field }
        })));
      }
      if (!seriesRefs.length) return null;
      const chart = {
        chart: { type: chartType },
        title: { text: viz.title || 'Visualization' },
        xAxis: {
          type: baseRef.xField === 'ts' ? 'datetime' : 'linear',
          title: { text: viz.xLabel || viz.xAxis?.title || 'Time' }
        },
        yAxis: {
          title: { text: viz.yLabel || viz.yAxis?.title || 'Value' }
        },
        series: seriesRefs
      };

      if (chartType === 'column' && viz.columns && dataRefKey) {
        const entry = findTraceEntryForPlanStep(dataRefKey);
        if (entry) {
          const bins = entry.result || [];
          chart.series = [{
            name: viz.title || 'Histogram',
            data: bins.map((row) => [row.binStart, row.count]),
            type: 'column'
          }];
          chart.xAxis = {
            categories: bins.map((row) => `${Number(row.binStart).toFixed(2)} - ${Number(row.binEnd).toFixed(2)}`),
            title: { text: 'Range' }
          };
          chart.yAxis = { title: { text: 'Count' } };
        }
      }
      return chart;
    };

    const extractTextFromAnswer = (payload) => {
      if (typeof payload === 'string') return payload.trim();
      if (!payload || typeof payload !== 'object') return '';
      const parts = [];
      const fields = ['answer', 'analysis', 'text', 'overview', 'details', 'summary'];
      for (const field of fields) {
        const value = payload[field];
        if (typeof value === 'string' && value.trim()) {
          parts.push(value.trim());
        } else if (Array.isArray(value)) {
          value.forEach((entry) => {
            if (typeof entry === 'string' && entry.trim()) parts.push(entry.trim());
          });
        }
      }
      return parts.join('\n\n').trim();
    };

    const normalizePlanSteps = (rawSteps = []) => {
      const normalized = [];
      const errors = [];
      rawSteps.forEach((raw, idx) => {
        if (!raw || typeof raw !== 'object') {
          errors.push(`Step ${idx + 1} must be an object with id/tool/goal.`);
          return;
        }
        const text = String(raw.goal ?? raw.text ?? raw.description ?? raw.summary ?? '').trim();
        if (!text) {
          errors.push(`Step ${idx + 1} is missing a goal/description.`);
          return;
        }
        const id = canonicalPlanStepId(raw.id ?? raw.stepId ?? raw.step_id ?? raw.step ?? raw.index ?? raw.name ?? raw.label ?? '', idx);
        if (!id) {
          errors.push(`Step ${idx + 1} is missing an id (use S1, S2, ...).`);
          return;
        }
        const rawToolName = raw.tool ?? raw.tool_name ?? raw.toolName ?? raw.action ?? raw.intent ?? '';
        const resolvedTool = resolveToolName(rawToolName);
        if (!resolvedTool || !tools[resolvedTool]) {
          errors.push(`Step ${id} must specify a valid tool (got "${rawToolName || 'none'}").`);
          return;
        }
        const inputs = [];
        const pushInput = (val) => {
          const str = String(val ?? '').trim();
          if (str) inputs.push(str);
        };
        if (Array.isArray(raw.inputs)) raw.inputs.forEach(pushInput);
        if (Array.isArray(raw.fields)) raw.fields.forEach(pushInput);
        if (Array.isArray(raw.metrics)) raw.metrics.forEach(pushInput);
        if (raw.metric) pushInput(raw.metric);
        if (raw.field) pushInput(raw.field);
        normalized.push({
          id,
          index: idx + 1,
          text,
          tool: resolvedTool,
          rawTool: rawToolName || resolvedTool,
          inputs,
          target: raw.room || raw.zone || raw.target || raw.scope || null,
          done: false,
          note: null
        });
      });
      return { steps: normalized, errors };
    };

    const planStatusPayload = () => planStatusSnapshot().map((step) => ({
      id: step.id,
      status: step.done ? 'done' : 'pending',
      finding: step.note || step.text || ''
    }));

    const attachPlanStatus = (obj = {}) => {
      if (!planConfirmed || !planStatus.length || !obj || typeof obj !== 'object') return obj;
      const payload = extractPlanStatusPayload(obj);
      if (!Array.isArray(payload) || !payload.length) {
        obj.plan_status = planStatusPayload();
      }
      return obj;
    };
    let comparisonSatisfied = !needsRoomComparison;
    let rankingSatisfied = !requireRoomRanking;
    const summarizePlanStatusLines = () => planStatus
      .map((step) => {
        if (!step) return null;
        const marker = step.done ? 'x' : ' ';
        const label = step.text || step.description || step.goal || '';
        const toolLabel = step.tool ? ` [${step.tool}]` : '';
        return `[${marker}] ${step.id || step.index}: ${label}${toolLabel}`;
      })
      .filter(Boolean)
      .join('\n');

    const pushPlanProgress = (note) => {
      if (!planStatus.length) return;
      const summaryLines = summarizePlanStatusLines();
      const next = planStatus.find((step) => !step.done);
      const defaultNote = next
        ? `Next: ${next.id}: ${next.text}. Execute it via {"action":"tool_call","planStep":"${next.id}","tool":"${next.tool}","args":{...}}.`
        : 'All planned steps are complete. Provide {"action":"final","plan_status":[...]} summarizing each step.';
      convo.push({
        role: 'user',
        content: `PLAN STATUS:\n${summaryLines}\n${note || defaultNote}\nRemember: every tool call must include "planStep":"S#".`
      });
    };

    const markPlanStepComplete = (stepRef = null, note = null) => {
      if (!planConfirmed || !planStatus.length) return;
      const target = stepRef ? findPlanStep(stepRef) : planStatus.find((s) => !s.done);
      if (!target) return;
      if (!target.done) {
        target.done = true;
        if (note) target.note = note;
        pushPlanProgress(`Completed ${target.id}: ${target.text}.`);
        incompletePlanWarnings = 0;
      } else if (note) {
        target.note = note;
      }
    };

    const extractPlanStatusPayload = (obj = {}) => {
      if (Array.isArray(obj.plan_status)) return obj.plan_status;
      if (Array.isArray(obj.planStatus)) return obj.planStatus;
      if (obj.plan && Array.isArray(obj.plan.status)) return obj.plan.status;
      return null;
    };

    const ensureFinalReferencesPlan = (obj = {}) => {
      if (!planConfirmed || !planStatus.length) return true;
      const payload = extractPlanStatusPayload(obj);
      if (!Array.isArray(payload) || !payload.length) {
        convo.push({
          role: 'user',
          content: 'Include "plan_status":[{"id":"S1","status":"done","finding":"..."}] summarizing each plan step before finalizing.'
        });
        return false;
      }
      const provided = new Set();
      for (const entry of payload) {
        const norm = canonicalPlanStepId(entry?.id ?? entry?.step ?? entry?.stepId ?? entry?.planStep ?? '');
        if (norm) provided.add(norm);
      }
      const missing = planStatus.filter((step) => !provided.has(step.id));
      if (missing.length) {
        convo.push({
          role: 'user',
          content: `Plan status missing for ${missing.map((s) => s.id).join(', ')}. Include each step with its outcome and resend the final response.`
        });
        return false;
      }
      return true;
    };
    
    STEP_LOOP: for (let step = 0; step < 12; step++) {
      const t0 = Date.now();
      const reply = await callGeminiChat(convo, {});
      const dt = Date.now() - t0;
      log(`LLM step ${step} took ${dt}ms`);
      
      if (!reply) {
        const emergency = runEmergencyAnalysis({ question, selectionRooms, room, range: rr });
        if (emergency) {
          const mergedTrace = Array.isArray(emergency.trace) ? [...trace, ...emergency.trace] : trace;
          return { ...emergency, trace: mergedTrace };
        }
        break;
      }
      if (DEBUG) log('LLM raw reply:', reply.slice(0, 600));

      const assistantTurn = String(reply || '').trim();
      if (assistantTurn) {
        convo.push({ role: 'assistant', content: assistantTurn });
      }
      
      // Force finalization if we've made enough tool calls
      if (totalToolCalls >= 8 && step >= 5) {
        const recentlyPaired = trace.some(t => t.tool === 'pair_timeseries');
        if (recentlyPaired && step < 5) {
          // Allow one extra iteration to let the model produce a chart using the paired dataRef
          log('Skipping forced finalization to allow scatter pairing (step', step, ')');
        } else {
          log('Strongly encouraging finalization after', totalToolCalls, 'tool calls at step', step);
        
        // CRITICAL: After 2 tools and step 2+, FORCE finalization with very explicit instructions
        if (step >= 4) {
          const ql = question.toLowerCase();
          const isCorrelationPlot = ql.includes('correlation') && (ql.includes('plot') || ql.includes('show'));
          const isScatterPlot = ql.includes('scatter') || ql.includes('scatterplot') || ql.includes(' vs ') || ql.includes(' against ');
          const isCompare = ql.includes('compare') || ql.includes('vs') || ql.includes('versus');
          const isRatioQuery = question.toLowerCase().includes('per person') || 
                               question.toLowerCase().includes('per capita') ||
                               question.toLowerCase().includes('ratio');
          
          let hint = `MANDATORY: You have called ${totalToolCalls} tools. You MUST provide a final answer NOW. Do NOT call any more tools.

CRITICAL: Use dataRef in your chart, NOT embedded data arrays.`;
          
          if (isCorrelationPlot) {
            hint += `\n\nFor correlation queries, provide:
1. The correlation coefficient from the correlate tool
2. An explanation of what it means
3. Optional: Two separate line charts showing both metrics over time (NOT a scatter plot unless you have paired data)

Example response:
{
  "action": "final",
  "answer": "The correlation between outside temperature and inside temperature is 0.73, indicating a strong positive relationship. When it's warmer outside, the inside temperature tends to be higher as well.",
  "chart": null
}`;
          } else if (isRatioQuery) {
            hint += `\n\nFor ratio queries like "${question}", use dataRef to reference the compute_ratio tool:
{
  "action": "final",
  "answer": "Here is the CO2 per person over time. When occupancy is 0, the ratio is shown as 0.",
  "chart": {
    "chart": {"type": "line"},
    "title": {"text": "CO2 per Person"},
    "xAxis": {"type": "datetime"},
    "yAxis": {"title": {"text": "CO2 / Person"}},
    "series": [{
      "name": "CO2 per Person",
      "dataRef": {"tool": "compute_ratio", "xField": "ts", "yField": "ratio"}
    }]
  }
}`;
          } else if (isScatterPlot) {
            hint += `\n\nFor scatter plots, first pair the two metrics using pair_timeseries, then return a Highcharts scatter chart using dataRef with xField: "x" and yField: "y". Example:\n{
  "action": "final",
  "answer": "Here is a scatter plot of VOC vs Lux for the selected time window.",
  "chart": {
    "chart": {"type": "scatter"},
    "title": {"text": "VOC vs Lux"},
    "xAxis": {"title": {"text": "Lux"}},
    "yAxis": {"title": {"text": "VOC"}},
    "series": [{
      "name": "VOC vs Lux",
      "dataRef": {"tool": "pair_timeseries", "xField": "x", "yField": "y"}
    }]
  }
}`;
          } else {
            hint += `\n\nProvide your response using this EXACT format with dataRef:
{
  "action": "final",
  "answer": "<describe what the data shows>",
  "chart": {
    "chart": {"type": "line"},
    "title": {"text": "..."},
    "xAxis": {"type": "datetime"},
    "yAxis": {"title": {"text": "..."}},
    "series": [{
      "name": "...",
      "dataRef": {"tool": "fetch_timeseries", "xField": "ts", "yField": "..."}
    }]
  }
}

OR if no chart is needed:
{"action": "final", "answer": "<your answer>", "chart": null}`;
          }
          
          convo.push({ role: 'user', content: hint });
          continue STEP_LOOP; // Force another iteration with this guidance
        }
      }
      }
      
      // Try to parse JSON response
      let obj = null;
      
      function extractJson(text) {
        // 1) code fence ```json ... ```
        const fence = text.match(/```json\s*([\s\S]*?)```/i);
        if (fence) {
          const candidate = fence[1].trim();
          try { 
            return JSON.parse(candidate); 
          } catch (e) {
            // If parsing failed, try to salvage the answer
            const answerMatch = candidate.match(/"answer"\s*:\s*"([^"]+)"/);
            if (answerMatch) {
              return { action: 'final', answer: answerMatch[1], chart: null };
            }
          }
        }
        
        // 2) find object containing "action":
        const idx = text.indexOf('"action"');
        if (idx >= 0) {
          const start = text.lastIndexOf('{', idx);
          if (start >= 0) {
            let depth = 0;
            for (let i = start; i < text.length; i++) {
              const c = text[i];
              if (c === '{') depth++;
              else if (c === '}') {
                depth--;
                if (depth === 0) {
                  const slice = text.slice(start, i+1);
                  try { 
                    return JSON.parse(slice); 
                  } catch (e) {}
                  break;
                }
              }
            }
          }
        }
        
        // 3) plain text fallback
        if (text && text.trim().length > 0 && !text.trim().startsWith('{')) {
          // Return as a final answer with no chart
          return {
            action: 'final',
            answer: text.trim(),
            chart: null
          };
        }

        // 4) last resort
        try { 
          return JSON.parse(text); 
        } catch (e) {}

        return null;
      }
      
      obj = extractJson(reply);

      if (obj) {
        consecutiveJsonFailures = 0;
        attachPlanStatus(obj);
      } else {
        consecutiveJsonFailures += 1;
        if (totalToolCalls > 0) {
          log('Synthesizing final JSON after parse error post-tools');
          const syntheticChart = buildChartFromTrace({
            trace,
            question,
            defaultRoom: room,
            selectionRooms
          });
          const syntheticAnswer = buildDefaultAnswer({
            question,
            trace,
            chart: syntheticChart,
            range: rr
          });
          obj = {
            action: 'final',
            answer: syntheticAnswer,
            chart: syntheticChart,
            plan_status: planStatusSnapshot()
          };
        } else {
          convo.push({
            role: 'user',
            content: `CRITICAL ERROR: Response could not be parsed as valid JSON. You must respond with a JSON object using the documented schema (action/tool_calls/final/chart). Resend your answer in the required JSON format.`
          });
          continue STEP_LOOP;
        }
      }

      if (!obj) {
        // Check if response looks truncated (ends with incomplete data)
        const trimmed = reply.trim();
        if (trimmed.includes('"action":"final"') && (
            trimmed.endsWith('[') || 
            trimmed.endsWith(',') || 
            trimmed.match(/\[\d+$/) ||
            trimmed.match(/\[\[[\d,\s]*$/) ||
            trimmed.match(/,\s*\d+\.\d+\]$/))) {
          log('Detected truncated response with embedded data arrays');
          markTiming(`iteration:${attemptIndex}:llm_parse_fail`, iterationStart);
          convo.push({
            role: 'user',
            content: `CRITICAL ERROR: Your response was truncated because you embedded data arrays directly in the JSON.

YOU MUST USE dataRef TO REFERENCE TOOL RESULTS. THIS IS MANDATORY.

WRONG (what you just did - CAUSES TRUNCATION):
{
  "series": [{"data": [[1759273200000,63],[1759273800000,60],...]  ← FORBIDDEN - ALWAYS TRUNCATES
  }]
}

CORRECT (what you MUST do - ALWAYS WORKS):
{
  "action": "final",
  "answer": "Here is the humidity over time.",
  "chart": {
    "chart": {"type": "line"},
    "title": {"text": "Humidity"},
    "xAxis": {"type": "datetime"},
    "yAxis": {"title": {"text": "Humidity %"}},
    "series": [{
      "name": "Humidity",
      "dataRef": {"tool": "fetch_timeseries", "xField": "ts", "yField": "humidity"}
    }]
  }
}

The backend automatically extracts data from tool results using dataRef.
You ONLY provide the reference, NEVER the actual data arrays.
Respond again with dataRef, NOT data arrays.`
          });
          continue STEP_LOOP;
        }
        
        // Check if the reply contains embedded data arrays (another detection method)
        if (trimmed.includes('"data":[[') || trimmed.match(/"data":\s*\[\[/)) {
          log('Detected embedded data array in response');
          convo.push({
            role: 'user',
            content: `CRITICAL ERROR: You embedded a data array in your chart JSON. This is FORBIDDEN and ALWAYS fails.

You wrote something like:
"series": [{"data": [[...timestamps and values...]]}]

This will ALWAYS be truncated. You MUST use dataRef instead:

CORRECT format (ALWAYS use this):
{
  "action": "final",
  "answer": "<your description>",
  "chart": {
    "chart": {"type": "line"},
    "title": {"text": "<title>"},
    "xAxis": {"type": "datetime"},
    "yAxis": {"title": {"text": "<label>"}},
    "series": [{
      "name": "<series name>",
      "dataRef": {
        "tool": "<tool name from previous call>",
        "xField": "ts",
        "yField": "<field name>"
      }
    }]
  }
}

The backend resolves dataRef automatically. You provide ONLY the reference.
Respond again with dataRef, NOT embedded data.`
          });
          continue STEP_LOOP;
        }
        
        // CRITICAL: Reject plain text responses - force JSON format
        const plain = String(reply || '').trim();
        if (plain.length > 20 && /[a-zA-Z]/.test(plain) && !plain.startsWith('{')) {
          if (totalToolCalls > 0 && (step >= 2 || attempt >= 1)) {
            log('Auto-wrapping plain text response after tooling');
            markTiming(`iteration:${attemptIndex}:llm_plaintext_autowrap`, iterationStart);
            return {
              message: assistantMessage(plain),
              chart: null,
              trace
            };
          }
          
          log('Rejecting plain text response, enforcing JSON format');
          markTiming(`iteration:${attemptIndex}:llm_plaintext_reject`, iterationStart);
          convo.push({
            role: 'user',
            content: `CRITICAL ERROR: You provided a plain text response instead of JSON. This is NOT acceptable.

Your response started with:
"${plain.slice(0, 200)}..."

You MUST respond with a valid JSON object using this EXACT format:

{"action":"final","answer":"${plain.slice(0, 100).replace(/"/g, '\\"')}...","chart":null}

Copy the above format and fill in your complete answer. Use proper JSON syntax.`
          });
          continue STEP_LOOP;
        }
        
        convo.push({
          role: 'user',
          content: `CRITICAL ERROR: Response could not be parsed as valid JSON. You must respond with a JSON object using the documented schema (action/tool_calls/final/chart). Resend your answer in the required JSON format.`
        });
        continue STEP_LOOP;
        
        // After step 2, if reply is not valid JSON with "action", force a JSON answer
        if (step >= 2 && (!obj || !obj.action)) {
          convo.push({
            role: 'user',
            content: `MANDATORY: Respond ONLY with a valid JSON object. 
Repeat the selected time window exactly as shown below in your answer.
Time window: Local: ${startFmt} to ${endFmt} (Epoch ms: start=${rr.start ?? 'none'} end=${rr.end ?? 'none'})
Example:
{
  "action": "final",
  "answer": "The peak humidity in the cafe for this time period (${startFmt} to ${endFmt}) was XX%, which occurred at YYYY-MM-DD HH:mm.",
  "chart": null
}
If you provide a chart, you MUST use dataRef, never embed data arrays.`
          });
          continue STEP_LOOP;
        }
        
        const results = [];
        for (const toolCall of obj.tools) {
          const { tool, args } = toolCall;
          
          if (!tools[tool]) {
            results.push({ tool, args, result: { error: `Tool ${tool} not found` } });
                                 continue;
          }
          
          // Auto-fill missing room/start/end from selected context
          const filledArgs = { ...(args || {}) };
          if (filledArgs.room == null && room) filledArgs.room = room;
          if (filledArgs.start == null && rr.start != null) filledArgs.start = rr.start;
          if (filledArgs.end == null && rr.end != null) filledArgs.end = rr.end;
          
          const cacheKey = JSON.stringify({ tool, args: filledArgs });
          let result = null;
          if (toolResultCache.has(cacheKey)) {
            result = toolResultCache.get(cacheKey);
            log(`  - ${tool} (cached)`);
          } else {
            try { 
              result = tools[tool](filledArgs); 
            } catch (e) { 
              result = { error: String(e) }; 
            }
            toolResultCache.set(cacheKey, result);
            log(`  - ${tool}:`, typeof result === 'object' ? `${Object.keys(result).length} keys` : result);
          }
          
          // Mark plan step complete when present
          const planStepRef = toolCall.planStep || toolCall.plan_step || filledArgs.planStep || filledArgs.plan_step || autoAssignPlanStep(tool)?.id || null;
          if (planStepRef) markPlanStepComplete(planStepRef);

          const slimArgs = trimResultForLLM(filledArgs);
          const slimResult = trimResultForLLM(result);
          results.push({ tool, args: slimArgs, result: slimResult, planStep: planStepRef });
          trace.push({ tool, args: filledArgs, result, planStep: planStepRef });
        }
        
        // Feed back all results together
        convo.push({ 
          role: 'user', 
          content: `{"tool_results": ${JSON.stringify(results).slice(0, 15000)} }` 
        });
        continue STEP_LOOP;
      }
      
      if (obj && obj.action === 'plan') {
        consecutivePlanReplies += 1;
        const rawSteps = Array.isArray(obj.steps) ? obj.steps : [];
        const { steps: structuredSteps, errors } = normalizePlanSteps(rawSteps);
        const signature = JSON.stringify(structuredSteps.map((step) => ({
          id: step.id,
          tool: step.tool,
          goal: step.text
        })));
        if (planConfirmed && planStatus.length && signature && signature === lastPlanSignature) {
          planLoopWarnings += 1;
          const next = planStatus.find((s) => !s.done);
          const reminder = next
            ? `Plan already locked. Execute ${next.id}: ${next.text} via {"action":"tool_call","planStep":"${next.id}","tool":"${next.tool}","args":{...}} instead of rewriting the plan.`
            : 'Plan locked and all steps complete. Respond with {"action":"final","plan_status":[...]} referencing each step.';
          convo.push({ role: 'user', content: reminder });
          if (planLoopWarnings >= 2) pushPlanProgress('Stop resending the plan—advance to the pending step.');
          continue STEP_LOOP;
        }
        if (errors.length) {
          convo.push({
            role: 'user',
            content: `Plan error: ${errors[0]}. Provide {"action":"plan","steps":[{"id":"S1","goal":"Review sales trend","tool":"fetch_timeseries","inputs":["sales_amount"]}, {"id":"S2","goal":"Compare products on sales_amount","tool":"compare_rooms_on_metric","inputs":["sales_amount"]}]}`
          });
          continue STEP_LOOP;
        }
        if (structuredSteps.length < 2) {
          convo.push({
            role: 'user',
            content: 'Plan must include at least two structured steps with ids/tools. Respond again with {"action":"plan","steps":[...]}'
          });
        } else {
          const planWasActive = planConfirmed && planStatus.length;
          planConfirmed = true;
          planSteps = structuredSteps.map((step) => ({ ...step }));
          planStatus = planSteps;
          registerPlanSteps(planStatus);
          incompletePlanWarnings = 0;
          lastPlanSignature = signature;
          trace.push({ tool: 'plan', args: { steps: planStatusSnapshot() }, result: null });
          const initialStep = planStatus.find((s) => !s.done);
          const prefix = planWasActive ? 'Plan updated.' : 'Plan locked.';
          const note = initialStep
            ? `${prefix} Begin ${initialStep.id}: ${initialStep.text} using {"action":"tool_call","planStep":"${initialStep.id}","tool":"${initialStep.tool}","args":{...}}.`
            : `${prefix} Execute the outlined steps with the required tools.`;
          pushPlanProgress(note);
        }
        planLoopWarnings = 0;
        consecutivePlanReplies = 0;
        continue STEP_LOOP;
      }

      consecutivePlanReplies = 0;

      if (!planConfirmed) {
        convo.push({
          role: 'user',
          content: 'MANDATORY: Provide {"action":"plan","steps":[...]} before calling tools or finalizing. Outline 2-4 analytical steps that reference the data or tools you will use.'
        });
        continue STEP_LOOP;
      }
      
      // Handle single tool call
      // Handle multiple parallel tool calls
      if (obj.action === 'tool_calls' && Array.isArray(obj.tools)) {
        if (toolCallTurns >= 1) {
          convo.push({ role: 'user', content: 'All tools should run together in one tool_calls turn. Use your existing results to finalize with {"action":"final",...}.' });
          continue STEP_LOOP;
        }
        toolCallTurns += 1;
        planLoopWarnings = 0;
        const resolvedCalls = [];
        for (const tc of obj.tools) {
          const planRefRaw = tc.planStep ?? tc.plan_step ?? tc.plan ?? tc.step ?? tc.stepId ?? tc.id ?? null;
          let planEntry = planConfirmed ? findPlanStep(planRefRaw) : null;
          if (!planEntry && planConfirmed) {
            planEntry = autoAssignPlanStep(tc.tool);
          }
          resolvedCalls.push({
            raw: tc,
            toolName: resolveToolName(tc.tool),
            planEntry,
            planStepId: planEntry?.id || (planRefRaw ? canonicalPlanStepId(planRefRaw) : null)
          });
        }
        const results = [];
        for (const tc of resolvedCalls) {
          const tool = tc.toolName;
          const args = { ...((tc.raw?.args) || {}) };
          if (!tools[tool]) {
            results.push({ planStep: tc.planStepId, tool, args, result: { error: `Tool ${tool} not found` } });
            continue;
          }
          if (args.room == null && room) args.room = room;
          if (args.start == null && rr.start != null) args.start = rr.start;
          if (args.end == null && rr.end != null) args.end = rr.end;
          // Steer tool args toward intended metric/table inferred from the question
          const want = (String(question||'').toLowerCase().includes('humidity') ? 'humidity' :
                       String(question||'').toLowerCase().includes('temperature') || String(question||'').toLowerCase().includes('temp') ? 'temperature' :
                       String(question||'').toLowerCase().includes('co2') ? 'co2' :
                       String(question||'').toLowerCase().includes('lux') || String(question||'').toLowerCase().includes('light') ? 'lux' : null);
          if (want) {
            if (tool === 'fetch_timeseries') {
              if (!args.fields || !args.fields.length || !args.fields.includes(want)) args.fields = [want];
              if (!args.table) { const t = inferDefaultTableForMetric(want); if (t) args.table = t; }
            } else if (tool === 'hourly_timeseries' || tool === 'daily_avg' || tool === 'stats' || tool === 'hour_of_day_stats' || tool === 'histogram') {
              if (!args.field) args.field = want;
              if (!args.table) { const t = inferDefaultTableForMetric(want); if (t) args.table = t; }
            }
          }
          prepareToolArgs(tool, args);
          let result = null;
          const started = Date.now();
          try { result = tools[tool](args); } catch (e) { result = { error: String(e) }; }
          const durationMs = Date.now() - started;
          results.push({ planStep: tc.planStepId, tool, args, result, durationMs });
          trace.push({ planStepId: tc.planStepId, tool, args, result, durationMs });
          totalToolCalls += 1;
          if (needsRoomComparison && (tool === 'compare_series_cross_room' || tool === 'compare_rooms_on_metric' || tool === 'compare_metrics_in_room' || tool === 'scope_daily_percentile')) {
            comparisonSatisfied = true;
          }
          if (requireRoomRanking && (tool === 'compare_series_cross_room' || tool === 'compare_rooms_on_metric' || tool === 'compare_metrics_in_room' || tool === 'scope_daily_percentile')) {
            rankingSatisfied = true;
          }
          markPlanStepComplete(tc.planStepId, `Executed ${tool} (${durationMs} ms)`);
        }
        convo.push({ role: 'user', content: `{"tool_results": ${JSON.stringify(results).slice(0, 15000)} }` });
        const toolList = results.map((r) => r.tool).filter(Boolean).join(', ');
        convo.push({ role: 'user', content: `Use the above tool results (${toolList}) to produce the final response now. Respond with {"action":"final","answer":"...","chart":<chart or null>,"plan_status":[...]} and ensure any chart series use dataRef pointing to these tools.` });
        continue STEP_LOOP;
      }
      if (obj.action === 'tool_calls' && !Array.isArray(obj.tools)) {
        convo.push({
          role: 'user',
          content: 'ERROR: Received tool_calls without a tools array. Respond with a proper JSON final answer.'
        });
        continue STEP_LOOP;
      }

      if (obj.action === 'tool_call') {
        if (toolCallTurns >= 1) {
          convo.push({ role: 'user', content: 'You already issued tool calls. Use the existing results to finalize with {"action":"final",...} instead of calling more tools.' });
          continue STEP_LOOP;
        }
        toolCallTurns += 1;
        planLoopWarnings = 0;
        const planRefRaw = obj.planStep ?? obj.plan_step ?? obj.plan ?? obj.step ?? obj.stepId ?? null;
        let planEntry = planConfirmed ? findPlanStep(planRefRaw) : null;
        if (!planEntry && planConfirmed) {
          planEntry = autoAssignPlanStep(obj.tool);
        }
        const planStepId = planEntry?.id || (planRefRaw ? canonicalPlanStepId(planRefRaw) : null);
        let { tool, args } = obj;
        tool = resolveToolName(tool);
        log('Tool call:', tool, 'args:', args);
        totalToolCalls += 1;
        
        if (!tools[tool]) {
          convo.push({ 
            role: 'user', 
            content: `Tool ${tool} not found.` 
          });
          break;
        }
        
        // Auto-fill missing room/start/end from selected context
        const filledArgs = { ...(args || {}) };
        if (filledArgs.room == null && room) filledArgs.room = room;
        if (filledArgs.start == null && rr.start != null) filledArgs.start = rr.start;
        if (filledArgs.end == null && rr.end != null) filledArgs.end = rr.end;
        // Steer tool args toward intended metric/table inferred from the question
        const want = (String(question||'').toLowerCase().includes('humidity') ? 'humidity' :
                     String(question||'').toLowerCase().includes('temperature') || String(question||'').toLowerCase().includes('temp') ? 'temperature' :
                     String(question||'').toLowerCase().includes('co2') ? 'co2' :
                     String(question||'').toLowerCase().includes('lux') || String(question||'').toLowerCase().includes('light') ? 'lux' : null);
        if (want) {
          if (tool === 'fetch_timeseries') {
            if (!filledArgs.fields || !filledArgs.fields.length || !filledArgs.fields.includes(want)) filledArgs.fields = [want];
            if (!filledArgs.table) { const t = inferDefaultTableForMetric(want); if (t) filledArgs.table = t; }
          } else if (tool === 'hourly_timeseries' || tool === 'daily_avg' || tool === 'stats' || tool === 'hour_of_day_stats' || tool === 'histogram') {
            if (!filledArgs.field) filledArgs.field = want;
            if (!filledArgs.table) { const t = inferDefaultTableForMetric(want); if (t) filledArgs.table = t; }
          }
        }
        prepareToolArgs(tool, filledArgs);
        
        let result = null;
        const started = Date.now();
        try { 
          result = tools[tool](filledArgs); 
        } catch (e) { 
          result = { error: String(e) }; 
        }
        const durationMs = Date.now() - started;
        
        const sizeHint = Array.isArray(result) ? 
          result.length : 
          (result && typeof result === 'object' ? Object.keys(result).length : 0);
        log('Tool result size hint:', sizeHint);
        trace.push({ planStepId, tool, args: filledArgs, result, durationMs });
        if (needsRoomComparison && (tool === 'compare_series_cross_room' || tool === 'compare_rooms_on_metric' || tool === 'compare_metrics_in_room' || tool === 'scope_daily_percentile')) {
          comparisonSatisfied = true;
        }
        if (requireRoomRanking && (tool === 'compare_series_cross_room' || tool === 'compare_rooms_on_metric' || tool === 'compare_metrics_in_room' || tool === 'scope_daily_percentile')) {
          rankingSatisfied = true;
        }
        markPlanStepComplete(planStepId, `Executed ${tool} (${durationMs} ms)`);
        
        // If compare tool returned series, finalize immediately with a ready-to-plot chart
        if (tool === 'compare_series_cross_room' && result && typeof result === 'object' && !Array.isArray(result)) {
          try {
            let entries = Object.entries(result);
            const qlc = String(question||'').toLowerCase();
            let chart = null;
            const requested = (args && Array.isArray(args.series)) ? args.series : [];
            let adaptedRange = null;
            const metaSummaries = [];
            const allEmpty = entries.every(([, pts]) => !Array.isArray(pts) || pts.length === 0);
            if (allEmpty && requested.length) {
              let maxStart = -Infinity;
              let minEnd = Infinity;
              let overlapPossible = true;
              for (const s of requested) {
                const tableReq = s.table || 'iaq';
                const meta = tools.fetch_table_meta({ room: s.room, table: tableReq });
                trace.push({ tool: 'fetch_table_meta', args: { room: s.room, table: tableReq }, result: meta });
                const label = s.name || deviceFriendlyName(s.room);
                metaSummaries.push({ label, meta });
                if (!meta || !Number(meta.count)) {
                  overlapPossible = false;
                  continue;
                }
                if (meta.tsMin != null) maxStart = Math.max(maxStart, meta.tsMin);
                if (meta.tsMax != null) minEnd = Math.min(minEnd, meta.tsMax);
              }
              if (overlapPossible && Number.isFinite(maxStart) && Number.isFinite(minEnd) && maxStart < minEnd) {
                const adaptedArgs = { ...args, start: maxStart, end: minEnd };
                const adaptedResult = tools.compare_series_cross_room(adaptedArgs);
                trace.push({ tool: 'compare_series_cross_room', args: { ...adaptedArgs, _adapted: true }, result: adaptedResult });
                const adaptedEntries = Object.entries(adaptedResult || {});
                const hasData = adaptedEntries.some(([, pts]) => Array.isArray(pts) && pts.length);
                if (hasData) {
                  result = adaptedResult;
                  entries = adaptedEntries;
                  adaptedRange = { start: maxStart, end: minEnd };
                }
              }
              if (adaptedRange) {
                adaptationNotes.push(`No overlapping data in the requested window; showing overlap from ${formatLocal(adaptedRange.start)} to ${formatLocal(adaptedRange.end)}.`);
              } else if (metaSummaries.length) {
                const summaryText = metaSummaries.map(({ label, meta }) => {
                  if (!meta || !Number(meta.count)) return `${label}: no stored data`;
                  const latest = meta.tsMax != null ? formatLocal(meta.tsMax) : 'n/a';
                  return `${label}: last data ${latest}`;
                }).join('; ');
                adaptationNotes.push(`No data in the requested window. ${summaryText}.`);
              }
            }
            if (/(histogram|distribution)\b/.test(qlc)) {
              // Build histograms per series (per room/field)
              const colSeries = [];
              const requested = (args && Array.isArray(args.series)) ? args.series : [];
              for (const s of requested) {
                const roomReq = s.room;
                const fieldReq = s.field;
                const tableReq = s.table || 'iaq';
                try {
                  const hist = tools.histogram({ room: roomReq, table: tableReq, field: fieldReq, bins: 20, start: args.start || undefined, end: args.end || undefined });
                  trace.push({ tool: 'histogram', args: { room: roomReq, table: tableReq, field: fieldReq }, result: hist });
                  const data = Array.isArray(hist) ? hist.map(h => [Number(h.binStart), Number(h.count)]) : [];
                  colSeries.push({ name: `${roomReq} ${fieldReq}`, data });
                } catch (e) { /* ignore */ }
              }
              const any = colSeries.some(s => s.data && s.data.length);
              chart = any ? { chart: { type: 'column' }, title: { text: 'Histogram Comparison' }, xAxis: { title: { text: 'Value' } }, yAxis: { title: { text: 'Count' } }, series: colSeries } : null;
            } else {
              const lineSeries = entries.map(([name, pts]) => ({
                name,
                data: Array.isArray(pts) ? pts.filter(p => p && p.ts != null && Number.isFinite(Number(p.y))).map(p => [Number(p.ts), Number(p.y)]) : []
              }));
              const any = lineSeries.some(s => s.data && s.data.length);
              chart = any ? {
                chart: { type: 'line' },
                title: { text: 'Comparison' },
                xAxis: { type: 'datetime' },
                yAxis: { title: { text: '' } },
                series: lineSeries
              } : null;
            }
            const baseAnswer = entries.length ? 'Compared series across products/pages.' : 'No data available to compare in the selected period.';
            let answerText = buildDefaultAnswer({
              question,
              chart,
              trace,
              fallbackText: baseAnswer,
              notes: adaptationNotes,
              range
            });
            if (!answerText || normalizeText(answerText) === normalizeText(question)) {
              const chartSummary = summarizeChart(chart);
              answerText = chartSummary || baseAnswer || 'Compared the requested metrics using available data.';
              if (Array.isArray(adaptationNotes) && adaptationNotes.length) {
                answerText += ' ' + adaptationNotes.join(' ');
              }
            }
            const evalMetrics = evaluateQA({ question, answer: answerText, retrievedDocs: ctx._retrievedDocs || [] });
            const extraEval = { message: assistantMessage(`Eval grounding=${(evalMetrics.grounding*100).toFixed(0)}% uncertainty=${(evalMetrics.uncertainty*100).toFixed(0)}%`), chart: null };
            return {
              message: assistantMessage(answerText),
              chart,
              extras: [extraEval],
              trace
            };
          } catch (e) {
            log('compare_series_cross_room finalize failed:', String(e));
          }
        }

        // Feed back a structured tool result frame when not finalizing
        const slimArgs = trimResultForLLM(filledArgs);
        const slimResult = trimResultForLLM(result);
        convo.push({ role: 'user', content: `{"tool_result": { "tool": ${JSON.stringify(tool)}, "args": ${JSON.stringify(slimArgs)}, "result": ${JSON.stringify(slimResult).slice(0, 10000)} }}` });
        // Immediately request final JSON to avoid extra turns
        convo.push({ role: 'user', content: 'Return the final answer now as {"action":"final","answer":"...","chart":<chart or null>,"plan_status":[...]} and include any correlations or key stats you computed.' });
        
        // If the selected window produced no data, fetch meta to inform the model (but do not auto-expand the window)
        if ((tool === 'fetch_timeseries' && Array.isArray(result) && result.length === 0) ||
            (tool === 'stats' && (!result || !Number(result.count)))) {
          try {
            const meta = tools.fetch_table_meta({
              room: filledArgs.room,
              table: filledArgs.table || filledArgs.table1 || filledArgs.table2
            });
            convo.push({
              role: 'user',
              content: `{"tool_hint": { "note": "No rows found in selected window; meta shown to help adaptation.", "meta": ${JSON.stringify(meta)} }}`
            });
          } catch {}
        }
        
        // Loop detection: if the same tool+args are called repeatedly, finalize with a schema summary
        const sig = `${tool}:${JSON.stringify(filledArgs||{})}`;
        if (sig === lastToolSig) {
          repeatCount++;
        } else { 
          lastToolSig = sig; 
          repeatCount = 0; 
        }
        
        if (repeatCount >= 2 || step === 9) {
          const r = room || (args && args.room) || '';
          if (r) {
            const tables = loadRoomTables(r);
            const summary = Object.fromEntries(
              Object.entries(tables).map(([k, v]) => [k, Object.keys((v||[])[0] || {})])
            );
            let answer = `Available data for product ${r}: ` + 
              Object.entries(summary)
                .map(([t, cols]) => `${t} [${cols.join(', ')}]`)
                .join('; ');
            answer = applyScopeHeader(answer);
            const evalMetrics = evaluateQA({ question, answer, retrievedDocs: ctx._retrievedDocs || [] });
            return { 
              message: assistantMessage(answer), 
              chart: null, 
              extras: [{ message: assistantMessage(`Query ${routing.level}; grounding ${(evalMetrics.grounding*100).toFixed(0)}%; uncertainty ${(evalMetrics.uncertainty*100).toFixed(0)}%`), chart: null }],
              trace 
            };
          }
        }
        continue STEP_LOOP;
        
      } else if (obj.action === 'final' || obj.action === 'finish' || obj.action === 'finalize') {
        planLoopWarnings = 0;
        log('Finalizing answer. Chart provided?', !!obj.chart);

        const executedToolCount = countTraceToolExecutions(trace);
        if (planConfirmed && executedToolCount === 0) {
          pushPlanProgress('Plan recorded but no tools have been executed. Execute Step 1 with the required tool before finalizing.');
          continue STEP_LOOP;
        }
        if (planConfirmed) {
          const incompleteSteps = planStatus.filter((step) => !step.done);
          if (incompleteSteps.length) {
            incompletePlanWarnings += 1;
            if (incompletePlanWarnings >= MAX_INCOMPLETE_PLAN_WARNINGS) {
              log('Auto-finalizing after repeated incomplete plan warnings');
              const fallbackAnswer = buildDefaultAnswer({
                question,
                chart: null,
                trace,
                notes: [`Plan steps ${incompleteSteps.map((s) => s.id).join(', ')} were not executed; summarizing available telemetry instead.`],
                range: rr
              });
              let overviewAnswer = enforceOverviewDetails(fallbackAnswer, { range: rr, trace, planStatus });
              overviewAnswer = applyScopeHeader(overviewAnswer);
              return {
                message: assistantMessage(overviewAnswer),
                chart: null,
                trace
              };
            }
            const nextStep = incompleteSteps[0];
            convo.push({
              role: 'user',
              content: `REMINDER: Plan steps ${incompleteSteps.map((s) => s.id).join(', ')} still need their tool calls. Execute {"action":"tool_call","planStep":"${nextStep.id}","tool":"${nextStep.tool}","args":{...}} before finalizing.`
            });
            continue STEP_LOOP;
          }
        }

        // If model returned embedded arrays or no dataRef, retrofit to dataRef
        if (obj.chart && obj.chart.series && Array.isArray(obj.chart.series)) {
          try {
            const tablesSets = availableFieldsByTable(room);
            const ql2 = (question || '').toLowerCase();
    const isVsQuery = /\bvs\b/.test(ql2) || /\bagainst\b/.test(ql2) || ql2.includes('scatter');

            function scrubDataArrays(series) {
              if (series && Array.isArray(series.data)) delete series.data; // prevent truncation
            }

            if (isVsQuery) {
              // Try to build a scatter chart using pair_timeseries
              let f1 = null, f2 = null;
              // Attempt from question: "x vs y"
              const vsMatch = (question || '').split(/\s+vs\s+/i);
              if (vsMatch.length >= 2) {
                f1 = inferFieldName(vsMatch[0], tablesSets);
                f2 = inferFieldName(vsMatch[1], tablesSets);
              }
              // Fallback: derive from first two series names or yAxis titles
              if (!f1 || !f2) {
                const names = (obj.chart.series || []).map(s => String(s.name||'')).filter(Boolean);
                if (names.length >= 2) {
                  f1 = f1 || inferFieldName(names[0], tablesSets);
                  f2 = f2 || inferFieldName(names[1], tablesSets);
                }
              }
              if (!f1 || !f2) {
                const yTitleTexts = [];
                const yAx = Array.isArray(obj.chart.yAxis) ? obj.chart.yAxis : (obj.chart.yAxis ? [obj.chart.yAxis] : []);
                for (const y of yAx) if (y && y.title && y.title.text) yTitleTexts.push(String(y.title.text));
                if (yTitleTexts.length >= 2) {
                  f1 = f1 || inferFieldName(yTitleTexts[0], tablesSets);
                  f2 = f2 || inferFieldName(yTitleTexts[1], tablesSets);
                }
              }

              if (f1 && f2) {
                obj.chart.chart = obj.chart.chart || {};
                obj.chart.chart.type = 'scatter';
                obj.chart.series = [{
                  name: `${f1} vs ${f2}`,
                  dataRef: { tool: 'pair_timeseries', xField: 'x', yField: 'y', field1: f1, field2: f2 }
                }];
              }
            } else {
              // For line charts: convert embedded arrays to dataRef by inferring fields
              for (const s of obj.chart.series) {
                if (!s.dataRef) {
                  // Try to infer field from series name or yAxis title
                  let field = inferFieldName(s.name, tablesSets);
                  if (!field) {
                    const yIdx = typeof s.yAxis === 'number' ? s.yAxis : 0;
                    const yAx = Array.isArray(obj.chart.yAxis) ? obj.chart.yAxis : (obj.chart.yAxis ? [obj.chart.yAxis] : []);
                    const yTitle = yAx[yIdx]?.title?.text;
                    field = inferFieldName(yTitle, tablesSets) || field;
                  }
                  const normField = (value) => String(value || '').trim().toLowerCase();
                  const candidateTools = new Set(['hourly_timeseries', 'daily_avg', 'fetch_timeseries']);
                  const match = (() => {
                    for (let i = trace.length - 1; i >= 0; i--) {
                      const entry = trace[i];
                      if (!entry || !candidateTools.has(entry.tool)) continue;
                      const args = entry.args || {};
                      const entryField = args.field || (Array.isArray(args.fields) ? args.fields[0] : null);
                      if (field && entryField && normField(entryField) !== normField(field)) continue;
                      return entry;
                    }
                    return null;
                  })();
                  if (match) {
                    const refObj = {
                      tool: match.tool,
                      room: match.args?.room,
                      table: match.args?.table || match.args?.table1 || match.args?.table2
                    };
                    if (match.tool === 'hourly_timeseries' || match.tool === 'daily_avg') {
                      refObj.field = match.args?.field || field;
                      refObj.xField = 'ts';
                      refObj.yField = 'avg';
                    } else if (match.tool === 'fetch_timeseries') {
                      refObj.fields = match.args?.fields || (field ? [field] : undefined);
                      refObj.xField = 'ts';
                      refObj.yField = field;
                    }
                    if (!refObj.yField) refObj.yField = 'value';
                    s.dataRef = refObj;
                    scrubDataArrays(s);
                  } else if (field) {
                    s.dataRef = { tool: 'fetch_timeseries', xField: 'ts', yField: field };
                    scrubDataArrays(s);
                  }
                } else {
                  scrubDataArrays(s);
                }
              }
            }
          } catch (e) {
            log('Retrofit to dataRef failed:', String(e));
          }
        }

        ensureChartData(obj.chart, { question, room, selectionRooms, range: rr, trace, scopeLabels });

        // Now resolve chart as usual
        const chartRequested = !!(obj.chart && Array.isArray(obj.chart.series) && obj.chart.series.length);
        let chartForAnswer = chartRequested ? cloneChart(obj.chart) : null;
        let validChart = chartRequested ? validateChart(cloneChart(obj.chart), trace) : null;
        if (obj.chart && !validChart) {
          log('Chart validation failed - attempting fallback synthesis');
        }

        const needsChartMain = chartRequested || histogramRequested || heatmapRequested || scatterRequested || needsRoomComparison || requireRoomRanking || questionRequiresChart(question);
        if ((!validChart || !chartHasRenderableSeries(validChart)) && needsChartMain) {
          const fallbackChart = buildChartFromTrace({
            trace,
            question,
            defaultRoom: room,
            selectionRooms
          });
          if (fallbackChart) {
            ensureChartData(fallbackChart, { question, room, selectionRooms, range: rr, trace, scopeLabels });
            const validated = validateChart(cloneChart(fallbackChart), trace);
            validChart = validated || fallbackChart;
            chartForAnswer = validChart;
          }
        }

        // Optionally execute background tools and return as extras
        let extras = [];
        try {
          if (Array.isArray(obj.background_tools)) {
            for (const bt of obj.background_tools) {
              const tool = bt && bt.tool;
              const args = { ...((bt && bt.args) || {}) };
              if (!tool || !tools[tool]) continue;
              if (args.room == null && room) args.room = room;
              if (args.start == null && rr.start != null) args.start = rr.start;
              if (args.end == null && rr.end != null) args.end = rr.end;
              let result = null;
              try { result = tools[tool](args); } catch (e) { result = { error: String(e) }; }
              trace.push({ tool, args, result });
              // Build a friendly extra message
              let extraMsg = `Fetched with ${tool}.`;
              if (Array.isArray(result)) extraMsg = `${tool}: ${result.length} rows.`;
              else if (result && typeof result === 'object' && typeof result.count === 'number') extraMsg = `${tool}: count=${result.count}.`;
              extras.push({ message: assistantMessage(extraMsg), chart: null });
            }
          }
        } catch (e) { log('background_tools execution failed:', String(e)); }

        // Inject routing info and evaluation into extras
        if (questionRequiresScatter(question)) {
          const chartType = chartForAnswer?.chart?.type || null;
          const scatterSeries = Array.isArray(chartForAnswer?.series) ? chartForAnswer.series : [];
          const isScatter = (chartType === 'scatter') || scatterSeries.some((s) => s && s.type === 'scatter');
          const hasDataRef = scatterSeries.length > 0 && scatterSeries.every((s) => s && s.dataRef && s.dataRef.tool);
          let scatterHasData = hasDataRef;
          if (scatterHasData) {
            const traceLookup = Array.isArray(trace) ? trace.slice().reverse() : [];
            scatterHasData = scatterSeries.every((series) => {
              const ref = series.dataRef || {};
              const toolName = ref.tool;
              if (!toolName) return false;
              const entry = traceLookup.find((t) => t.tool === toolName);
              if (!entry || !entry.result) return false;
              const result = entry.result;
              if (Array.isArray(result)) return result.length > 0;
              if (ref.field && Array.isArray(result[ref.field])) return result[ref.field].length > 0;
              if (toolName === 'pair_timeseries') {
                const pairs = Array.isArray(result) ? result : Array.isArray(result.pairs) ? result.pairs : [];
                return pairs.length > 0;
              }
              if (toolName === 'building_temp_weather_corr' || toolName === 'building_temp_weather_scatter') {
                const scatter = Array.isArray(result.scatter) ? result.scatter : Array.isArray(result.scatter_series) ? result.scatter_series : [];
                return scatter.length > 0;
              }
              return false;
            });
          }
          if ((!validChart || !chartForAnswer || !isScatter || !hasDataRef || !scatterHasData) && scatterRetryCount < 2) {
            scatterRetryCount++;
            convo.push({
              role: 'user',
              content: 'REMINDER: You must return a scatter chart with a valid dataRef referencing the tool results before finalizing. Call pair_timeseries or building_temp_weather_corr/building_temp_weather_scatter to generate data for the scatter and include it in your final chart.'
            });
            continue STEP_LOOP;
          }
        }
        if (needsRoomComparison && !comparisonSatisfied) {
          convo.push({
            role: 'user',
            content: `REMINDER: You still need to compare ${comparisonRoomsList || 'the selected products/pages'} using compare_rooms_on_metric or compare_series_cross_room before finalizing. Call the comparison tool and summarize the differences.`
          });
          continue STEP_LOOP;
        }
        if (requireRoomRanking && !rankingSatisfied) {
          convo.push({
            role: 'user',
            content: `REMINDER: You still need to rank ${rankingRoomsList || 'the selected products/pages'} by their traffic KPIs. Call compare_rooms_on_metric (preferred) or compare_series_cross_room on visits/sessions to produce the ranking and identify underperforming pages before finalizing.`
          });
          continue STEP_LOOP;
        }

        let chartForResponse = validChart ? validChart : null;
        const baseChartRequested = questionRequiresChart(question);
        const needsChartFallback = baseChartRequested || needsRoomComparison || requireRoomRanking;
        if (needsChartFallback && !chartHasRenderableSeries(chartForResponse)) {
          const allowNoChart = adaptationNotes.some(note => /no (chart|data)/i.test(String(note)));
          if (!allowNoChart && chartRetryCount < 2) {
            chartRetryCount++;
            convo.push({
              role: 'user',
              content: 'REMINDER: You must include a chart with valid dataRef references before finalizing. Try a different tool if the prior one returned no data (e.g., switch between scope_multiline, fetch_timeseries, compare_series_cross_room, scope_heatmap).'
            });
            continue STEP_LOOP;
          }
          if (!allowNoChart && chartRetryCount >= 2) {
            adaptationNotes.push('Stopping chart retries after 2 attempts to avoid excessive looping.');
          }
        }
        const chartHasSeries = chartHasRenderableSeries(chartForResponse);
        const histogramHasData = traceHasHistogramData(trace);
        if (histogramRequested) {
          const type = (chartForResponse?.chart?.type || chartForResponse?.type || '').toLowerCase();
          const acceptableType = type === 'column' || type === 'bar' || type === 'histogram';
          const histogramSeriesValid = chartForResponse
            && Array.isArray(chartForResponse.series)
            && chartForResponse.series.length > 0
            && chartForResponse.series.every((series) => series?.dataRef && (series.dataRef.tool === 'histogram' || series.dataRef.tool === 'field_histogram'));
          if (histogramHasData) {
            if (!chartForResponse || !acceptableType || !histogramSeriesValid) {
              if (chartRetryCount < 2) {
                chartRetryCount++;
                convo.push({
                  role: 'user',
                  content: 'REMINDER: A histogram/distribution was requested. Call histogram or field_histogram for the requested metric(s) and provide a column-style chart that references those tool results via dataRef before finalizing.'
                });
                continue STEP_LOOP;
              }
              adaptationNotes.push('Stopping histogram chart retries after 2 attempts to avoid looping.');
            }
          } else {
            adaptationNotes.push('Histogram requested but no usable bins were available in the selected window.');
          }
        }
        if (heatmapRequested) {
          const type = (chartForResponse?.chart?.type || chartForResponse?.type || '').toLowerCase();
          const acceptableType = type === 'heatmap';
          const heatmapTools = new Set(['scope_heatmap', 'correlation_matrix', 'hour_of_day_stats', 'weekday_weekend_comparison', 'busiest_day_of_week']);
          const hasHeatmapData = acceptableType
            && Array.isArray(chartForResponse?.series)
            && chartForResponse.series.every((series) => {
              const toolName = series?.dataRef?.tool;
              if (!toolName) return false;
              if (heatmapTools.has(toolName)) return true;
              if (series?.dataRef?.format === 'heatmap') return true;
              return false;
            });
          if (!acceptableType || !hasHeatmapData) {
            if (chartRetryCount < 2) {
              chartRetryCount++;
              convo.push({
                role: 'user',
                content: 'REMINDER: A heatmap was requested. Call scope_heatmap or correlation_matrix to build heatmap data, then return a heatmap chart referencing that tool via dataRef before finalizing.'
              });
              continue STEP_LOOP;
            }
            adaptationNotes.push('Stopping heatmap chart retries after 2 attempts to avoid looping.');
          }
        }
        if (scatterRequested) {
          const type = (chartForResponse?.chart?.type || chartForResponse?.type || '').toLowerCase();
          const seriesList = Array.isArray(chartForResponse?.series) ? chartForResponse.series : [];
          const isScatter = type === 'scatter' || seriesList.some((s) => s?.type === 'scatter');
          const hasScatterData = isScatter && seriesList.some((s) => Array.isArray(s.data) && s.data.length);
          if (!hasScatterData) {
            if (chartRetryCount < 2) {
              chartRetryCount++;
              convo.push({
                role: 'user',
                content: 'REMINDER: A scatter plot was requested. Call building_temp_weather_scatter or pair_timeseries (or scope_multiline + manual scatter) and return a scatter chart with valid dataRef referencing that tool result.'
              });
              continue STEP_LOOP;
            }
            adaptationNotes.push('Stopping scatter chart retries after 2 attempts to avoid looping.');
          }
        }
        if (!ensureFinalReferencesPlan(obj)) {
          continue STEP_LOOP;
        }

        const dataPresent = traceHasData(trace);
        if (!obj.chart && Array.isArray(obj.supportingData) && obj.supportingData.length) {
          const supportChart = chartFromSupportingData(obj.supportingData);
        if (supportChart) obj.chart = supportChart;
        const inlinePlot = chartFromPlotSpec(
          obj.plot ||
          (obj.answer && typeof obj.answer === 'object' ? obj.answer.plot : null)
        ) || chartFromVisualization(
          obj.visualization ||
          (obj.answer && typeof obj.answer === 'object' ? obj.answer.visualization : null),
          trace
        );
        if (inlinePlot) obj.chart = inlinePlot;
        }

        const baseAnswer = extractTextFromAnswer(obj.answer);
        const summaryAnswer = extractTextFromAnswer(obj.summary);
        const llmAnswer = baseAnswer || summaryAnswer;
        let finalAnswer = llmAnswer && !isPlaceholderAnswer(llmAnswer)
          ? llmAnswer
          : buildDefaultAnswer({
              question,
              chart: validChart,
              trace,
              fallbackText: llmAnswer || reply || '',
              notes: adaptationNotes,
              range
            });
        // If the model returned only boilerplate/scope text, rebuild a richer answer from tool outputs
        if (finalAnswer && finalAnswer.length < 300 && traceHasData(trace)) {
          finalAnswer = buildDefaultAnswer({
            question,
            chart: validChart,
            trace,
            fallbackText: reply || '',
            notes: adaptationNotes,
            range
          });
        }
        // Skip plan status echo; keep answers concise
        if (requireRoomRanking) {
          const type = (chartForResponse?.chart?.type || chartForResponse?.type || '').toLowerCase();
          const acceptableType = type === 'column' || type === 'bar';
          const rankingTools = new Set(['compare_rooms_on_metric', 'compare_series_cross_room', 'compare_metrics_in_room', 'scope_daily_percentile']);
          const rankingSeriesValid = chartForResponse
            && Array.isArray(chartForResponse.series)
            && chartForResponse.series.some((series) => {
              const toolName = series?.dataRef?.tool;
              return toolName && rankingTools.has(toolName);
            });
          if (!chartForResponse || !acceptableType || !rankingSeriesValid) {
            if (chartRetryCount < 2) {
              chartRetryCount++;
              convo.push({
                role: 'user',
                content: 'REMINDER: A product/page ranking was requested. Include a column or bar chart that references compare_rooms_on_metric (or another comparison tool) via dataRef so the busiest and underperforming pages are visualized before finalizing.'
              });
              continue STEP_LOOP;
            }
            adaptationNotes.push('Stopping ranking chart retries after 2 attempts to avoid looping.');
          }
        }
        if (!finalAnswer || normalizeText(finalAnswer) === normalizeText(question)) {
          const fallbackChartSummary = summarizeChart(validChart);
          const insight = traceInsight(trace);
          finalAnswer = fallbackChartSummary || insight || 'I analyzed the available data for the selected scope and time window.';
          if (Array.isArray(adaptationNotes) && adaptationNotes.length) {
            finalAnswer += ' ' + adaptationNotes.join(' ');
          }
        }
        // Reject recycled/placeholder replies and rebuild from current tool outputs
        if (/^i have already provided/i.test(finalAnswer) || /previous response/i.test(finalAnswer)) {
          const fallbackChartSummary = summarizeChart(validChart);
          const insight = traceInsight(trace);
          finalAnswer = fallbackChartSummary || insight || buildDefaultAnswer({
            question,
            chart: validChart,
            trace,
            fallbackText: '',
            notes: adaptationNotes,
            range: rr
          });
        }
        if (!dataPresent) {
          finalAnswer = 'No telemetry data was available for the selected scope and time window; adjust the range or choose a different scope.';
          chartForResponse = null;
        }
        if ((!chartForResponse || !chartHasRenderableSeries(chartForResponse)) && needsChartMain) {
          const fallbackChart = buildChartFromTrace({
            trace,
            question,
            defaultRoom: room,
            selectionRooms
          });
          if (fallbackChart) {
            ensureChartData(fallbackChart, { question, room, selectionRooms, range: rr, trace, scopeLabels });
            chartForResponse = fallbackChart;
          }
        }
        if (!chartForResponse) {
          const autoChart = buildChartFromTrace({
            trace,
            question,
            defaultRoom: room,
            selectionRooms
          });
          if (autoChart) {
            ensureChartData(autoChart, { question, room, selectionRooms, range: rr, trace, scopeLabels });
            chartForResponse = autoChart;
          }
        }
        if (chartForResponse) {
          // Force dataRef resolution just before sending to the UI to avoid empty series.
          const resolvedChart = validateChart(cloneChart(chartForResponse), trace);
          if (resolvedChart && chartHasRenderableSeries(resolvedChart)) {
            chartForResponse = resolvedChart;
          }
          const chartSummary = summarizeChart(chartForResponse);
          if (chartSummary && !normalizeText(finalAnswer).includes(normalizeText(chartSummary))) {
            finalAnswer += finalAnswer.endsWith('.') ? ' ' : '\n';
            finalAnswer += `Chart insight: ${chartSummary}`;
          }
        }
        finalAnswer = ensureQuestionAnswerCoverage(question, finalAnswer, trace);
        finalAnswer = enforceOverviewDetails(finalAnswer, { range: rr, trace, planStatus });
        finalAnswer = applyScopeHeader(finalAnswer);

        try {
          const evalMetrics = evaluateQA({ question, answer: finalAnswer, retrievedDocs: ctx._retrievedDocs || [] });
          extras = extras || [];
          extras.unshift({ message: assistantMessage(`Query ${routing.level}; grounding ${(evalMetrics.grounding*100).toFixed(0)}%; uncertainty ${(evalMetrics.uncertainty*100).toFixed(0)}%`), chart: null });
        } catch {}

        return {
          message: assistantMessage(finalAnswer),
          chart: chartForResponse,
          extras,
          trace
        };
        
      } else if (obj.action === 'final_text') {
        log('Finalizing plain text answer.');
        const executedToolCount = countTraceToolExecutions(trace);

        // Build a chart immediately from tool outputs so we don't nag the model if a chart is already ready.
        let chartCandidate = buildChartFromTrace({
          trace,
          question,
          defaultRoom: room,
          selectionRooms
        });
        if (chartCandidate) {
          ensureChartData(chartCandidate, { question, room, selectionRooms, range: rr, trace, scopeLabels });
        }
        let chartCandidateValidated = null;
        if (chartCandidate) {
          const validated = validateChart(cloneChart(chartCandidate), trace);
          if (validated && chartHasRenderableSeries(validated)) {
            chartCandidateValidated = validated;
          }
        }
        const chartAlreadyReady = !!chartCandidateValidated;

        if (planConfirmed && executedToolCount === 0) {
          pushPlanProgress('Plan recorded but no tools have been executed. Execute Step 1 before finalizing.');
          continue STEP_LOOP;
        }
        if (needsRoomComparison && !comparisonSatisfied) {
          convo.push({
            role: 'user',
            content: `REMINDER: You must compare ${comparisonRoomsList || 'the selected products/pages'} using compare_rooms_on_metric or compare_series_cross_room before providing the final answer.`
          });
          continue STEP_LOOP;
        }
        if (requireRoomRanking && !rankingSatisfied) {
          convo.push({
            role: 'user',
            content: `REMINDER: You must rank ${rankingRoomsList || 'the selected products/pages'} using compare_rooms_on_metric (or compare_series_cross_room) before providing the final answer. Report the top and underperforming pages.`
          });
          continue STEP_LOOP;
        }
        if ((histogramRequested || heatmapRequested || requireRoomRanking) && !chartAlreadyReady) {
          const histogramNeedsChart = histogramRequested && traceHasHistogramData(trace);
          if (histogramNeedsChart || heatmapRequested || requireRoomRanking) {
            convo.push({
              role: 'user',
              content: 'REMINDER: You must include the requested visualization (histogram/heatmap/ranking chart) before finalizing in plain text. Return {"action":"final","chart":{...}} with the correct chart type referencing the appropriate tool output.'
            });
            continue STEP_LOOP;
          }
        }
        if (histogramRequested && !traceHasHistogramData(trace)) {
          const note = 'Histogram requested but no usable bins were available in the selected window.';
          if (!adaptationNotes.includes(note)) adaptationNotes.push(note);
        }
        if (!ensureFinalReferencesPlan(obj)) {
          continue STEP_LOOP;
        }
        const llmAnswer = typeof obj.answer === 'string' ? obj.answer.trim() : '';
        let finalAnswer = llmAnswer && !isPlaceholderAnswer(llmAnswer)
          ? llmAnswer
          : buildDefaultAnswer({
              question,
              chart: null,
              trace,
              fallbackText: llmAnswer || reply || '',
              notes: adaptationNotes,
              range
            });
        if (finalAnswer && finalAnswer.length < 300 && traceHasData(trace)) {
          finalAnswer = buildDefaultAnswer({
            question,
            chart: null,
            trace,
            fallbackText: reply || '',
            notes: adaptationNotes,
            range
          });
        }
        // Skip plan status echo; keep answers concise
        if (!finalAnswer || normalizeText(finalAnswer) === normalizeText(question)) {
          const insight = traceInsight(trace);
          finalAnswer = insight || 'I analyzed the available data for the selected scope and time window.';
          if (Array.isArray(adaptationNotes) && adaptationNotes.length) {
            finalAnswer += ' ' + adaptationNotes.join(' ');
          }
        }
      if (!traceHasData(trace)) {
        finalAnswer = 'No telemetry data was available for the selected scope and time window; adjust the range or choose a different scope.';
      }
      finalAnswer = ensureQuestionAnswerCoverage(question, finalAnswer, trace);
      finalAnswer = enforceOverviewDetails(finalAnswer, { range: rr, trace, planStatus });
      finalAnswer = applyScopeHeader(finalAnswer);
        let finalChart = chartCandidateValidated || chartCandidate || null;
        const baseChartRequested = questionRequiresChart(question);
        const chartNeeded = baseChartRequested || needsRoomComparison || requireRoomRanking || histogramRequested || heatmapRequested || scatterRequested;
        if (chartNeeded) {
          if (!finalChart) {
            finalChart = buildChartFromTrace({
              trace,
              question,
              defaultRoom: room,
              selectionRooms
            });
            if (finalChart) {
              ensureChartData(finalChart, { question, room, selectionRooms, range: rr, trace, scopeLabels });
              const validated = validateChart(cloneChart(finalChart), trace);
              finalChart = validated || finalChart;
            }
          }
        }
      return {
        message: assistantMessage(finalAnswer),
        chart: finalChart,
        trace
      };
      } else {
        // Unknown → continue
        log('Unknown action from LLM:', obj.action);
        convo.push({ 
          role: 'user', 
          content: 'ERROR: Invalid action. Use "tool_call", "tool_calls", or "final".' 
        });
      }
    }
    
    // If model emitted non-JSON but informative text, return it
    let autoChart = null;
    if (convo.length && typeof convo[convo.length - 1]?.content === 'string') {
      const last = convo[convo.length - 1].content;
      // NEVER return tool_results JSON as the final answer
      if (last.includes('"tool_results"') || last.includes('"tool_result"') || last.includes('"tool_hint"')) {
        log('Prevented tool results JSON from being returned as final answer');
        markTiming(`iteration:${attemptIndex}:llm_toolresult_block`, iterationStart);
        
        // If detectors/metrics per room were fetched, summarize them explicitly
        try {
          const recentDet = trace.filter(t => t && (t.tool === 'scope_list_detectors'));
          if (recentDet.length) {
            const lines = [];
            for (const t of recentDet) {
              const r = t.args && t.args.room;
              if (!r) continue;
              const dets = Array.isArray(t.result) ? t.result : [];
              const tables = loadRoomTables(r);
              const fieldSet = new Set();
              for (const rows of Object.values(tables)) { const first=(rows||[])[0]||{}; for (const k of Object.keys(first)) if (k!=='ts') fieldSet.add(k); }
              const label = deviceFriendlyName(r);
              lines.push(`- ${label}: detectors=[${dets.join(', ')||'—'}], metrics=[${Array.from(fieldSet).sort().join(', ')||'—'}]`);
            }
            if (lines.length) {
              return { message: assistantMessage(`KPIs by product in current scope:\n${lines.join('\n')}`), chart: null, trace };
            }
          }
        } catch (e) { log('detectors summary in tool_results fallback failed:', String(e)); }

        // Try to construct a useful answer from the trace otherwise
        const fallbackChart = buildChartFromTrace({
          trace,
          question,
          defaultRoom: room,
          selectionRooms
        });
        const answer = buildDefaultAnswer({
          question,
          chart: fallbackChart,
          trace,
          notes: adaptationNotes,
          range
        });
        let overviewAnswer = enforceOverviewDetails(answer, { range: rr, trace, planStatus });
        overviewAnswer = applyScopeHeader(overviewAnswer);
        return {
          message: assistantMessage(overviewAnswer),
          chart: fallbackChart,
          trace
        };
      }
      const trimmedLast = last.trim();
      const planPromptLeak = /Include\s+"plan_status"/i.test(trimmedLast);
      const isSystemReminder =
        /^REMINDER:/i.test(trimmedLast) ||
        /^MANDATORY:/i.test(trimmedLast) ||
        /^CRITICAL ERROR:/i.test(trimmedLast) ||
        /^ERROR:/i.test(trimmedLast) ||
        /^PLAN STATUS:/i.test(trimmedLast) ||
        planPromptLeak ||
        /^You must include the requested visualization/i.test(trimmedLast);
      if (!isSystemReminder &&
          last && last.length > 40 && !last.includes('respond with a JSON') && !last.includes('ERROR:')) {
        autoChart = buildChartFromTrace({
          trace,
          question,
          defaultRoom: room,
          selectionRooms
        });
        if (autoChart) {
          ensureChartData(autoChart, { question, room, selectionRooms, range: rr, trace, scopeLabels });
        }
        let safeAnswer = buildDefaultAnswer({
          question,
          chart: autoChart,
          trace,
          fallbackText: last,
          notes: adaptationNotes,
          range
        });
        if (!safeAnswer || normalizeText(safeAnswer) === normalizeText(question)) {
          const chartSummary = summarizeChart(autoChart);
          const insight = traceInsight(trace);
          safeAnswer = chartSummary || insight || 'I analyzed the available data for the selected scope and time window.';
          if (Array.isArray(adaptationNotes) && adaptationNotes.length) {
            safeAnswer += ' ' + adaptationNotes.join(' ');
          }
        }
        safeAnswer = enforceOverviewDetails(safeAnswer, { range: rr, trace, planStatus });
        safeAnswer = applyScopeHeader(safeAnswer);
        return { message: assistantMessage(safeAnswer), chart: autoChart, trace };
      }
    }
    
    // Fallback: construct answer from trace
    log('Constructing fallback answer from trace');
    markTiming(`iteration:${attemptIndex}:fallback`, iterationStart);
    if (!autoChart) {
      autoChart = buildChartFromTrace({
        trace,
        question,
        defaultRoom: room,
        selectionRooms
      });
    }
    if (autoChart) {
      ensureChartData(autoChart, { question, room, selectionRooms, range: rr, trace, scopeLabels });
    }
    // Deduplicate repeated tool results in trace (by tool+args signature) to avoid noisy retries in the saved trace.
    try {
      const seen = new Set();
      const deduped = [];
      for (const entry of trace || []) {
        const key = JSON.stringify({ tool: entry.tool, args: entry.args });
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(entry);
      }
      trace = deduped;
    } catch {}
    const traceSummary = traceInsight(trace);
    const fallbackAnswer = buildDefaultAnswer({
      question,
      chart: autoChart,
      trace,
      fallbackText: traceSummary,
      knowledgeSnippets,
      includeKnowledge: !traceSummary,
      notes: adaptationNotes,
      range
    });

    let finalFallback = fallbackAnswer;
    if (!finalFallback || normalizeText(finalFallback) === normalizeText(question)) {
      const chartSummary = summarizeChart(autoChart);
      const intentSummary = traceSummary || traceInsight(trace);
      const rankingInsight = deriveTimeseriesInsights({ trace, range: rr }).join(' ');
      finalFallback = chartSummary || rankingInsight || intentSummary || 'I analyzed the available data for the selected scope and time window.';
      if (Array.isArray(adaptationNotes) && adaptationNotes.length) {
        finalFallback += ' ' + adaptationNotes.join(' ');
      }
      if (knowledgeSnippets && knowledgeSnippets.trim()) {
        const hint = shortenKnowledgeSnippet(knowledgeSnippets);
        if (hint) {
          finalFallback += `\nHint: ${hint}`;
        }
      }
    }

    finalFallback = enforceOverviewDetails(finalFallback, { range: rr, trace, planStatus });
    finalFallback = applyScopeHeader(finalFallback);

    return { 
      message: assistantMessage(finalFallback), 
      chart: null, 
      trace 
    };
    } finally {
      setScopeContext();
    }
  }

  return run;
}
