import http from 'http';
import fs from 'fs';
import path from 'path';
import url from 'url';
import { createAgent } from './agent.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const csvexDir = process.env.CSV_DIR
  ? path.resolve(root, process.env.CSV_DIR)
  : path.join(root, 'CSVex');

// Simple env loader
const envPath = path.join(root, '.env');
if (fs.existsSync(envPath)) {
  const raw = fs.readFileSync(envPath, 'utf8');
  raw.split(/\r?\n/).forEach((line) => {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2];
  });
}

const LLM_TEMPERATURE = Number(process.env.LLM_TEMPERATURE ?? 0.3);
const LLM_MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS ?? 2048); // Increased from 800 to 2048
const LLM_DEBUG = (process.env.LLM_DEBUG === '1') || (process.env.LOG_LEVEL === 'debug');

const USE_LLM = (process.env.USE_LLM || 'false').toLowerCase() === 'true';
const LLM_PROVIDER = process.env.LLM_PROVIDER || 'gemini';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'models/gemini-2.5-flash';


const dataDir = path.join(root, 'data');
const publicDir = path.join(root, 'public');

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function serveStatic(req, res) {
  let pathname = url.parse(req.url).pathname;
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.join(publicDir, pathname);
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404); res.end('Not Found'); return;
    }
    const ext = path.extname(filePath);
    const map = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
    res.writeHead(200, { 'Content-Type': map[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function listRooms() {
  if (!fs.existsSync(csvexDir)) return [];
  return fs.readdirSync(csvexDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
}

// Helper to parse CSV files
function parseCSV(filePath) {
  const rows = [];
  if (!fs.existsSync(filePath)) return rows;
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return rows;
  const headers = lines[0].split(',');
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(',');
    const row = {};
    headers.forEach((h, idx) => {
      let v = vals[idx];
      if (h === 'ts') v = Number(v);
      else if (!isNaN(Number(v))) v = Number(v);
      row[h] = v;
    });
    rows.push(row);
  }
  return rows;
}

function loadRoomTables(room) {
  const roomDir = path.join(csvexDir, room);
  if (!fs.existsSync(roomDir)) return {};
  const files = fs.readdirSync(roomDir).filter(f => f.endsWith('.csv'));
  const out = {};
  files.forEach(f => {
    const table = f.replace(/\.csv$/, '');
    const filePath = path.join(roomDir, f);
    out[table] = parseCSV(filePath);
  });
  // Normalize: sort each table by ts ascending and drop rows without ts
  for (const k of Object.keys(out)) {
    const arr = (out[k] || []).filter(r => r && r.ts != null);
    arr.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
    out[k] = arr;
  }
  return out;
}

function findFieldTable(room, field) {
  const tables = loadRoomTables(room);
  const target = String(field || '').toLowerCase();
  for (const [name, rows] of Object.entries(tables)) {
    const first = rows?.[0] || {};
    for (const k of Object.keys(first)) {
      if (k !== 'ts' && String(k).toLowerCase() === target) return { table: name, field: k };
    }
  }
  for (const [name, rows] of Object.entries(tables)) {
    const first = rows?.[0] || {};
    for (const k of Object.keys(first)) {
      if (k !== 'ts' && String(k).toLowerCase().includes(target)) return { table: name, field: k };
    }
  }
  return null;
}

function withinRange(ts, start, end) {
  return (!start || ts >= start) && (!end || ts <= end);
}

function loadWeather() {
  try {
    const csv1 = path.join(csvexDir, 'weather', 'weather.csv');
    const csv2 = path.join(csvexDir, 'weather.csv');
    const csvPath = fs.existsSync(csv1) ? csv1 : (fs.existsSync(csv2) ? csv2 : null);
    if (!csvPath) return [];
    return parseCSV(csvPath).map(r => ({
      ts: Number(r.ts),
      temp: Number(r.temp),
      humidity: Number(r.humidity),
      pressure: Number(r.pressure),
      wind_speed: Number(r.wind_speed),
      wind_deg: Number(r.wind_deg),
      clouds: Number(r.clouds),
      weather_main: r.weather_main,
      weather_desc: r.weather_desc
    }));
  } catch { return []; }
}

// Basic analytics helpers used both by rule fallback and for LLM context
const analytics = {
  roomOccupancySummary(roomData, start, end) {
    const people = roomData.people || [];
    let total = 0, count = 0, maxVal = -Infinity, maxTs = null;
    people.forEach(r => {
      if (!r || r.ts == null || r.people_count == null) return;
      if (!withinRange(r.ts, start, end)) return;
      const v = Number(r.people_count) || 0;
      total += v; count += 1;
      if (v > maxVal) { maxVal = v; maxTs = r.ts; }
    });
    const avg = count ? total / count : 0;
    return { avg, peak: maxVal > -Infinity ? maxVal : 0, peakTs: maxTs };
  },
  energySummary(roomData, start, end) {
    const energy = roomData.energy || [];
    let total = 0;
    energy.forEach(r => {
      if (!r || r.ts == null || r.value == null) return;
      if (!withinRange(r.ts, start, end)) return;
      total += Number(r.value) || 0;
    });
    return { total };
  }
};

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

// Generic retry with exponential backoff (for 429/5xx/network errors)
async function fetchWithRetry(urlStr, options, { retries = 3, baseDelayMs = 500, maxDelayMs = 4000 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeoutMs = options?.timeoutMs ?? 15000;
    const to = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(urlStr, { ...options, signal: controller.signal, headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(options?.headers || {}) } });
      clearTimeout(to);
      if (res.ok) return res;
      // Retry for 429 / 5xx
      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        if (LLM_DEBUG) console.log(`[LLM] HTTP ${res.status} on ${urlStr}. Retrying...`);
        const delay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      // Non-retryable
      if (LLM_DEBUG) {
        try { const errTxt = await res.text(); console.log('[LLM] Error body:', errTxt.slice(0, 500)); } catch {}
      }
      lastErr = new Error(`LLM HTTP ${res.status}`);
      break;
    } catch (e) {
      clearTimeout(to);
      lastErr = e;
      if (LLM_DEBUG) console.log(`[LLM] Network error: ${String(e)}. Retrying...`);
      const delay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
      await new Promise(r => setTimeout(r, delay));
      continue;
    }
  }
  throw lastErr || new Error('LLM request failed');
}

function modelIdBare(model) {
  const m = model || 'gemini-2.5-flash';
  return m.replace(/^models\//, '');
}

function buildGenerationConfig() {
  const cfg = {
    temperature: Number.isFinite(LLM_TEMPERATURE) ? LLM_TEMPERATURE : 0.3,
    maxOutputTokens: Number.isFinite(LLM_MAX_TOKENS) ? LLM_MAX_TOKENS : 2048 // Increased default
  };
  return cfg;
}

async function tryGeminiSDK(contents) {
  // Try @google/generative-ai if installed; otherwise return null
  try {
    const mod = await import('@google/generative-ai').catch(() => null);
    if (!mod) return null;
    const { GoogleGenerativeAI } = mod;
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const modelId = (GEMINI_MODEL || 'gemini-2.5-flash').replace(/^models\//, '');
    const model = genAI.getGenerativeModel({ model: modelId, generationConfig: { temperature: LLM_TEMPERATURE, maxOutputTokens: LLM_MAX_TOKENS } });
    const result = await model.generateContent({ contents });
    const resp = result?.response;
    const txt = resp?.text?.trim?.();
    if (txt) return txt;
    const cands = resp?.candidates || [];
    const parts = [];
    for (const c of cands) {
      const p = c?.content?.parts || [];
      for (const part of p) if (part?.text) parts.push(part.text);
    }
    return parts.length ? parts.join('\n') : null;
  } catch (e) {
    if (LLM_DEBUG) console.log('[LLM] SDK path failed:', String(e));
    return null;
  }
}

async function callGemini(prompt, context) {
  if (!USE_LLM || LLM_PROVIDER !== 'gemini' || !GEMINI_API_KEY) return null;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelIdBare(GEMINI_MODEL))}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const body = {
    contents: [
      { role: 'user', parts: [{ text: prompt }] },
      { role: 'user', parts: [{ text: `Context JSON (truncated):\n${JSON.stringify(context).slice(0, 6000)}` }] }
    ],
    generationConfig: buildGenerationConfig()
  };
  try {
    // Try SDK first if present
    const sdkText = await tryGeminiSDK(body.contents);
    if (sdkText && sdkText.trim()) return sdkText;
    const res = await fetchWithRetry(endpoint, { method: 'POST', body: JSON.stringify(body), timeoutMs: 20000 });
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('\n') || '';
    return text;
  } catch (e) {
    if (LLM_DEBUG) console.log('[LLM] callGemini failed:', String(e));
    return null;
  }
}

async function callGeminiChat(messages, context) {
  if (!USE_LLM || LLM_PROVIDER !== 'gemini' || !GEMINI_API_KEY) return null;
  const contents = [];
  for (const m of messages.slice(-12)) {
    const role = m.role === 'assistant' || m.role === 'model' ? 'model' : 'user';
    contents.push({ role, parts: [{ text: m.content }] });
  }
  contents.push({ role: 'user', parts: [{ text: `Context JSON (truncated):\n${JSON.stringify(context).slice(0, 6000)}` }] });
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelIdBare(GEMINI_MODEL))}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  try {
    // Try SDK path first if installed
    const sdkText = await tryGeminiSDK(contents);
    if (sdkText && sdkText.trim()) return sdkText;
    const res = await fetchWithRetry(endpoint, { method: 'POST', body: JSON.stringify({ contents, generationConfig: buildGenerationConfig() }), timeoutMs: 25000 });
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('\n') || '';
    return text;
  } catch (e) {
    if (LLM_DEBUG) console.log('[LLM] callGeminiChat failed:', String(e));
    return null;
  }
}

