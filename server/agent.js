import { buildDocsFromData, buildRagIndex } from './rag.js';
import fs from 'fs';
import path from 'path';

export function createAgent({ dataDir, listRooms, loadRoomTables, loadWeather, callGeminiChat }) {
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

  function toolDefs() {
    return [
      { name: 'list_rooms', args: {}, desc: 'List available rooms' },
      { name: 'list_tables', args: { room: 'string' }, desc: 'List available tables in a room' },
      { name: 'get_schema', args: { room: 'string', table: 'string' }, desc: 'Get first row keys for a table' },
      { name: 'fetch_timeseries', args: { room: 'string', table: 'string', fields: 'string[]', start: 'number?', end: 'number?', limit: 'number?', after_ts: 'number?' }, desc: 'Fetch timeseries points as [{ts, field1, ...}] with optional paging using after_ts' },
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
      { name: 'forecast_polyfit', args: { room: 'string', table: 'string', field: 'string', start: 'number?', end: 'number?', degree: 'number?', horizon_hours: 'number?' }, desc: 'Polynomial regression forecast (degree 2)' }
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
          if (trace[i].tool === ref.tool) {
            toolResult = trace[i].result;
            break;
          }
        }
        
        if (!toolResult) {
          log('Warning: Could not find tool result for', ref.tool);
          series.data = [];
          continue;
        }
        
        // Extract data based on the reference
        let sourceData = toolResult;
        
        // If ref specifies a field (e.g., "historical" or "forecast" from forecast tools)
        if (ref.field && toolResult[ref.field]) {
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
    
    // Resolve any dataRef references
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
      if (target === cn || syns.includes(target)) {
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
    const candidates = ['co2','voc','lux','pressure','humidity','temperature','people_count','people','pm1','pm25','pm10','value','total_kwh','energy'];
    for (const c of candidates) {
      if (fields.length >= 2) break;
      if (q.includes(c)) {
        const f = inferFieldName(c, availableSets);
        if (f && !fields.includes(f)) fields.push(f);
      }
    }
    return fields;
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
    battery: ['battery_level', 'batt'],
    rssi: ['signal', 'signalstrength'],
    value: ['reading', 'measurement'],
    unit: ['units'],
    sla: ['servicelevelagreement'],
    time: ['timestamp', 'datetime'],
    date: ['datestamp']
  };
  
  function resolveField(rows, field) {
    const keys = Object.keys(rows?.[0] || {});
    if (!keys.length) return field;
    const target = norm(field);
    let k = keys.find(x => norm(x) === target);
    if (k) return k;
    for (const [canon, syns] of Object.entries(FIELD_SYNONYMS)) {
      if (norm(canon) === target || syns.includes(target)) {
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
      const arr = t[table] || [];
      
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
      const arr = t[table] || [];
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
    
    weather_fetch({ fields = [], start = null, end = null, limit = 2000 }) {
      const arr = loadWeather();
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

    latest_value({ room, table, field, start = null, end = null }) {
      const t = loadRoomTables(room);
      const arr = (t[table] || []).filter(r => withinRange(r.ts, start, end));
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
        const arr = (t[table] || []).filter(x => withinRange(x.ts, start, end));
        let val = null, ts = null;
        for (let i = arr.length - 1; i >= 0; i--) {
          const v = arr[i][field];
          if (v != null && Number.isFinite(Number(v))) { val = Number(v); ts = arr[i].ts; break; }
        }
        out.push({ room: r, ts, value: val });
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
    busiest_day_of_week({ room, table, field, start = null, end = null, agg = 'avg' }) {
      const t = loadRoomTables(room);
      const arr = (t[table] || []).filter(r => withinRange(r.ts, start, end));
      const buckets = Array.from({ length: 7 }, () => ({ sum: 0, n: 0 }));
      for (const r of arr) { const v = Number(r[field]); if (!Number.isFinite(v)) continue; const d = new Date(r.ts).getDay(); buckets[d].sum += v; buckets[d].n += 1; }
      const stats = buckets.map((b,i)=>({ day:i, avg: b.n? b.sum/b.n : 0, sum: b.sum, n:b.n }));
      const key = agg==='sum'?'sum':'avg';
      const best = stats.reduce((a,b)=> b[key]>(a?.[key]??-Infinity)?b:a, null);
      return { best, stats };
    },
    weekday_weekend_comparison({ room, table, field, start = null, end = null }) {
      const t = loadRoomTables(room);
      const arr = (t[table] || []).filter(r => withinRange(r.ts, start, end));
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
    detect_spikes({ room, table, field, z = 3, start = null, end = null }) {
      const t = loadRoomTables(room);
      const arr = (t[table] || []).filter(r => withinRange(r.ts, start, end)).map(r => Number(r[field])).filter(Number.isFinite);
      if (arr.length < 5) return [];
      const mean = arr.reduce((a,b)=>a+b,0)/arr.length;
      const sd = Math.sqrt(arr.reduce((a,b)=>a+(b-mean)*(b-mean),0)/arr.length) || 1;
      const rows = (t[table] || []).filter(r => withinRange(r.ts, start, end));
      const out = [];
      for (const r of rows) { const v=Number(r[field]); if(!Number.isFinite(v)) continue; const zz=(v-mean)/sd; if (Math.abs(zz) >= z) out.push({ ts:r.ts, value:v, z:zz }); }
      return out;
    },
    histogram({ room, table, field, bins = 10, start = null, end = null }) {
      const t = loadRoomTables(room);
      const vals = (t[table] || []).filter(r => withinRange(r.ts, start, end)).map(r => Number(r[field])).filter(Number.isFinite);
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
    data_gaps({ room, table, field, max_gap_ms, start = null, end = null }) {
      const t = loadRoomTables(room);
      const arr = (t[table] || []).filter(r => withinRange(r.ts, start, end)).filter(r => Number.isFinite(Number(r[field])));
      const out = [];
      for (let i=1;i<arr.length;i++) { const gap = arr[i].ts - arr[i-1].ts; if (gap > max_gap_ms) out.push({ from: arr[i-1].ts, to: arr[i].ts, gap }); }
      return out;
    },
    distinct_values({ room, table, field, limit = 50 }) {
      const t = loadRoomTables(room);
      const set = new Set();
      for (const r of (t[table]||[])) { const v=r[field]; if (v!=null) { set.add(String(v)); if (set.size>=limit) break; } }
      return Array.from(set);
    }
,

    fetch_table_meta({ room, table }) {
      const t = loadRoomTables(room);
      const arr = t[table] || [];
      const n = arr.length;
      const fields = Object.keys(arr[0] || {});
      const tsMin = n ? arr[0].ts : null;
      const tsMax = n ? arr[n - 1].ts : null;
      return { count: n, fields, tsMin, tsMax };
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
    
    hour_of_day_stats({ room, table, field, start = null, end = null }) {
      const t = loadRoomTables(room);
      const arr = t[table] || [];
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

  function buildContextSnippet(question, room, range) {
    const hits = rag.search(question, 6);
    const head = hits.map(h => 
      `Score:${h.score.toFixed(3)} Meta:${JSON.stringify(h.meta)}\n${h.text}`
    ).join('\n---\n');
    
    const schema = room ? 
      Object.fromEntries(
        Object.entries(loadRoomTables(room))
          .map(([k, v]) => [k, Object.keys(v?.[0] || {})])
      ) : {};
    
    const meta = {};
    if (room) {
      const tables = loadRoomTables(room);
      for (const [t, rows] of Object.entries(tables)) {
        const n = rows.length;
        const tsMin = n ? rows[0].ts : null;
        const tsMax = n ? rows[n-1].ts : null;
        meta[t] = { count: n, tsMin, tsMax };
      }
    }
    return { retrieved: head, schema, meta, range, room };
  }

  async function run(messages, { room, range }) {
    const question = messages[messages.length - 1]?.content || '';

    // --- QUERY ENRICHMENT: RAG Knowledge Pack ---
    const ragHits = rag.search(question, 6);
    const knowledgeSnippets = ragHits
      .filter(h => h.meta?.type === 'knowledge')
      .map(h => `From ${h.meta.file}: ${h.text}`)
      .join('\n---\n');
    // --------------------------------------------

    const ctx = buildContextSnippet(question, room, range);
    log('Question:', question);
    if (DEBUG) log('Context snippet schema keys:', Object.keys(ctx.schema));

    const rr = range || {};
    // Inject knowledge enrichment into system prompt
    const startDate = rr.start ? new Date(rr.start) : null;
const endDate = rr.end ? new Date(rr.end) : null;
const startFmt = startDate ? `${startDate.toLocaleString()} (UTC: ${startDate.toISOString().replace('T', ' ').slice(0, 16)})` : 'none';
const endFmt = endDate ? `${endDate.toLocaleString()} (UTC: ${endDate.toISOString().replace('T', ' ').slice(0, 16)})` : 'none';

const sys = `You are a senior data analyst agent for building operations.
Selected room: ${room || '(none)'}.
Selected time window: 
- Local: ${startFmt} to ${endFmt}
- Epoch ms: start=${rr.start ?? 'none'} end=${rr.end ?? 'none'}

MANDATORY: Always use this time window for all analysis and answers. Do NOT invent or assume any other period. If the user asks "what time period are you analysing", repeat this exact window.
=== KNOWLEDGE PACK ENRICHMENT ===
${knowledgeSnippets || 'No extra knowledge found for this query.'}

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
Context: ${JSON.stringify(ctx).slice(0, 5000)}`;

    const convo = [
      { role: 'user', content: sys },
      ...messages
    ];

    const trace = [];
    let lastToolSig = '';
    let repeatCount = 0;
    let totalToolCalls = 0;
    
    for (let step = 0; step < 6; step++) {
      const t0 = Date.now();
      const reply = await callGeminiChat(convo, {});
      const dt = Date.now() - t0;
      log(`LLM step ${step} took ${dt}ms`);
      
      if (!reply) break;
      if (DEBUG) log('LLM raw reply:', reply.slice(0, 600));
      
      // Force finalization if we've made enough tool calls
      if (totalToolCalls >= 2 && step >= 1) {
        const recentlyPaired = trace.some(t => t.tool === 'pair_timeseries');
        if (recentlyPaired && step < 4) {
          // Allow one extra iteration to let the model produce a chart using the paired dataRef
          log('Skipping forced finalization to allow scatter pairing (step', step, ')');
        } else {
          log('Strongly encouraging finalization after', totalToolCalls, 'tool calls at step', step);
        
        // CRITICAL: After 2 tools and step 2+, FORCE finalization with very explicit instructions
        if (step >= 2) {
          const ql = question.toLowerCase();
          const isCorrelationPlot = ql.includes('correlation') && (ql.includes('plot') || ql.includes('show'));
          const isScatterPlot = ql.includes('scatter') || ql.includes('scatterplot');
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
      if (obj.action === 'tool_call') {
        const { tool, args } = obj;
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
        
        // Feed back a structured tool result frame
        convo.push({ 
          role: 'model', 
          content: `{"tool_result": { "tool": ${JSON.stringify(tool)}, "args": ${JSON.stringify(filledArgs)}, "result": ${JSON.stringify(result).slice(0, 10000)} }}` 
        });
        
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
            return { 
              message: { role: 'assistant', content: answer }, 
              chart: null, 
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
            const fields = parseFieldsFromQuestion(question, tablesSets);
            if (fields.length >= 2) {
              // Prefer scatter for 2-field comparisons
              obj.chart = {
                chart: { type: 'scatter' },
                title: { text: `${fields[0]} vs ${fields[1]}` },
                xAxis: { title: { text: fields[0] } },
                yAxis: { title: { text: fields[1] } },
                series: [{ name: `${fields[0]} vs ${fields[1]}`, dataRef: { tool: 'pair_timeseries', xField: 'x', yField: 'y', field1: fields[0], field2: fields[1] } }]
              };
            } else if (fields.length === 1 || wantsChart(question)) {
              const f = fields[0] || 'temperature';
              obj.chart = {
                chart: { type: 'line' },
                title: { text: `${f} over time` },
                xAxis: { type: 'datetime' },
                yAxis: { title: { text: f } },
                series: [{ name: f, dataRef: { tool: 'fetch_timeseries', xField: 'ts', yField: f } }]
              };
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
              const found = trace.some(t => t.tool === ref.tool);
              if (!found) {
                // Prepare tool call args
                let args = {};
                if (ref.tool === 'fetch_timeseries') {
                  // Try to auto-detect the correct table for the requested field
                  let table = null;
                  const tables = loadRoomTables(room);
                  for (const [tname, rows] of Object.entries(tables)) {
                    if (rows.length && Object.keys(rows[0]).includes(ref.yField)) {
                      table = tname;
                      break;
                    }
                  }
                  // Fallback to 'iaq' if not found
                  args = {
                    room: room,
                    table: table || 'iaq',
                    fields: [ref.yField],
                    start: (range && range.start) || undefined,
                    end: (range && range.end) || undefined
                  };
                } else if (ref.tool === 'pair_timeseries') {
                  // Attempt to infer fields from ref or series name
                  const tables = loadRoomTables(room);
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
                  // Fallback: try common fields
                  const candidates = ['voc','lux','co2','humidity','temperature','people_count','value'];
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
                    room: room,
                    table1: t1,
                    field1: f1,
                    table2: t2,
                    field2: f2,
                    start: (range && range.start) || undefined,
                    end: (range && range.end) || undefined
                  };
                } else if (ref.tool === 'pair_timeseries') {
                  // Try to use ref.field1/field2 if present; otherwise infer from series name
                  const tables = loadRoomTables(room);
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
                  const candidates = ['voc','lux','co2','humidity','temperature','people_count','value','pressure'];
                  f1 = f1 || candidates.find(c => Object.values(allFields).some(set => set.has(c)));
                  f2 = f2 || candidates.find(c => c !== f1 && Object.values(allFields).some(set => set.has(c)));
                  function findTableForField(field) {
                    for (const [t, set] of Object.entries(allFields)) if (set.has(field)) return t;
                    return Object.keys(tables)[0] || 'iaq';
                  }
                  const t1 = findTableForField(f1);
                  const t2 = findTableForField(f2);
                  args = { room, table1: t1, field1: f1, table2: t2, field2: f2, start: (range && range.start) || undefined, end: (range && range.end) || undefined };
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
        const validChart = validateChart(obj.chart, trace);
        if (obj.chart && !validChart) {
          log('Chart validation failed - returning without chart');
        }

        return {
          message: { role: 'assistant', content: obj.answer || reply },
          chart: validChart,
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
        
        // Try to construct a useful answer from the trace
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
          if (fields.length >= 2) {
            autoChart = {
              chart: { type: 'scatter' },
              title: { text: `${fields[0]} vs ${fields[1]}` },
              xAxis: { title: { text: fields[0] } },
              yAxis: { title: { text: fields[1] } },
              series: [{ name: `${fields[0]} vs ${fields[1]}`, dataRef: { tool: 'pair_timeseries', xField: 'x', yField: 'y', field1: fields[0], field2: fields[1] } }]
            };
          } else if (fields.length === 1 || wantsChart(question)) {
            const f = fields[0] || 'temperature';
            autoChart = {
              chart: { type: 'line' },
              title: { text: `${f} over time` },
              xAxis: { type: 'datetime' },
              yAxis: { title: { text: f } },
              series: [{ name: f, dataRef: { tool: 'fetch_timeseries', xField: 'ts', yField: f } }]
            };
          }
        } catch {}
        return { 
          message: { role: 'assistant', content: last }, 
          chart: autoChart, 
          trace 
        };
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
      chart: null, 
      trace 
    };
  }

  return { run };
}
