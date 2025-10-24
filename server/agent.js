import { buildDocsFromData, buildRagIndex } from './rag.js';
import { classifyQuery, suggestRetrievalFilters } from './router.js';
import { hybridRetrieve } from './retrieval.js';
import { evaluateQA } from './eval.js';
import fs from 'fs';
import path from 'path';

export function createAgent({ dataDir, listRooms, loadRoomTables, loadWeather, callGeminiChat, graph = null, vector = null }) {
  const DEBUG = process.env.RAG_DEBUG === '1' || process.env.LOG_LEVEL === 'debug';
  const log = (...a) => { if (DEBUG) console.log('[Agent]', ...a); };
  
  // Build RAG index once at startup
  const docs = buildDocsFromData({
    dataDir,
    rooms: listRooms(),
    loadRoomTables,
    knowledgeDir: path.join(path.dirname(dataDir), 'knowledge')
  });
  log(`Initialized RAG with ${docs.length} docs`);
  const rag = buildRagIndex(docs, { debug: DEBUG });

  // Graph snapshot loader for sync graph-aware tools
  function loadGraphSnapshot() {
    try {
      const rootDir = path.join(path.dirname(dataDir));
      const p = path.join(rootDir, 'data', 'graph_snapshot.json');
      const raw = fs.readFileSync(p, 'utf8');
      return JSON.parse(raw);
    } catch { return null; }
  }

  // State used by weather_fetch_by_scope
  let lastBuildingForWeather = null;
  let lastSelectionRooms = [];
  let lastRoom = null;

  function toolDefs() {
    return [
      { name: 'list_rooms', args: {}, desc: 'List available rooms' },
      { name: 'list_tables', args: { room: 'string' }, desc: 'List available tables in a room' },
      { name: 'get_schema', args: { room: 'string', table: 'string' }, desc: 'Get first row keys for a table' },
      { name: 'fetch_timeseries', args: { room: 'string', table: 'string', fields: 'string[]', start: 'number?', end: 'number?', limit: 'number?', after_ts: 'number?' }, desc: 'Fetch timeseries points as [{ts, field1, ...}] with optional paging using after_ts' },
      { name: 'compare_series_cross_room', args: { series: '[{room:string,table:string,field:string,name?:string}]', start: 'number?', end: 'number?' }, desc: 'Compare arbitrary series across rooms. Returns an object of arrays keyed by series name: {"name": [{ts, y}], ...}' },
      { name: 'pair_timeseries', args: { room: 'string', table1: 'string', field1: 'string', table2: 'string', field2: 'string', start: 'number?', end: 'number?', time_window_ms: 'number?' }, desc: 'Pair two fields by nearest timestamps within a time window (default ±30min). Returns [{x, y, ts1, ts2, dt}] for scatter plots' },
      { name: 'compute_ratio', args: { room: 'string', table1: 'string', field1: 'string', table2: 'string', field2: 'string', start: 'number?', end: 'number?', time_window_ms: 'number?', zero_if_denominator_zero: 'boolean?' }, desc: 'Compute ratio of field1/field2 with time-window matching. Returns [{ts, ratio}]. If zero_if_denominator_zero=true, returns 0 when denominator is 0, otherwise skips that point' },
      { name: 'stats', args: { room: 'string', table: 'string', field: 'string', start: 'number?', end: 'number?' }, desc: 'Compute count,min,max,avg,sum' },
      { name: 'correlate', args: { room: 'string', table1: 'string', field1: 'string', table2: 'string', field2: 'string', start: 'number?', end: 'number?', time_window_ms: 'number?' }, desc: 'Pearson correlation between two fields from room tables. Uses time-window matching (default ±30min) to handle different sampling rates' },
      { name: 'correlate_cross_room', args: { room1: 'string', table1: 'string', field1: 'string', room2: 'string', table2: 'string', field2: 'string', start: 'number?', end: 'number?', time_window_ms: 'number?' }, desc: 'Correlate metrics between different rooms with time-window matching' },
      { name: 'correlate_weather_room', args: { room: 'string', table: 'string', field_room: 'string', field_weather: 'string', start: 'number?', end: 'number?', time_window_ms: 'number?' }, desc: 'Correlate room metric with weather metric (temp, humidity, wind_speed, clouds, etc)' },
      { name: 'weather_correlate', args: { field1: 'string', field2: 'string', start: 'number?', end: 'number?' }, desc: 'Pearson correlation between two weather fields (temp, humidity, wind_speed, clouds, etc)' },
      { name: 'weather_fetch', args: { fields: 'string[]', start: 'number?', end: 'number?', limit: 'number?' }, desc: 'Fetch weather rows' },
      { name: 'latest_value', args: { room: 'string', table: 'string', field: 'string', start: 'number?', end: 'number?' }, desc: 'Latest ts and value for a field in a table within range' },
      { name: 'latest_per_room', args: { table: 'string', field: 'string', start: 'number?', end: 'number?' }, desc: 'Latest value per room for a field' },
      { name: 'current_occupied_rooms', args: { threshold: 'number?' }, desc: 'Rooms currently occupied based on latest people_count > threshold (default 0)' },
      { name: 'occupancy_current_total', args: {}, desc: 'Sum of latest people_count across all rooms' },
      { name: 'rooms_unused_since', args: { duration_ms: 'number' }, desc: 'Rooms with no people_count > 0 in the last duration_ms' },
      { name: 'busiest_day_of_week', args: { room: 'string', table: 'string', field: 'string', start: 'number?', end: 'number?', agg: 'string?' }, desc: 'Day of week with highest average or sum for field' },
      { name: 'weekday_weekend_comparison', args: { room: 'string', table: 'string', field: 'string', start: 'number?', end: 'number?' }, desc: 'Compare average field on weekdays vs weekends' },
      { name: 'energy_delta_kwh', args: { room: 'string', start: 'number?', end: 'number?' }, desc: 'Delta of total_kwh over period' },
      { name: 'energy_high_when_empty', args: { room: 'string', energy_table: 'string', occupancy_table: 'string', energy_threshold: 'number?', start: 'number?', end: 'number?' }, desc: 'Find times when energy was high while occupancy was zero' },
      { name: 'detect_spikes', args: { room: 'string', table: 'string', field: 'string', z: 'number?', start: 'number?', end: 'number?' }, desc: 'Simple z-score spike detection, returns [{ts,value,z}]' },
      { name: 'histogram', args: { room: 'string', table: 'string', field: 'string', bins: 'number?', start: 'number?', end: 'number?' }, desc: 'Histogram bins [{binStart,binEnd,count}]' },
      { name: 'data_gaps', args: { room: 'string', table: 'string', field: 'string', max_gap_ms: 'number', start: 'number?', end: 'number?' }, desc: 'Find gaps bigger than max_gap_ms between successive points' },
      { name: 'distinct_values', args: { room: 'string', table: 'string', field: 'string', limit: 'number?' }, desc: 'List distinct values up to limit' },
      { name: 'weekday_exceedance', args: { room: 'string', table: 'string', field: 'string', threshold: 'number', start: 'number?', end: 'number?' }, desc: 'Counts per weekday where field > threshold. Returns [{day, total, exceed, ratio}]' },
      { name: 'fetch_table_meta', args: { room: 'string', table: 'string' }, desc: 'Get table size, ts range, and fields' },
      { name: 'dump_room', args: { room: 'string', start: 'number?', end: 'number?', max_rows_per_table: 'number?' }, desc: 'Return raw rows per table for the room (use carefully; may be large)'},
      { name: 'hour_of_day_stats', args: { room: 'string', table: 'string', field: 'string', start: 'number?', end: 'number?' }, desc: 'Aggregate a field by hour-of-day across the selected window, returning [{hour, count, avg, min, max}]' },
      { name: 'hourly_timeseries', args: { room: 'string', table: 'string', field: 'string', start: 'number?', end: 'number?' }, desc: 'Aggregate to hourly buckets (absolute time), returns [{ts, avg}] for plotting' },
      { name: 'forecast_hourly_naive', args: { room: 'string', table: 'string', field: 'string', start: 'number?', end: 'number?', horizon_hours: 'number?' }, desc: 'Naive forecast: repeat last hourly value for N hours into future. Returns [{ts, forecast}]' },
      { name: 'forecast_hourly_linear', args: { room: 'string', table: 'string', field: 'string', start: 'number?', end: 'number?', horizon_hours: 'number?' }, desc: 'Linear trend forecast on hourly averages for N hours. Returns [{ts, forecast}]' },
      { name: 'forecast_from_profile', args: { room: 'string', table: 'string', field: 'string', start: 'number?', end: 'number?', days: 'number?' }, desc: 'Forecast next N days using hour-of-day profile from historical data. Returns [{ts, forecast}]' },
      { name: 'forecast_exponential_smoothing', args: { room: 'string', table: 'string', field: 'string', start: 'number?', end: 'number?', alpha: 'number?', horizon_hours: 'number?' }, desc: 'Simple exponential smoothing forecast' },
      { name: 'forecast_moving_average', args: { room: 'string', table: 'string', field: 'string', start: 'number?', end: 'number?', window: 'number?', horizon_hours: 'number?' }, desc: 'Moving average forecast' },
      { name: 'forecast_seasonal_hourly', args: { room: 'string', table: 'string', field: 'string', start: 'number?', end: 'number?', horizon_hours: 'number?' }, desc: 'Seasonal naive forecast using previous weeks' },
      { name: 'forecast_polyfit', args: { room: 'string', table: 'string', field: 'string', start: 'number?', end: 'number?', degree: 'number?', horizon_hours: 'number?' }, desc: 'Polynomial regression forecast (degree 2)' },
      { name: 'graph_rooms_by_tenant', args: { tenant: 'string' }, desc: 'List rooms permitted for a tenant from Neo4j' },
      { name: 'graph_devices_by_scope', args: { tenant: 'string?', building: 'string?', floor: 'string?', zone: 'string?', type: 'string?' }, desc: 'List devices within the provided scope from Neo4j' },
      { name: 'graph_rooms_by_scope', args: { building: 'string?', floor: 'string?' }, desc: 'List room IDs within a building and/or floor scope (uses graph snapshot if available, else local inference)' },
      { name: 'scope_list_buildings', args: {}, desc: 'List buildings from graph snapshot (fallback: infer from room IDs)' },
      { name: 'scope_list_floors', args: { building: 'string' }, desc: 'List floors for a building (graph snapshot fallback: infer from room IDs)' },
      { name: 'scope_list_rooms', args: { building: 'string?', floor: 'string?' }, desc: 'List rooms filtered by building and/or floor' },
      { name: 'scope_list_detectors', args: { room: 'string' }, desc: 'List detectors/sensor types present in a room based on available tables' },
      { name: 'graph_zone_devices', args: { room: 'string' }, desc: 'List devices and measured metric types for a room (from graph snapshot)' },
      { name: 'knowledge_search', args: { query: 'string', k: 'number?' }, desc: 'Search knowledge base and return top snippets with metadata' },
      { name: 'scope_csv_rooms', args: { building: 'string?', floor: 'string?', zone: 'string?', tenant: 'string?' }, desc: 'Map graph scope to CSV room IDs using snapshot heuristics' },
      { name: 'vector_search_docs', args: { query: 'string', k: 'number?' }, desc: 'Search documentation via vector store (fallbacks to TF-IDF if unavailable)' },
      { name: 'aggregate_stats_across_rooms', args: { table: 'string', field: 'string', agg: 'string?', start: 'number?', end: 'number?' }, desc: 'Aggregate a metric across all rooms (sum, avg, min, max) over the selected window' },
      { name: 'aggregate_hourly_across_rooms', args: { table: 'string', field: 'string', agg: 'string?', start: 'number?', end: 'number?' }, desc: 'Aggregate per-hour across rooms (sum or avg) returning [{ts, y}]' },
      { name: 'compare_field_across_rooms', args: { table: 'string', field: 'string', agg: 'string?', start: 'number?', end: 'number?' }, desc: 'Compute per-room value (avg/sum/peak) for ranking and comparison' },
      { name: 'compare_rooms_on_metric', args: { rooms: 'string[]?', table: 'string', field: 'string', agg: 'string?', start: 'number?', end: 'number?' }, desc: 'Rank rooms by metric aggregate within selection (uses selectionRooms if rooms omitted). Returns [{room, value}] sorted desc.' },
      { name: 'compare_metrics_in_room', args: { room: 'string', table: 'string', fields: 'string[]', agg: 'string?', start: 'number?', end: 'number?' }, desc: 'Compare multiple metrics within one room; returns [{field, value}]' },
      { name: 'common_metrics_in_scope', args: { rooms: 'string[]?' }, desc: 'List metrics common to all scoped rooms (intersection of first-row keys excluding ts)' },
      { name: 'correlation_matrix', args: { room: 'string', table: 'string', fields: 'string[]', start: 'number?', end: 'number?', time_window_ms: 'number?' }, desc: 'Pairwise Pearson correlation among fields within a room/table over the window' }
    ];
  }

  function resolveChartDataRefs(chartObj, trace) {
    if (!chartObj || !chartObj.series) return chartObj;
    
    for (const series of chartObj.series) {
      if (series.dataRef) {
        const ref = series.dataRef;
        log('Resolving dataRef:', ref);
        
        // Find the tool result in trace
        let toolResult = null;
        for (let i = trace.length - 1; i >= 0; i--) {
          const t = trace[i];
          if (t.tool !== ref.tool) continue;
          if (ref.room && t.args && t.args.room && String(t.args.room) !== String(ref.room)) continue;
          if (ref.yField && t.args && Array.isArray(t.args.fields) && !t.args.fields.includes(ref.yField)) continue;
          toolResult = t.result;
          break;
        }
        
        if (!toolResult) {
          log('Warning: Could not find tool result for', ref.tool);
          series.data = [];
          continue;
        }
        
        // Extract data based on the reference
        let sourceData = toolResult;
        
        // If compare_series_cross_room returned a map, select series by ref.field or series.name
        if (ref.tool === 'compare_series_cross_room' && sourceData && typeof sourceData === 'object' && !Array.isArray(sourceData)) {
          const keys = Object.keys(sourceData);
          let key = ref.field || series.name || '';
          let match = keys.find(k => k === key) || keys.find(k => k.toLowerCase() === String(key).toLowerCase());
          if (!match && key) match = keys.find(k => k.toLowerCase().includes(String(key).toLowerCase()));
          if (!match) match = keys[0];
          sourceData = sourceData[match] || [];
        }
        
        // If ref specifies a field (e.g., forecast blocks)
        if (ref.field && Array.isArray(toolResult?.[ref.field])) {
          sourceData = toolResult[ref.field];
        }
        
        // Convert to chart data format
        if (Array.isArray(sourceData)) {
          const xField = ref.xField || 'ts';
          const yField = ref.yField;
          
          let data = sourceData
            .map(item => {
              const x = item[xField];
              const y = yField ? item[yField] : item[Object.keys(item).find(k => k !== xField)];
              return [x, y];
            })
            .filter(d => d[0] != null && d[1] != null && Number.isFinite(d[1]));
          
          // Sample down if too large
          if (data.length > 500) {
            data = sampleArray(data, 500);
            log(`Sampled ${ref.tool} data from ${sourceData.length} to ${data.length} points`);
          }
          
          series.data = data;
        } else {
          log('Warning: Tool result is not an array for', ref.tool);
          series.data = [];
        }
        
        // Remove the dataRef after resolving
        delete series.dataRef;
      }
    }
    
    return chartObj;
  }
  
  function validateChart(chartObj, trace) {
    if (!chartObj) return null;
    
    // Ensure series exists
    if (!chartObj.series || !Array.isArray(chartObj.series) || chartObj.series.length === 0) {
      log('Chart validation failed: missing or empty series');
      return null;
    }
    
    // Resolve any dataRef references (with support for special formats)
    // Special-case: correlation_matrix → heatmap triples + categories
    try {
      for (const s of (chartObj.series || [])) {
        const ref = s && s.dataRef;
        if (ref && ref.tool === 'correlation_matrix') {
          // Find the latest correlation_matrix result in trace
          let last = null;
          for (let i = trace.length - 1; i >= 0; i--) {
            const t = trace[i];
            if (t && t.tool === 'correlation_matrix' && t.result && Array.isArray(t.result.matrix)) { last = t.result; break; }
          }
          if (last && Array.isArray(last.matrix) && Array.isArray(last.fields)) {
            const fields = last.fields;
            const triples = [];
            for (let i = 0; i < last.matrix.length; i++) {
              for (let j = 0; j < last.matrix[i].length; j++) {
                const v = last.matrix[i][j];
                if (v == null) continue;
                triples.push([i, j, Number(v)]);
              }
            }
            s.data = triples;
            delete s.dataRef;
            // Provide categories for heatmap axes if not already present
            chartObj.xAxis = chartObj.xAxis || {};
            chartObj.yAxis = chartObj.yAxis || {};
            if (!chartObj.xAxis.categories) chartObj.xAxis.categories = fields;
            if (!chartObj.yAxis.categories) chartObj.yAxis.categories = fields;
          }
        }
      }
    } catch (e) { log('Heatmap correlation_matrix resolve failed:', String(e)); }

    // Resolve generic dataRefs afterwards
    chartObj = resolveChartDataRefs(chartObj, trace);
    
    // Check if series has data
    const hasData = chartObj.series.some(s => s.data && s.data.length > 0);
    if (!hasData) {
      log('Chart validation failed: no data in series');
      return null;
    }
    
    // Sample down large datasets to prevent UI issues (backup in case LLM included raw data)
    for (const series of chartObj.series) {
      if (series.data && series.data.length > 500) {
        const originalLength = series.data.length;
        const sampled = sampleArray(series.data, 500);
        series.data = sampled;
        log(`Sampled series from ${originalLength} to ${sampled.length} points`);
      }
    }
    
    return chartObj;
  }
  
  function sampleArray(arr, maxPoints) {
    if (arr.length <= maxPoints) return arr;
    const step = Math.floor(arr.length / maxPoints);
    const sampled = [];
    sampled.push(arr[0]); // Always include first point
    for (let i = step; i < arr.length - 1; i += step) {
      sampled.push(arr[i]);
    }
    sampled.push(arr[arr.length - 1]); // Always include last point
    return sampled;
  }

  function pearson(xs, ys) {
    const n = Math.min(xs.length, ys.length);
    if (n < 3) return NaN;
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, k = 0;
    for (let i = 0; i < n; i++) {
      const x = xs[i];
      const y = ys[i];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      sx += x; sy += y; sxx += x*x; syy += y*y; sxy += x*y; k++;
    }
    if (k < 3) return NaN;
    const cov = (sxy - (sx*sy)/k) / k;
    const vx = (sxx - (sx*sx)/k) / k;
    const vy = (syy - (sy*sy)/k) / k;
    const denom = Math.sqrt(vx*vy);
    return denom > 0 ? cov/denom : NaN;
  }

  function withinRange(ts, start, end) { 
    return (!start || ts >= start) && (!end || ts <= end); 
  }
  
  function floorHour(ts) { 
    const d = new Date(ts); 
    d.setMinutes(0,0,0); 
    return d.getTime(); 
  }
  function inferRoomFromText(text) {
    try {
      const rooms = listRooms();
      const tl = String(text || '').toLowerCase();
      for (const r of rooms) {
        if (tl.includes(String(r).toLowerCase())) return r;
      }
    } catch {}
    return null;
  }

  function isAllRooms(sel) {
    const s = String(sel || '').toLowerCase();
    return s === 'all' || s === '*';
  }

  
  function norm(s) { 
    return String(s||'').toLowerCase().replace(/[^a-z0-9]/g,''); 
  }
  
  function resolveTable(room, name) {
    const t = loadRoomTables(room);
    if (t[name]) return name;
    const keys = Object.keys(t);
    const n = norm(name);
    const k1 = keys.find(k => norm(k) === n);
    if (k1) return k1;
    const parts = name.split('_');
    const core = norm(parts[parts.length-1] || name);
    const k2 = keys.find(k => norm(k) === core) || keys.find(k => norm(k).endsWith(core)) || keys.find(k => norm(k).includes(core));
    return k2 || name;
  }

  function availableFieldsByTable(room) {
    const t = loadRoomTables(room);
    const out = {};
    for (const [name, rows] of Object.entries(t)) {
      out[name] = new Set(rows.length ? Object.keys(rows[0]) : []);
    }
    return out;
  }

  function inferFieldName(label, availableSets) {
    if (!label) return null;
    const target = norm(String(label).replace(/\(([^)]*)\)/g, '').trim());
    // Direct match across any table
    for (const set of Object.values(availableSets)) {
      for (const f of set) if (norm(f) === target) return f;
    }
    // Synonyms
    for (const [canon, syns] of Object.entries(FIELD_SYNONYMS)) {
      const cn = norm(canon);
      if (target === cn || syns.some(s => norm(s) === target)) {
        for (const set of Object.values(availableSets)) {
          for (const f of set) if (norm(f) === cn) return f;
          for (const s of syns) {
            for (const f of set) if (norm(f) === norm(s)) return f;
          }
        }
      }
    }
    // Fuzzy contains
    for (const set of Object.values(availableSets)) {
      for (const f of set) if (norm(f).includes(target) || target.includes(norm(f))) return f;
    }
    return null;
  }