function buildHighchartsSeriesFromTable(table, valueKey, start, end) {
  // Line charts: time on X axis (datetime), metric on Y axis
  const points = [];
  for (const r of table || []) {
    if (r?.ts == null || r?.[valueKey] == null) continue;
    if (!withinRange(r.ts, start, end)) continue;
    points.push([Number(r.ts), Number(r[valueKey])]);
  }
  return points;
}

function answerWithFallback(question, room, range) {
  const start = range?.start ?? null;
  const end = range?.end ?? null;
  const tables = loadRoomTables(room);
  const lower = (question || '').toLowerCase();
  let answer = 'No data available.';
  let chart = null;

  // Describe available data/metrics for the selected room
  if (lower.includes('what data do you see') || lower.includes('what metrics') || lower.includes('what meters')) {
    const summary = Object.entries(tables).map(([k, v]) => {
      const fields = Object.keys((v||[])[0] || {}).filter(x => x !== 'ts');
      const span = v && v.length ? `${new Date(v[0].ts).toISOString().slice(0,10)} → ${new Date(v[v.length-1].ts).toISOString().slice(0,10)}` : '—';
      return `${k}: [${fields.join(', ')}] (${(v||[]).length} rows, ${span})`;
    }).join('; ');
    return { answer: summary || 'No tables available.', chart: null };
  }

  if (lower.includes('how would you analyse') || lower.includes('how do you analyze')) {
    const parts = [];
    if (tables.people?.length) parts.push('- Occupancy: peak/avg, best time (by hour), weekly pattern');
    if (tables.iaq?.length) parts.push('- Air quality: CO2 vs occupancy, humidity comfort range, PM trends');
    if (tables.energy?.length) parts.push('- Energy: total and per-occupant, anomaly vs low occupancy');
    if (loadWeather()?.length) parts.push('- Weather correlation: temp vs occupancy/energy');
    return { answer: parts.length ? `Analysis plan:\n${parts.join('\n')}` : 'No data available for analysis in the selected range.', chart: null };
  }

  // Best time people leave (lowest occupancy hour) within selected window
  if ((lower.includes('most people leave') || lower.includes('discount') || lower.includes('coffees') || lower.includes('teas')) && tables.people?.length) {
    const people = (tables.people || []).filter(r => withinRange(r.ts, start, end) && Number.isFinite(Number(r.people_count)));
    const byHour = Array.from({ length: 24 }, () => ({ sum:0, n:0 }));
    for (const p of people) {
      const h = new Date(p.ts).getHours();
      const v = Number(p.people_count) || 0;
      byHour[h].sum += v; byHour[h].n += 1;
    }
    const stats = byHour.map((b, h) => ({ h, avg: b.n ? b.sum / b.n : null, n: b.n }));
    const ranked = stats.filter(s => s.avg != null).sort((a,b) => (a.avg - b.avg));
    if (ranked.length) {
      const fmt = (h) => {
        const ampm = h >= 12 ? 'PM' : 'AM';
        const hh = h % 12 === 0 ? 12 : (h % 12);
        return `${hh} ${ampm}`;
      };
      const top = ranked.slice(0, 3);
      answer = `Lowest average occupancy by hour: ${top.map(t => `${fmt(t.h)} (~${t.avg.toFixed(2)} people)`).join(', ')} based on ${people.length} samples in your selected period.`;
      const categories = stats.map(s => {
        const ampm = s.h >= 12 ? 'PM' : 'AM';
        const hh = s.h % 12 === 0 ? 12 : (s.h % 12);
        return `${hh} ${ampm}`;
      });
      const seriesData = stats.map(s => (s.avg != null ? Number(s.avg.toFixed(2)) : null));
      chart = {
        chart: { type: 'column' },
        title: { text: 'Average Occupancy by Hour' },
        xAxis: { categories, title: { text: 'Hour of day' } },
        yAxis: { title: { text: 'Average people' } },
        series: [{ name: 'People', data: seriesData }]
      };
      return { answer, chart };
    } else {
      return { answer: 'No occupancy data in the selected window to estimate leave times.', chart: null };
    }
  }

  // Cross-room questions
  if (lower.includes('any of the rooms') || lower.includes('which room')) {
    const rooms = listRooms();
    const summaries = rooms.map(r => {
      const t = loadRoomTables(r);
      const occ = analytics.roomOccupancySummary(t, start, end);
      return { room: r, avg: occ.avg, peak: occ.peak, peakTs: occ.peakTs };
    });
    if (lower.includes('not been used')) {
      const unused = summaries.filter(s => (s.avg || 0) === 0 && (s.peak || 0) === 0).map(s => s.room);
      answer = unused.length ? `Unused rooms in range: ${unused.join(', ')}` : 'All rooms show some usage in the selected range.';
      return { answer, chart: null };
    }
    if (lower.includes('busiest')) {
      const best = summaries.reduce((a, b) => (b.peak > (a?.peak ?? -Infinity) ? b : a), null);
      answer = best ? `Busiest room: ${best.room} (peak ${best.peak} at ${best.peakTs ? new Date(best.peakTs).toISOString() : 'n/a'})` : 'No data.';
      return { answer, chart: null };
    }
  }

  if (lower.includes('unoccupied') && (lower.includes('over 21') || lower.includes('> 21') || lower.includes('21 degrees'))) {
    const env = tables.env || [];
    const people = tables.people || [];
    const latestTs = Math.max(...[...env, ...people].filter(r => withinRange(r.ts, start, end)).map(r => r.ts || 0));
    const temp = env.filter(r => r.ts === latestTs).map(r => r.temperature)[0];
    const occ = people.filter(r => r.ts === latestTs).map(r => r.people_count)[0] || 0;
    const hot = (Number(temp) || 0) > 21;
    answer = `At ${new Date(latestTs).toISOString()}, occupancy=${occ}, temperature=${temp}. ${occ === 0 && hot ? 'Yes, unoccupied and over 21°C.' : 'Condition not met.'}`;
    chart = {
      title: { text: 'Temperature vs Time' },
      xAxis: { title: { text: 'Temperature (°C)' } },
      yAxis: { title: { text: 'Time' }, type: 'datetime' },
      series: [{ name: 'Temp', data: buildHighchartsSeriesFromTable(env, 'temperature', start, end) }]
    };
  } else if (lower.includes('busiest') || lower.includes('how many people') || lower.includes('occupy')) {
    const occ = analytics.roomOccupancySummary(tables, start, end);
    answer = `Average occupancy: ${occ.avg.toFixed(2)}, peak: ${occ.peak} at ${occ.peakTs ? new Date(occ.peakTs).toISOString() : 'n/a'}.`;
    chart = {
      title: { text: 'Occupancy vs Time' },
      xAxis: { type: 'datetime', title: { text: 'Time' } },
      yAxis: { title: { text: 'People' } },
      series: [{ name: 'People', data: buildHighchartsSeriesFromTable(tables.people, 'people_count', start, end) }]
    };
  } else if (lower.includes('save energy') || lower.includes('how can i save energy') || lower.includes('save energy?')) {
    answer = 'Energy-saving recommendations: 1) Align HVAC schedules with occupancy; pre-heat/pre-cool before peaks and reduce during lows. 2) Use demand-response windows to curtail non-critical loads. 3) Target 20–22°C to avoid over-heating/cooling. 4) Investigate high-energy periods with low occupancy and adjust setpoints/schedules. 5) Optimize lighting and plug loads with sensors and scheduling.';
    chart = null;
  } else if ((lower.includes('average') || lower.includes('avg')) && lower.includes('humidity')) {
    const envRows = (tables.env || []).filter(r => withinRange(r.ts, start, end) && Number.isFinite(Number(r.humidity)));
    const iaqRows = (tables.iaq || []).filter(r => withinRange(r.ts, start, end) && Number.isFinite(Number(r.humidity)));
    const series = iaqRows.length >= envRows.length ? iaqRows : envRows;
    let sum = 0, count = 0;
    for (const r of series) { const v = Number(r.humidity); if (Number.isFinite(v)) { sum += v; count++; } }
    const avg = count ? sum / count : 0;
    answer = count ? `Average humidity: ${avg.toFixed(2)}% based on ${count} samples.` : 'No humidity data in the selected range.';
    chart = count ? {
      title: { text: 'Humidity vs Time' },
      xAxis: { type: 'datetime', title: { text: 'Time' } },
      yAxis: { title: { text: 'Humidity (%)' } },
      series: [{ name: 'Humidity', data: buildHighchartsSeriesFromTable(series, 'humidity', start, end) }]
    } : null;
  } else if (lower.includes('describe') && lower.includes('humidity')) {
    const rows = ((tables.iaq || []).concat(tables.env || [])).filter(r => withinRange(r.ts, start, end) && Number.isFinite(Number(r.humidity)));
    let min = Infinity, max = -Infinity, sum = 0, n = 0;
    for (const r of rows) { const v = Number(r.humidity); if (Number.isFinite(v)) { if (v<min) min=v; if (v>max) max=v; sum+=v; n++; } }
    const avg = n ? sum/n : NaN;
    answer = n ? `Humidity is generally ${avg.toFixed(1)}% on average (range ${min.toFixed(1)}%–${max.toFixed(1)}%) over the selected period.` : 'No humidity data in the selected range.';
    chart = n ? {
      title: { text: 'Humidity vs Time' },
      xAxis: { type: 'datetime', title: { text: 'Time' } },
      yAxis: { title: { text: 'Humidity (%)' } },
      series: [{ name: 'Humidity', data: buildHighchartsSeriesFromTable(rows, 'humidity', start, end) }]
    } : null;
  } else if (lower.includes('weather')) {
    const wrows = loadWeather().filter(w => withinRange(w.ts, start, end));
    if (wrows.length) {
      let tSum=0, hSum=0, n=0, tMin=Infinity, tMax=-Infinity;
      for (const w of wrows) {
        const t = Number(w.temp); const h = Number(w.humidity);
        if (Number.isFinite(t)) { tSum+=t; if (t<tMin) tMin=t; if (t>tMax) tMax=t; }
        if (Number.isFinite(h)) { hSum+=h; }
        n++;
      }
      const tAvg = n ? tSum/n : NaN; const hAvg = n ? hSum/n : NaN;
      answer = `Weather summary for selected period: temperature avg ${Number.isFinite(tAvg)?tAvg.toFixed(1):'n/a'}°C (min ${Number.isFinite(tMin)?tMin.toFixed(1):'n/a'}°C, max ${Number.isFinite(tMax)?tMax.toFixed(1):'n/a'}°C); humidity avg ${Number.isFinite(hAvg)?hAvg.toFixed(1):'n/a'}%.`;
    chart = {
      title: { text: 'Weather vs Time' },
      xAxis: { type: 'datetime', title: { text: 'Time' } },
      yAxis: { title: { text: 'Value' } },
      series: [
        { name: 'Temperature (°C)', data: buildHighchartsSeriesFromTable(wrows, 'temp', start, end) },
        { name: 'Humidity (%)', data: buildHighchartsSeriesFromTable(wrows, 'humidity', start, end) }
      ]
    };
    } else {
      answer = 'No weather data in the selected range.';
      chart = null;
    }
  } else if ((lower.includes('best time') && (lower.includes('toilet') || lower.includes('bathroom') || lower.includes('restroom'))) || (lower.includes('best time') && (room?.toLowerCase?.() === 'toilet'))) {
    const people = (tables.people || []).filter(r => withinRange(r.ts, start, end) && Number.isFinite(Number(r.people_count)));
    const byHour = Array.from({ length: 24 }, () => ({ sum:0, n:0 }));
    for (const p of people) {
      const h = new Date(p.ts).getHours();
      const v = Number(p.people_count) || 0;
      byHour[h].sum += v; byHour[h].n += 1;
    }
    const avgs = byHour.map((b, h) => ({ h, avg: b.n ? b.sum / b.n : Infinity }));
    avgs.sort((a,b) => a.avg - b.avg);
    const best = avgs.filter(x => Number.isFinite(x.avg)).slice(0, 3);
    if (best.length) {
      const fmt = (h) => `${String(h).padStart(2,'0')}:00`;
      answer = `Lowest average occupancy by hour: ${best.map(b => `${fmt(b.h)} (~${b.avg.toFixed(2)} people)`).join(', ')}. Chosen from ${people.length} samples.`;
      chart = {
        title: { text: 'Occupancy vs Time' },
        xAxis: { title: { text: 'People' } },
        yAxis: { title: { text: 'Time' }, type: 'datetime' },
        series: [{ name: 'People', data: buildHighchartsSeriesFromTable(people, 'people_count', start, end) }]
      };
    } else {
      answer = 'No occupancy data to compute best time in the selected range.';
      chart = null;
    }
  } else if (lower.includes('energy')) {
    const e = analytics.energySummary(tables, start, end);
    answer = `Total energy (sum of instantaneous values): ${e.total.toFixed(2)}.`;
    chart = {
      title: { text: 'Energy vs Time' },
      xAxis: { type: 'datetime', title: { text: 'Time' } },
      yAxis: { title: { text: 'Energy (A or kWh)*' } },
      series: [{ name: 'Energy', data: buildHighchartsSeriesFromTable(tables.energy, 'value', start, end) }]
    };
  } else if ((lower.includes('average') || lower.includes('avg')) && lower.includes('humidity')) {
    const envRows = (tables.env || []).filter(r => withinRange(r.ts, start, end) && Number.isFinite(Number(r.humidity)));
    const iaqRows = (tables.iaq || []).filter(r => withinRange(r.ts, start, end) && Number.isFinite(Number(r.humidity)));
    const series = iaqRows.length >= envRows.length ? iaqRows : envRows;
    let sum = 0, count = 0;
    for (const r of series) { const v = Number(r.humidity); if (Number.isFinite(v)) { sum += v; count++; } }
    const avg = count ? sum / count : 0;
    answer = `Average humidity: ${avg.toFixed(2)}% based on ${count} samples.`;
    chart = {
      title: { text: 'Humidity vs Time' },
      xAxis: { title: { text: 'Humidity (%)' } },
      yAxis: { title: { text: 'Time' }, type: 'datetime' },
      series: [{ name: 'Humidity', data: buildHighchartsSeriesFromTable(series, 'humidity', start, end) }]
    };
  } else if (lower.includes('save energy') || lower.includes('how can i save energy') || lower.includes('save energy?')) {
    answer = 'Energy-saving recommendations: 1) Align HVAC schedules with occupancy; pre-heat/pre-cool before peaks and reduce during lows. 2) Use demand-response windows to curtail non-critical loads. 3) Target 20–22°C to avoid over-heating/cooling. 4) Investigate high-energy periods with low occupancy and adjust setpoints/schedules. 5) Optimize lighting and plug loads with sensors and scheduling.';
    chart = null;
  } else if (lower.includes('correlation') && lower.includes('weather') && lower.includes('occup')) {
    const weather = loadWeather();
    const people = tables.people || [];
    const pairs = [];
    for (const p of people) {
      if (!withinRange(p.ts, start, end)) continue;
      // nearest weather within 60min
      let best = null; let bestDt = Infinity;
      // quick search: weather sorted, but we do simple scan due to small samples
      for (const w of weather) {
        const dt = Math.abs((w.ts ?? 0) - p.ts);
        if (dt < bestDt) { best = w; bestDt = dt; }
        if (dt > 60*60*1000 && (w.ts ?? 0) > p.ts) break;
      }
      if (best && bestDt <= 60*60*1000) pairs.push([best.temp, Number(p.people_count) || 0]);
    }
    const corr = pearson(pairs.map(x => x[0]), pairs.map(x => x[1]));
    answer = `Pearson correlation between outdoor temperature and occupancy: ${Number.isFinite(corr) ? corr.toFixed(3) : 'n/a'} (n=${pairs.length}).`;
    chart = {
      title: { text: 'Weather/Occupancy vs Time' },
      xAxis: { type: 'datetime', title: { text: 'Time' } },
      yAxis: { title: { text: 'Value' } },
      series: [
        { name: 'Temperature (°C)', data: buildHighchartsSeriesFromTable(weather, 'temp', start, end) },
        { name: 'People', data: buildHighchartsSeriesFromTable(people, 'people_count', start, end) }
      ]
    };
  } else if (lower.includes('temperature should i make the rooms')) {
    answer = 'Target 20–22°C for typical office comfort; adjust for activity and clothing.';
  } else if (lower.includes('comfortable temperature range')) {
    const rooms = listRooms();
    const outside = [];
    for (const r of rooms) {
      const t = loadRoomTables(r);
      const env = (t.env || t.iaq || []).filter(row => withinRange(row.ts, start, end));
      const anyOut = env.some(row => row.temperature < 20 || row.temperature > 22);
      if (anyOut) outside.push(r);
    }
    answer = outside.length ? `Out of comfort range (20–22°C): ${outside.join(', ')}` : 'All rooms within 20–22°C for the selected range.';
  } else if (lower.includes('lighting') || lower.includes('light') || lower.includes('lux')) {
    const iaq = tables.iaq || [];
    const hasLux = iaq.length && iaq.some(r => r.lux != null);
    if (hasLux) {
      const data = buildHighchartsSeriesFromTable(iaq, 'lux', start, end);
      const n = data.length;
      let min=Infinity, max=-Infinity, sum=0;
      for (const p of data) { const v = p[1]; if (Number.isFinite(v)) { if (v<min) min=v; if (v>max) max=v; sum+=v; } }
      const avg = n ? sum/n : NaN;
      answer = `Lighting (lux) summary for selected period: avg ${Number.isFinite(avg)?avg.toFixed(1):'n/a'} lx (min ${Number.isFinite(min)?min.toFixed(1):'n/a'} lx, max ${Number.isFinite(max)?max.toFixed(1):'n/a'} lx).`;
      chart = {
        title: { text: 'Lux vs Time' },
        xAxis: { type: 'datetime', title: { text: 'Time' } },
        yAxis: { title: { text: 'Lux (lx)' } },
        series: [{ name: 'Lux', data }]
      };
    } else {
      answer = 'No lux (lighting) data found in the selected room for the chosen period.';
      chart = null;
    }
  }

  return { answer, chart };
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const { pathname, query } = parsed;

  if (pathname === '/api/rooms' && req.method === 'GET') {
    return sendJson(res, 200, { rooms: listRooms() });
  }

  if (pathname === '/api/weather' && req.method === 'GET') {
    const weather = loadWeather();
    return sendJson(res, 200, { count: weather.length, latest: weather.at(-1) || null });
  }

  if (pathname === '/api/schema' && req.method === 'GET') {
    const room = query.room;
    if (!room) return sendJson(res, 400, { error: 'room required' });
    const tables = loadRoomTables(room);
    const schema = Object.fromEntries(Object.entries(tables).map(([k, rows]) => {
      const first = rows?.[0] || {};
      const metrics = Object.keys(first).filter(col =>
        col !== 'raw data' && col !== 'units' && col !== 'ts'
      );
      return [k, metrics];
    }));
    return sendJson(res, 200, { schema });
  }

  if (pathname === '/api/meta' && req.method === 'GET') {
    const room = query.room;
    if (!room) return sendJson(res, 400, { error: 'room required' });
    const start = query.start ? Number(query.start) : null;
    const end = query.end ? Number(query.end) : null;
    const tables = loadRoomTables(room);
    const meta = {};
    for (const [tname, rows] of Object.entries(tables)) {
      const info = { count: rows.length, tsMin: null, tsMax: null, fields: [], fieldSpans: {}, types: {}, inRangeCount: 0 };
      const fieldSet = new Set();
      let minTs = Infinity, maxTs = -Infinity;
      for (const r of rows) {
        if (!r || r.ts == null) continue;
        const ts = Number(r.ts);
        if (Number.isFinite(ts)) {
          if (ts < minTs) minTs = ts;
          if (ts > maxTs) maxTs = ts;
        }
        if (withinRange(ts, start, end)) info.inRangeCount += 1;
        for (const [k, v] of Object.entries(r)) {
          if (k === 'ts') continue;
          fieldSet.add(k);
          const isNum = typeof v === 'number' || (typeof v === 'string' && !isNaN(Number(v)));
          if (info.types[k] == null) info.types[k] = isNum ? 'number' : 'string';
          if (v == null || (typeof v === 'number' && !Number.isFinite(v))) continue;
          const f = info.fieldSpans[k] || { tsMin: null, tsMax: null, count: 0 };
          // consider presence at this ts regardless of value type
          if (f.tsMin == null || ts < f.tsMin) f.tsMin = ts;
          if (f.tsMax == null || ts > f.tsMax) f.tsMax = ts;
          f.count += 1;
          info.fieldSpans[k] = f;
        }
      }
      info.fields = Array.from(fieldSet);
      info.tsMin = isFinite(minTs) ? minTs : null;
      info.tsMax = isFinite(maxTs) ? maxTs : null;
      meta[tname] = info;
    }
    // Weather meta
    const weatherArr = loadWeather();
    let wMeta = null;
    if (weatherArr.length) {
      const wInfo = { count: weatherArr.length, tsMin: null, tsMax: null, fieldSpans: {}, types: {}, inRangeCount: 0 };
      let minTs = Infinity, maxTs = -Infinity;
      for (const r of weatherArr) {
        const ts = Number(r.ts);
        if (Number.isFinite(ts)) { if (ts < minTs) minTs = ts; if (ts > maxTs) maxTs = ts; }
        if (withinRange(ts, start, end)) wInfo.inRangeCount += 1;
        for (const [k, v] of Object.entries(r)) {
          if (k === 'ts') continue;
          const isNum = typeof v === 'number' || (typeof v === 'string' && !isNaN(Number(v)));
          if (wInfo.types[k] == null) wInfo.types[k] = isNum ? 'number' : 'string';
          if (v == null || (typeof v === 'number' && !Number.isFinite(v))) continue;
          const f = wInfo.fieldSpans[k] || { tsMin: null, tsMax: null, count: 0 };
          if (f.tsMin == null || ts < f.tsMin) f.tsMin = ts;
          if (f.tsMax == null || ts > f.tsMax) f.tsMax = ts;
          f.count += 1;
          wInfo.fieldSpans[k] = f;
        }
      }
      wInfo.tsMin = isFinite(minTs) ? minTs : null;
      wInfo.tsMax = isFinite(maxTs) ? maxTs : null;
      wMeta = wInfo;
    }
    return sendJson(res, 200, { tables: meta, weather: wMeta });
  }

  if (pathname === '/api/series' && req.method === 'GET') {
    const room = query.room;
    const field = query.field;
    const start = query.start ? Number(query.start) : null;
    const end = query.end ? Number(query.end) : null;
    if (!room || !field) return sendJson(res, 400, { error: 'room and field required' });
    const match = findFieldTable(room, field);
    if (!match) return sendJson(res, 404, { error: 'field_not_found' });
    const tables = loadRoomTables(room);
    const arr = tables[match.table] || [];
    const data = [];
    for (const r of arr) {
      if (r?.ts == null || r?.[match.field] == null) continue;
      if (!withinRange(r.ts, start, end)) continue;
      const y = Number(r[match.field]);
      if (!Number.isFinite(y)) continue;
      data.push([Number(r.ts), y]);
    }
    return sendJson(res, 200, {
      room,
      table: match.table,
      field: match.field,
      count: data.length,
      data
    });
  }

  if (pathname === '/api/chat' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { messages = [], room, range } = JSON.parse(body || '{}');
        if (!room) return sendJson(res, 400, { error: 'room required' });

        // --- LOGGING ADDED HERE ---
        console.log('[API/chat] Received range:', range);
        if (range) {
          console.log('[API/chat] Start:', range.start, new Date(range.start).toISOString());
          console.log('[API/chat] End:', range.end, new Date(range.end).toISOString());
        }
        // --------------------------

        const userLast = [...messages].reverse().find(m => m.role === 'user' || m.role === 'User' || m.role === 'human');
        const question = userLast?.content || '';
        const tables = loadRoomTables(room);
        const context = {
          instruction: 'You are a building analytics chat assistant. Answer succinctly. If plotting helps, include a JSON HighchartsOptions with yAxis as time and xAxis as chosen metric. Do not include code fences in the JSON.',
          tables: Object.keys(tables),
          sampleRows: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.slice(0, 5)])),
          range: range || {},
          knowledge: loadKnowledge(),
          weatherSample: loadWeather().slice(-50)
        };

        // Use the tool-enabled agent (RAG + tools). If it can't complete, fall back to heuristics.
        const { message, chart } = await agent.run(messages.concat({ role: 'user', content: question }), { room, range });
        if (!message || !message.content || /^Unable to complete tool-based reasoning/i.test(message.content)) {
          const fb = answerWithFallback(question, room, range || {});
          return sendJson(res, 200, { message: { role: 'assistant', content: fb.answer }, chart: fb.chart, mode: 'fallback' });
        }
        return sendJson(res, 200, { message, chart, mode: 'agent' });
      } catch (e) {
        return sendJson(res, 500, { error: 'bad_request', detail: String(e) });
      }
    });
    return;
  }

  if (pathname === '/api/query' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { question, room, range } = JSON.parse(body || '{}');
        if (!room) return sendJson(res, 400, { error: 'room required' });

        // --- LOGGING ADDED HERE ---
        console.log('[API/query] Received range:', range);
        if (range) {
          console.log('[API/query] Start:', range.start, new Date(range.start).toISOString());
          console.log('[API/query] End:', range.end, new Date(range.end).toISOString());
        }
        // --------------------------

        const start = range?.start ?? null;
        const end = range?.end ?? null;
        const tables = loadRoomTables(room);

        // Prepare a concise context for LLM
        const context = {
          instruction: 'Answer succinctly. If plotting helps, return a Highcharts options JSON with yAxis as time and xAxis as the chosen metric. Also provide a short explanation.',
          tables: Object.keys(tables),
          sampleRows: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.slice(0, 5)])),
          range: { start, end },
          knowledge: loadKnowledge(),
          weatherSample: loadWeather().slice(-50)
        };

        const llmText = await callGemini(buildPrompt(question, room), context);

        if (llmText) {
          return sendJson(res, 200, { mode: 'llm', answer: llmText });
        }

        const fb = answerWithFallback(question, room, { start, end });
        return sendJson(res, 200, { mode: 'fallback', answer: fb.answer, chart: fb.chart });
      } catch (e) {
        return sendJson(res, 500, { error: 'bad_request', detail: String(e) });
      }
    });
    return;
  }

  if (pathname === '/api/knowledge' && req.method === 'GET') {
    return sendJson(res, 200, { files: listKnowledge() });
  }

  if (pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, useLLM: USE_LLM, provider: LLM_PROVIDER });
  }

  return serveStatic(req, res);
});

