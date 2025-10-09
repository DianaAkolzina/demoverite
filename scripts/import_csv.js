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
      { name: 'compute_ratio', args: { room: 'string', table1: 'string', field1: 'string', table2: 'string', field2: 'string', start: 'number?', end: 'number?', time_window_ms: 'number?', zero_if_denominator_zero: 'boolean?' }, desc: 'Compute ratio of field1/field2 with time-window matching. Returns [{ts, ratio}]. If zero_if_denominator_zero=true, returns 0 when denominator is 0, otherwise skips that point' },
      { name: 'stats', args: { room: 'string', table: 'string', field: 'string', start: 'number?', end: 'number?' }, desc: 'Compute count,min,max,avg,sum' },
      { name: 'correlate', args: { room: 'string', table1: 'string', field1: 'string', table2: 'string', field2: 'string', start: 'number?', end: 'number?', time_window_ms: 'number?' }, desc: 'Pearson correlation between two fields from room tables. Uses time-window matching (default ±30min) to handle different sampling rates' },
      { name: 'correlate_cross_room', args: { room1: 'string', table1: 'string', field1: 'string', room2: 'string', table2: 'string', field2: 'string', start: 'number?', end: 'number?', time_window_ms: 'number?' }, desc: 'Correlate metrics between different rooms with time-window matching' },
      { name: 'correlate_weather_room', args: { room: 'string', table: 'string', field_room: 'string', field_weather: 'string', start: 'number?', end: 'number?', time_window_ms: 'number?' }, desc: 'Correlate room metric with weather metric (temp, humidity, wind_speed, clouds, etc)' },
      { name: 'weather_correlate', args: { field1: 'string', field2: 'string', start: 'number?', end: 'number?' }, desc: 'Pearson correlation between two weather fields (temp, humidity, wind_speed, clouds, etc)' },
      { name: 'weather_fetch', args: { fields: 'string[]', start: 'number?', end: 'number?', limit: 'number?' }, desc: 'Fetch weather rows' },
      { name: 'fetch_table_meta', args: { room: 'string', table: 'string' }, desc: 'Get table size, ts range, and fields' },
      { name: 'dump_room', args: { room: 'string', start: 'number?', end: 'number?', max_rows_per_table: 'number?' }, desc: 'Return raw rows per table for the room (use carefully; may be large)'},
      { name: 'hour_of_day_stats', args: { room: 'string', table: 'string', field: 'string', start: 'number?', end: 'number?' }, desc: 'Aggregate a field by hour-of-day across the selected window, returning [{hour, count, avg, min, max}]' },
      { name: 'hourly_timeseries', args: { room: 'string', table: 'string', field: 'string', start: 'number?', end: 'number?' }, desc: 'Aggregate to hourly buckets (absolute time), returns [{ts, avg}] for plotting' },
      { name: 'forecast_hourly_naive', args: { room: 'string', table: 'string', field: 'string', start: 'number?', end: 'number?', horizon_hours: 'number?' }, desc: 'Naive forecast: repeat last hourly value for N hours into future. Returns [{ts, forecast}]' },
      { name: 'forecast_hourly_linear', args: { room: 'string', table: 'string', field: 'string', start: 'number?', end: 'number?', horizon_hours: 'number?' }, desc: 'Linear trend forecast on hourly averages for N hours. Returns [{ts, forecast}]' },
      { name: 'forecast_from_profile', args: { room: 'string', table: 'string', field: 'string', start: 'number?', end: 'number?', days: 'number?' }, desc: 'Forecast next N days using hour-of-day profile from historical data. Returns [{ts, forecast}]' }
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
  
  const FIELD_SYNONYMS = {
    temperature: ['temp','temperaturec','temp_c'],
    people_count: ['people','count','occupants'],
    virusrisk: ['virus_risk','virusrisk','risk'],
    total_kwh: ['totalkwh','kwh_total','energy_total'],
    humidity: ['hum','rh','relativehumidity'],
    co2: ['co2ppm','carbondioxide']
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
      .map(([ts,b]) => ({ ts, avg: b.n ? b.sum/b.n : null }));
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
    
    cleaning_time_suggestion({ room, start = null, end = null }) {
      const stats = tools.hour_of_day_stats({ 
        room, 
        table: 'people', 
        field: 'people_count', 
        start, 
        end 
      });
      const ranked = stats
        .filter(x => x.avg != null)
        .sort((a,b)=> (a.avg||Infinity) - (b.avg||Infinity))
        .slice(0,3);
      return ranked;
    },
    
    busiest_day_of_week({ room, start = null, end = null }) {
      const people = (loadRoomTables(room).people || [])
        .filter(r => withinRange(r.ts, start, end));
      const days = Array.from({length:7}, () => ({ sum:0, n:0 }));
      for (const r of people) { 
        const d = new Date(r.ts).getDay(); 
        const v = Number(r.people_count)||0; 
        days[d].sum+=v; 
        days[d].n++; 
      }
      const avgs = days.map((b,i)=> ({ 
        weekday:i, 
        avg: b.n? b.sum/b.n : null 
      }));
      const best = avgs
        .filter(x=>x.avg!=null)
        .sort((a,b)=> b.avg - a.avg)[0] || null;
      return { byWeekday: avgs, best };
    },
    
    comfort_temp_compliance({ room, min = 20, max = 22, start = null, end = null }) {
      const temp = (loadRoomTables(room).env || loadRoomTables(room).iaq || [])
        .filter(r => withinRange(r.ts, start, end));
      let ok=0, n=0; 
      for (const r of temp) { 
        const t = Number(r.temperature); 
        if (Number.isFinite(t)) { 
          n++; 
          if (t>=min && t<=max) ok++; 
        } 
      }
      return { percent: n? (ok*100/n): null, n };
    }
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
    const ctx = buildContextSnippet(question, room, range);
    log('Question:', question);
    if (DEBUG) log('Context snippet schema keys:', Object.keys(ctx.schema));
    
    const rr = range || {};
    const sys = `You are a senior data analyst agent for building operations.
Selected room: ${room || '(none)'}.
Selected time window: start=${rr.start ?? 'none'} end=${rr.end ?? 'none'} (milliseconds since epoch).

Rules:
- Always assume the selected room/time window for analysis. Do NOT ask the user for dates; use the provided window as defaults for tools.
- When calling tools, if args omit room/start/end, fill them with the selected room and time window.
- PREDICTION/FORECAST queries: When user asks to "predict", "forecast", "what will be", "estimate future", etc., use the appropriate forecast tool:
  * forecast_from_profile: Best for daily patterns (temperature, humidity, occupancy over days/weeks)
  * forecast_hourly_linear: For trending metrics with clear direction
  * forecast_hourly_naive: Simple baseline (last value repeated)
  * Default horizon: 168 hours (1 week) or 7 days depending on tool
- If a tool returns no rows in the selected window (e.g., fetch_timeseries or stats shows 0), call fetch_table_meta to get the available ts range and decide whether to adapt.
- Prefer concise answers with the specific metrics you used. If plotting helps, include a HighchartsOptions JSON (no code fences).
- CRITICAL: Charts MUST include a "series" array with data. 
  Scatter plot example:
  {"chart":{"type":"scatter"},"title":{"text":"Temp vs Humidity"},"xAxis":{"title":{"text":"Temperature"}},"yAxis":{"title":{"text":"Humidity"}},"series":[{"name":"Data","data":[[20,65],[22,70],[21,68]]}]}
  
  Time series example:
  {"chart":{"type":"line"},"title":{"text":"Temperature Over Time"},"xAxis":{"type":"datetime"},"yAxis":{"title":{"text":"°C"}},"series":[{"name":"Temperature","data":[[1699000000000,20],[1699003600000,21]]}]}
  
  FORECAST chart example (shows historical + prediction):
  {"chart":{"type":"line"},"title":{"text":"Humidity Forecast"},"xAxis":{"type":"datetime"},"yAxis":{"title":{"text":"Humidity %"}},"series":[{"name":"Historical","data":[[ts1,val1],[ts2,val2]]},{"name":"Forecast","data":[[ts3,pred1],[ts4,pred2]],"dashStyle":"dash","color":"#ff6b6b"}]}
  
- When a forecast tool returns {historical, forecast}, ALWAYS create a chart with TWO series: one for historical data, one for predictions (use dashStyle:"dash" for forecast).
- ALWAYS transform tool results into chart data arrays before including in the chart object.
- PARALLEL TOOL CALLS: You can call MULTIPLE tools at once to gather all needed information efficiently:
  {"action":"tool_calls","tools":[{"tool":"<name1>","args":{...}},{"tool":"<name2>","args":{...}}]}
  
- Return either:
  * Single tool call: {"action":"tool_call","tool":"<n>","args":{...}}
  * Multiple parallel tool calls: {"action":"tool_calls","tools":[...]}
  * Final answer: {"action":"final","answer":"...","chart":<HighchartsOptions or null>}
  
- When presenting times, format timestamps as 'YYYY-MM-DD HH:mm' (local time) and hours of day as 'h AM/PM' (e.g., 1 PM, 2 PM).
- For "best time" style questions, prefer hour_of_day_stats (e.g., on people_count or co2) and explain the hour labels in human terms.
- ALWAYS provide final answer as properly formatted JSON with action:"final". Never just provide conversational text without the JSON structure.

Tools: ${buildToolSpec()}.
Notes: In weather data, temperature field is 'temp'. Use 'hour_of_day_stats' for "best time" by CO2 or occupancy.
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
    
    for (let step = 0; step < 10; step++) {
      const t0 = Date.now();
      const reply = await callGeminiChat(convo, {});
      const dt = Date.now() - t0;
      log(`LLM step ${step} took ${dt}ms`);
      
      if (!reply) break;
      if (DEBUG) log('LLM raw reply:', reply.slice(0, 600));
      
      // Force finalization if we've made enough tool calls
      if (totalToolCalls >= 2 && step >= 1) {
        log('Strongly encouraging finalization after', totalToolCalls, 'tool calls at step', step);
        // Inject a strong hint to finalize
        if (!reply.includes('"action":"final"')) {
          const isRatioQuery = question.toLowerCase().includes('per person') || 
                               question.toLowerCase().includes('per capita') ||
                               question.toLowerCase().includes('ratio');
          
          let hint = `CRITICAL: You have called ${totalToolCalls} tools and gathered the necessary data. You MUST now provide a final answer.`;
          
          if (isRatioQuery) {
            hint += `\n\nFor ratio queries like "${question}", use the compute_ratio tool result to create a chart with dataRef:
{
  "action":"final",
  "answer":"Here is the CO2 per person over time. When occupancy is 0, the ratio is shown as 0.",
  "chart":{
    "chart":{"type":"line"},
    "title":{"text":"CO2 per Person"},
    "xAxis":{"type":"datetime"},
    "yAxis":{"title":{"text":"CO2 / Person"}},
    "series":[{
      "name":"CO2 per Person",
      "dataRef":{"tool":"compute_ratio","xField":"ts","yField":"ratio"}
    }]
  }
}`;
          } else {
            hint += `\n\nProvide your response using this EXACT format:
{"action":"final","answer":"<describe what the data shows>","chart":<chart object with dataRef or null>}`;
          }
          
          convo.push({
            role: 'model',
            content: hint
          });
        }
      }
      
      // After step 5, if still not finalized, force wrap any response in JSON
      if (step >= 5 && totalToolCalls >= 2) {
        log('Step 5+ reached, will auto-wrap any plain text responses in JSON');
      }
      
      // Try to parse JSON response
      let obj = null;
      
      function extractJson(text) {
        // 1) code fence ```json ... ```
        const fence = text.match(/```json\s*([\s\S]*?)```/i);
        if (fence) {
          try { 
            const json = fence[1].trim();
            return JSON.parse(json); 
          } catch (e) {
            if (DEBUG) log('Failed to parse JSON from fence:', e.message);
            // If parsing failed due to truncation, try to extract partial chart
            try {
              const json = fence[1].trim();
              // Try to find the action field at least
              if (json.includes('"action"')) {
                // If it looks like a final with truncated chart, salvage what we can
                const actionMatch = json.match(/"action"\s*:\s*"(\w+)"/);
                const answerMatch = json.match(/"answer"\s*:\s*"([^"]+)"/);
                if (actionMatch && actionMatch[1] === 'final' && answerMatch) {
                  log('Salvaging truncated final response');
                  return {
                    action: 'final',
                    answer: answerMatch[1],
                    chart: null // Skip truncated chart
                  };
                }
              }
            } catch {}
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
                  } catch (e) {
                    if (DEBUG) log('Failed to parse JSON from action search:', e.message);
                  }
                  break;
                }
              }
            }
          }
        }
        
        // 3) last resort
        try { 
          return JSON.parse(text); 
        } catch (e) {
          if (DEBUG) log('Failed to parse entire text as JSON:', e.message);
        }
        
        return null;
      }
      
      obj = extractJson(reply);
      
      if (!obj) {
        // Check if response looks truncated (ends with incomplete data)
        const trimmed = reply.trim();
        if (trimmed.includes('"action":"final"') && (
            trimmed.endsWith('[') || 
            trimmed.endsWith(',') || 
            trimmed.match(/\[\d+$/))) {
          log('Detected truncated response with embedded data arrays');
          convo.push({
            role: 'model',
            content: `ERROR: Your response was truncated because you embedded data arrays directly in the JSON. You MUST use "dataRef" to reference tool results instead.

CORRECT format:
{
  "action":"final",
  "answer":"...",
  "chart":{
    "chart":{"type":"line"},
    "title":{"text":"Occupancy"},
    "xAxis":{"type":"datetime"},
    "yAxis":{"title":{"text":"People"}},
    "series":[{
      "name":"Occupancy",
      "dataRef":{"tool":"fetch_timeseries","xField":"ts","yField":"people_count"}
    }]
  }
}

WRONG format (DO NOT DO THIS):
{
  "action":"final",
  "chart":{
    "series":[{"data":[[1715122800000,0],[1715130000000,6],...]}]
  }
}

Now provide the final answer again using dataRef references.`
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
        
        log('Parse failure: expecting JSON action');
        convo.push({ 
          role: 'model', 
          content: 'ERROR: You must respond with a valid JSON object containing "action" field. Use {"action":"tool_call",...} or {"action":"tool_calls",...} or {"action":"final",...}' 
        });
        continue;
      }
      
      // Handle parallel tool calls
      if (obj.action === 'tool_calls' && Array.isArray(obj.tools)) {
        log(`Parallel tool calls (${obj.tools.length} tools):`, obj.tools.map(t => t.tool));
        totalToolCalls += obj.tools.length;
        
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
        
        // Validate chart structure and resolve dataRefs
        if (DEBUG && obj.chart) {
          log('Chart object received:', JSON.stringify(obj.chart, null, 2).slice(0, 1000));
        }
        
        const validChart = validateChart(obj.chart, trace);
        if (obj.chart && !validChart) {
          log('Chart validation failed - returning without chart');
        }
        
        return { 
          message: { role: 'assistant', content: obj.answer || reply }, 
          chart: validChart, 
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
        return {
          message: { 
            role: 'assistant', 
            content: 'I gathered the data you requested but encountered an issue formatting the final response. Please try rephrasing your question.' 
          },
          chart: null,
          trace
        };
      }
      if (last && last.length > 40 && !last.includes('respond with a JSON') && !last.includes('ERROR:')) {
        return { 
          message: { role: 'assistant', content: last }, 
          chart: null, 
          trace 
        };
      }
    }
    
    // Fallback plain answer if agent loop did not converge
    return { 
      message: { 
        role: 'assistant', 
        content: 'Unable to complete tool-based reasoning. Try rephrasing or narrowing the question.' 
      }, 

      
      chart: null, 
      trace 
    };
  }

  return { run };
}