function parseFieldsFromQuestion(question, availableSets) {
  const q = String(question || '').toLowerCase();
  const fields = [];
  // Recognize air exchange rate synonyms explicitly
  try {
    const airSyns = ['air exchangerate','air exchange rate','airexchangerate','airchangerate','airchange','ach'];
    if (airSyns.some(s => q.includes(s))) {
      const f = inferFieldName('airExchangeRate', availableSets) || inferFieldName('ach', availableSets);
      if (f && !fields.includes(f)) fields.push(f);
    }
  } catch {}
    // 1) explicit "x vs y"
    if (q.includes(' vs ')) {
      const parts = question.split(/\s+vs\s+/i).map(s => s.trim());
      if (parts.length >= 2) {
        const f1 = inferFieldName(parts[0], availableSets);
        const f2 = inferFieldName(parts[1], availableSets);
        if (f1) fields.push(f1);
        if (f2) fields.push(f2);
      }
    }
    // 2) "correlation between x and y" or "between x and y"
    if (fields.length < 2 && q.includes('between') && (q.includes('and') || q.includes('&'))) {
      const bet = question.split(/between/i)[1] || '';
      const bits = bet.split(/\band\b|&/i).map(s => s.trim()).filter(Boolean);
      if (bits.length >= 2) {
        const f1 = inferFieldName(bits[0], availableSets);
        const f2 = inferFieldName(bits[1], availableSets);
        if (f1 && !fields.includes(f1)) fields.push(f1);
        if (f2 && !fields.includes(f2)) fields.push(f2);
      }
    }
    // 3) single metric mentions
    const candidates = ['co2','co₂','voc','lux','light','illum', 'pressure','humidity','humid','temperature','temp','people_count','people','occupancy','pm1','pm25','pm10','nh3','h2s','odor','odour','odor_level','value','total_kwh','energy','kwh','power'];
    for (const c of candidates) {
      if (fields.length >= 2) break;
      if (q.includes(c)) {
        const f = inferFieldName(c, availableSets);
        if (f && !fields.includes(f)) fields.push(f);
      }
    }
    return fields;
  }

  // Lightweight intent classifier tolerant to varied phrasing
  function classifyIntent(question) {
    const q = String(question || '').toLowerCase();
    const has = (...words) => words.some(w => q.includes(w));
    const typeRegex = /(boardroom|meeting|lab|laboratory|toilet|restroom|bathroom|wc|cafe|cafeteria|kitchen)/i;
    return {
      selectionTime: has('what selection','what scope and time','what selection and time','what time period are you analys','current range','current window','what scope do you see','selection and time','selection and time frame','selection and time period','what selection and time'),
      metricsEachRoom: (
        has(
          'metrics in each room','metrics in every room','metrics per room',
          'what metrics are in each','what metrics are in the rooms',
          'metrics are measured in these rooms','metrics measured in these rooms',
          'what metrics are measured in these rooms','what metrics are measured in the rooms',
          'metrics in these rooms','metrics for these rooms','metrics across these rooms'
        ) ||
        (
          (has('in scope','in the scope','in selection','in the selection','here','these rooms','the rooms')
            && has('metrics','detectors') && has('room','rooms'))
          || (has('detectors') && has('each','every','rooms'))
        )
      ),
      devicesInRoom: has('what detectors','what devices','what sensors') && !has('each','every'),
      plotAcrossRooms: (has('plot','chart','visualize') && (has('across all rooms','on this floor','on this building'))) || has('compare across rooms','timeseries across rooms'),
      rankRooms: (has('highest','top','most') && (has('avg','average','mean','peak') || true) && (has('on this floor') || has('on this building'))),
      plotSingle: has('plot','chart','visualize') && !has('across all rooms','on this floor','on this building'),
      correlation: has('correlation','correlate','matrix')
      ,
      compareTypes: (q.includes('compare') && /\b(and|vs|versus)\b/i.test(q) && typeRegex.test(q))
    };
  }

  function resolveMetricAndTableFromQuestion(question, availableSets, fallbackField='people_count') {
    const fields = parseFieldsFromQuestion(question, availableSets);
    const field = fields[0] || (question.toLowerCase().includes('occup') ? 'people_count' : (question.toLowerCase().includes('energy') ? 'value' : fallbackField));
    let table = null;
    for (const [t, set] of Object.entries(availableSets)) if (set.has(field)) { table = t; break; }
    if (!table) table = (field === 'value' || field === 'total_kwh') ? 'energy' : 'iaq';
    return { field, table };
  }

  function resolveToolName(name) {
    const t = String(name || '').toLowerCase();
    const map = new Map([
      ['list_rooms_in_scope','graph_rooms_by_scope'],
      ['rooms_in_scope','graph_rooms_by_scope'],
      ['scope_rooms','graph_rooms_by_scope'],
      ['graph_rooms_in_scope','graph_rooms_by_scope'],
      ['list_buildings','scope_list_buildings'],
      ['buildings','scope_list_buildings'],
      ['list_floors','scope_list_floors'],
      ['floors','scope_list_floors'],
      ['list_rooms','scope_list_rooms'],
      ['rooms','scope_list_rooms'],
      ['list_detectors','scope_list_detectors'],
      ['detectors_in_room','scope_list_detectors'],
      ['room_detectors','scope_list_detectors'],
      ['sensors_in_room','scope_list_detectors'],
      ['list_sensors','scope_list_detectors'],
      ['devices_in_room','graph_zone_devices'],
      ['list_devices','graph_zone_devices'],
      ['common_metrics','common_metrics_in_scope'],
      ['common_fields','common_metrics_in_scope'],
      ['metrics_in_scope','common_metrics_in_scope'],
      ['rank_rooms','compare_rooms_on_metric'],
      ['top_rooms','compare_rooms_on_metric'],
      ['highest_avg','compare_rooms_on_metric'],
      ['compare_metrics','compare_metrics_in_room'],
      ['compare_fields','compare_metrics_in_room'],
      ['correlate_metrics','correlation_matrix'],
      ['correlationmatrix','correlation_matrix'],
      ['vector_search','vector_search_docs'],
      ['search_docs','vector_search_docs']
    ]);
    return map.get(t) || name;
  }

  function wantsChart(question) {
    const q = String(question || '').toLowerCase();
    return (
      q.includes('plot') || q.includes('chart') || q.includes('visual') || q.includes('trend') ||
      q.includes('over time') || q.includes('history') || q.includes('vs') || q.includes('correlation')
    );
  }
  
  const FIELD_SYNONYMS = {
    temperature: ['temp', 'temperaturec', 'temp_c', 'airtemp', 'ambienttemp'],
    people_count: ['people', 'count', 'occupants', 'occupancy', 'personcount'],
    virusrisk: ['virus_risk', 'virusrisk', 'risk'],
    total_kwh: ['totalkwh', 'kwh_total', 'energy_total', 'total_energy'],
    humidity: ['hum', 'rh', 'relativehumidity', 'humid'],
    co2: ['co2ppm', 'carbondioxide', 'co2_level'],
    lux: ['illuminance', 'light', 'lightlevel'],
    pm1: ['pm_1', 'particulate1'],
    pm25: ['pm_2_5', 'pm2.5', 'particulate25'],
    pm10: ['pm_10', 'particulate10'],
    pressure: ['atmpressure', 'barometricpressure'],
    voc: ['volatileorganiccompounds', 'voc_level'],
    nh3: ['ammonia', 'nh_3', 'nh-3'],
    h2s: ['hydrogen_sulfide', 'hydrogensulfide', 'h_2_s', 'h-2-s'],
    odor_level: ['odor','odour','odorlevel','smell','odor_level'],
    airExchangeRate: ['air exchange rate','airexchangerate','airchangerate','airchange','ach','air_exch_rate','air_exch','airexchagerate'],
    battery: ['battery_level', 'batt'],
    rssi: ['signal', 'signalstrength'],
    value: ['reading', 'measurement'],
    unit: ['units'],
    sla: ['servicelevelagreement'],
    time: ['timestamp', 'datetime'],
    date: ['datestamp']
  };

  function normalizeRoomTypeFromId(roomId) {
    const m = String(roomId || '').toLowerCase().match(/^[a-z]_f\d+_([a-z0-9]+)/);
    return m ? m[1] : null;
  }

  function roomsByType(selectionRooms, type) {
    const t = String(type || '').toLowerCase();
    const synonyms = {
      boardroom: ['boardroom','meeting'],
      lab: ['lab','laboratory'],
      toilet: ['toilet','restroom','bathroom','wc'],
      cafe: ['cafe','cafeteria','kitchen']
    };
    const keys = synonyms[t] || [t];
    return (selectionRooms||[]).filter(r => keys.some(k => String(r).toLowerCase().includes(k)));
  }

  function pickFieldsForRoom(room, count = 3) {
    const tablesSets = availableFieldsByTable(room);
    const priority = ['people_count','co2','temperature','humidity','lux','value','total_kwh','voc','pm25','pm10'];
    const out = [];
    for (const p of priority) {
      if (out.length >= count) break;
      for (const set of Object.values(tablesSets)) { if (set.has(p)) { out.push(p); break; } }
    }
    // Fallback: any fields
    if (out.length < count) {
      const any = new Set();
      for (const set of Object.values(tablesSets)) for (const f of set) if (f !== 'ts') any.add(f);
      for (const f of any) { if (out.length >= count) break; if (!out.includes(f)) out.push(f); }
    }
    return out.slice(0, count);
  }
  
  function resolveField(rows, field) {
    const keys = Object.keys(rows?.[0] || {});
    if (!keys.length) return field;
    const target = norm(field);
    let k = keys.find(x => norm(x) === target);
    if (k) return k;
    for (const [canon, syns] of Object.entries(FIELD_SYNONYMS)) {
      if (norm(canon) === target || syns.some(s => norm(s) === target)) {
        k = keys.find(x => norm(x) === norm(canon));
        if (k) return k;
        for (const s of syns) { 
          const m = keys.find(x => norm(x) === norm(s)); 
          if (m) return m; 
        }
      }
    }
    k = keys.find(x => norm(x).includes(target));
    return k || field;
  }
  
  function getHourlySeries(room, table, field, start=null, end=null) {
    const t = loadRoomTables(room);
    const tab = resolveTable(room, table);
    const arr = t[tab] || [];
    const fld = resolveField(arr, field);
    const buckets = new Map();
    for (const r of arr) {
      if (!withinRange(r.ts, start, end)) continue;
      const v = Number(r[fld]); 
      if (!Number.isFinite(v)) continue;
      const key = floorHour(r.ts);
      const b = buckets.get(key) || { sum: 0, n: 0 };
      b.sum += v; 
      b.n += 1; 
      buckets.set(key, b);
    }
    return Array.from(buckets.entries())
      .sort((a,b)=>a[0]-b[0])
      .map(([ts,b]) => ({ ts, avg: b.n ? b.sum / b.n : null }));
  }
  
  function lrForecast(points, horizon) {
    const xs=[], ys=[]; 
    for (const p of points) { 
      if (Number.isFinite(p.avg)) { 
        xs.push(p.ts); 
        ys.push(p.avg); 
      } 
    }
    const n=xs.length; 
    if (n<2) return [];
    const mean=a=>a.reduce((s,v)=>s+v,0)/a.length; 
    const mx=mean(xs), my=mean(ys);
    let num=0, den=0; 
    for (let i=0;i<n;i++){ 
      const dx=xs[i]-mx; 
      num+=dx*(ys[i]-my); 
      den+=dx*dx; 
    }
    const b = den? num/den : 0; 
    const a = my - b*mx;
    const step = n>=2 ? (xs[n-1]-xs[n-2]) : 3600*1000; 
    const last=xs[n-1];
    const out=[]; 
    for (let i=1;i<=horizon;i++){ 
      const ts=last+i*step; 
      out.push({ ts, forecast: a + b*ts }); 
    }
    return out;
  }
  
  function naiveForecast(lastTs, lastY, stepMs, horizon) { 
    const out=[]; 
    for (let i=1;i<=horizon;i++){ 
      out.push({ ts: lastTs + i*stepMs, forecast: lastY }); 
    } 
    return out; 
  }

  function logToolResult(tool, args, result) {
    log(`[Tool] ${tool} called with args:`, args);
    log(`[Tool] ${tool} result:`, typeof result === 'object' ? JSON.stringify(result).slice(0, 300) : result);
    return result;
  }

  const tools = {
    list_rooms() { 
      return listRooms(); 
    },
    
    list_tables({ room }) {
      const t = loadRoomTables(room);
      return Object.keys(t);
    },
    
    get_schema({ room, table }) {
      const t = loadRoomTables(room);
      const first = (t[table] || [])[0] || {};
      return Object.keys(first);
    },
    
    compute_ratio({ room, table1, field1, table2, field2, start = null, end = null, time_window_ms = 30 * 60 * 1000, zero_if_denominator_zero = true }) {
      const t = loadRoomTables(room);
      const a = t[table1] || [];
      const b = t[table2] || [];
      
      const aFiltered = a.filter(r => withinRange(r.ts, start, end));
      const bFiltered = b.filter(r => withinRange(r.ts, start, end));
      
      if (!aFiltered.length || !bFiltered.length) {
        return [];
      }
      
      const ratios = [];
      
      // For each point in numerator dataset, find matching denominator
      for (const r of aFiltered) {
        const numerator = Number(r[field1]);
        if (!Number.isFinite(numerator)) continue;
        
        // Find nearest timestamp in denominator within time window
        let best = null, bestDt = Infinity;
        for (const s of bFiltered) {
          const dt = Math.abs((s.ts ?? 0) - r.ts);
          if (dt < bestDt) {
            best = s;
            bestDt = dt;
          }
          if (dt > time_window_ms && s.ts > r.ts) break;
        }
        
        if (best && bestDt <= time_window_ms) {
          const denominator = Number(best[field2]);
          
          if (Number.isFinite(denominator)) {
            if (denominator === 0) {
              if (zero_if_denominator_zero) {
                ratios.push({ ts: r.ts, ratio: 0, numerator, denominator });
              }
              // else skip this point
            } else {
              const ratio = numerator / denominator;
              ratios.push({ ts: r.ts, ratio, numerator, denominator });
            }
          }
        }
      }
      
      return ratios;
    },
    
    fetch_timeseries({ room, table, fields = [], start = null, end = null, limit = 2000, after_ts = null }) {
      const t = loadRoomTables(room);
      const tab = resolveTable(room, table);
      const arr = t[tab] || [];
      
      // If limit is small (like 1) and no specific start, get from the end (most recent)
      const getLatest = limit <= 5 && !start && !after_ts;
      const source = getLatest ? [...arr].reverse() : arr;
      
      const out = [];
      for (const r of source) {
        if (after_ts != null && r.ts <= after_ts) continue;
        if (!withinRange(r.ts, start, end)) continue;
        const o = { ts: r.ts };
        for (const f of fields) if (f in r) o[f] = r[f];
        out.push(o);
        if (limit && out.length >= limit) break;
      }
      
      // If we reversed for latest, reverse back to chronological order
      return getLatest ? out.reverse() : out;
    },
    
    stats({ room, table, field, start = null, end = null }) {
      const t = loadRoomTables(room);
      const tab = resolveTable(room, table);
      const arr = t[tab] || [];
      let count = 0, min = Infinity, max = -Infinity, sum = 0;
      for (const r of arr) {
        if (!withinRange(r.ts, start, end)) continue;
        const v = Number(r[field]);
        if (!Number.isFinite(v)) continue;
        count++; 
        sum += v; 
        if (v < min) min = v; 
        if (v > max) max = v;
      }
      const avg = count ? sum / count : NaN;
      return { 
        count, 
        min: isFinite(min) ? min : null, 
        max: isFinite(max) ? max : null, 
        avg: isFinite(avg) ? avg : null, 
        sum 
      };
    },
    
    correlate({ room, table1, field1, table2, field2, start = null, end = null, time_window_ms = 30 * 60 * 1000 }) {
      const t = loadRoomTables(room);
      const a = t[table1] || [];
      let b = [];
      if (table2 === 'weather') {
        b = loadWeather();
        if (field2 === 'temperature') field2 = 'temp';
      } else {
        b = t[table2] || [];
      }
      
      const pairs = [];
      
      // Filter both arrays to the time range first
      const aFiltered = a.filter(r => withinRange(r.ts, start, end));
      const bFiltered = b.filter(r => withinRange(r.ts, start, end));
      
      if (!aFiltered.length || !bFiltered.length) {
        return { n: 0, corr: null, error: 'No data in selected range for one or both tables' };
      }
      
      // For each point in the more frequently sampled dataset, find nearest in the other
      for (const r of aFiltered) {
        const v1 = Number(r[field1]);
        if (!Number.isFinite(v1)) continue;
        
        // Find nearest timestamp in b within time window
        let best = null, bestDt = Infinity;
        for (const s of bFiltered) {
          const dt = Math.abs((s.ts ?? 0) - r.ts);
          if (dt < bestDt) {
            best = s;
            bestDt = dt;
          }
          // Early exit if we've passed the window
          if (dt > time_window_ms && s.ts > r.ts) break;
        }
        
        if (best && bestDt <= time_window_ms) {
          const v2 = Number(best[field2]);
          if (Number.isFinite(v1) && Number.isFinite(v2)) {
            pairs.push([v1, v2]);
          }
        }
      }
      
      const corr = pearson(pairs.map(p => p[0]), pairs.map(p => p[1]));
      return { 
        n: pairs.length, 
        corr,
        time_window_ms,
        table1_samples: aFiltered.length,
        table2_samples: bFiltered.length
      };
    },
    
    correlate_cross_room({ room1, table1, field1, room2, table2, field2, start = null, end = null, time_window_ms = 30 * 60 * 1000 }) {
      const t1 = loadRoomTables(room1);
      const t2 = loadRoomTables(room2);
      const a = t1[table1] || [];
      const b = t2[table2] || [];
      
      const aFiltered = a.filter(r => withinRange(r.ts, start, end));
      const bFiltered = b.filter(r => withinRange(r.ts, start, end));
      
      if (!aFiltered.length || !bFiltered.length) {
        return { n: 0, corr: null, error: 'No data in selected range for one or both rooms' };
      }
      
      const pairs = [];
      for (const r of aFiltered) {
        const v1 = Number(r[field1]);
        if (!Number.isFinite(v1)) continue;
        
        let best = null, bestDt = Infinity;
        for (const s of bFiltered) {
          const dt = Math.abs((s.ts ?? 0) - r.ts);
          if (dt < bestDt) {
            best = s;
            bestDt = dt;
          }
          if (dt > time_window_ms && s.ts > r.ts) break;
        }
        
        if (best && bestDt <= time_window_ms) {
          const v2 = Number(best[field2]);
          if (Number.isFinite(v1) && Number.isFinite(v2)) {
            pairs.push([v1, v2]);
          }
        }
      }
      
      const corr = pearson(pairs.map(p => p[0]), pairs.map(p => p[1]));
      return { 
        n: pairs.length, 
        corr,
        room1,
        room2,
        time_window_ms
      };
    },
    
    correlate_weather_room({ room, table, field_room, field_weather, start = null, end = null, time_window_ms = 60 * 60 * 1000 }) {
      const t = loadRoomTables(room);
      const roomData = t[table] || [];
      const weatherData = loadWeather();
      
      // Handle weather field aliases
      let weatherField = field_weather;
      if (field_weather === 'temperature') weatherField = 'temp';
      
      const roomFiltered = roomData.filter(r => withinRange(r.ts, start, end));
      const weatherFiltered = weatherData.filter(r => withinRange(r.ts, start, end));
      
      if (!roomFiltered.length || !weatherFiltered.length) {
        return { n: 0, corr: null, error: 'No data in selected range for room or weather' };
      }
      
      const pairs = [];
      for (const r of roomFiltered) {
        const v1 = Number(r[field_room]);
        if (!Number.isFinite(v1)) continue;
        
        let best = null, bestDt = Infinity;
        for (const w of weatherFiltered) {
          const dt = Math.abs((w.ts ?? 0) - r.ts);
          if (dt < bestDt) {
            best = w;
            bestDt = dt;
          }
          if (dt > time_window_ms && w.ts > r.ts) break;
        }
        
        if (best && bestDt <= time_window_ms) {
          const v2 = Number(best[weatherField]);
          if (Number.isFinite(v1) && Number.isFinite(v2)) {
            pairs.push([v1, v2]);
          }
        }
      }
      
      const corr = pearson(pairs.map(p => p[0]), pairs.map(p => p[1]));
      return { 
        n: pairs.length, 
        corr,
        field_room,
        field_weather: weatherField,
        time_window_ms
      };
    },
    
    weather_correlate({ field1, field2, start = null, end = null }) {
      const weather = loadWeather();
      const pairs = [];
      for (const r of weather) {
        if (!withinRange(r.ts, start, end)) continue;
        const v1 = Number(r[field1]);
        const v2 = Number(r[field2]);
        if (Number.isFinite(v1) && Number.isFinite(v2)) {
          pairs.push([v1, v2]);
        }
      }
      const corr = pearson(pairs.map(p => p[0]), pairs.map(p => p[1]));
      return { n: pairs.length, corr, field1, field2 };
    },
    
    unoccupied_over_temp({ room, temp = 21, start = null, end = null }) {
      const t = loadRoomTables(room);
      const env = (t.env && t.env.length) ? t.env : (t.iaq || []);
      const people = t.people || [];
      const latestTs = Math.max(...[...env, ...people]
        .filter(r => withinRange(r.ts, start, end))
        .map(r => r.ts || 0));
      if (!Number.isFinite(latestTs)) return { ts: null, ok: null };
      const tr = env.find(x => x.ts === latestTs) || env[env.length-1];
      const pr = people.find(x => x.ts === latestTs) || people[people.length-1];
      const occ = pr ? Number(pr.people_count) : 0;
      const temperature = tr ? Number(tr.temperature) : null;
      const ok = (occ === 0) && (temperature != null && temperature > temp);
      return { ts: latestTs, temperature, occupancy: occ, ok };
    },
    
    rooms_unused_in_window({ start, end }) {
      const out = [];
      for (const r of listRooms()) {
        const t = loadRoomTables(r);
        const people = t.people || [];
        const any = people.some(x => withinRange(x.ts, start, end) && Number(x.people_count) > 0);
        if (!any) out.push(r);
      }
      return out;
    },

    compare_series_cross_room({ series = [], start = null, end = null }) {
      const out = {};
      if (!Array.isArray(series)) return out;
      for (const s of series) {
        if (!s || !s.room || !s.table || !s.field) continue;
        const t = loadRoomTables(String(s.room));
        const arr = (t[String(s.table)] || []).filter(r => withinRange(r.ts, start, end));
        const name = s.name || `${s.room} ${s.field}`;
        const points = [];
        for (const r of arr) {
          const y = Number(r[s.field]);
          if (!Number.isFinite(y)) continue;
          points.push({ ts: r.ts, y });
        }
        out[name] = points;
      }
      return out;
    },
    
    people_total({ room, start = null, end = null }) {
      const arr = (loadRoomTables(room).people || [])
        .filter(r => withinRange(r.ts, start, end));
      const sum = arr.reduce((a,r)=> a + (Number(r.people_count)||0), 0);
      return { sum, count: arr.length };
    },
    
    avg_occupancy({ room, start = null, end = null }) {
      const arr = (loadRoomTables(room).people || [])
        .filter(r => withinRange(r.ts, start, end));
      const sum = arr.reduce((a,r)=> a + (Number(r.people_count)||0), 0);
      const avg = arr.length ? sum / arr.length : null;
      return { avg, count: arr.length };
    },
    
    busiest_room({ start = null, end = null, metric = 'peak' }) {
      let best = null;
      for (const r of listRooms()) {
        const people = (loadRoomTables(r).people || [])
          .filter(x => withinRange(x.ts, start, end));
        if (!people.length) continue;
        const peak = Math.max(...people.map(x => Number(x.people_count)||0));
        const avg = people.reduce((a,x)=>a+(Number(x.people_count)||0),0) / people.length;
        const score = metric === 'avg' ? avg : peak;
        if (!best || score > best.score) {
          best = { room: r, peak, avg, score };
        }
      }
      return best;
    },
    
    energy_usage({ room, start = null, end = null }) {
      const energy = (loadRoomTables(room).energy || [])
        .filter(r => withinRange(r.ts, start, end));
      const sumValue = energy.reduce((a,r)=> a + (Number(r.value)||0), 0);
      const vals = energy.map(r => Number(r.total_kwh))
        .filter(Number.isFinite)
        .sort((a,b)=>a-b);
      const deltaKwh = vals.length>=2 ? (vals[vals.length-1]-vals[0]) : null;
      return { sum_value: sumValue, delta_kwh: deltaKwh };
    },
    
    energy_peak_time({ room, start = null, end = null }) {
      const energy = (loadRoomTables(room).energy || [])
        .filter(r => withinRange(r.ts, start, end));
      let bestTs = null, bestDelta = -Infinity;
      for (let i=1;i<energy.length;i++) {
        const prev = Number(energy[i-1].total_kwh);
        const cur = Number(energy[i].total_kwh);
        if (Number.isFinite(prev) && Number.isFinite(cur)) {
          const d = cur - prev;
          if (d > bestDelta) { 
            bestDelta = d; 
            bestTs = energy[i].ts; 
          }
        }
      }
      if (bestTs == null) {
        const m = energy.reduce((b,r)=> (Number(r.value)> (b?.value||-Infinity)? r: b), null);
        bestTs = m?.ts ?? null; 
        bestDelta = m?.value ?? null;
      }
      return { ts: bestTs, delta: bestDelta };
    },

    aggregate_stats_across_rooms({ table, field, agg = 'sum', start = null, end = null }) {
      let values = [];
      for (const r of listRooms()) {
        const t = loadRoomTables(r);
        const tab = resolveTable(r, table);
        const arr = (t[tab] || []).filter(row => withinRange(row.ts, start, end));
        for (const row of arr) {
          const v = Number(row[field]);
          if (Number.isFinite(v)) values.push(v);
        }
      }
      if (!values.length) return { agg, value: null, count: 0 };
      const sum = values.reduce((a,b)=>a+b,0);
      const avg = sum / values.length;
      const min = Math.min(...values);
      const max = Math.max(...values);
      const map = { sum, avg, min, max };
      const value = map[agg] != null ? map[agg] : sum;
      return { agg, value, count: values.length, sum, avg, min, max };
    },

    aggregate_hourly_across_rooms({ table, field, agg = 'sum', start = null, end = null }) {
      const buckets = new Map();
      for (const r of listRooms()) {
        const hourly = getHourlySeries(r, table, field, start, end);
        for (const p of hourly) {
          if (!Number.isFinite(p.avg)) continue;
          const b = buckets.get(p.ts) || { sum: 0, n: 0 };
          b.sum += p.avg;
          b.n += 1;
          buckets.set(p.ts, b);
        }
      }
      const out = [];
      for (const [ts, b] of Array.from(buckets.entries()).sort((a,b)=>a[0]-b[0])) {
        const y = agg === 'avg' ? (b.n ? b.sum / b.n : null) : b.sum;
        out.push({ ts, y });
      }
      return out;
    },

    compare_rooms_on_metric({ rooms = null, table, field, agg = 'avg', start = null, end = null }) {
      const targetRooms = Array.isArray(rooms) && rooms.length ? rooms : listRooms();
      const out = [];
      for (const r of targetRooms) {
        const t = loadRoomTables(r);
        const tab = resolveTable(r, table);
        const arr = (t[tab] || []).filter(row => withinRange(row.ts, start, end));
        const vals = arr.map(row => Number(row[field])).filter(Number.isFinite);
        if (!vals.length) { out.push({ room: r, value: null }); continue; }
        const sum = vals.reduce((a,b)=>a+b,0);
        const avg = sum / vals.length;
        const peak = Math.max(...vals);
        const map = { sum, avg, peak };
        out.push({ room: r, value: map[agg] != null ? map[agg] : avg });
      }
      out.sort((a,b)=> (b.value ?? -Infinity) - (a.value ?? -Infinity));
      return out;
    },

    compare_metrics_in_room({ room, table, fields = [], agg = 'avg', start = null, end = null }) {
      const t = loadRoomTables(room);
      const tab = resolveTable(room, table);
      const arr = (t[tab] || []).filter(row => withinRange(row.ts, start, end));
      const out = [];
      for (const f of fields) {
        const vals = arr.map(r => Number(r[f])).filter(Number.isFinite);
        if (!vals.length) { out.push({ field: f, value: null }); continue; }
        const sum = vals.reduce((a,b)=>a+b,0);
        const avg = sum / vals.length;
        const peak = Math.max(...vals);
        const map = { sum, avg, peak };
        out.push({ field: f, value: map[agg] != null ? map[agg] : avg });
      }
      out.sort((a,b)=> (b.value ?? -Infinity) - (a.value ?? -Infinity));
      return out;
    },

    common_metrics_in_scope({ rooms = null }) {
      const rs = Array.isArray(rooms) && rooms.length ? rooms : listRooms();
      let common = null;
      for (const r of rs) {
        const t = loadRoomTables(r);
        const set = new Set();
        for (const [name, rows] of Object.entries(t)) {
          const first = rows?.[0] || {};
          for (const k of Object.keys(first)) if (k !== 'ts') set.add(k);
        }
        if (common == null) common = set; else common = new Set([...common].filter(x => set.has(x)));
      }
      return Array.from(common || []);
    },

    correlation_matrix({ room, table, fields = [], start = null, end = null, time_window_ms = 30 * 60 * 1000 }) {
      const t = loadRoomTables(room);
      const tab = resolveTable(room, table);
      const arr = (t[tab] || []).filter(r => withinRange(r.ts, start, end));
      // Build per-field time aligned vectors by ts
      const byTs = new Map();
      for (const r of arr) {
        const o = byTs.get(r.ts) || {}; byTs.set(r.ts, o);
        for (const f of fields) { if (r[f] != null) o[f] = Number(r[f]); }
      }
      const xs = Array.from(byTs.values());
      const n = fields.length;
      const matrix = Array.from({ length: n }, () => Array(n).fill(null));
      function corr(a, b) {
        let sx=0, sy=0, sxx=0, syy=0, sxy=0, k=0;
        for (const row of xs) {
          const x = row[a]; const y = row[b];
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
          sx += x; sy += y; sxx += x*x; syy += y*y; sxy += x*y; k++;
        }
        if (k < 3) return null;
        const cov = (sxy - (sx*sy)/k) / k;
        const vx = (sxx - (sx*sx)/k) / k; const vy = (syy - (sy*sy)/k) / k;
        const denom = Math.sqrt(vx*vy);
        return denom>0 ? cov/denom : null;
      }
      for (let i=0;i<n;i++) for (let j=i;j<n;j++) {
        const c = i===j ? 1 : corr(fields[i], fields[j]);
        matrix[i][j] = c; matrix[j][i] = c;
      }
      return { fields, matrix };
    },

    compare_field_across_rooms({ table, field, agg = 'avg', start = null, end = null }) {
      const perRoom = {};
      for (const r of listRooms()) {
        const t = loadRoomTables(r);
        const tab = resolveTable(r, table);
        const arr = (t[tab] || []).filter(row => withinRange(row.ts, start, end));
        const vals = arr.map(row => Number(row[field])).filter(Number.isFinite);
        if (!vals.length) { perRoom[r] = null; continue; }
        const sum = vals.reduce((a,b)=>a+b,0);
        const avg = sum / vals.length;
        const peak = Math.max(...vals);
        const map = { sum, avg, peak };
        perRoom[r] = map[agg] != null ? map[agg] : avg;
      }
      return perRoom;
    },
    
    weather_fetch({ fields = [], start = null, end = null, limit = 2000, building = null }) {
      const arr = (typeof loadWeather === 'function') ? loadWeather(building || null) : [];
      const out = [];
      for (const r of arr) {
        if (!withinRange(r.ts, start, end)) continue;
        const o = { ts: r.ts };
        for (const f of fields) if (f in r) o[f] = r[f];
        out.push(o);
        if (out.length >= limit) break;
      }
      return out;
    },

    // Graph adapters (Neo4j) — return synchronous placeholders if adapter is async in this context
    graph_rooms_by_tenant({ tenant }) {
      try {
        if (!graph || !graph.roomsByTenant) return { rooms: [], error: 'graph_not_configured' };
        const res = graph.roomsByTenant(tenant);
        return res && typeof res.then === 'function' ? { rooms: [], pending: true } : res;
      } catch (e) { return { rooms: [], error: String(e) }; }
    },

    graph_devices_by_scope({ tenant = null, building = null, floor = null, zone = null, type = null }) {
      try {
        if (!graph || !graph.devicesByScope) return { devices: [], error: 'graph_not_configured' };
        const args = { tenant, building, floor, zone, type };
        const res = graph.devicesByScope(args);
        return res && typeof res.then === 'function' ? { devices: [], pending: true } : res;
      } catch (e) { return { devices: [], error: String(e) }; }
    },

    graph_rooms_by_scope({ building = null, floor = null, tenant = null }) {
      // Prefer graph snapshot or adapter; otherwise infer from room IDs locally
      try {
        const snap = loadGraphSnapshot();
        if (snap && Array.isArray(snap.nodes) && Array.isArray(snap.links)) {
          const buildingNames = building ? [building, `Building ${building}`] : [];
          const floors = new Map();
          const nodesById = new Map(snap.nodes.map(n => [n.id, n]));
          const hasRel = (from, to, rel) => snap.links.some(l => l.source===from && l.target===to && (!rel || l.rel===rel));
          const rooms = [];
          // Iterate zones and backtrack to floor/building
          for (const n of snap.nodes) {
            if ((n.nodeType||n.label) !== 'Zone') continue;
            const zid = n.id;
            // find floor
            const floorLink = snap.links.find(l => l.source===zid && l.rel==='BELONGS_TO_FLOOR');
            const fid = floorLink ? floorLink.target : null;
            const fNode = fid ? nodesById.get(fid) : null;
            // find building
            let bNode = null;
            if (fid) {
              const bLink = snap.links.find(l => l.source===fid && l.rel==='BELONGS_TO_BUILDING');
              const bid = bLink ? bLink.target : null;
              bNode = bid ? nodesById.get(bid) : null;
            }
            // tenant filter: building must belong to tenant if provided
            if (tenant && bNode) {
              const tLink = snap.links.find(l => l.source===bNode.id && l.rel==='BELONGS_TO_TENANT');
              if (!tLink) continue;
              const tNode = nodesById.get(tLink.target);
              if (!tNode || (tNode.name !== tenant)) continue;
            }
            const bOk = building ? (bNode && buildingNames.includes(bNode.name)) : true;
            const fOk = floor ? (fNode && (fNode.name === floor || fNode.name.endsWith(` ${String(floor).replace(/^F/, '')}`))) : true;
            if (bOk && fOk) {
              if (n.roomId) rooms.push(n.roomId);
            }
          }
          return { rooms: Array.from(new Set(rooms)) };
        }
      } catch {}
      const rooms = listRooms();
      function normBuilding(b) { if (!b) return null; const m = String(b).match(/([A-Za-z])$/); return m ? m[1].toUpperCase() : String(b).toUpperCase(); }
      function normFloor(f) { if (!f) return null; const m = String(f).match(/(\d+)/); return m ? `F${m[1]}` : String(f); }
      const b = normBuilding(building);
      const f = normFloor(floor);
      const out = rooms.filter(r => {
        const m = String(r).match(/^([A-Za-z])_(F\d+)_.+$/);
        if (!m) return false;
        const rb = m[1].toUpperCase();
        const rf = m[2];
        if (b && rb !== b) return false;
        if (f && rf !== f) return false;
        return true;
      });
      return { rooms: out };
    },

    scope_list_buildings() {
      const snap = loadGraphSnapshot();
      if (snap && Array.isArray(snap.nodes)) {
        const bs = snap.nodes.filter(n => (n.nodeType||n.label)==='Building').map(n => n.name).filter(Boolean);
        return Array.from(new Set(bs)).sort();
      }
      const rooms = listRooms();
      const set = new Set();
      for (const r of rooms) { const m = String(r).match(/^([A-Za-z])_/); if (m) set.add(`Building ${m[1].toUpperCase()}`); }
      return Array.from(set).sort();
    },

    scope_list_floors({ building }) {
      const snap = loadGraphSnapshot();
      if (snap && Array.isArray(snap.nodes) && Array.isArray(snap.links)) {
        const targets = building ? [building, `Building ${building}`] : [];
        const floorNames = new Set();
        for (const n of snap.nodes) {
          if ((n.nodeType||n.label) !== 'Floor') continue;
          const fid = n.id;
          const bLink = snap.links.find(l => l.source===fid && l.rel==='BELONGS_TO_BUILDING');
          const bid = bLink ? bLink.target : null;
          const bNode = bid ? snap.nodes.find(nn => nn.id===bid) : null;
          if (building && (!bNode || !targets.includes(bNode.name))) continue;
          floorNames.add(n.name);
        }
        return Array.from(floorNames).sort((a,b)=> Number(a.replace(/\D+/g,'')) - Number(b.replace(/\D+/g,'')));
      }
      // Fallback to inference
      const rooms = listRooms();
      const set = new Set();
      const b = (String(building||'').match(/([A-Za-z])$/) || [,''])[1].toUpperCase();
      for (const r of rooms) { const m = String(r).match(/^([A-Za-z])_(F\d+)_/); if (m && (!b || m[1].toUpperCase()===b)) set.add(`Floor ${m[2].slice(1)}`); }
      return Array.from(set).sort((a,b)=> Number(a.split(' ').at(-1)) - Number(b.split(' ').at(-1)));
    },

    scope_list_rooms({ building = null, floor = null }) {
      return (this.graph_rooms_by_scope({ building, floor })?.rooms) || [];
    },

    scope_list_detectors({ room }) {
      const t = loadRoomTables(room);
      const detectors = [];
      if (t.iaq && t.iaq.length) detectors.push('IAQ_Sensor');
      if (t.energy && t.energy.length) detectors.push('Energy_Meter');
      if (t.people && t.people.length) detectors.push('People_Counter');
      if (t.water && t.water.length) detectors.push('Water_Meter');
      return detectors;
    },

    graph_zone_devices({ room }) {
      const snap = loadGraphSnapshot();
      if (!snap || !Array.isArray(snap.nodes) || !Array.isArray(snap.links)) return { devices: [] };
      const nodesById = new Map(snap.nodes.map(n => [n.id, n]));
      // Find zone node by roomId
      const z = snap.nodes.find(n => (n.nodeType||n.label)==='Zone' && n.roomId === room);
      if (!z) return { devices: [] };
      const devs = [];
      for (const l of snap.links) {
        if (l.target === z.id && l.rel === 'LOCATED_IN_ZONE') {
          const d = nodesById.get(l.source);
          if (d && (d.nodeType||d.label)==='Device') devs.push({ id: d.id, name: d.name, type: d.deviceType || d.type || 'Device' });
        }
      }
      // Attach metric types measured
      const withMetrics = devs.map(d => {
        const mids = snap.links.filter(l => l.target===d.id && l.rel==='MEASURES').map(l => l.source);
        const metrics = mids.map(mid => (nodesById.get(mid)?.name)).filter(Boolean);
        return { ...d, metrics };
      });
      return { devices: withMetrics };
    },

    knowledge_search({ query, k = 6 }) {
      try {
        const hits = rag.search(String(query||''), Math.max(1, Math.min(24, k||6))) || [];
        return hits.map(h => ({ id: h.id, score: h.score, meta: h.meta, text: h.text.slice(0, 1500) }));
      } catch (e) { return { error: String(e), hits: [] }; }
    },

    scope_csv_rooms({ building = null, floor = null, zone = null, tenant = null }) {
      // Heuristic mapping: use graph snapshot and CSVex rooms list
      const snap = loadGraphSnapshot();
      if (!snap || !Array.isArray(snap.nodes) || !Array.isArray(snap.links)) return { rooms: [] };
      const rooms = new Set(listRooms());
      const nodes = snap.nodes;
      const links = snap.links;
      const byId = new Map(nodes.map(n => [n.id, n]));
      const zones = nodes.filter(n => (n.nodeType||n.label)==='Zone');
      function slugify(s) { return String(s||'').trim().toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,''); }
      const out = new Set();
      for (const z of zones) {
        // Optional tenant filter via Building -> Tenant in snapshot (if present)
        let floorNode = null, buildingNode = null;
        const lf = links.find(l => l.source===z.id && l.rel==='BELONGS_TO_FLOOR');
        if (lf) floorNode = byId.get(lf.target);
        if (floorNode) {
          const lb = links.find(l => l.source===floorNode.id && l.rel==='BELONGS_TO_BUILDING');
          if (lb) buildingNode = byId.get(lb.target);
        } else {
          const lb2 = links.find(l => l.source===z.id && (l.rel==='BELONGS_TO_BUILDING' || l.rel==='IN_BUILDING'));
          if (lb2) buildingNode = byId.get(lb2.target);
        }
        if (tenant) {
          const tb = buildingNode ? links.find(l => l.source===buildingNode.id && l.rel==='BELONGS_TO_TENANT') : null;
          const tNode = tb ? byId.get(tb.target) : null;
          if (tNode && tNode.name !== tenant) continue;
        }
        const bName = buildingNode?.name || null;
        const fName = floorNode?.name || null;
        const zName = z.name;
        if (building && bName !== building) continue;
        if (floor && fName !== floor) continue;
        if (zone && zName !== zone) continue;
        const cands = [];
        if (z.roomId) cands.push(String(z.roomId));
        // Derive F-code from floor name
        let fIdx = (String(fName||'').match(/(\d+)/) || [,''])[1];
        const fl = String(fName||'').toLowerCase();
        if (!fIdx) {
          if (/ground/.test(fl)) fIdx = '0'; else if (/first/.test(fl)) fIdx = '1'; else if (/second/.test(fl)) fIdx = '2'; else if (/third/.test(fl)) fIdx = '3';
        }
        const bInit = (String(bName||'').match(/\b([A-Za-z])[A-Za-z]*$/) || [,''])[1]?.toUpperCase();
        const fCode = fIdx ? `F${fIdx}` : null;
        const zSlug = slugify(zName);
        if (bInit && fCode) cands.push(`${bInit}_${fCode}_${zSlug}`);
        cands.push(zSlug);
        const best = cands.find(c => rooms.has(c));
        if (best) out.add(best);
      }
      return { rooms: Array.from(out) };
    },

    // Vector search — fallback stub (the system already has TF‑IDF rag)
    vector_search_docs({ query, k = 6 }) {
      try {
        if (!vector || !vector.searchDocs) return { hits: [], error: 'vector_not_configured' };
        const res = vector.searchDocs({ query, k });
        return res && typeof res.then === 'function' ? { hits: [], pending: true } : (res || { hits: [] });
      } catch (e) { return { hits: [], error: String(e) }; }
    },

    compare_series_cross_room({ series = [], start = null, end = null }) {
      const out = {};
      if (!Array.isArray(series)) return out;
      for (const s of series) {
        if (!s || !s.room || !s.table || !s.field) continue;
        const t = loadRoomTables(String(s.room));
        const arr = (t[String(s.table)] || []).filter(r => withinRange(r.ts, start, end));
        const name = s.name || `${s.room} ${s.field}`;
        const points = [];
        for (const r of arr) {
          const y = Number(r[s.field]);
          if (!Number.isFinite(y)) continue;
          points.push({ ts: r.ts, y });
        }
        out[name] = points;
      }
      return out;
    },

    latest_value({ room, table, field, start = null, end = null }) {
      const t = loadRoomTables(room);
      const tab = resolveTable(room, table);
      const arr = (t[tab] || []).filter(r => withinRange(r.ts, start, end));
      for (let i = arr.length - 1; i >= 0; i--) {
        const v = arr[i][field];
        if (v != null && Number.isFinite(Number(v))) return { ts: arr[i].ts, value: Number(v) };
      }
      return null;
    },
    latest_per_room({ table, field, start = null, end = null }) {
      const out = [];
      for (const r of listRooms()) {
        const t = loadRoomTables(r);
        const tab = resolveTable(r, table);
        const arr = (t[tab] || []).filter(x => withinRange(x.ts, start, end));
        let val = null, ts = null;
        for (let i = arr.length - 1; i >= 0; i--) {
          const v = arr[i][field];
          if (v != null && Number.isFinite(Number(v))) { val = Number(v); ts = arr[i].ts; break; }
        }
        out.push({ room: r, ts, value: val });
      }
      return out;
    },

    compare_series_cross_room({ series = [], start = null, end = null }) {
      const out = {};
      if (!Array.isArray(series)) return out;
      for (const s of series) {
        if (!s || !s.room || !s.table || !s.field) continue;
        const t = loadRoomTables(String(s.room));
        const arr = (t[String(s.table)] || []).filter(r => withinRange(r.ts, start, end));
        const name = s.name || `${s.room} ${s.field}`;
        const points = [];
        for (const r of arr) {
          const y = Number(r[s.field]);
          if (!Number.isFinite(y)) continue;
          points.push({ ts: r.ts, y });
        }
        out[name] = points;
      }
      return out;
    },
    current_occupied_rooms({ threshold = 0 }) {
      const rooms = listRooms();
      const out = [];
      for (const r of rooms) {
        const t = loadRoomTables(r);
        const arr = t.people || t.people_count || t.occupancy || [];
        let latest = null;
        for (let i = arr.length - 1; i >= 0; i--) { if (Number.isFinite(Number(arr[i].people_count))) { latest = Number(arr[i].people_count); break; } }
        if (latest != null && latest > threshold) out.push({ room: r, people: latest });
      }
      return out;
    },

    compare_series_cross_room({ series = [], start = null, end = null }) {
      const out = {};
      if (!Array.isArray(series)) return out;
      for (const s of series) {
        if (!s || !s.room || !s.table || !s.field) continue;
        const t = loadRoomTables(String(s.room));
        const arr = (t[String(s.table)] || []).filter(r => withinRange(r.ts, start, end));
        const name = s.name || `${s.room} ${s.field}`;
        const points = [];
        for (const r of arr) {
          const y = Number(r[s.field]);
          if (!Number.isFinite(y)) continue;
          points.push({ ts: r.ts, y });
        }
        out[name] = points;
      }
      return out;
    },
    occupancy_current_total() {
      let total = 0;
      for (const r of listRooms()) {
        const t = loadRoomTables(r);
        const arr = t.people || t.people_count || t.occupancy || [];
        for (let i = arr.length - 1; i >= 0; i--) { const v = Number(arr[i].people_count); if (Number.isFinite(v)) { total += v; break; } }
      }
      return { total };
    },
    rooms_unused_since({ duration_ms }) {
      const now = Date.now();
      const out = [];
      for (const r of listRooms()) {
        const t = loadRoomTables(r);
        const arr = t.people || t.people_count || t.occupancy || [];
        let used = false;
        for (let i = arr.length - 1; i >= 0; i--) {
          const row = arr[i];
          if (now - row.ts > duration_ms) break;
          if (Number(row.people_count) > 0) { used = true; break; }
        }
        if (!used) out.push(r);
      }
      return out;
    },

    compare_series_cross_room({ series = [], start = null, end = null }) {
      const out = {};
      if (!Array.isArray(series)) return out;
      for (const s of series) {
        if (!s || !s.room || !s.table || !s.field) continue;
        const t = loadRoomTables(String(s.room));
        const arr = (t[String(s.table)] || []).filter(r => withinRange(r.ts, start, end));
        const name = s.name || `${s.room} ${s.field}`;
        const points = [];
        for (const r of arr) {
          const y = Number(r[s.field]);
          if (!Number.isFinite(y)) continue;
          points.push({ ts: r.ts, y });
        }
        out[name] = points;
      }
      return out;
    },
    busiest_day_of_week({ room, table, field, start = null, end = null, agg = 'avg' }) {
      const t = loadRoomTables(room);
      const tab = resolveTable(room, table);
      const arr = (t[tab] || []).filter(r => withinRange(r.ts, start, end));
      const buckets = Array.from({ length: 7 }, () => ({ sum: 0, n: 0 }));
      for (const r of arr) { const v = Number(r[field]); if (!Number.isFinite(v)) continue; const d = new Date(r.ts).getDay(); buckets[d].sum += v; buckets[d].n += 1; }
      const stats = buckets.map((b,i)=>({ day:i, avg: b.n? b.sum/b.n : 0, sum: b.sum, n:b.n }));
      const key = agg==='sum'?'sum':'avg';
      const best = stats.reduce((a,b)=> b[key]>(a?.[key]??-Infinity)?b:a, null);
      return { best, stats };
    },
    weekday_weekend_comparison({ room, table, field, start = null, end = null }) {
      const t = loadRoomTables(room);
      const tab = resolveTable(room, table);
      const arr = (t[tab] || []).filter(r => withinRange(r.ts, start, end));
      let wSum=0,wN=0, weSum=0,weN=0;
      for (const r of arr) { const v=Number(r[field]); if(!Number.isFinite(v)) continue; const d=new Date(r.ts).getDay(); if(d===0||d===6){ weSum+=v; weN++; } else { wSum+=v; wN++; } }
      return { weekday_avg: wN? wSum/wN: null, weekend_avg: weN? weSum/weN: null, weekday_n:wN, weekend_n:weN };
    },
    energy_delta_kwh({ room, start = null, end = null }) {
      const t = loadRoomTables(room);
      const arr = (t.energy || t.energy_clamp || []).filter(r => withinRange(r.ts, start, end));
      const vals = arr.map(r => Number(r.total_kwh)).filter(Number.isFinite).sort((a,b)=>a-b);
      const delta = vals.length>=2 ? vals[vals.length-1]-vals[0] : null;
      return { delta_kwh: delta, points: vals.length };
    },
    energy_high_when_empty({ room, energy_table = 'energy', occupancy_table = 'people', energy_threshold = 0, start = null, end = null }) {
      const t = loadRoomTables(room);
      const e = (t[energy_table] || []).filter(r => withinRange(r.ts, start, end));
      const p = (t[occupancy_table] || t.people || []).filter(r => withinRange(r.ts, start, end));
      const out = [];
      let j=0;
      for (const r of e) {
        const val = Number(r.value);
        if (!Number.isFinite(val) || val <= energy_threshold) continue;
        while (j+1 < p.length && Math.abs(p[j+1].ts - r.ts) <= Math.abs(p[j].ts - r.ts)) j++;
        const occ = Number(p[j]?.people_count);
        if (Number.isFinite(occ) && occ === 0) out.push({ ts: r.ts, energy: val, people: occ });
      }
      return out;
    },

    compare_series_cross_room({ series = [], start = null, end = null }) {
      const out = {};
      if (!Array.isArray(series)) return out;
      for (const s of series) {
        if (!s || !s.room || !s.table || !s.field) continue;
        const t = loadRoomTables(String(s.room));
        const arr = (t[String(s.table)] || []).filter(r => withinRange(r.ts, start, end));
        const name = s.name || `${s.room} ${s.field}`;
        const points = [];
        for (const r of arr) {
          const y = Number(r[s.field]);
          if (!Number.isFinite(y)) continue;
          points.push({ ts: r.ts, y });
        }
        out[name] = points;
      }
      return out;
    },
    detect_spikes({ room, table, field, z = 3, start = null, end = null }) {
      const t = loadRoomTables(room);
      const tab = resolveTable(room, table);
      const arr = (t[tab] || []).filter(r => withinRange(r.ts, start, end)).map(r => Number(r[field])).filter(Number.isFinite);
      if (arr.length < 5) return [];
      const mean = arr.reduce((a,b)=>a+b,0)/arr.length;
      const sd = Math.sqrt(arr.reduce((a,b)=>a+(b-mean)*(b-mean),0)/arr.length) || 1;
      const rows = (t[tab] || []).filter(r => withinRange(r.ts, start, end));
      const out = [];
      for (const r of rows) { const v=Number(r[field]); if(!Number.isFinite(v)) continue; const zz=(v-mean)/sd; if (Math.abs(zz) >= z) out.push({ ts:r.ts, value:v, z:zz }); }
      return out;
    },

    compare_series_cross_room({ series = [], start = null, end = null }) {
      const out = {};
      if (!Array.isArray(series)) return out;
      for (const s of series) {
        if (!s || !s.room || !s.table || !s.field) continue;
        const t = loadRoomTables(String(s.room));
        const arr = (t[String(s.table)] || []).filter(r => withinRange(r.ts, start, end));
        const name = s.name || `${s.room} ${s.field}`;
        const points = [];
        for (const r of arr) {
          const y = Number(r[s.field]);
          if (!Number.isFinite(y)) continue;
          points.push({ ts: r.ts, y });
        }
        out[name] = points;
      }
      return out;
    },
    histogram({ room, table, field, bins = 10, start = null, end = null }) {
      const t = loadRoomTables(room);
      const tab = resolveTable(room, table);
      const vals = (t[tab] || []).filter(r => withinRange(r.ts, start, end)).map(r => Number(r[field])).filter(Number.isFinite);
      if (!vals.length) return [];
      const min = Math.min(...vals), max = Math.max(...vals);
      const width = (max - min) || 1;
      const step = width / bins;
      const out = Array.from({ length: bins }, (_,i)=>({ binStart: min + i*step, binEnd: min + (i+1)*step, count: 0 }));
      for (const v of vals) {
        let idx = Math.floor((v - min) / step);
        if (idx >= bins) idx = bins - 1;
        if (idx < 0) idx = 0;
        out[idx].count += 1;
      }
      return out;
    },

    compare_series_cross_room({ series = [], start = null, end = null }) {
      const out = {};
      if (!Array.isArray(series)) return out;
      for (const s of series) {
        if (!s || !s.room || !s.table || !s.field) continue;
        const t = loadRoomTables(String(s.room));
        const arr = (t[String(s.table)] || []).filter(r => withinRange(r.ts, start, end));
        const name = s.name || `${s.room} ${s.field}`;
        const points = [];
        for (const r of arr) {
          const y = Number(r[s.field]);
          if (!Number.isFinite(y)) continue;
          points.push({ ts: r.ts, y });
        }
        out[name] = points;
      }
      return out;
    },
    data_gaps({ room, table, field, max_gap_ms, start = null, end = null }) {
      const t = loadRoomTables(room);
      const arr = (t[table] || []).filter(r => withinRange(r.ts, start, end)).filter(r => Number.isFinite(Number(r[field])));
      const out = [];
      for (let i=1;i<arr.length;i++) { const gap = arr[i].ts - arr[i-1].ts; if (gap > max_gap_ms) out.push({ from: arr[i-1].ts, to: arr[i].ts, gap }); }
      return out;
    },

    compare_series_cross_room({ series = [], start = null, end = null }) {
      const out = {};
      if (!Array.isArray(series)) return out;
      for (const s of series) {
        if (!s || !s.room || !s.table || !s.field) continue;
        const t = loadRoomTables(String(s.room));
        const arr = (t[String(s.table)] || []).filter(r => withinRange(r.ts, start, end));
        const name = s.name || `${s.room} ${s.field}`;
        const points = [];
        for (const r of arr) {
          const y = Number(r[s.field]);
          if (!Number.isFinite(y)) continue;
          points.push({ ts: r.ts, y });
        }
        out[name] = points;
      }
      return out;
    },
    distinct_values({ room, table, field, limit = 50 }) {
      const t = loadRoomTables(room);
      const tab = resolveTable(room, table);
      const set = new Set();
      for (const r of (t[tab]||[])) { const v=r[field]; if (v!=null) { set.add(String(v)); if (set.size>=limit) break; } }
      return Array.from(set);
    }