function buildPrompt(question, room) {
  return `You are a building analytics assistant. Answer the user's question about room "${room}" using the provided context.
If a chart will help, return a JSON block labeled HighchartsOptions that can be parsed by JSON.parse, with yAxis as time (datetime type) and xAxis as the metric of interest (temperature, energy, CO2, etc.). Keep text answer concise and include reasoning only if asked.`;
}

function listKnowledge() {
  const kdir = path.join(root, 'knowledge');
  if (!fs.existsSync(kdir)) return [];
  return fs.readdirSync(kdir).filter(f => f.endsWith('.md') || f.endsWith('.txt'));
}

function loadKnowledge() {
  const kdir = path.join(root, 'knowledge');
  const files = listKnowledge();
  return files.map(f => ({ name: f, text: fs.readFileSync(path.join(kdir, f), 'utf8').slice(0, 5000) }));
}

const PORT = process.env.PORT || 3000;
// Initialize agent (RAG + tools)
const agent = createAgent({
  dataDir,
  listRooms,
  loadRoomTables,
  loadWeather,
  callGeminiChat
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

// Graceful shutdown for Docker and local runs
function shutdown(sig) {
  console.log(`Received ${sig}. Closing server...`);
  server.close(() => {
    console.log('HTTP server closed.');
    process.exit(0);
  });
  // safeguard
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