,

    fetch_table_meta({ room, table }) {
      const t = loadRoomTables(room);
      const tab = resolveTable(room, table);
      const arr = t[tab] || [];
      const n = arr.length;
      const fields = Object.keys(arr[0] || {});
      const tsMin = n ? arr[0].ts : null;
      const tsMax = n ? arr[n - 1].ts : null;
      return { count: n, fields, tsMin, tsMax, table: tab };
    },
    
    dump_room({ room, start = null, end = null, max_rows_per_table = null }) {
      const t = loadRoomTables(room);
      const out = {};
      for (const [name, rows] of Object.entries(t)) {
        const sel = [];
        for (const r of rows) {
          if (!withinRange(r.ts, start, end)) continue;
          sel.push(r);
          if (max_rows_per_table && sel.length >= max_rows_per_table) break;
        }
        out[name] = sel;
      }
      return out;
    },

    compare_series_cross_room({ series = [], start = null, end = null }) {
      const out = {};
      if (!Array.isArray(series)) return out;
      for (const s of series) {
        if (!s || !s.room || !s.table || !s.field) continue;
        const t = loadRoomTables(String(s.room));
        const arr = (t[String(s.table)] || []).filter(r => withinRange(r.ts, start, end));
        const name = s.name || `${s.room} ${s.field}`;
        const points = [];
        for (const r of arr) {
          const y = Number(r[s.field]);
          if (!Number.isFinite(y)) continue;
          points.push({ ts: r.ts, y });
        }
        out[name] = points;
      }
      return out;
    },
    
    hour_of_day_stats({ room, table, field, start = null, end = null }) {
      const t = loadRoomTables(room);
      const tab = resolveTable(room, table);
      const arr = t[tab] || [];
      const bins = Array.from({ length: 24 }, () => ({ 
        count: 0, 
        sum: 0, 
        min: Infinity, 
        max: -Infinity 
      }));
      for (const r of arr) {
        if (!withinRange(r.ts, start, end)) continue;
        const v = Number(r[field]);
        if (!Number.isFinite(v)) continue;
        const h = new Date(r.ts).getHours();
        const b = bins[h];
        b.count += 1; 
        b.sum += v; 
        if (v < b.min) b.min = v; 
        if (v > b.max) b.max = v;
      }
      return bins.map((b, h) => ({ 
        hour: h, 
        count: b.count, 
        avg: b.count ? b.sum / b.count : null, 
        min: isFinite(b.min) ? b.min : null, 
        max: isFinite(b.max) ? b.max : null 
      }));
    },
    
    hourly_timeseries({ room, table, field, start = null, end = null }) {
      const t = loadRoomTables(room);
      const tab = resolveTable(room, table);
      const arr = t[tab] || [];
      const fld = resolveField(arr, field);
      const buckets = new Map();
      for (const r of arr) {
        if (!withinRange(r.ts, start, end)) continue;
        const v = Number(r[fld]); 
        if (!Number.isFinite(v)) continue;
        const key = floorHour(r.ts);
        const b = buckets.get(key) || { sum: 0, n: 0 };
        b.sum += v; 
        b.n += 1; 
        buckets.set(key, b);
      }
      return Array.from(buckets.entries())
        .sort((a,b) => a[0]-b[0])
        .map(([ts, b]) => ({ ts, avg: b.n ? b.sum / b.n : null }));
    },
    
    forecast_hourly_naive({ room, table, field, start = null, end = null, horizon_hours = 168 }) {
      const hourly = getHourlySeries(room, table, field, start, end);
      if (!hourly.length) return { historical: [], forecast: [] };
      const last = hourly[hourly.length - 1];
      const step = hourly.length >= 2 ? (hourly[hourly.length-1].ts - hourly[hourly.length-2].ts) : 3600*1000;
      const predictions = naiveForecast(last.ts, last.avg, step, horizon_hours);
      return { historical: hourly, forecast: predictions };
    },
    
    forecast_hourly_linear({ room, table, field, start = null, end = null, horizon_hours = 168 }) {
      const hourly = getHourlySeries(room, table, field, start, end);
      if (hourly.length < 2) return { historical: hourly, forecast: [] };
      const predictions = lrForecast(hourly, horizon_hours);
      return { historical: hourly, forecast: predictions };
    },
    
    forecast_from_profile({ room, table, field, start = null, end = null, days = 7 }) {
      const t = loadRoomTables(room);
      const tab = resolveTable(room, table);
      const arr = t[tab] || [];
      const fld = resolveField(arr, field);
      
      // Build hour-of-day profile
      const bins = Array.from({ length: 24 }, () => ({ sum: 0, n: 0 }));
      for (const r of arr) {
        if (!withinRange(r.ts, start, end)) continue;
        const v = Number(r[fld]);
        if (!Number.isFinite(v)) continue;
        const h = new Date(r.ts).getHours();
        bins[h].sum += v;
        bins[h].n += 1;
      }
      const profile = bins.map(b => b.n ? b.sum / b.n : null);
      
      // Get last timestamp and forecast forward
      const filtered = arr.filter(r => withinRange(r.ts, start, end));
      if (!filtered.length) return { historical: [], forecast: [], profile };
      
      const lastTs = filtered[filtered.length - 1].ts;
      const hourly = getHourlySeries(room, table, field, start, end);
      
      const predictions = [];
      const hoursToForecast = days * 24;
      for (let i = 1; i <= hoursToForecast; i++) {
        const ts = lastTs + i * 3600 * 1000;
        const h = new Date(ts).getHours();
        const forecast = profile[h];
        if (forecast != null) {
          predictions.push({ ts, forecast });
        }
      }
      
      return { historical: hourly, forecast: predictions, profile };
    },
    
    forecast_exponential_smoothing({ room, table, field, start = null, end = null, alpha = 0.5, horizon_hours = 168 }) {
      const hourly = getHourlySeries(room, table, field, start, end);
      if (!hourly.length) return { historical: [], forecast: [] };
      // Exponential smoothing
      let last = hourly[0]?.avg ?? 0;
      const smoothed = [];
      for (const p of hourly) {
        last = alpha * p.avg + (1 - alpha) * last;
        smoothed.push({ ts: p.ts, avg: last });
      }
      // Forecast: extend last smoothed value
      const step = hourly.length >= 2 ? (hourly[hourly.length-1].ts - hourly[hourly.length-2].ts) : 3600*1000;
      const lastTs = hourly[hourly.length - 1].ts;
      const predictions = [];
      for (let i = 1; i <= horizon_hours; i++) {
        predictions.push({ ts: lastTs + i * step, forecast: last });
      }
      return { historical: smoothed, forecast: predictions };
    },
    
    forecast_moving_average({ room, table, field, start = null, end = null, window = 5, horizon_hours = 168 }) {
      const hourly = getHourlySeries(room, table, field, start, end);
      if (!hourly.length) return { historical: [], forecast: [] };
      const ma = [];
      for (let i = 0; i < hourly.length; i++) {
        const slice = hourly.slice(Math.max(0, i - window + 1), i + 1);
        const avg = slice.reduce((s, p) => s + (p.avg || 0), 0) / slice.length;
        ma.push({ ts: hourly[i].ts, avg });
      }
      // Forecast: extend last MA value
      const step = hourly.length >= 2 ? (hourly[hourly.length-1].ts - hourly[hourly.length-2].ts) : 3600*1000;
      const lastTs = hourly[hourly.length - 1].ts;
      const lastAvg = ma[ma.length - 1]?.avg ?? 0;
      const predictions = [];
      for (let i = 1; i <= horizon_hours; i++) {
        predictions.push({ ts: lastTs + i * step, forecast: lastAvg });
      }
      return { historical: ma, forecast: predictions };
    },
    
    forecast_seasonal_hourly({ room, table, field, start = null, end = null, horizon_hours = 168 }) {
      const hourly = getHourlySeries(room, table, field, start, end);
      if (!hourly.length) return { historical: [], forecast: [] };
      // Use previous week for each hour
      const step = hourly.length >= 2 ? (hourly[hourly.length-1].ts - hourly[hourly.length-2].ts) : 3600*1000;
      const lastTs = hourly[hourly.length - 1].ts;
      const weekHours = 168;
      const predictions = [];
      for (let i = 1; i <= horizon_hours; i++) {
        const idx = Math.max(0, hourly.length - weekHours + (i % weekHours) - 1);
        const forecast = hourly[idx]?.avg ?? hourly[hourly.length - 1]?.avg ?? 0;
        predictions.push({ ts: lastTs + i * step, forecast });
      }
      return { historical: hourly, forecast: predictions };
    },
    
    forecast_polyfit({ room, table, field, start = null, end = null, degree = 2, horizon_hours = 168 }) {
      const hourly = getHourlySeries(room, table, field, start, end);
      if (hourly.length < degree + 1) return { historical: hourly, forecast: [] };
      // Fit polynomial (least squares)
      const xs = hourly.map(p => (p.ts - hourly[0].ts) / 3600e3); // hours since start
      const ys = hourly.map(p => p.avg);
      // Build Vandermonde matrix
      const X = xs.map(x => Array.from({length: degree+1}, (_, k) => Math.pow(x, k)));
      // Solve for coefficients using normal equations
      function transpose(A) { return A[0].map((_,i)=>A.map(r=>r[i])); }
      function multiply(A,B) {
        return A.map(row => transpose(B).map(col => row.reduce((s,v,i)=>s+v*col[i],0)));
      }
      function invert2x2(M) {
        const [[a,b],[c,d]] = M;
        const det = a*d-b*c;
        return det ? [[d/det,-b/det],[-c/det,a/det]] : null;
      }
      // Only support degree 2 for simplicity
      if (degree !== 2) return { historical: hourly, forecast: [] };
      const XT = transpose(X);
      const XT_X = multiply(XT, X);
      const XT_Y = XT.map(row => row.reduce((s,v,i)=>s+v*ys[i],0));
      // Solve (XT_X) * coeffs = XT_Y
      // For degree 2: XT_X is 3x3, XT_Y is 3
      // Use Cramer's rule for 3x3
      function solve3x3(A, b) {
        const m = A;
        const det = m[0][0]*m[1][1]*m[2][2] + m[0][1]*m[1][2]*m[2][0] + m[0][2]*m[1][0]*m[2][1]
                  - m[0][2]*m[1][1]*m[2][0] - m[0][1]*m[1][0]*m[2][2] - m[0][0]*m[1][2]*m[2][1];
        if (!det) return [0,0,0];
        function minor(i,j) {
          const rows = [0,1,2].filter(r=>r!==i);
          const cols = [0,1,2].filter(c=>c!==j);
          return m[rows[0]][cols[0]]*m[rows[1]][cols[1]] - m[rows[0]][cols[1]]*m[rows[1]][cols[0]];
        }
        const inv = [
          [ minor(0,0), -minor(0,1), minor(0,2) ],
          [ -minor(1,0), minor(1,1), -minor(1,2) ],
          [ minor(2,0), -minor(2,1), minor(2,2) ]
        ].map(row => row.map(v => v/det));
        return inv.map(row => row.reduce((s,v,i)=>s+v*b[i],0));
      }
      const coeffs = solve3x3(XT_X, XT_Y);
      // Forecast
      const step = hourly.length >= 2 ? (hourly[hourly.length-1].ts - hourly[hourly.length-2].ts) : 3600*1000;
      const lastTs = hourly[hourly.length - 1].ts;
      const predictions = [];
      for (let i = 1; i <= horizon_hours; i++) {
        const x = xs[xs.length-1] + i;
        const forecast = coeffs[0] + coeffs[1]*x + coeffs[2]*x*x;
        predictions.push({ ts: lastTs + i * step, forecast });
      }
      return { historical: hourly, forecast: predictions, coeffs };
    },

    pair_timeseries({ room, table1, field1, table2, field2, start = null, end = null, time_window_ms = 30 * 60 * 1000 }) {
      const t = loadRoomTables(room);
      const a = t[resolveTable(room, table1)] || [];
      const b = t[resolveTable(room, table2)] || [];

      // Filter to range
      const af = a.filter(r => withinRange(r.ts, start, end));
      const bf = b.filter(r => withinRange(r.ts, start, end));
      if (!af.length || !bf.length) return [];

      // For each point in A, find best match in B within window
      const out = [];
      let j = 0; // pointer for bf
      for (let i = 0; i < af.length; i++) {
        const ra = af[i];
        const xa = Number(ra[field1]);
        if (!Number.isFinite(xa)) continue;
        // advance j to near ra.ts
        while (j + 1 < bf.length && Math.abs(bf[j + 1].ts - ra.ts) <= Math.abs(bf[j].ts - ra.ts)) j++;
        // check local neighborhood around j for closest
        let best = null, bestDt = Infinity, bestIdx = j;
        for (let k = Math.max(0, j - 3); k <= Math.min(bf.length - 1, j + 3); k++) {
          const dt = Math.abs((bf[k].ts ?? 0) - ra.ts);
          if (dt < bestDt) { best = bf[k]; bestDt = dt; bestIdx = k; }
        }
        if (best && bestDt <= time_window_ms) {
          const yb = Number(best[field2]);
          if (Number.isFinite(yb)) {
            out.push({ x: xa, y: yb, ts1: ra.ts, ts2: best.ts, dt: bestDt });
          }
          j = bestIdx;
        }
      }
      return out;
    },

    compare_series_cross_room({ series = [], start = null, end = null }) {
      const out = {};
      if (!Array.isArray(series)) return out;
      for (const s of series) {
        if (!s || !s.room || !s.table || !s.field) continue;
        const t = loadRoomTables(String(s.room));
        const arr = (t[String(s.table)] || []).filter(r => withinRange(r.ts, start, end));
        const name = s.name || `${s.room} ${s.field}`;
        const points = [];
        for (const r of arr) {
          const y = Number(r[s.field]);
          if (!Number.isFinite(y)) continue;
          points.push({ ts: r.ts, y });
        }
        out[name] = points;
      }
      return out;
    },

    // New tool: get_field_stats - returns stats for all fields in a table
    get_field_stats({ room, table, start = null, end = null }) {
      const t = loadRoomTables(room);
      const arr = t[table] || [];
      const fields = Object.keys(arr[0] || {});
      const stats = {};
      for (const field of fields) {
        let count = 0, min = Infinity, max = -Infinity, sum = 0;
        for (const r of arr) {
          if (!withinRange(r.ts, start, end)) continue;
          const v = Number(r[field]);
          if (!Number.isFinite(v)) continue;
          count++; sum += v;
          if (v < min) min = v;
          if (v > max) max = v;
        }
        const avg = count ? sum / count : null;
        stats[field] = { count, min: isFinite(min) ? min : null, max: isFinite(max) ? max : null, avg, sum };
      }
      return logToolResult('get_field_stats', { room, table, start, end }, stats);
    },

    // New tool: get_latest_row - returns the latest row for a table
    get_latest_row({ room, table }) {
      const t = loadRoomTables(room);
      const arr = t[table] || [];
      if (!arr.length) return logToolResult('get_latest_row', { room, table }, null);
      const latest = arr[arr.length - 1];
      return logToolResult('get_latest_row', { room, table }, latest);
    },

    // New tool: get_time_range - returns the min/max timestamp for a table
    get_time_range({ room, table }) {
      const t = loadRoomTables(room);
      const arr = t[table] || [];
      if (!arr.length) return logToolResult('get_time_range', { room, table }, { tsMin: null, tsMax: null });
      return logToolResult('get_time_range', { room, table }, { tsMin: arr[0].ts, tsMax: arr[arr.length - 1].ts });
    },

    // New tool: field_histogram - returns histogram for a field
    field_histogram({ room, table, field, bins = 10, start = null, end = null }) {
      const t = loadRoomTables(room);
      const arr = t[table] || [];
      const values = arr.filter(r => withinRange(r.ts, start, end)).map(r => Number(r[field])).filter(Number.isFinite);
      if (!values.length) return logToolResult('field_histogram', { room, table, field, bins, start, end }, []);
      const min = Math.min(...values);
      const max = Math.max(...values);
      const binSize = (max - min) / bins;
      const histogram = Array.from({ length: bins }, (_, i) => ({
        binStart: min + i * binSize,
        binEnd: min + (i + 1) * binSize,
        count: 0
      }));
      for (const v of values) {
        let idx = Math.floor((v - min) / binSize);
        if (idx >= bins) idx = bins - 1;
        if (idx < 0) idx = 0;
        histogram[idx].count++;
      }
      return logToolResult('field_histogram', { room, table, field, bins, start, end }, histogram);
    },

    // New tool: get_missing_data - returns timestamps where a field is missing
    get_missing_data({ room, table, field, start = null, end = null }) {
      const t = loadRoomTables(room);
      const arr = t[table] || [];
      const missing = arr.filter(r => withinRange(r.ts, start, end) && (r[field] == null || r[field] === '')).map(r => r.ts);
      return logToolResult('get_missing_data', { room, table, field, start, end }, missing);
    },

    // New tool: get_distinct_values - returns distinct values for a field
    get_distinct_values({ room, table, field, start = null, end = null }) {
      const t = loadRoomTables(room);
      const arr = t[table] || [];
      const values = new Set();
      for (const r of arr) {
        if (!withinRange(r.ts, start, end)) continue;
        if (r[field] != null) values.add(r[field]);
      }
      return logToolResult('get_distinct_values', { room, table, field, start, end }, Array.from(values));
    },

    // New tool: get_rows_by_value - returns rows where field matches value
    get_rows_by_value({ room, table, field, value, start = null, end = null, limit = 100 }) {
      const t = loadRoomTables(room);
      const arr = t[table] || [];
      const rows = arr.filter(r => withinRange(r.ts, start, end) && r[field] === value);
      return logToolResult('get_rows_by_value', { room, table, field, value, start, end, limit }, rows.slice(0, limit));
    },

    // New tool: correlate_timeseries_aligned
    // Returns paired data for two fields from two tables, aligned by hour (or closest timestamp), for scatter plotting and correlation
    correlate_timeseries_aligned({ room, table1, field1, table2, field2, start = null, end = null, method = 'hourly' }) {
      const t = loadRoomTables(room);
      const arr1 = t[table1] || [];
      const arr2 = t[table2] || [];
      if (!arr1.length || !arr2.length) return { pairs: [], corr: null, error: 'No data in one or both tables' };

      // Helper: group by hour
      function groupByHour(arr, field) {
        const buckets = new Map();
        for (const r of arr) {
          if (!withinRange(r.ts, start, end)) continue;
          const v = Number(r[field]);
          if (!Number.isFinite(v)) continue;
          const hourTs = floorHour(r.ts);
          const b = buckets.get(hourTs) || [];
          b.push(v);
          buckets.set(hourTs, b);
        }
        // Average per hour
        return Array.from(buckets.entries()).map(([ts, vals]) => ({
          ts,
          avg: vals.reduce((a, v) => a + v, 0) / vals.length
        }));
      }

      // Group both tables by hour
      const series1 = groupByHour(arr1, field1);
      const series2 = groupByHour(arr2, field2);

      // Align by hour timestamp
      const map2 = new Map(series2.map(r => [r.ts, r.avg]));
      const pairs = [];
      for (const r1 of series1) {
        if (map2.has(r1.ts)) {
          pairs.push({ ts: r1.ts, x: r1.avg, y: map2.get(r1.ts) });
        }
      }

      // Calculate correlation
      const xs = pairs.map(p => p.x);
      const ys = pairs.map(p => p.y);
      const corr = pearson(xs, ys);

      // For scatter plot, return [{x, y, ts}]
      return logToolResult('correlate_timeseries_aligned', { room, table1, field1, table2, field2, start, end, method }, { pairs, corr });
    },

  };

  function buildToolSpec() {
    return JSON.stringify(toolDefs(), null, 0);
  }

  // Role masking helpers
  const ROLE_PRESETS = {
    guest: { allow: new Set(['temperature','humidity','co2','pm25','pm10','lux']) },
    host: { allow: new Set(['temperature','humidity','co2','pm25','pm10','lux','people_count']) },
    viewer: { allow: new Set(['temperature','humidity','co2','pm25','pm10','lux','people_count']) },
    analyst: { allow: 'ALL' },
    admin: { allow: 'ALL' },
    'tenant admin': { allow: 'ALL' },
    'reseller admin': { allow: 'ALL' },
    sa: { allow: 'ALL' }
  };
  function normRole(role) { return String(role||'').trim().toLowerCase(); }
  function roleAllowsField(role, field) {
    const preset = ROLE_PRESETS[normRole(role)] || ROLE_PRESETS.guest;
    if (preset.allow === 'ALL') return true;
    return preset.allow.has(String(field||'').toLowerCase());
  }
  function maskTablesByRole(tables, role) {
    if (!role) return tables;
    const out = {};
    for (const [t, rows] of Object.entries(tables || {})) {
      if (!Array.isArray(rows) || !rows.length) { out[t] = rows; continue; }
      const cols = Object.keys(rows[0] || {});
      const keep = cols.filter(c => c === 'ts' || roleAllowsField(role, c));
      out[t] = rows.map(r => { const o = {}; for (const k of keep) o[k] = r[k]; return o; });
    }
    return out;
  }

  async function buildContextSnippet(question, room, range, selectionRooms = [], role = null) {
    const retrieved = await hybridRetrieve({ query: question, ragIndex: rag, vectorClient: vector, k: 6 }).catch(() => []);
    const head = (retrieved || []).map(h => 
      `Score:${(h.final ?? h.rrf ?? h.scoreRaw ?? 0).toFixed(3)} Meta:${JSON.stringify(h.meta)}\n${h.text}`
    ).join('\n---\n');
    
    let schema = {};
    if (room && room !== 'ALL') {
      const t = maskTablesByRole(loadRoomTables(room), role);
      schema = Object.fromEntries(
        Object.entries(t).map(([k, v]) => [k, Object.keys(v?.[0] || {})])
      );
    } else if (Array.isArray(selectionRooms) && selectionRooms.length) {
      const perRoom = {};
      for (const r of selectionRooms.slice(0, 20)) {
        const tr = maskTablesByRole(loadRoomTables(r), role);
        perRoom[r] = Object.fromEntries(
          Object.entries(tr).map(([k, v]) => [k, Object.keys(v?.[0] || {})])
        );
      }
      schema = { _multiRoom: true, rooms: perRoom };
    }
    
    const meta = {};
    // Try to infer a single building for weather context
    function inferBuildingFromRoom(r) {
      try {
        const snap = loadGraphSnapshot(); if (!snap) return null;
        const nodes = snap.nodes || []; const links = snap.links || [];
        const byId = new Map(nodes.map(n => [n.id, n]));
        const z = nodes.find(n => (n.nodeType||n.label)==='Zone' && n.roomId === r);
        if (!z) return null;
        const lf = links.find(l => l.source===z.id && l.rel==='BELONGS_TO_FLOOR');
        const f = lf ? byId.get(lf.target) : null;
        if (f) {
          const lb = links.find(l => l.source===f.id && l.rel==='BELONGS_TO_BUILDING');
          const b = lb ? byId.get(lb.target) : null; return b?.name || null;
        }
        const lb2 = links.find(l => l.source===z.id && (l.rel==='BELONGS_TO_BUILDING' || l.rel==='IN_BUILDING'));
        const b2 = lb2 ? byId.get(lb2.target) : null; return b2?.name || null;
      } catch { return null; }
    }
    let buildingForWeather = null;
    if (room && room !== 'ALL') buildingForWeather = inferBuildingFromRoom(room);
    if (!buildingForWeather && Array.isArray(selectionRooms) && selectionRooms.length) buildingForWeather = inferBuildingFromRoom(selectionRooms[0]);
    if (room && room !== 'ALL') {
      const tables = maskTablesByRole(loadRoomTables(room), role);
      for (const [t, rows] of Object.entries(tables)) {
        const n = rows.length;
        const tsMin = n ? rows[0].ts : null;
        const tsMax = n ? rows[n-1].ts : null;
        meta[t] = { count: n, tsMin, tsMax };
      }
    } else if (Array.isArray(selectionRooms) && selectionRooms.length) {
      const agg = {};
      for (const r of selectionRooms.slice(0, 20)) {
        const tables = maskTablesByRole(loadRoomTables(r), role);
        for (const [t, rows] of Object.entries(tables)) {
          const n = rows.length;
          const tsMin = n ? rows[0].ts : null;
          const tsMax = n ? rows[n-1].ts : null;
          const cur = agg[t] || { count: 0, tsMin: null, tsMax: null };
          cur.count += n;
          cur.tsMin = (cur.tsMin == null || (tsMin != null && tsMin < cur.tsMin)) ? tsMin : cur.tsMin;
          cur.tsMax = (cur.tsMax == null || (tsMax != null && tsMax > cur.tsMax)) ? tsMax : cur.tsMax;
          agg[t] = cur;
        }
      }
      Object.assign(meta, agg);
    }
    return { retrieved: head, schema, meta, range, room, selectionRooms, buildingForWeather, _retrievedDocs: retrieved };
  }

  async function run(messages, { room, range, selectionRooms = [], tenant = null, role = null }) {
    const question = messages[messages.length - 1]?.content || '';

    // --- ROUTING & HYBRID RETRIEVAL ---
    const routing = classifyQuery(question);
    const filters = suggestRetrievalFilters(routing.level);
    const hybridHits = await hybridRetrieve({ query: question, ragIndex: rag, vectorClient: vector, k: routing?.pipeline?.retrieval?.k || 6 }).catch(()=>[]);

    // --- QUERY ENRICHMENT: Knowledge Pack ---
    let knowledgeSnippets = hybridHits
      .filter(h => h.meta?.type === 'knowledge')
      .map(h => `From ${h.meta.file}: ${h.text}`)
      .join('\n---\n');
    if (knowledgeSnippets && knowledgeSnippets.length > 1500) {
      knowledgeSnippets = knowledgeSnippets.slice(0, 1500) + '\n…';
    }
    // --------------------------------------------

    const ctx = await buildContextSnippet(question, room && room !== 'ALL' ? room : null, range, selectionRooms, role);
    log('Question:', '<redacted>');
    if (DEBUG) log('Context snippet schema keys:', Object.keys(ctx.schema));
    lastBuildingForWeather = ctx.buildingForWeather || null;
    lastSelectionRooms = Array.isArray(selectionRooms) ? selectionRooms.slice(0) : [];
    lastRoom = room;
    lastBuildingForWeather = ctx.buildingForWeather || null;
    lastSelectionRooms = Array.isArray(selectionRooms) ? selectionRooms.slice(0) : [];
    lastRoom = room;

    const rr = range || {};
    // Inject knowledge enrichment into system prompt
    const startDate = rr.start ? new Date(rr.start) : null;
    const endDate = rr.end ? new Date(rr.end) : null;
const startFmt = startDate ? `${startDate.toLocaleString()} (UTC: ${startDate.toISOString().replace('T', ' ').slice(0, 16)})` : 'none';
const endFmt = endDate ? `${endDate.toLocaleString()} (UTC: ${endDate.toISOString().replace('T', ' ').slice(0, 16)})` : 'none';

const sys = `You are a senior data analyst agent for building operations.
Tenant: ${tenant || '(none)'}.
Selected room: ${room || '(none)'}.
Rooms in scope: ${Array.isArray(selectionRooms) && selectionRooms.length ? selectionRooms.join(', ') : (room || '(none)')}
${room === 'ALL' && selectionRooms && selectionRooms.length ? `IMPORTANT: Cross-room analysis MUST be limited to ONLY these rooms. Do NOT invent other rooms.` : ''}
Selected time window: 
- Local: ${startFmt} to ${endFmt}
- Epoch ms: start=${rr.start ?? 'none'} end=${rr.end ?? 'none'}

Weather context: ${ctx.buildingForWeather ? `Use building-scoped weather for ${ctx.buildingForWeather}` : 'Use site weather if building cannot be inferred.'}

Access policy: role=${role || 'Guest'}${tenant ? `; tenant=${tenant}` : ''}. Do not reveal data outside allowed metrics for this role.

MANDATORY: Always use this time window for all analysis and answers. Do NOT invent or assume any other period. If the user asks "what time period are you analysing", repeat this exact window.

FREEDOM TO ANALYZE: You are encouraged to analyze the data, derive insights, compare across rooms within scope, and synthesize conclusions. Use tools as needed; if tools are insufficient, explain and proceed with reasoned analysis using available data.

=== KNOWLEDGE PACK ENRICHMENT (REPHRASE ONLY) ===
${knowledgeSnippets || 'No extra knowledge found for this query.'}

RULE: Do NOT dump or quote long passages from knowledge. If you use it, REPHRASE concisely in your own words and keep it brief.

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

=== CHART EXAMPLES WITH dataRef ===

Line chart (timeseries):
{
  "chart": {"type": "line"},
  "title": {"text": "Temperature Over Time"},
  "xAxis": {"type": "datetime"},
  "yAxis": {"title": {"text": "°C"}},
  "series": [{
    "name": "Temperature",
    "dataRef": {"tool": "fetch_timeseries", "xField": "ts", "yField": "temperature"}
  }]
}

Ratio/computed metric chart:
{
  "chart": {"type": "line"},
  "title": {"text": "CO2 per Person"},
  "xAxis": {"type": "datetime"},
  "yAxis": {"title": {"text": "CO2 / Person"}},
  "series": [{
    "name": "CO2 per Person",
    "dataRef": {"tool": "compute_ratio", "xField": "ts", "yField": "ratio"}
  }]
}

Forecast chart (historical + prediction):
{
  "chart": {"type": "line"},
  "title": {"text": "Humidity Forecast"},
  "xAxis": {"type": "datetime"},
  "yAxis": {"title": {"text": "Humidity %"}},
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
If you want to answer in plain text (no chart, no structured data), respond with:
{ "action": "final_text", "answer": "<your answer>" }
=== ANALYSIS RULES ===
- Always assume the selected room/time window for analysis. Do NOT ask the user for dates; use the provided window as defaults for tools.
- When calling tools, if args omit room/start/end, fill them with the selected room and time window.

- PREDICTION/FORECAST queries: When user asks to "predict", "forecast", "what will be", "estimate future", etc., use the appropriate forecast tool:
  * forecast_from_profile: Best for daily patterns (temperature, humidity, occupancy over days/weeks)
  * forecast_hourly_linear: For trending metrics with clear direction
  * forecast_hourly_naive: Simple baseline (last value repeated)
  * Default horizon: 168 hours (1 week) or 7 days depending on tool

- If a tool returns no rows in the selected window (e.g., fetch_timeseries or stats shows 0), call fetch_table_meta to get the available ts range and decide whether to adapt.

- PARALLEL TOOL CALLS: You can call MULTIPLE tools at once to gather all needed information efficiently:
  {"action":"tool_calls","tools":[{"tool":"<name1>","args":{...}},{"tool":"<name2>","args":{...}}]}
  
- Return either:
  * Single tool call: {"action":"tool_call","tool":"<n>","args":{...}}
  * Multiple parallel tool calls: {"action":"tool_calls","tools":[...]}
  * Final answer: {"action":"final","answer":"...","chart":<HighchartsOptions with dataRef or null>}
  
- When presenting times, format timestamps as 'YYYY-MM-DD HH:mm' (local time) and hours of day as 'h AM/PM' (e.g., 1 PM, 2 PM).
- For "best time" style questions, prefer hour_of_day_stats (e.g., on people_count or co2) and explain the hour labels in human terms.
- ALWAYS provide final answer as properly formatted JSON with action:"final". Never just provide conversational text without the JSON structure.

=== REMEMBER ===
- Use dataRef in all chart series - NEVER embed data arrays
- The backend resolves dataRef automatically from tool results
- Embedding data causes truncation - always use references

Tools: ${buildToolSpec()}.
Notes: 
- In weather data, temperature field is 'temp'.
- Use 'hour_of_day_stats' for "best time" by CO2 or occupancy.
- Use 'busiest_day_of_week' for questions about "busiest day", "which weekday", "most crowded day", "highest occupancy day", etc.
For IAQ table: common fields are temperature, humidity, co2, pm25, pm10, lux, airexchangerate
When user asks to COMPARE between rooms or metrics, prefer these tools:
- compare_series_cross_room (timeseries across rooms)
- compare_rooms_on_metric (rank rooms by agg over window)
- compare_metrics_in_room (compare multiple fields within one room)
- correlation_matrix (pairwise correlations among metrics)
Context: ${JSON.stringify(ctx).slice(0, 5000)}`;

    const convo = [
      { role: 'user', content: sys },
      ...messages
    ];

    // Deterministic handling: if user asks about the current analysis time window, return it explicitly.
    const ql_time = (question || '').toLowerCase();
    if (/what\s+(time|period|window)\s+are\s+you\s+analys/i.test(ql_time)
      || /what\s+time\s+period/i.test(ql_time)
      || /current\s+(range|window)/i.test(ql_time)
      || /what\s+scope\s+and\s+time/i.test(ql_time)
      || /what\s+scope\s+do\s+you\s+see/i.test(ql_time)
      || /selection\s+and\s+time\s*(frame|period|window)?/i.test(ql_time)
      || /what\s+selection\s+and\s+time/i.test(ql_time)
      || /what\s+selection\s+do\s+you\s+see/i.test(ql_time)) {
      const st = rr.start != null ? `${startDate?.toLocaleString()} (UTC: ${startDate?.toISOString().replace('T',' ').slice(0,16)})` : 'none';
      const en = rr.end != null ? `${endDate?.toLocaleString()} (UTC: ${endDate?.toISOString().replace('T',' ').slice(0,16)})` : 'none';
      const scopeRooms = Array.isArray(selectionRooms) && selectionRooms.length ? selectionRooms.join(', ') : (room && room!=='ALL' ? room : '(none)');
      const txt = `Scope rooms: ${scopeRooms}\nTime window:\n- Local: ${st} → ${en}\n- Epoch (ms): start=${rr.start ?? 'none'}, end=${rr.end ?? 'none'}`;
      const extras = [{ message: { role: 'assistant', content: `Query ${routing.level}` }, chart: null }];
    return { message: { role: 'assistant', content: txt }, chart: null, trace: [], extras };
  }

    // Selection only (no time) direct answer
    if (/what\s+selection\s+do\s+you\s+see/i.test(ql_time) || /what\s+scope\s+do\s+you\s+see/i.test(ql_time)) {
      const scopeRooms = Array.isArray(selectionRooms) && selectionRooms.length ? selectionRooms.join(', ') : (room && room!=='ALL' ? room : '(none)');
      return { message: { role: 'assistant', content: `Scope rooms: ${scopeRooms}` }, chart: null, trace: [] };
    }

    // EARLY PLOTTING: floor/building scope cross-room plots
    const ql = (question || '').toLowerCase();
    const intent = classifyIntent(question);
    const floorAll = isAllRooms(room) && Array.isArray(selectionRooms) && selectionRooms.length;
    const multiScope = Array.isArray(selectionRooms) && selectionRooms.length >= 2;
    const wantsAcrossRooms = /across\s+all\s+rooms|on\s+this\s+floor|on\s+this\s+building/.test(ql);
    if ((floorAll || multiScope) && (intent.plotAcrossRooms || ((ql.includes('plot') || ql.includes('chart')) && wantsAcrossRooms))) {
      try {
        const tablesSets = availableFieldsByTable(selectionRooms[0]);
        const { field: f } = resolveMetricAndTableFromQuestion(question, tablesSets, (ql.includes('occupancy')||ql.includes('people')) ? 'people_count' : 'temperature');
        const compareArgs = { start: rr.start || undefined, end: rr.end || undefined, series: [] };
        for (const r of selectionRooms.slice(0, 8)) {
          const t = loadRoomTables(r);
          let tableMatch = null;
          for (const [tname, rows] of Object.entries(t)) { if (rows.length && Object.keys(rows[0] || {}).includes(f)) { tableMatch = tname; break; } }
          compareArgs.series.push({ room: r, table: tableMatch || 'iaq', field: f, name: `${r} ${f}` });
        }
        const result = tools.compare_series_cross_room(compareArgs);
        const seriesKeys = Object.keys(result || {}).slice(0, 8);
        const chart = seriesKeys.length ? {
          chart: { type: 'line' },
          title: { text: `${f} across rooms` },
          xAxis: { type: 'datetime' },
          yAxis: { title: { text: f } },
          series: seriesKeys.map(k => ({ name: k, dataRef: { tool: 'compare_series_cross_room', field: k, xField: 'ts', yField: 'y' } }))
        } : null;
        const trace = [{ tool: 'compare_series_cross_room', args: compareArgs, result }];
        const valid = validateChart(chart, trace);
        if (valid) {
          return { message: { role: 'assistant', content: `Plotted ${f} across ${seriesKeys.length} room(s) in scope.` }, chart: valid, trace };
        }
      } catch (e) { log('early plot across rooms failed:', String(e)); }
    }

    // EARLY COMPARE between two room types (e.g., "compare humidity in the cafe and boardroom")
    if ((floorAll || multiScope) && intent.compareTypes) {
      try {
        // Extract two room-type keywords
        const types = [];
        const tokens = ql.split(/[^a-z0-9_]+/).filter(Boolean);
        const typeWords = ['boardroom','meeting','lab','laboratory','toilet','restroom','bathroom','wc','cafe','cafeteria','kitchen'];
        for (const tk of tokens) {
          if (typeWords.includes(tk) && !types.includes(tk)) types.push(tk);
          if (types.length >= 2) break;
        }
        const norm = (t) => (t==='meeting'?'boardroom': t==='laboratory'?'lab': (t==='restroom'||t==='bathroom'||t==='wc')?'toilet': (t==='cafeteria'||t==='kitchen')?'cafe': t);
        const t1 = types[0] ? norm(types[0]) : null;
        const t2 = types[1] ? norm(types[1]) : null;
        const tablesSets = availableFieldsByTable(selectionRooms[0]);
        const { field: f } = resolveMetricAndTableFromQuestion(question, tablesSets, 'humidity');
        const r1 = t1 ? roomsByType(selectionRooms, t1)[0] : null;
        const r2 = t2 ? roomsByType(selectionRooms, t2)[0] : null;
        const compareArgs = { start: rr.start || undefined, end: rr.end || undefined, series: [] };
        if (r1) {
          let tableMatch = null; for (const [tname, rows] of Object.entries(loadRoomTables(r1))) { if (rows.length && Object.keys(rows[0]||{}).includes(f)) { tableMatch = tname; break; } }
          compareArgs.series.push({ room: r1, table: tableMatch || 'iaq', field: f, name: `${r1} ${f}` });
        }
        if (r2) {
          let tableMatch = null; for (const [tname, rows] of Object.entries(loadRoomTables(r2))) { if (rows.length && Object.keys(rows[0]||{}).includes(f)) { tableMatch = tname; break; } }
          compareArgs.series.push({ room: r2, table: tableMatch || 'iaq', field: f, name: `${r2} ${f}` });
        }
        if (compareArgs.series.length >= 2) {
          const result = tools.compare_series_cross_room(compareArgs);
          const keys = Object.keys(result || {}).slice(0, 8);
          const chart = keys.length ? {
            chart: { type: 'line' }, title: { text: `${f} comparison` }, xAxis: { type: 'datetime' }, yAxis: { title: { text: f } },
            series: keys.map(k => ({ name: k, dataRef: { tool: 'compare_series_cross_room', field: k, xField: 'ts', yField: 'y' } }))
          } : null;
          const trace = [{ tool: 'compare_series_cross_room', args: compareArgs, result }];
          const valid = validateChart(chart, trace);
          if (valid) {
            const extras = [{ message: { role: 'assistant', content: `Query ${routing.level}` }, chart: null }];
            return { message: { role: 'assistant', content: `Compared ${f} between ${r1} and ${r2}.` }, chart: valid, trace, extras };
          }
        }
      } catch (e) { log('early compareTypes failed:', String(e)); }
    }

    // EARLY METRICS SUMMARY: "what metrics are in each room" at floor/building scope
    if ((floorAll || multiScope) && (intent.metricsEachRoom || /(what|which)\s+(metrics|detectors)[^?]*\b(each|every)\b[^?]*\brooms?/i.test(ql))) {
      try {
        const lines = [];
        for (const r of selectionRooms.slice(0, 20)) {
          const t = loadRoomTables(r);
          const detectors = [];
          if (t.iaq && t.iaq.length) detectors.push('IAQ_Sensor');
          if (t.energy && t.energy.length) detectors.push('Energy_Meter');
          if (t.people && t.people.length) detectors.push('People_Counter');
          if (t.water && t.water.length) detectors.push('Water_Meter');
          const fields = new Set();
          for (const rows of Object.values(t)) {
            const first = (rows||[])[0] || {};
            for (const k of Object.keys(first)) if (k !== 'ts') fields.add(k);
          }
          lines.push(`- ${r}: detectors=[${detectors.join(', ')||'—'}], metrics=[${Array.from(fields).sort().join(', ')||'—'}]`);
        }
        const msg = `Metrics by room in current scope:\n${lines.join('\n')}`;
        const extras = [{ message: { role: 'assistant', content: `Query ${routing.level}` }, chart: null }];
        return { message: { role: 'assistant', content: msg }, chart: null, trace: [], extras };
      } catch (e) { log('early metrics summary failed:', String(e)); }
    }

    // EARLY: compare metric between exactly two rooms in scope (e.g., "compare temperature between the two rooms in the scope")
    if (multiScope && selectionRooms.length === 2 && /\bcompare\b/i.test(question)) {
      try {
        const rA = selectionRooms[0];
        const rB = selectionRooms[1];
        const tablesSetsA = availableFieldsByTable(rA);
        const { field: f } = resolveMetricAndTableFromQuestion(question, tablesSetsA, 'temperature');
        const compareArgs = { start: rr.start || undefined, end: rr.end || undefined, series: [] };
        // room A
        let tabA = null; for (const [tname, rows] of Object.entries(loadRoomTables(rA))) { if (rows.length && Object.keys(rows[0]||{}).includes(f)) { tabA = tname; break; } }
        compareArgs.series.push({ room: rA, table: tabA || 'iaq', field: f, name: `${rA} ${f}` });
        // room B
        let tabB = null; for (const [tname, rows] of Object.entries(loadRoomTables(rB))) { if (rows.length && Object.keys(rows[0]||{}).includes(f)) { tabB = tname; break; } }
        compareArgs.series.push({ room: rB, table: tabB || 'iaq', field: f, name: `${rB} ${f}` });
        const result = tools.compare_series_cross_room(compareArgs);
        const keys = Object.keys(result || {});
        const chart = keys.length ? {
          chart: { type: 'line' }, title: { text: `${f} comparison` }, xAxis: { type: 'datetime' }, yAxis: { title: { text: f } },
          series: keys.map(k => ({ name: k, dataRef: { tool: 'compare_series_cross_room', field: k, xField: 'ts', yField: 'y' } }))
        } : null;
        const trace = [{ tool: 'compare_series_cross_room', args: compareArgs, result }];
        const valid = validateChart(chart, trace);
        if (valid) return { message: { role: 'assistant', content: `Compared ${f} between ${rA} and ${rB}.` }, chart: valid, trace };
      } catch (e) { log('early compare two rooms failed:', String(e)); }
    }

    // Devices/Detectors for a specific room (broad phrasing)
    if (intent.devicesInRoom) {
      let r = inferRoomFromText(question) || (selectionRooms && selectionRooms.length===1 ? selectionRooms[0] : null);
      if (!r && floorAll) {
        // Try by room type keyword in question
        const types = ['boardroom','lab','toilet','cafe'];
        for (const tp of types) {
          if (ql.includes(tp) || (tp==='boardroom' && ql.includes('meeting'))) {
            const matches = roomsByType(selectionRooms, tp);
            if (matches.length) { r = matches[0]; break; }
          }
        }
      }
      if (r) {
        try {
          const dets = tools.scope_list_detectors({ room: r });
          const tables = loadRoomTables(r);
          const fieldSet = new Set();
          for (const rows of Object.values(tables)) { const first=(rows||[])[0]||{}; for (const k of Object.keys(first)) if (k!=='ts') fieldSet.add(k); }
          const msg = `${r}: detectors=[${(Array.isArray(dets)?dets:[]).join(', ')||'—'}], metrics=[${Array.from(fieldSet).sort().join(', ')||'—'}]`;
          const extras = [{ message: { role: 'assistant', content: `Query ${routing.level}` }, chart: null }];
          return { message: { role: 'assistant', content: msg }, chart: null, trace: [], extras };
        } catch (e) { log('early devices summary failed:', String(e)); }
      }
    }

    // Plot metrics in the boardroom/lab/toilet/cafe with N random (or available) series
    if (floorAll && intent.plotSingle && /(boardroom|meeting|lab|laboratory|toilet|restroom|bathroom|wc|cafe|cafeteria|kitchen)/i.test(question)) {
      try {
        let roomForPlot = inferRoomFromText(question);
        if (!roomForPlot) {
          const types = ['boardroom','lab','toilet','cafe'];
          for (const tp of types) { if (ql.includes(tp) || (tp==='boardroom' && ql.includes('meeting'))) { const matches = roomsByType(selectionRooms, tp); if (matches.length) { roomForPlot = matches[0]; break; } } }
        }
        if (roomForPlot) {
          const nMatch = question.match(/(\d+)\s*(random|metrics|series)?/i);
          const n = nMatch ? Math.max(1, Math.min(5, parseInt(nMatch[1], 10))) : 3;
          const fields = pickFieldsForRoom(roomForPlot, n);
          const tablesSets = availableFieldsByTable(roomForPlot);
          const series = fields.map(f => {
            let table = null; for (const [t, set] of Object.entries(tablesSets)) if (set.has(f)) { table = t; break; }
            return { name: `${roomForPlot} ${f}`, dataRef: { tool: 'fetch_timeseries', room: roomForPlot, xField: 'ts', yField: f } };
          });
          const chart = { chart: { type: 'line' }, title: { text: `${roomForPlot} — ${fields.join(', ')}` }, xAxis: { type: 'datetime' }, yAxis: { title: { text: 'Value' } }, series };
          // Ensure tool results are present
          const trace = [];
          for (const f of fields) {
            // Decide table for this field
            let tab = null; for (const [t, set] of Object.entries(tablesSets)) if (set.has(f)) { tab = t; break; }
            const args = { room: roomForPlot, table: tab || 'iaq', fields: [f], start: rr.start || undefined, end: rr.end || undefined };
            const res = tools.fetch_timeseries(args);
            trace.push({ tool: 'fetch_timeseries', args, result: res });
          }
          const valid = validateChart(chart, trace);
          if (valid) return { message: { role: 'assistant', content: `Plotted ${fields.length} metric(s) for ${roomForPlot}.` }, chart: valid, trace };
        }
      } catch (e) { log('plot room-type random metrics failed:', String(e)); }
    }

    // EARLY RANKING: highest average co2 (or similar) on this floor/building
    if (floorAll && /(highest|top|most)\s+(avg|average|mean)?\s*(co2|temperature|humidity|lux|pm25|pm10|value)/i.test(question)) {
      try {
        const m = question.match(/(co2|temperature|humidity|lux|pm25|pm10|value)/i);
        const field = (m && m[1]) ? m[1].toLowerCase() : 'co2';
        const tableGuess = field==='value' ? 'energy' : 'iaq';
        const ranking = tools.compare_rooms_on_metric({ rooms: selectionRooms, table: tableGuess, field, agg: 'avg', start: rr.start || undefined, end: rr.end || undefined });
        const top = ranking.filter(r => r.value!=null).slice(0, 5).map(r => `${r.room}: ${Number(r.value).toFixed(2)}`).join('\n');
        const chart = ranking.length ? {
          chart: { type: 'bar' },
          title: { text: `Average ${field} by room` },
          xAxis: { categories: ranking.map(r => r.room) },
          yAxis: { title: { text: field } },
          series: [{ name: `avg(${field})`, data: ranking.map(r => (r.value!=null ? Number(r.value) : null)) }]
        } : null;
        return { message: { role: 'assistant', content: `Top rooms by average ${field} in the selected window:\n${top || 'No data'}` }, chart, trace: [] };
      } catch (e) { log('early ranking failed:', String(e)); }
    }

    // Auto-handle plotting intents by directly building charts without LLM
    {
      const qlc = String(question||'').toLowerCase();
      const isPlotIntent = /(plot|chart|graph|scatter|histogram|heatmap)\b/.test(qlc);
      if (isPlotIntent && room && room !== 'ALL') {
        function pickMetric(q) {
          const s = String(q||'').toLowerCase();
          if (s.includes('humidity')) return 'humidity';
          if (s.includes('co2')) return 'co2';
          if (s.includes('temperature') || s.includes('temp')) return 'temperature';
          if (s.includes('lux') || s.includes('light')) return 'lux';
          if (s.includes('energy') || s.includes('kwh')) return 'total_kwh';
          if (s.includes('people') || s.includes('occupancy')) return 'people_count';
          return 'co2';
        }
        const metric = pickMetric(question);
        let granularity = 'raw';
        if (qlc.includes('daily')) granularity = 'daily';
        else if (qlc.includes('hourly')) granularity = 'hourly';
        else if (qlc.includes('scatter') || qlc.includes(' vs ')) granularity = 'scatter';
        else if (qlc.includes('histogram') || qlc.includes('distribution')) granularity = 'histogram';
        else if (qlc.includes('heatmap') || qlc.includes('correlation')) granularity = 'heatmap';
        const wantsStack = /(stack|stacked|composition)\b/.test(qlc);
        const wantsArea = /\barea\b/.test(qlc);
        const wantsDualAxis = /(dual[- ]axis|overlay|outside temperature)/.test(qlc);
        const wantsColumn = /\bcolumn\b/.test(qlc);
        const wantsBar = /\bbar\b/.test(qlc);
        const wantsForecast = /(forecast|predict|next|tomorrow|future)/.test(qlc);
        try {
          const rr = range || {};
          const traceAuto = [];
          if (granularity === 'histogram') {
            const res = tools.histogram({ room, table: 'iaq', field: metric, bins: 20, start: rr.start || undefined, end: rr.end || undefined });
            traceAuto.push({ tool: 'histogram', args: { room, table: 'iaq', field: metric }, result: res });
            const chart = { chart: { type: 'column' }, title: { text: `Histogram of ${metric}` }, xAxis: { title: { text: metric } }, yAxis: { title: { text: 'Count' } }, series: [{ name: `${room} ${metric}`, dataRef: { tool: 'histogram', xField: 'binStart', yField: 'count' } }] };
            const valid = validateChart(chart, traceAuto);
            if (valid) return { message: { role: 'assistant', content: `Plotted ${metric} histogram for ${room}.` }, chart: valid, trace: traceAuto };
          } else if (granularity === 'heatmap') {
            const fields = ['temperature','humidity','co2','lux'];
            const res = tools.correlation_matrix({ room, table: 'iaq', fields, start: rr.start || undefined, end: rr.end || undefined });
            traceAuto.push({ tool: 'correlation_matrix', args: { room, table: 'iaq', fields }, result: res });
            const chart = { chart: { type: 'heatmap' }, title: { text: 'Correlation Heatmap' }, colorAxis: { min: -1, max: 1 }, series: [{ name: 'Correlation', dataRef: { tool: 'correlation_matrix', format: 'heatmap' } }] };
            const valid = validateChart(chart, traceAuto);
            if (valid) return { message: { role: 'assistant', content: `Correlation heatmap for ${room}.` }, chart: valid, trace: traceAuto };
          } else if (granularity === 'scatter') {
            const res = tools.pair_timeseries({ room, table1: 'iaq', field1: metric, table2: 'weather', field2: 'temp', start: rr.start || undefined, end: rr.end || undefined, time_window_ms: 60*60*1000 });
            traceAuto.push({ tool: 'pair_timeseries', args: { room, table1: 'iaq', field1: metric, table2: 'weather', field2: 'temp' }, result: res });
            const chart = { chart: { type: 'scatter' }, title: { text: `${metric} vs outside temp` }, series: [{ name: `${metric} vs temp`, dataRef: { tool: 'pair_timeseries', xField: 'x', yField: 'y' } }] };
            const valid = validateChart(chart, traceAuto);
            if (valid) return { message: { role: 'assistant', content: `Scatter plotted for ${metric} vs outside temp.` }, chart: valid, trace: traceAuto };
          } else {
            // time series
            let res = null, yField = metric, toolName = 'fetch_timeseries';
            if (granularity === 'hourly') { res = tools.hourly_timeseries({ room, table: 'iaq', field: metric, start: rr.start || undefined, end: rr.end || undefined }); toolName = 'hourly_timeseries'; yField = 'avg'; }
            else if (granularity === 'daily') { res = tools.daily_avg({ room, table: 'iaq', field: metric, start: rr.start || undefined, end: rr.end || undefined }); toolName = 'daily_avg'; yField = 'avg'; }
            else { res = tools.fetch_timeseries({ room, table: 'iaq', fields: [metric], start: rr.start || undefined, end: rr.end || undefined }); }
            traceAuto.push({ tool: toolName, args: { room, table: 'iaq', field: metric, fields: [metric], start: rr.start || undefined, end: rr.end || undefined }, result: res });
            const chartType = wantsArea ? 'area' : (wantsColumn ? 'column' : (wantsBar ? 'bar' : 'line'));
            const chart = { chart: { type: chartType }, title: { text: `${room} — ${metric} (${granularity})` }, xAxis: { type: 'datetime' }, yAxis: [{ title: { text: metric } }], plotOptions: wantsStack ? { series: { stacking: 'normal' } } : {}, series: [{ name: `${room} ${metric}`, dataRef: { tool: toolName, xField: 'ts', yField } }] };
            if (wantsDualAxis) {
              const wf = tools.weather_fetch({ fields: ['temp'], start: rr.start || undefined, end: rr.end || undefined, limit: 10000 });
              traceAuto.push({ tool: 'weather_fetch', args: { fields: ['temp'], start: rr.start || undefined, end: rr.end || undefined }, result: wf });
              chart.yAxis.push({ title: { text: 'Outside Temp' }, opposite: true });
              chart.series.push({ name: 'Outside Temp', dataRef: { tool: 'weather_fetch', xField: 'ts', yField: 'temp' }, yAxis: 1 });
            }
            if (wantsForecast) {
              if (granularity === 'daily' || /next\s+(7|seven)\s+days|week/.test(qlc)) {
                const f = tools.forecast_from_profile({ room, table: 'iaq', field: metric, start: rr.start || undefined, end: rr.end || undefined, days: 7 });
                traceAuto.push({ tool: 'forecast_from_profile', args: { room, table: 'iaq', field: metric, days: 7 }, result: f });
                chart.series.push({ name: 'Forecast', dataRef: { tool: 'forecast_from_profile', xField: 'ts', yField: 'forecast' }, dashStyle: 'dash', color: '#ff6b6b' });
              } else {
                const hours = /next\s+(\d+)\s+hours/.exec(qlc);
                const h = hours ? Math.max(1, Math.min(240, parseInt(hours[1],10))) : 24;
                const f = tools.forecast_hourly_linear({ room, table: 'iaq', field: metric, start: rr.start || undefined, end: rr.end || undefined, horizon_hours: h });
                traceAuto.push({ tool: 'forecast_hourly_linear', args: { room, table: 'iaq', field: metric, horizon_hours: h }, result: f });
                chart.series.push({ name: 'Forecast', dataRef: { tool: 'forecast_hourly_linear', xField: 'ts', yField: 'forecast' }, dashStyle: 'dash', color: '#ff6b6b' });
                chart.series.push({ name: 'Forecast CI', dataRef: { tool: 'forecast_hourly_linear', field: 'ci', xField: 'ts', yField: 'range' }, type: 'arearange', color: 'rgba(255,107,107,0.25)', linkedTo: ':previous' });
              }
            }
            const valid = validateChart(chart, traceAuto);
            if (valid) return { message: { role: 'assistant', content: `Plotted ${metric} for ${room}.` }, chart: valid, trace: traceAuto };
          }
        } catch (e) { log('auto-plot failed:', String(e)); }
      }
    }

    const trace = [];
    let lastToolSig = '';
    let repeatCount = 0;
    let totalToolCalls = 0;
    
    for (let step = 0; step < 10; step++) {
      const t0 = Date.now();
    // Enforce chart_query for plotting intents
    const qlc = String(question||'').toLowerCase();
    if (/(plot|chart|graph|scatter|histogram|heatmap)\b/.test(qlc)) {
      convo.push({ role: 'model', content: 'Reminder: For plotting questions, first call chart_query to produce a plan and chart with dataRef, then execute the plan and finalize with the chart.' });
    }
    const reply = await callGeminiChat(convo, {});
      const dt = Date.now() - t0;
      log(`LLM step ${step} took ${dt}ms`);
      
      if (!reply) break;
      if (DEBUG) log('LLM raw reply:', reply.slice(0, 600));
      
      // Force finalization if we've made enough tool calls
      if (totalToolCalls >= 6 && step >= 4) {
        const recentlyPaired = trace.some(t => t.tool === 'pair_timeseries');
        if (recentlyPaired && step < 4) {
          // Allow one extra iteration to let the model produce a chart using the paired dataRef
          log('Skipping forced finalization to allow scatter pairing (step', step, ')');
        } else {
          log('Strongly encouraging finalization after', totalToolCalls, 'tool calls at step', step);
        
        // CRITICAL: After 2 tools and step 2+, FORCE finalization with very explicit instructions
        if (step >= 3) {
          const ql = question.toLowerCase();
          const isCorrelationPlot = ql.includes('correlation') && (ql.includes('plot') || ql.includes('show'));
          const isScatterPlot = ql.includes('scatter') || ql.includes('scatterplot');
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
          
          convo.push({ role: 'model', content: hint });
          continue; // Force another iteration with this guidance
        }
      }
      }
      
      // After step 2, if reply is not valid JSON with "action", force a JSON answer
      if (step >= 2 && (!obj || !obj.action)) {
        convo.push({
          role: 'model',
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
        continue;
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
          convo.push({
            role: 'model',
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
          continue;
        }
        
        // Check if the reply contains embedded data arrays (another detection method)
        if (trimmed.includes('"data":[[') || trimmed.match(/"data":\s*\[\[/)) {
          log('Detected embedded data array in response');
          convo.push({
            role: 'model',
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
          continue;
        }
        
        // CRITICAL: Reject plain text responses - force JSON format
        const plain = String(reply || '').trim();
        if (plain.length > 20 && /[a-zA-Z]/.test(plain) && !plain.startsWith('{')) {
          // After step 5, auto-wrap plain text in JSON as last resort
          if (step >= 5 && totalToolCalls >= 2) {
            log('Auto-wrapping plain text response in JSON (step', step, ')');
            return {
              message: { role: 'assistant', content: plain },
              chart: null,
              trace
            };
          }
          
          log('Rejecting plain text response, enforcing JSON format');
          convo.push({
            role: 'model',
            content: `CRITICAL ERROR: You provided a plain text response instead of JSON. This is NOT acceptable.

Your response started with:
"${plain.slice(0, 200)}..."

You MUST respond with a valid JSON object using this EXACT format:

{"action":"final","answer":"${plain.slice(0, 100).replace(/"/g, '\\"')}...","chart":null}

Copy the above format and fill in your complete answer. Use proper JSON syntax.`
          });
          continue;
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
          
          let result = null;
          try { 
            result = tools[tool](filledArgs); 
          } catch (e) { 
            result = { error: String(e) }; 
          }
          
          log(`  - ${tool}:`, typeof result === 'object' ? `${Object.keys(result).length} keys` : result);
          results.push({ tool, args: filledArgs, result });
          trace.push({ tool, args: filledArgs, result });
        }
        
        // Feed back all results together
        convo.push({ 
          role: 'model', 
          content: `{"tool_results": ${JSON.stringify(results).slice(0, 15000)} }` 
        });
        continue;
      }
      
      // Handle single tool call
      // Handle multiple parallel tool calls
      if (obj.action === 'tool_calls' && Array.isArray(obj.tools)) {
        const results = [];
        for (const tc of obj.tools) {
          const tool = resolveToolName(tc.tool);
          const args = { ...(tc.args || {}) };
          if (!tools[tool]) {
            results.push({ tool, args, result: { error: `Tool ${tool} not found` } });
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
          function inferTbl(m) { if (!m) return null; if (['co2','temperature','humidity','lux'].includes(m)) return 'iaq'; if (m==='people_count') return 'people'; if (m==='total_kwh') return 'energy'; return null; }
          if (want) {
            if (tool === 'fetch_timeseries') {
              if (!args.fields || !args.fields.length || !args.fields.includes(want)) args.fields = [want];
              if (!args.table) { const t = inferTbl(want); if (t) args.table = t; }
            } else if (tool === 'hourly_timeseries' || tool === 'daily_avg' || tool === 'stats' || tool === 'hour_of_day_stats' || tool === 'histogram') {
              if (!args.field) args.field = want;
              if (!args.table) { const t = inferTbl(want); if (t) args.table = t; }
            }
          }
          let result = null;
          try { result = tools[tool](args); } catch (e) { result = { error: String(e) }; }
          results.push({ tool, args, result });
          trace.push({ tool, args, result });
          totalToolCalls += 1;
        }
        convo.push({ role: 'model', content: `{"tool_results": ${JSON.stringify(results).slice(0, 15000)} }` });
        continue;
      }

      if (obj.action === 'tool_call') {
        let { tool, args } = obj;
        tool = resolveToolName(tool);
        log('Tool call:', tool, 'args:', args);
        totalToolCalls += 1;
        
        if (!tools[tool]) {
          convo.push({ 
            role: 'model', 
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
        function inferTbl(m) { if (!m) return null; if (['co2','temperature','humidity','lux'].includes(m)) return 'iaq'; if (m==='people_count') return 'people'; if (m==='total_kwh') return 'energy'; return null; }
        if (want) {
          if (tool === 'fetch_timeseries') {
            if (!filledArgs.fields || !filledArgs.fields.length || !filledArgs.fields.includes(want)) filledArgs.fields = [want];
            if (!filledArgs.table) { const t = inferTbl(want); if (t) filledArgs.table = t; }
          } else if (tool === 'hourly_timeseries' || tool === 'daily_avg' || tool === 'stats' || tool === 'hour_of_day_stats' || tool === 'histogram') {
            if (!filledArgs.field) filledArgs.field = want;
            if (!filledArgs.table) { const t = inferTbl(want); if (t) filledArgs.table = t; }
          }
        }
        
        let result = null;
        try { 
          result = tools[tool](filledArgs); 
        } catch (e) { 
          result = { error: String(e) }; 
        }
        
        const sizeHint = Array.isArray(result) ? 
          result.length : 
          (result && typeof result === 'object' ? Object.keys(result).length : 0);
        log('Tool result size hint:', sizeHint);
               trace.push({ tool, args, result });
        
        // If compare tool returned series, finalize immediately with a ready-to-plot chart
        if (tool === 'compare_series_cross_room' && result && typeof result === 'object' && !Array.isArray(result)) {
          try {
            const entries = Object.entries(result);
            const qlc = String(question||'').toLowerCase();
            let chart = null;
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
            const answerText = entries.length ? 'Compared series across rooms.' : 'No data available to compare in the selected period.';
            const evalMetrics = evaluateQA({ question, answer: answerText, retrievedDocs: ctx._retrievedDocs || [] });
            const extraEval = { message: { role: 'assistant', content: `Eval grounding=${(evalMetrics.grounding*100).toFixed(0)}% uncertainty=${(evalMetrics.uncertainty*100).toFixed(0)}%` }, chart: null };
            return {
              message: { role: 'assistant', content: answerText },
              chart,
              extras: [extraEval],
              trace
            };
          } catch (e) {
            log('compare_series_cross_room finalize failed:', String(e));
          }
        }

        // Feed back a structured tool result frame when not finalizing
        convo.push({ role: 'model', content: `{"tool_result": { "tool": ${JSON.stringify(tool)}, "args": ${JSON.stringify(filledArgs)}, "result": ${JSON.stringify(result).slice(0, 10000)} }}` });
        
        // If the selected window produced no data, fetch meta to help the model adapt
        if ((tool === 'fetch_timeseries' && Array.isArray(result) && result.length === 0) || 
            (tool === 'stats' && (!result || !Number(result.count)))) {
          try {
            const meta = tools.fetch_table_meta({ 
              room: filledArgs.room, 
              table: filledArgs.table || filledArgs.table1 || filledArgs.table2 
            });
            
            // For "latest" queries, automatically retry with the actual data range
            const isLatestQuery = question.toLowerCase().includes('latest') || 
                                 question.toLowerCase().includes('most recent') ||
                                 question.toLowerCase().includes('current');
            
            if (isLatestQuery && meta.tsMax != null && meta.count > 0) {
              log('Auto-adapting "latest" query to actual data range');
              const adaptedArgs = { ...filledArgs, start: null, end: meta.tsMax };
              try {
                const adaptedResult = tools[tool](adaptedArgs);
                if ((Array.isArray(adaptedResult) && adaptedResult.length > 0) || 
                    (adaptedResult && typeof adaptedResult === 'object' && adaptedResult.count > 0)) {
                  log('Auto-adaptation successful, using adapted result');
                  result = adaptedResult;
                  convo.push({ 
                    role: 'model', 
                    content: `{"tool_result_adapted": { "tool": ${JSON.stringify(tool)}, "args": ${JSON.stringify(adaptedArgs)}, "result": ${JSON.stringify(result).slice(0, 10000)}, "note": "Query adapted to use actual data range since selected window had no data. Data available from ${new Date(meta.tsMin).toISOString()} to ${new Date(meta.tsMax).toISOString()}" }}` 
                  });
                  continue;
                }
              } catch {}
            }
            
            convo.push({ 
              role: 'model', 
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
            const answer = `Available data for room ${r}: ` + 
              Object.entries(summary)
                .map(([t, cols]) => `${t} [${cols.join(', ')}]`)
                .join('; ');
            const evalMetrics = evaluateQA({ question, answer, retrievedDocs: ctx._retrievedDocs || [] });
            return { 
              message: { role: 'assistant', content: answer }, 
              chart: null, 
              extras: [{ message: { role: 'assistant', content: `Query ${routing.level}; grounding ${(evalMetrics.grounding*100).toFixed(0)}%; uncertainty ${(evalMetrics.uncertainty*100).toFixed(0)}%` }, chart: null }],
              trace 
            };
          }
        }
        continue;
        
      } else if (obj.action === 'final') {
        log('Finalizing answer. Chart provided?', !!obj.chart);

        // If model returned embedded arrays or no dataRef, retrofit to dataRef
        if (obj.chart && obj.chart.series && Array.isArray(obj.chart.series)) {
          try {
            const tablesSets = availableFieldsByTable(room);
            const ql2 = (question || '').toLowerCase();
            const isVsQuery = /\bvs\b/.test(ql2) || ql2.includes('scatter');

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
                  if (field) {
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

        // If no chart provided, infer a useful one from the question
        if (!obj.chart || !obj.chart.series || !obj.chart.series.length) {
          try {
            const tablesSets = availableFieldsByTable(room);
            const ql = (question||'').toLowerCase();
            const isHist = ql.includes('histogram') || ql.includes('distribution');
            if (isHist) {
              const fields = parseFieldsFromQuestion(question, tablesSets);
              const f = fields[0] || 'odor_level';
              obj.chart = {
                chart: { type: 'column' },
                title: { text: `${f} distribution` },
                xAxis: { title: { text: f } },
                yAxis: { title: { text: 'Count' } },
                series: [{ name: `${f} histogram`, dataRef: { tool: 'histogram', field: f, xField: 'binStart', yField: 'count' } }]
              };
            } else {
              const fields = parseFieldsFromQuestion(question, tablesSets);
              const floorAll = isAllRooms(room) && Array.isArray(selectionRooms) && selectionRooms.length;
              if (fields.length >= 2) {
                obj.chart = {
                  chart: { type: 'scatter' },
                  title: { text: `${fields[0]} vs ${fields[1]}` },
                  xAxis: { title: { text: fields[0] } },
                  yAxis: { title: { text: fields[1] } },
                  series: [{ name: `${fields[0]} vs ${fields[1]}`, dataRef: { tool: 'pair_timeseries', xField: 'x', yField: 'y', field1: fields[0], field2: fields[1] } }]
                };
              } else if ((fields.length === 1 && !floorAll) || (wantsChart(question) && !floorAll)) {
                const f = fields[0] || 'temperature';
                obj.chart = {
                  chart: { type: 'line' },
                  title: { text: `${f} over time` },
                  xAxis: { type: 'datetime' },
                  yAxis: { title: { text: f } },
                  series: [{ name: f, dataRef: { tool: 'fetch_timeseries', xField: 'ts', yField: f } }]
                };
              } else if (floorAll && fields.length >= 1) {
                // Build cross-room comparison line chart for selected rooms
                const f = fields[0];
                obj.chart = {
                  chart: { type: 'line' },
                  title: { text: `${f} across rooms` },
                  xAxis: { type: 'datetime' },
                  yAxis: { title: { text: f } },
                  series: selectionRooms.slice(0, 8).map(r => ({ name: `${r} ${f}`, dataRef: { tool: 'compare_series_cross_room', field: `${r} ${f}`, xField: 'ts', yField: 'y' } }))
                };
                // Ensure compare tool result is present in trace
                try {
                  const compareArgs = { start: rr.start || undefined, end: rr.end || undefined, series: [] };
                  for (const r of selectionRooms.slice(0, 8)) {
                    const t = loadRoomTables(r);
                    let tableMatch = null;
                    for (const [tname, rows] of Object.entries(t)) {
                      if (rows.length && Object.keys(rows[0] || {}).includes(f)) { tableMatch = tname; break; }
                    }
                    compareArgs.series.push({ room: r, table: tableMatch || 'iaq', field: f, name: `${r} ${f}` });
                  }
                  const compareResult = tools.compare_series_cross_room(compareArgs);
                  trace.push({ tool: 'compare_series_cross_room', args: compareArgs, result: compareResult });
                } catch (e) { log('auto-compare build failed:', String(e)); }
              }
            }
          } catch (e) {
            log('Auto-chart inference failed:', String(e));
          }
        }

        // Find all dataRefs in the chart
        const missingToolCalls = [];
        if (obj.chart && obj.chart.series) {
          for (const series of obj.chart.series) {
            if (series.dataRef) {
              const ref = series.dataRef;
              // Check if tool result is in trace
              const found = trace.some(t => t.tool === ref.tool && (!ref.room || (t.args && String(t.args.room) === String(ref.room))));
              if (!found) {
                // Prepare tool call args
                let args = {};
                if (ref.tool === 'fetch_timeseries') {
                  // Try to auto-detect the correct table for the requested field
                  let table = null;
                  let roomForRef = ref.room || inferRoomFromText(series.name) || inferRoomFromText(question) || (isAllRooms(room) ? null : room);
                  if (!roomForRef && isAllRooms(room) && Array.isArray(selectionRooms) && selectionRooms.length) {
                    // Prefer rooms matching keywords in the question (toilet/lab/boardroom/cafe)
                    const ql3 = (question||'').toLowerCase();
                    const typeHint = ['toilet','lab','boardroom','cafe'].find(tk => ql3.includes(tk));
                    const pick = selectionRooms.find(r => typeHint ? r.toLowerCase().includes(typeHint) : true);
                    roomForRef = pick || selectionRooms[0];
                  }
                  const tables = loadRoomTables(roomForRef);
                  for (const [tname, rows] of Object.entries(tables)) {
                    if (rows.length && Object.keys(rows[0]).includes(ref.yField)) {
                      table = tname;
                      break;
                    }
                  }
                  // Fallback to 'iaq' if not found
                  args = {
                    room: roomForRef,
                    table: table || 'iaq',
                    fields: [ref.yField],
                    start: (range && range.start) || undefined,
                    end: (range && range.end) || undefined
                  };
                } else if (ref.tool === 'pair_timeseries') {
                  // Attempt to infer fields from ref or series name
                  let roomForRef = ref.room || inferRoomFromText(series.name) || inferRoomFromText(question) || (isAllRooms(room) ? null : room);
                  if (!roomForRef && isAllRooms(room) && Array.isArray(selectionRooms) && selectionRooms.length) {
                    // prefer first room in selection; try type-hinted pick
                    const ql3 = (question||'').toLowerCase();
                    const typeHint = ['toilet','lab','boardroom','cafe','lounge','reception'].find(tk => ql3.includes(tk));
                    const pick = selectionRooms.find(r => typeHint ? r.toLowerCase().includes(typeHint) : true) || selectionRooms[0];
                    roomForRef = pick;
                  }
                  const tables = loadRoomTables(roomForRef);
                  const allFields = Object.fromEntries(Object.entries(tables).map(([t, rows]) => [t, new Set(rows.length ? Object.keys(rows[0]) : [])]));
                  // Prefer explicit ref fields if provided
                  let f1 = ref.field1, f2 = ref.field2;
                  if ((!f1 || !f2) && series && typeof series.name === 'string') {
                    const nm = series.name.toLowerCase();
                    const m = nm.split(/\s+vs\s+|\s+and\s+/);
                    if (m.length >= 2) {
                      f1 = f1 || m[0].trim();
                      f2 = f2 || m[1].trim();
                    }
                  }
                  // Fallback: try common fields (prefer temperature & humidity if asking for scatter)
                  const candidates = (/(temperature|temp).*?(humidity)|humidity.*?(temperature|temp)/i.test(question||'')
                    ? ['temperature','humidity','co2','voc','lux','people_count','value']
                    : ['voc','lux','co2','humidity','temperature','people_count','value']);
                  f1 = f1 || candidates.find(c => Object.values(allFields).some(set => set.has(c)));
                  f2 = f2 || candidates.find(c => c !== f1 && Object.values(allFields).some(set => set.has(c)));
                  // Find tables containing those fields
                  function findTableForField(field) {
                    for (const [t, set] of Object.entries(allFields)) if (set.has(field)) return t;
                    return Object.keys(tables)[0] || 'iaq';
                  }
                  const t1 = findTableForField(f1);
                  const t2 = findTableForField(f2);
                  args = {
                    room: roomForRef,
                    table1: t1,
                    field1: f1,
                    table2: t2,
                    field2: f2,
                    start: (range && range.start) || undefined,
                    end: (range && range.end) || undefined
                  };
                } else if (ref.tool === 'pair_timeseries') {
                  // Try to use ref.field1/field2 if present; otherwise infer from series name
                  let roomForRef = ref.room || inferRoomFromText(series.name) || inferRoomFromText(question) || (isAllRooms(room) ? null : room);
                  if (!roomForRef && isAllRooms(room) && Array.isArray(selectionRooms) && selectionRooms.length) {
                    const ql3 = (question||'').toLowerCase();
                    const typeHint = ['toilet','lab','boardroom','cafe','lounge','reception'].find(tk => ql3.includes(tk));
                    const pick = selectionRooms.find(r => typeHint ? r.toLowerCase().includes(typeHint) : true) || selectionRooms[0];
                    roomForRef = pick;
                  }
                  const tables = loadRoomTables(roomForRef);
                  const allFields = Object.fromEntries(Object.entries(tables).map(([t, rows]) => [t, new Set(rows.length ? Object.keys(rows[0]) : [])]));
                  let f1 = ref.field1, f2 = ref.field2;
                  if ((!f1 || !f2) && series && typeof series.name === 'string') {
                    const nm = series.name.toLowerCase();
                    const m = nm.split(/\s+vs\s+|\s+and\s+/);
                    if (m.length >= 2) {
                      f1 = f1 || inferFieldName(m[0], allFields);
                      f2 = f2 || inferFieldName(m[1], allFields);
                    }
                  }
                  const candidates = (/(temperature|temp).*?(humidity)|humidity.*?(temperature|temp)/i.test(question||'')
                    ? ['temperature','humidity','co2','voc','lux','people_count','value','pressure']
                    : ['voc','lux','co2','humidity','temperature','people_count','value','pressure']);
                  f1 = f1 || candidates.find(c => Object.values(allFields).some(set => set.has(c)));
                  f2 = f2 || candidates.find(c => c !== f1 && Object.values(allFields).some(set => set.has(c)));
                  function findTableForField(field) {
                    for (const [t, set] of Object.entries(allFields)) if (set.has(field)) return t;
                    return Object.keys(tables)[0] || 'iaq';
                  }
                  const t1 = findTableForField(f1);
                  const t2 = findTableForField(f2);
                  args = { room, table1: t1, field1: f1, table2: t2, field2: f2, start: (range && range.start) || undefined, end: (range && range.end) || undefined };
                } else if (ref.tool === 'histogram') {
                  let table = null;
                  const roomForRef = isAllRooms(room) ? (inferRoomFromText(series.name) || inferRoomFromText(question) || listRooms()[0]) : room;
                  const tables = loadRoomTables(roomForRef);
                  for (const [tname, rows] of Object.entries(tables)) {
                    if (rows.length && Object.keys(rows[0]).includes(ref.field)) { table = tname; break; }
                  }
                  args = { room: roomForRef, table: table || 'iaq', field: ref.field, bins: 12, start: (range && range.start) || undefined, end: (range && range.end) || undefined };
                } else if (ref.tool === 'correlation_matrix') {
                  // Build correlation matrix for a set of fields in a room/table
                  const roomForRef = isAllRooms(room) ? (inferRoomFromText(series.name) || inferRoomFromText(question) || listRooms()[0]) : (ref.room || room);
                  const tables = loadRoomTables(roomForRef);
                  // Pick table containing most of candidate fields
                  const candidateFields = Array.isArray(ref.fields) && ref.fields.length ? ref.fields : ['temperature','humidity','co2'];
                  let bestTable = 'iaq'; let bestHit = -1;
                  for (const [tname, rows] of Object.entries(tables)) {
                    const keys = rows.length ? Object.keys(rows[0]) : [];
                    const hit = candidateFields.filter(f => keys.includes(f)).length;
                    if (hit > bestHit) { bestHit = hit; bestTable = tname; }
                  }
                  const fields = candidateFields.filter(f => (tables[bestTable] || []).length && Object.keys((tables[bestTable][0]||{})).includes(f));
                  args = { room: roomForRef, table: bestTable, fields: fields.length ? fields : candidateFields, start: (range && range.start) || undefined, end: (range && range.end) || undefined };
                } else if (ref.tool === 'compare_series_cross_room') {
                  const roomsList = Array.isArray(selectionRooms) && selectionRooms.length ? selectionRooms.slice(0, 8) : (room && !isAllRooms(room) ? [room] : listRooms().slice(0, 4));
                  // Infer field from ref or series name/question
                  const tablesSetsAny = roomsList.length ? availableFieldsByTable(roomsList[0]) : {};
                  let field = ref.yField || ref.field || inferFieldName(series.name, tablesSetsAny) || inferFieldName(question, tablesSetsAny) || 'temperature';
                  const seriesArgs = [];
                  for (const r of roomsList) {
                    const t = loadRoomTables(r);
                    let tableMatch = null;
                    for (const [tname, rows] of Object.entries(t)) {
                      if (rows.length && Object.keys(rows[0]||{}).includes(field)) { tableMatch = tname; break; }
                    }
                    seriesArgs.push({ room: r, table: tableMatch || 'iaq', field, name: `${r} ${field}` });
                  }
                  args = { start: (range && range.start) || undefined, end: (range && range.end) || undefined, series: seriesArgs };
                }
                // Add other tool types as needed
                missingToolCalls.push({ tool: ref.tool, args });
              }
            }
          }
        }

        // If missing tool calls, run them and add to trace
        for (const call of missingToolCalls) {
          if (tools[call.tool]) {
            const result = tools[call.tool](call.args);
            trace.push({ tool: call.tool, args: call.args, result });
            log(`Auto-ran missing tool: ${call.tool}`, call.args);
          }
        }

        // Now resolve chart as usual
        let validChart = validateChart(obj.chart, trace);
        if (obj.chart && !validChart) {
          log('Chart validation failed - attempting fallback synthesis');
        }

        // Fallback: if no valid chart, synthesize from latest compare_series_cross_room
        if (!validChart) {
          try {
            let lastCompare = null;
            for (let i = trace.length - 1; i >= 0; i--) {
              const t = trace[i];
              if (t && t.tool === 'compare_series_cross_room' && t.result && typeof t.result === 'object') { lastCompare = t; break; }
            }
            if (lastCompare) {
              const keys = Object.keys(lastCompare.result || {}).slice(0, 8);
              if (keys.length) {
                const series = keys.map((k) => ({ name: String(k), dataRef: { tool: 'compare_series_cross_room', field: k, xField: 'ts', yField: 'y' } }));
                const fallbackChart = { chart: { type: 'line' }, title: { text: 'Cross-Room Comparison' }, xAxis: { type: 'datetime', title: { text: 'Time' } }, yAxis: { title: { text: 'Value' } }, series };
                const vc = validateChart(fallbackChart, trace);
                if (vc) { validChart = vc; log('Synthesized fallback chart from compare_series_cross_room'); }
              }
            }
          } catch (e) { log('Fallback chart synthesis failed:', String(e)); }
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
              extras.push({ message: { role: 'assistant', content: extraMsg }, chart: null });
            }
          }
        } catch (e) { log('background_tools execution failed:', String(e)); }

        // Inject routing info and evaluation into extras
        try {
          const evalMetrics = evaluateQA({ question, answer: obj.answer || reply, retrievedDocs: ctx._retrievedDocs || [] });
          extras = extras || [];
          extras.unshift({ message: { role: 'assistant', content: `Query ${routing.level}; grounding ${(evalMetrics.grounding*100).toFixed(0)}%; uncertainty ${(evalMetrics.uncertainty*100).toFixed(0)}%` }, chart: null });
        } catch {}

        return {
          message: { role: 'assistant', content: obj.answer || reply },
          chart: validChart,
          extras,
          trace
        };
        
      } else if (obj.action === 'final_text') {
        log('Finalizing plain text answer.');
        return {
          message: { role: 'assistant', content: obj.answer || reply },
          chart: null,
          trace
        };
      } else {
        // Unknown → continue
        log('Unknown action from LLM:', obj.action);
        convo.push({ 
          role: 'model', 
          content: 'ERROR: Invalid action. Use "tool_call", "tool_calls", or "final".' 
        });
      }
    }
    
    // If model emitted non-JSON but informative text, return it
    if (convo.length && typeof convo[convo.length - 1]?.content === 'string') {
      const last = convo[convo.length - 1].content;
      // NEVER return tool_results JSON as the final answer
      if (last.includes('"tool_results"') || last.includes('"tool_result"') || last.includes('"tool_hint"')) {
        log('Prevented tool results JSON from being returned as final answer');
        
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
              lines.push(`- ${r}: detectors=[${dets.join(', ')||'—'}], metrics=[${Array.from(fieldSet).sort().join(', ')||'—'}]`);
            }
            if (lines.length) {
              return { message: { role: 'assistant', content: `Metrics by room in current scope:\n${lines.join('\n')}` }, chart: null, trace };
            }
          }
        } catch (e) { log('detectors summary in tool_results fallback failed:', String(e)); }

        // Try to construct a useful answer from the last tool otherwise
        let answer = 'I analyzed the data. ';
        const lastTool = trace[trace.length - 1];
        
        if (lastTool) {
          if (lastTool.tool === 'correlate' || lastTool.tool === 'correlate_weather_room' || lastTool.tool === 'correlate_cross_room') {
            const corr = lastTool.result?.corr;
            const n = lastTool.result?.n || 0;
            if (Number.isFinite(corr)) {
              const strength = Math.abs(corr) > 0.7 ? 'strong' : Math.abs(corr) > 0.4 ? 'moderate' : 'weak';
              const direction = corr > 0 ? 'positive' : 'negative';
              answer = `The correlation is ${corr.toFixed(3)}, showing a ${strength} ${direction} relationship (based on ${n} data pairs).`;
            } else {
              answer = `Could not calculate correlation. ${lastTool.result?.error || 'Insufficient paired data in the selected time window.'}`;
            }
          } else if (lastTool.tool === 'compute_ratio') {
            const ratios = lastTool.result;
            if (Array.isArray(ratios) && ratios.length > 0) {
              const avgRatio = ratios.reduce((sum, r) => sum + (r.ratio || 0), 0) / ratios.length;
              answer = `Computed ${ratios.length} ratio values. Average ratio: ${avgRatio.toFixed(2)}.`;
            } else {
              answer = 'Could not compute ratios for the selected period.';
            }
          } else if (lastTool.tool === 'fetch_timeseries' || lastTool.tool === 'weather_fetch') {
            const data = lastTool.result;
            if (Array.isArray(data)) {
              answer = `Retrieved ${data.length} data points from ${lastTool.tool}.`;
            }
          } else {
            answer = `Retrieved data using ${lastTool.tool}.`;
          }
        }
        
        return {
          message: { role: 'assistant', content: answer },
          chart: null,
          trace
        };
      }
      if (last && last.length > 40 && !last.includes('respond with a JSON') && !last.includes('ERROR:')) {
        // Try to infer a helpful chart for plain text responses
        let autoChart = null;
        try {
          const tablesSets = availableFieldsByTable(room);
          const fields = parseFieldsFromQuestion(question, tablesSets);
          const floorAll = isAllRooms(room) && Array.isArray(selectionRooms) && selectionRooms.length;
          if (fields.length >= 2) {
            autoChart = {
              chart: { type: 'scatter' },
              title: { text: `${fields[0]} vs ${fields[1]}` },
              xAxis: { title: { text: fields[0] } },
              yAxis: { title: { text: fields[1] } },
              series: [{ name: `${fields[0]} vs ${fields[1]}`, dataRef: { tool: 'pair_timeseries', xField: 'x', yField: 'y', field1: fields[0], field2: fields[1] } }]
            };
          } else if ((fields.length === 1 && !floorAll) || (wantsChart(question) && !floorAll)) {
            const f = fields[0] || 'temperature';
            autoChart = {
              chart: { type: 'line' },
              title: { text: `${f} over time` },
              xAxis: { type: 'datetime' },
              yAxis: { title: { text: f } },
              series: [{ name: f, dataRef: { tool: 'fetch_timeseries', xField: 'ts', yField: f } }]
            };
          } else if (floorAll) {
            // Build a cross-room comparison from last compare_series_cross_room or run one now
            let compare = null;
            for (let i = trace.length - 1; i >= 0; i--) {
              if (trace[i].tool === 'compare_series_cross_room' && trace[i].result && typeof trace[i].result === 'object') { compare = trace[i]; break; }
            }
            const f = fields[0] || 'people_count';
            if (!compare) {
              // Execute compare now for scoped rooms
              const compareArgs = { start: rr.start || undefined, end: rr.end || undefined, series: [] };
              for (const r of selectionRooms.slice(0, 8)) {
                const t = loadRoomTables(r);
                let tableMatch = null;
                for (const [tname, rows] of Object.entries(t)) { if (rows.length && Object.keys(rows[0] || {}).includes(f)) { tableMatch = tname; break; } }
                compareArgs.series.push({ room: r, table: tableMatch || 'iaq', field: f, name: `${r} ${f}` });
              }
              const result = tools.compare_series_cross_room(compareArgs);
              trace.push({ tool: 'compare_series_cross_room', args: compareArgs, result });
              compare = { result };
            }
            const keys = Object.keys(compare.result || {}).slice(0, 8);
            if (keys.length) {
              autoChart = {
                chart: { type: 'line' },
                title: { text: `${f} across rooms` },
                xAxis: { type: 'datetime' },
                yAxis: { title: { text: f } },
                series: keys.map(k => ({ name: k, dataRef: { tool: 'compare_series_cross_room', field: k, xField: 'ts', yField: 'y' } }))
              };
            }
          }
        } catch {}
        // If recent trace includes scope_list_detectors calls, summarize detectors/metrics per room
        try {
          const recent = trace.filter(t => t.tool === 'scope_list_detectors' && t.args && t.args.room);
          if (recent.length) {
            const lines = [];
            for (const t of recent) {
              const r = t.args.room;
              const dets = Array.isArray(t.result) ? t.result : [];
              const tables = loadRoomTables(r);
              const fieldSet = new Set();
              for (const rows of Object.values(tables)) { const first = (rows||[])[0]||{}; for (const k of Object.keys(first)) if (k!=='ts') fieldSet.add(k); }
              lines.push(`- ${r}: detectors=[${dets.join(', ')||'—'}], metrics=[${Array.from(fieldSet).sort().join(', ')||'—'}]`);
            }
            const msg = `Metrics by room in current scope:\n${lines.join('\n')}`;
            return { message: { role: 'assistant', content: msg }, chart: autoChart, trace };
          }
        } catch {}
        return { message: { role: 'assistant', content: last }, chart: autoChart, trace };
      }
    }
    
    // Fallback: construct answer from trace
    log('Constructing fallback answer from trace');
    let fallbackAnswer = 'I gathered information from the available data. ';

    // Find the most useful tool result
    let foundUseful = false;
    for (let i = trace.length - 1; i >= 0; i--) {
      const t = trace[i];
      if (t.tool === 'correlate' || t.tool === 'correlate_weather_room' || t.tool === 'correlate_cross_room') {
        const corr = t.result?.corr;
        const n = t.result?.n || 0;
        if (Number.isFinite(corr)) {
          const strength = Math.abs(corr) > 0.7 ? 'strong' : Math.abs(corr) > 0.4 ? 'moderate' : 'weak';
          const direction = corr > 0 ? 'positive' : 'negative';
          fallbackAnswer = `The correlation is ${corr.toFixed(3)}, showing a ${strength} ${direction} relationship (based on ${n} data pairs).`;
          foundUseful = true;
          break;
        }
      } else if (t.tool === 'stats') {
        const stats = t.result;
        if (stats && Number.isFinite(stats.avg)) {
          fallbackAnswer = `Statistics: average ${stats.avg.toFixed(2)}, range ${stats.min?.toFixed(2)}-${stats.max?.toFixed(2)} (${stats.count} samples).`;
          foundUseful = true;
          break;        }
      }
    }

    // If no useful data, inject knowledge pack guidance
    if (!foundUseful && knowledgeSnippets) {
      fallbackAnswer += '\n\nBased on best practices and available knowledge:\n' + knowledgeSnippets;
    }

    return { 
      message: { 
        role: 'assistant', 
        content: fallbackAnswer
    },

    // Helper: weather by current scope (uses inferred building)
    weather_fetch_by_scope({ fields = [], start = null, end = null, limit = 2000, room = null }) {
      try {
  // Infer building name from roomId using graph snapshot
  function inferBuildingFromRoom(roomId) {
    try {
      const snap = loadGraphSnapshot(); if (!snap) return null;
      const nodes = snap.nodes || []; const links = snap.links || [];
      const byId = new Map(nodes.map(n => [n.id, n]));
      const z = nodes.find(n => (n.nodeType||n.label)==='Zone' && n.roomId === roomId);
      if (!z) return null;
      const lf = links.find(l => l.source===z.id && l.rel==='BELONGS_TO_FLOOR');
      const f = lf ? byId.get(lf.target) : null;
      if (f) {
        const lb = links.find(l => l.source===f.id && l.rel==='BELONGS_TO_BUILDING');
        const b = lb ? byId.get(lb.target) : null; return b?.name || null;
      }
      const lb2 = links.find(l => l.source===z.id && (l.rel==='BELONGS_TO_BUILDING' || l.rel==='IN_BUILDING'));
      const b2 = lb2 ? byId.get(lb2.target) : null; return b2?.name || null;
    } catch { return null; }
  }

  let lastBuildingForWeather = null;
  let lastSelectionRooms = [];
  let lastRoom = null;
        let building = lastBuildingForWeather || null;
        let roomRef = room || (lastRoom && lastRoom !== 'ALL' ? lastRoom : (lastSelectionRooms[0] || null));
        if (!building && roomRef) building = inferBuildingFromRoom(roomRef);
        const arr = (typeof loadWeather === 'function') ? loadWeather(building || null) : [];
        const out = [];
        for (const r of arr) {
          if (!withinRange(r.ts, start, end)) continue;
          const o = { ts: r.ts };
          for (const f of fields) if (f in r) o[f] = r[f];
          out.push(o);
          if (out.length >= (limit || 2000)) break;
        }
        return out;
      } catch (e) { return { error: String(e) }; }
    },
      chart: null, 
      trace 
    };
  }

  return { run };
}
