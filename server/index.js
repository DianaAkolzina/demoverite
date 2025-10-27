import http from 'http';
import fs from 'fs';
import path from 'path';
import url from 'url';
import { spawn } from 'child_process';
import { createAgent } from './agent.js';
import { createGraphFromEnv } from './graph.js';
import { createVectorClient } from './vector.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const s3LocalDir = path.join(root, process.env.S3_LOCAL_DIR || 'CSVex_s3');

// Simple env loader
const envPath = path.join(root, '.env');
if (fs.existsSync(envPath)) {
  const raw = fs.readFileSync(envPath, 'utf8');
  raw.split(/\r?\n/).forEach((line) => {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) {
      const key = m[1].trim();
      // Respect existing env (e.g., runtime overrides) instead of clobbering
      if (process.env[key] == null || process.env[key] === '') {
        process.env[key] = m[2];
      }
    }
  });
}

const LLM_TEMPERATURE = Number(process.env.LLM_TEMPERATURE ?? 0.3);
const LLM_MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS ?? 4096); // Increased default for richer replies
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > 1e6) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
async function runCmd(cmd, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit', env });
    p.on('exit', (code) => {
      if (code === 0) resolve(); else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`));
    });
    p.on('error', reject);
  });
}

async function neo4jVerifyConnectivityFromEnv(env = process.env) {
  const uri = env.NEO4J_URI;
  const username = env.NEO4J_USERNAME;
  const password = env.NEO4J_PASSWORD;
  const database = env.NEO4J_DATABASE || 'neo4j';
  try {
    const neo4j = await import('neo4j-driver').then(m => m.default || m).catch(() => null);
    if (!neo4j) return false;
    const driver = neo4j.driver(uri, neo4j.auth.basic(username, password), {
      connectionTimeout: 15000
    });
    try {
      await driver.verifyConnectivity({ database });
      return true;
    } finally {
      await driver.close();
    }
  } catch {
    return false;
  }
}

async function ensureDatastores() {
  const skipCheck = (process.env.NEO4J_SKIP_CHECK || '0') === '1';
  if (skipCheck) console.warn('[startup] Skipping Neo4j readiness wait (NEO4J_SKIP_CHECK=1)');
  // Neo4j is REQUIRED
  const { NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD } = process.env;
  if (!NEO4J_URI || !NEO4J_USERNAME || !NEO4J_PASSWORD) {
    console.error('[startup] Neo4j env missing. Set NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD');
    process.exit(1);
  }
  let ok = skipCheck ? true : false; let attempts = 0; const maxAttempts = Number(process.env.NEO4J_WAIT_ATTEMPTS || 150); // ~5 minutes at 2s
  while (!ok && attempts < maxAttempts) {
    attempts++;
    try {
      ok = await neo4jVerifyConnectivityFromEnv(process.env);
      if (!ok) {
        if (attempts % 5 === 0) console.log(`[startup] Waiting for Neo4j... attempt ${attempts}/${maxAttempts}`);
        await wait(2000);
      }
    } catch (e) {
      if (attempts % 5 === 0) console.warn('[startup] Neo4j check error:', String(e));
      await wait(2000);
    }
  }
  if (!ok) {
    if ((process.env.NEO4J_ALLOW_DEGRADED || '0') === '1') {
      console.error('[startup] Neo4j not reachable after waiting. Continuing in degraded mode.');
    } else {
      console.error('[startup] Neo4j not reachable after waiting. Exiting.');
      process.exit(1);
    }
  }
  if ((process.env.NEO4J_FORCE_POPULATE || '0') === '1' || (process.env.NEO4J_SKIP_POPULATE || '0') !== '1') {
    console.log('[startup] Populating Neo4j graph…');
    await runCmd('node', ['scripts/populate_neo4j.js']);
  }
  // After Neo4j step, attempt to capture a lightweight graph snapshot for agent/UI
  try {
    console.log('[startup][graph] Taking snapshot...');
    const outDir = path.join(root, 'data');
    try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) { console.warn('[startup][graph] mkdir failed:', String(e)); }
    const g = createGraphFromEnv(process.env);
    let snap = { nodes: [], links: [] };
    if (g && g.fullHierarchy) {
      snap = await g.fullHierarchy(null);
      const nodes = snap?.nodes?.length || 0; const links = snap?.links?.length || 0;
      console.log('[startup][graph] Snapshot computed: nodes', nodes, 'links', links);
      if (!nodes || !links) console.warn('[startup][graph] Warning: snapshot has low counts (nodes or links missing). Check relationship names and filters.');
      // Optional per-building weather
      if (process.env.OPENWEATHER_API_KEY && (process.env.WEATHER_FETCH_ALL_BUILDINGS || '1') === '1') {
        try {
          const { records } = await g.runQuery('MATCH (b:Building) RETURN b.name AS name, b.lat AS lat, b.long AS lon, b.latitude AS lat2, b.longitude AS lon2');
          const items = (records || []).map(r => ({ name: r.get('name'), lat: r.get('lat') ?? r.get('lat2'), lon: r.get('lon') ?? r.get('lon2') })).filter(x => x && x.name && x.lat != null && x.lon != null);
          console.log('[startup][weather] Buildings with coordinates:', items.length);
          for (const it of items) {
            try { const res = await fetchAndCacheWeatherForBuilding(it.name, it.lat, it.lon); if (res && res.ok) console.log(`[startup][weather] Cached for ${it.name}: rows=${res.rows}`); } catch (e) { console.warn('[startup][weather] Fetch failed:', String(e)); }
            await wait(300);
          }
        } catch (e) { console.warn('[startup][weather] Prefetch step failed:', String(e)); }
      }
    } else {
      console.warn('[startup][graph] Adapter not configured or missing fullHierarchy; writing empty snapshot for UI baselines');
    }
    const snapPath = path.join(outDir, 'graph_snapshot.json');
    fs.writeFileSync(snapPath, JSON.stringify({ generatedAt: Date.now(), ...snap }, null, 2));
    console.log('[startup][graph] Wrote snapshot to', snapPath);
  } catch (e) {
    console.error('[startup][graph] Snapshot failed:', e?.stack || String(e));
  }
  if (process.env.CHROMA_URL && (process.env.CHROMA_SKIP_INDEX || '0') !== '1') {
    const base = String(process.env.CHROMA_URL).replace(/\/$/, '');
    async function chromaReachable() {
      try {
        const r = await fetch(base + '/api/v2/heartbeat', { method: 'GET' }).catch(() => null);
        if (r && r.ok) return true;
      } catch {}
      try {
        const r2 = await fetch(base + '/api/v1/heartbeat', { method: 'GET' }).catch(() => null);
        if (r2 && r2.ok) return true;
      } catch {}
      return false;
    }
    const ok = await chromaReachable();
    if (!ok) {
      console.warn('[startup] CHROMA_URL set but Chroma not reachable at', base, '- skipping indexing.');
    } else {
      try {
        console.log('[startup] Indexing Chroma (HTTP)…');
        await runCmd('python3', ['scripts/index_chroma_http.py']);
      } catch (e) {
        console.error('[startup] Chroma HTTP indexing failed, trying client-based indexer:', String(e));
        try {
          await runCmd('python3', ['scripts/index_chroma.py']);
        } catch (e2) {
          console.error('[startup] Chroma indexing failed (continuing):', String(e2));
        }
      }
    }
  }
}

function listRooms() {
  // Enumerate device CSVs from local S3 mirror only
  try {
    if (!fs.existsSync(s3LocalDir)) return [];
    return fs.readdirSync(s3LocalDir).filter(f => f.endsWith('.csv')).map(f => f.replace(/\.csv$/i, ''));
  } catch { return []; }
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
  // S3 mode: interpret room as deviceId and load its telemetry CSV
  try {
    const filePath = path.join(s3LocalDir, `${room}.csv`);
    if (!fs.existsSync(filePath)) return {};
    const rows = parseCSV(filePath).filter(r => r && r.ts != null).sort((a,b)=>(a.ts??0)-(b.ts??0));
    // Optional: log a one-time match hint via Neo4j mapping
    if (!loadRoomTables._logged) loadRoomTables._logged = new Set();
    if (!loadRoomTables._logged.has(room)) {
      loadRoomTables._logged.add(room);
      try {
        // Best-effort property match
        const idNorm = String(room).toLowerCase().replace(/[-_]/g,'');
        import('neo4j-driver').then(m => {
          const neo4j = m.default || m;
          const uri = process.env.NEO4J_URI, user = process.env.NEO4J_USERNAME, pass = process.env.NEO4J_PASSWORD, db = process.env.NEO4J_DATABASE || 'neo4j';
          if (!uri || !user || !pass) return;
          const drv = neo4j.driver(uri, neo4j.auth.basic(user, pass));
          const s = drv.session({ database: db });
          const cy = `
            MATCH (d:Device)
            WITH d, [$idNorm] AS ids
            WITH d, ids, [toString(d.id), toString(d.cloud_id), toString(d.deviceId), toString(d.name)] AS cands
            WITH d, [x IN cands WHERE x IS NOT NULL | toLower(replace(replace(x,'-',''),'_',''))] AS norms, ids[0] AS target
            WHERE target IN norms
            RETURN coalesce(d.id,d.cloud_id,d.deviceId,d.name) AS matchVal,
                   CASE WHEN toLower(replace(replace(toString(d.cloud_id),'-',''),'_',''))=target THEN 'cloud_id'
                        WHEN toLower(replace(replace(toString(d.id),'-',''),'_',''))=target THEN 'id'
                        WHEN toLower(replace(replace(toString(d.deviceId),'-',''),'_',''))=target THEN 'deviceId'
                        WHEN toLower(replace(replace(toString(d.name),'-',''),'_',''))=target THEN 'name' ELSE 'unknown' END AS matchedBy
          `;
          s.run(cy, { idNorm }).then(r => {
            const rec = r.records?.[0]; if (rec) console.log('[s3] device match', room, '->', rec.get('matchVal'), 'by', rec.get('matchedBy'));
          }).catch(()=>{}).finally(()=>{s.close(); drv.close();});
        }).catch(()=>{});
      } catch {}
    }
    return { telemetry: rows };
  } catch { return {}; }
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

function buildingSlug(name) { return String(name||'').trim().toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,''); }

function loadWeather(building = null) {
  try {
    // Per-building weather cached under S3 local mirror
    if (building) {
      const bslug = buildingSlug(building);
      const csvb = path.join(s3LocalDir, 'weather_buildings', `${bslug}.csv`);
      if (fs.existsSync(csvb)) return parseCSV(csvb).map(r => ({ ts: Number(r.ts), temp: Number(r.temp), humidity: Number(r.humidity), pressure: Number(r.pressure), wind_speed: Number(r.wind_speed), wind_deg: Number(r.wind_deg), clouds: Number(r.clouds), weather_main: r.weather_main, weather_desc: r.weather_desc }));
    }
    return [];
  } catch { return []; }
}

// Fetch and cache per-building weather (OpenWeather) using lat/lon from graph
async function fetchAndCacheWeatherForBuilding(buildingName, lat, lon) {
  const key = process.env.OPENWEATHER_API_KEY;
  if (!key || !lat || !lon) return { error: 'missing_api_or_coords' };
  try {
    const currentUrl = `https://api.openweathermap.org/data/2.5/weather?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&appid=${encodeURIComponent(key)}&units=metric`;
    const forecastUrl = `https://api.openweathermap.org/data/2.5/forecast?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&appid=${encodeURIComponent(key)}&units=metric`;
    const [curRes, fcRes] = await Promise.all([ fetch(currentUrl), fetch(forecastUrl) ]);
    const cur = await curRes.json();
    const fc = await fcRes.json();
    const rows = [];
    const push = (ts, main, wind, clouds, weather) => rows.push({
      ts, temp: main?.temp, humidity: main?.humidity, pressure: main?.pressure,
      wind_speed: wind?.speed, wind_deg: wind?.deg, clouds: (clouds?.all ?? 0),
      weather_main: (weather && weather[0] && weather[0].main) || '', weather_desc: (weather && weather[0] && weather[0].description) || ''
    });
    if (cur && cur.dt) push(cur.dt * 1000, cur.main, cur.wind, cur.clouds, cur.weather);
    if (fc && Array.isArray(fc.list)) fc.list.forEach(x => push(x.dt * 1000, x.main, x.wind, x.clouds, x.weather));
    // Write under S3 local dir for S3-only mode compatibility
    const outDir = path.join(s3LocalDir, 'weather_buildings');
    try { fs.mkdirSync(outDir, { recursive: true }); } catch {}
    const outFile = path.join(outDir, `${buildingSlug(buildingName)}.csv`);
    const header = 'ts,temp,humidity,pressure,wind_speed,wind_deg,clouds,weather_main,weather_desc\n';
    const csv = header + rows.map(r => [r.ts, r.temp, r.humidity, r.pressure, r.wind_speed, r.wind_deg, r.clouds, JSON.stringify(r.weather_main).replace(/"/g,''), JSON.stringify(r.weather_desc).replace(/"/g,'')].join(',')).join('\n') + '\n';
    fs.writeFileSync(outFile, csv);
    return { ok: true, rows: rows.length, file: outFile };
  } catch (e) {
    return { error: String(e) };
  }
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

const DEBUG_HTTP = (process.env.HTTP_DEBUG === '1') || (process.env.LOG_LEVEL === 'debug');
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const { pathname, query } = parsed;
  if (DEBUG_HTTP) {
    console.log(`[HTTP] ${req.method} ${pathname} ${Object.keys(query).length ? JSON.stringify(query) : ''}`);
  }

  if (pathname === '/api/rooms' && req.method === 'GET') {
    try {
      const g = createGraphFromEnv(process.env);
      if (g && g.runQuery) {
        const { records = [] } = await g.runQuery('MATCH (z:Zone) RETURN DISTINCT coalesce(z.roomId, z.name) AS room ORDER BY room');
        const zones = records.map(r => r.get('room')).filter(Boolean);
        if (zones.length) return sendJson(res, 200, { rooms: zones, source: 'graph.zones' });
      }
    } catch {}
    return sendJson(res, 200, { rooms: listRooms(), source: 's3.devices' });
  }

  if (pathname === '/api/weather' && req.method === 'GET') {
    const weather = loadWeather();
    return sendJson(res, 200, { count: weather.length, latest: weather.at(-1) || null });
  }

  if (pathname === '/api/status' && req.method === 'GET') {
    try {
      const g = createGraphFromEnv(process.env);
      const gstats = g && g.stats ? await g.stats() : { error: 'no_graph' };
      const neo4jConnected = !gstats.error;
      const vConfigured = !!(process.env.CHROMA_URL);
      let vReachable = false;
      if (vConfigured) {
        const base = String(process.env.CHROMA_URL).replace(/\/$/, '');
        try {
          const r = await fetch(base + '/api/v2/heartbeat').catch(() => null);
          vReachable = !!(r && r.ok);
        } catch {}
        if (!vReachable) {
          try {
            const r2 = await fetch(base + '/api/v1/heartbeat').catch(() => null);
            vReachable = !!(r2 && r2.ok);
          } catch {}
        }
      }
      return sendJson(res, 200, {
        neo4j: { connected: neo4jConnected, ...gstats },
        chroma: { configured: vConfigured, reachable: vReachable }
      });
    } catch (e) {
      return sendJson(res, 500, { error: 'status_failed', detail: String(e) });
    }
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

  if (pathname === '/api/graph/summary' && req.method === 'GET') {
    const zoneTypeRaw = String(query.zoneType || '').trim();
    const zoneType = zoneTypeRaw ? (zoneTypeRaw[0].toUpperCase() + zoneTypeRaw.slice(1).toLowerCase()) : '';
    if (!zoneType) return sendJson(res, 400, { error: 'zoneType required' });
    try {
      const g = createGraphFromEnv(process.env);
      if (!g || !g.devicesByZoneType) return sendJson(res, 500, { error: 'graph_not_configured' });
      const out = await g.devicesByZoneType(zoneType);
      return sendJson(res, 200, out);
    } catch (e) {
      return sendJson(res, 500, { error: 'graph_failed', detail: String(e) });
    }
  }

  if (pathname === '/api/graph/subgraph' && req.method === 'GET') {
    const zoneTypeRaw = String(query.zoneType || '').trim();
    const zoneType = zoneTypeRaw ? (zoneTypeRaw[0].toUpperCase() + zoneTypeRaw.slice(1).toLowerCase()) : '';
    if (!zoneType) return sendJson(res, 400, { error: 'zoneType required' });
    try {
      const g = createGraphFromEnv(process.env);
      if (!g || !g.subgraphByZoneType) return sendJson(res, 500, { error: 'graph_not_configured' });
      const out = await g.subgraphByZoneType(zoneType);
      return sendJson(res, 200, { zoneType, ...out });
    } catch (e) {
      return sendJson(res, 500, { error: 'graph_failed', detail: String(e) });
    }
  }

  if (pathname === '/api/graph/full' && req.method === 'GET') {
    try {
      const g = createGraphFromEnv(process.env);
      if (!g || !g.fullHierarchy) return sendJson(res, 500, { error: 'graph_not_configured' });
      const tenant = String(query.tenant || '').trim() || null;
      const out = await g.fullHierarchy(tenant);
      if (DEBUG_HTTP) console.log('[HTTP] /api/graph/full -> nodes', out.nodes?.length || 0, 'links', out.links?.length || 0);
      return sendJson(res, 200, out);
    } catch (e) {
      return sendJson(res, 500, { error: 'graph_failed', detail: String(e) });
    }
  }

  // Force-generate and persist the current graph snapshot (optionally filtered by tenant)
  if (pathname === '/api/graph/snapshot' && req.method === 'POST') {
    try {
      const g = createGraphFromEnv(process.env);
      if (!g || !g.fullHierarchy) return sendJson(res, 500, { error: 'graph_not_configured' });
      let raw = '';
      try { raw = await readBody(req); } catch {}
      let tenant = null; try { const j = raw ? JSON.parse(raw) : {}; tenant = (j && j.tenant) ? String(j.tenant).trim() : null; } catch {}
      const snap = await g.fullHierarchy(tenant);
      const outDir = path.join(root, 'data');
      try { fs.mkdirSync(outDir, { recursive: true }); } catch {}
      const snapPath = path.join(outDir, 'graph_snapshot.json');
      fs.writeFileSync(snapPath, JSON.stringify({ generatedAt: Date.now(), tenant: tenant || null, ...snap }, null, 2));
      return sendJson(res, 200, { ok: true, nodes: (snap.nodes||[]).length, links: (snap.links||[]).length, file: 'data/graph_snapshot.json' });
    } catch (e) {
      return sendJson(res, 500, { error: 'snapshot_failed', detail: String(e) });
    }
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
        const { messages = [], room, range, selection } = JSON.parse(body || '{}');
        if (DEBUG_HTTP) console.log('[API/chat] selection:', selection);
        // Compute effective scope from UI selection (building/floor/room(zone))
        // In S3-only mode, a "room" is a deviceId; zones are mapped to devices via graph.
        let effRoom = room || null;
        let scopeNote = '';
        let selectionRooms = [];
        try {
          if (selection && (selection.building || selection.floor || selection.room)) {
            const g = createGraphFromEnv(process.env);
            // If a specific zone (room) is selected, gather devices in that zone
            if (selection.room && g && g.devicesByScope) {
              const { devices = [] } = await g.devicesByScope({ tenant: selection.tenant || null, building: selection.building || null, floor: selection.floor || null, zone: selection.room || null, type: null });
              const devIds = Array.from(new Set(devices.map(d => String(d.id)).filter(Boolean)));
              if (devIds.length) {
                effRoom = 'ALL';
                selectionRooms = devIds;
                scopeNote = `Scope: building=${selection.building||''} floor=${selection.floor||''} zone=${selection.room||''} devices=[${devIds.slice(0,30).join(', ')}${devIds.length>30?' …':''}]`;
              }
            } else if (g && g.devicesByScope && (selection.building || selection.floor)) {
              // Building/floor scope: gather all devices under this scope
              const { devices = [] } = await g.devicesByScope({ tenant: selection.tenant || null, building: selection.building || null, floor: selection.floor || null, zone: null, type: null });
              const devIds = Array.from(new Set(devices.map(d => String(d.id)).filter(Boolean)));
              if (devIds.length) {
                effRoom = 'ALL';
                selectionRooms = devIds;
                scopeNote = `Scope: ${selection.building ? 'building='+selection.building+' ' : ''}${selection.floor ? 'floor='+selection.floor+' ' : ''}devices=[${devIds.slice(0,30).join(', ')}${devIds.length>30?' …':''}]`;
              }
            }
          }
        } catch (e) { if (DEBUG_HTTP) console.warn('[API/chat] selection resolution failed:', String(e)); }
        // If still nothing, default to ALL and include all S3 devices
        if (!effRoom) {
          effRoom = 'ALL';
          try { const all = listRooms(); selectionRooms = all; scopeNote = `Scope: devices=[${all.slice(0,30).join(', ')}${all.length>30?' …':''}]`; } catch {}
        }
        if (DEBUG_HTTP) console.log('[API/chat] effective room=', effRoom, 'note=', scopeNote);

        // --- LOGGING ADDED HERE ---
        console.log('[API/chat] Received range:', range);
        if (range) {
          console.log('[API/chat] Start:', range.start, new Date(range.start).toISOString());
          console.log('[API/chat] End:', range.end, new Date(range.end).toISOString());
        }
        // --------------------------

        const userLast = [...messages].reverse().find(m => m.role === 'user' || m.role === 'User' || m.role === 'human');
        const question = userLast?.content || '';
        const tables = effRoom && effRoom !== 'ALL' ? loadRoomTables(effRoom) : {};
        const context = {
          instruction: 'You are a building analytics chat assistant. Answer succinctly. If plotting helps, include a JSON HighchartsOptions with yAxis as time and xAxis as chosen metric. Do not include code fences in the JSON.',
          tables: Object.keys(tables),
          sampleRows: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.slice(0, 5)])),
          range: range || {},
          knowledge: loadKnowledge(),
          weatherSample: loadWeather().slice(-50)
        };

        // Use the tool-enabled agent (RAG + tools). If it can't complete, fall back to heuristics.
        const effMessages = scopeNote ? [{ role: 'user', content: scopeNote }, ...messages, { role: 'user', content: question }] : messages.concat({ role: 'user', content: question });
        const { message, chart, trace, extras } = await agent.run(effMessages, { room: effRoom, range, selectionRooms });
        if (!message || !message.content || /^Unable to complete tool-based reasoning/i.test(message.content)) {
          const fb = answerWithFallback(question, room, range || {});
          return sendJson(res, 200, { message: { role: 'assistant', content: fb.answer }, chart: fb.chart, mode: 'fallback', trace: [] });
        }
        return sendJson(res, 200, { message, chart, extras: extras || ((agent && agent.extras) ? agent.extras : undefined), trace, mode: 'agent' });
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

  // Weather endpoint (supports building param)
  if (pathname === '/api/weather' && req.method === 'GET') {
    try {
      const building = String(query.building || '').trim() || null;
      const rows = loadWeather(building);
      return sendJson(res, 200, { count: rows.length, latest: rows.at(-1) || null, building });
    } catch (e) { return sendJson(res, 500, { error: 'weather_failed', detail: String(e) }); }
  }

  // Tenants list
  if (pathname === '/api/tenants' && req.method === 'GET') {
    try {
      const g = createGraphFromEnv(process.env);
      if (!g || !g.runQuery) return sendJson(res, 500, { error: 'graph_not_configured' });
      const { records } = await g.runQuery('MATCH (t:Tenant) RETURN DISTINCT t.name AS name ORDER BY name');
      const tenants = (records || []).map(r => r.get('name')).filter(Boolean);
      return sendJson(res, 200, { tenants });
    } catch (e) { return sendJson(res, 500, { error: 'tenants_failed', detail: String(e) }); }
  }

  // Buildings list for tenant with counts
  if (pathname === '/api/buildings' && req.method === 'GET') {
    try {
      const tenant = String(query.tenant || '').trim() || null;
      const g = createGraphFromEnv(process.env);
      if (!g || !g.runQuery) return sendJson(res, 500, { error: 'graph_not_configured' });
      const cy = `
        OPTIONAL MATCH (t:Tenant)
        WHERE $tenant IS NULL OR t.name=$tenant OR toString(t.id)=$tenant
        MATCH (b:Building)
        WHERE $tenant IS NULL OR (b)-[:BELONGS_TO_TENANT]->(t)
        OPTIONAL MATCH (f:Floor)-[:LOCATED_IN_BUILDING|BELONGS_TO_BUILDING|IN_BUILDING]->(b)
        OPTIONAL MATCH (z1:Zone)-[:LOCATED_ON_FLOOR|BELONGS_TO_FLOOR]->(f)
        OPTIONAL MATCH (z2:Zone)-[:LOCATED_IN_BUILDING|BELONGS_TO_BUILDING]->(b)
        WITH b, collect(DISTINCT f) AS fs, collect(DISTINCT coalesce(z1,z2)) AS zs
        OPTIONAL MATCH (d:Device)-[:IN_BUILDING|LOCATED_IN_BUILDING]->(b)
        OPTIONAL MATCH (d2:Device)-[:LOCATED_IN_ZONE]->(:Zone)-[:LOCATED_IN_BUILDING|BELONGS_TO_BUILDING]->(b)
        WITH b, fs, zs, collect(DISTINCT coalesce(d,d2)) AS ds
        RETURN b.name AS name,
               size([x IN fs WHERE x IS NOT NULL]) AS floors,
               size([x IN zs WHERE x IS NOT NULL]) AS zones,
               size([x IN ds WHERE x IS NOT NULL]) AS devices
        ORDER BY name
      `;
      const { records } = await g.runQuery(cy, { tenant });
      const items = (records || []).map(r => ({ name: r.get('name'), floors: r.get('floors') ?? 0, zones: r.get('zones') ?? 0, devices: r.get('devices') ?? 0 }));
      return sendJson(res, 200, { tenant, buildings: items });
    } catch (e) { return sendJson(res, 500, { error: 'buildings_failed', detail: String(e) }); }
  }

  // Topology (Building -> Floors -> Zones -> Devices)
  if (pathname === '/api/topology' && req.method === 'GET') {
    try {
      const tenant = String(query.tenant || '').trim() || null;
      const g = createGraphFromEnv(process.env);
      if (!g || !g.runQuery) return sendJson(res, 500, { error: 'graph_not_configured' });
      const cy = `
        OPTIONAL MATCH (t:Tenant)
        WHERE $tenant IS NULL OR t.name=$tenant OR toString(t.id)=$tenant
        MATCH (b:Building)
        WHERE $tenant IS NULL OR (b)-[:BELONGS_TO_TENANT]->(t)
        OPTIONAL MATCH (f:Floor)-[:LOCATED_IN_BUILDING|BELONGS_TO_BUILDING|IN_BUILDING]->(b)
        OPTIONAL MATCH (z1:Zone)-[:LOCATED_ON_FLOOR|BELONGS_TO_FLOOR]->(f)
        OPTIONAL MATCH (z2:Zone)-[:LOCATED_IN_BUILDING|BELONGS_TO_BUILDING]->(b)
        WITH b, f, coalesce(z1, z2) AS z
        OPTIONAL MATCH (d:Device)
        WHERE (z IS NOT NULL AND (d)-[:LOCATED_IN_ZONE]->(z)) OR (z IS NULL AND (d)-[:IN_BUILDING|LOCATED_IN_BUILDING]->(b))
        RETURN b.name AS building,
               f.name AS floor,
               coalesce(z.roomId, z.name) AS zone,
               collect(DISTINCT coalesce(d.id, d.cloud_id, d.deviceId, d.name)) AS devices
      `;
      const { records } = await g.runQuery(cy, { tenant });
      const byB = new Map();
      const bfKey = (b,f)=>`${b}||${f||''}`;
      const byBF = new Map();
      for (const r of (records || [])) {
        const b = r.get('building') || 'Unknown';
        const f = r.get('floor') || null;
        const z = r.get('zone') || null;
        const ds = (r.get('devices') || []).filter(Boolean);
        if (!byB.has(b)) byB.set(b, { name: b, floors: [], unzonedDevices: [] });
        const B = byB.get(b);
        if (!f && !z) { ds.forEach(id => { if (!B.unzonedDevices.includes(id)) B.unzonedDevices.push(id); }); continue; }
        const key = bfKey(b,f);
        let F = byBF.get(key); if (!F) { F = { name: f, zones: [] }; byBF.set(key,F); B.floors.push(F); }
        if (z) { let Z = F.zones.find(x=>x.name===z); if (!Z) { Z={ name:z, devices:[]}; F.zones.push(Z); } ds.forEach(id=>{ if(!Z.devices.includes(id)) Z.devices.push(id); }); }
      }
      const out = Array.from(byB.values()).sort((a,b)=>String(a.name).localeCompare(String(b.name)));
      out.forEach(B => { B.floors.sort((a,b)=>String(a.name||'').localeCompare(String(b.name||''))); B.floors.forEach(F=>F.zones.sort((a,b)=>String(a.name||'').localeCompare(String(b.name||'')))); });
      return sendJson(res, 200, { tenant, buildings: out });
    } catch (e) { return sendJson(res, 500, { error: 'topology_failed', detail: String(e) }); }
  }

  // Metrics available in a scope (tenant/building/floor/zone)
  if (pathname === '/api/scope/metrics' && req.method === 'GET') {
    try {
      const tenant = String(query.tenant || '').trim() || null;
      const building = String(query.building || '').trim() || null;
      const floor = String(query.floor || '').trim() || null;
      const zone = String(query.zone || '').trim() || null;
      const g = createGraphFromEnv(process.env);
      if (!g || !g.devicesByScope) return sendJson(res, 500, { error: 'graph_not_configured' });
      const { devices = [] } = await g.devicesByScope({ tenant, building, floor, zone, type: null });
      const deviceIds = Array.from(new Set(devices.map(d => String(d.id)).filter(Boolean)));
      const byDevice = {};
      const union = new Map();
      // Include per-building weather metrics (prefixed) in union if building given
      const weatherFields = [];
      try {
        if (building) {
          const w = loadWeather(building) || [];
          if (w.length) {
            const keys = Object.keys(w[0] || {}).filter(k => k !== 'ts');
            for (const k of keys) weatherFields.push(`weather.${k}`);
          }
        }
      } catch {}
      // 1) Prefer graph TelemetryKeys per device (batched, with normalized ID matching)
      const graphKeys = new Map();
      try {
        const cy = `
          UNWIND $ids AS raw
          WITH raw, toLower(replace(replace(raw,'-',''),'_','')) AS idNorm
          MATCH (d:Device)
          WITH raw, idNorm, d,
            [toString(d.id), toString(d.cloud_id), toString(d.deviceId), toString(d.name)] AS cands
          WITH raw, d, [x IN cands WHERE x IS NOT NULL | toLower(replace(replace(x,'-',''),'_',''))] AS norms
          WHERE idNorm IN norms
          OPTIONAL MATCH (d)-[:HAS_TELEMETRY_KEY]->(k:TelemetryKey)
          RETURN raw AS id, collect(DISTINCT k.name) AS keys
        `;
        const { records } = await g.runQuery(cy, { ids: deviceIds });
        for (const r of (records || [])) graphKeys.set(String(r.get('id')), (r.get('keys') || []).filter(Boolean));
      } catch {}
      // 2) Fallback to S3 headers when no graph keys present
      const dir = path.join(root, process.env.S3_LOCAL_DIR || 'CSVex_s3');
      for (const id of deviceIds) {
        let fields = graphKeys.get(id) || [];
        if (!fields || fields.length === 0) {
          try {
            const p = path.join(dir, `${id}.csv`);
            if (fs.existsSync(p)) {
              const text = fs.readFileSync(p, 'utf8');
              const first = String(text).split(/\r?\n/).find(l => l.trim().length) || '';
              const headers = first.split(',').map(h => h.trim()).filter(Boolean);
              fields = headers.filter(h => h !== 'ts');
            }
          } catch {}
        }
        const uniq = Array.from(new Set((fields || []).filter(Boolean))).sort();
        byDevice[id] = uniq;
        for (const f of uniq) union.set(f, (union.get(f) || 0) + 1);
      }
      // Add weather.* fields to union (count as 1 for scope)
      for (const wf of weatherFields) union.set(wf, (union.get(wf) || 0) + 1);
      const metrics = Array.from(new Set([...union.keys()])).sort();
      const counts = Object.fromEntries(metrics.map(k => [k, union.get(k)]));
      return sendJson(res, 200, { scope: { tenant, building, floor, zone }, devices: deviceIds, metrics, counts, byDevice, weather: weatherFields });
    } catch (e) { return sendJson(res, 500, { error: 'scope_metrics_failed', detail: String(e) }); }
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
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.(md|txt)$/i.test(entry.name)) out.push(path.relative(kdir, p));
    }
  };
  walk(kdir);
  return out;
}

function loadKnowledge() {
  const kdir = path.join(root, 'knowledge');
  const files = listKnowledge();
  return files.map(rel => ({ name: rel, text: fs.readFileSync(path.join(kdir, rel), 'utf8').slice(0, 5000) }));
}

const PORT = process.env.PORT || 3000;
// Initialize agent (RAG + tools)
const graph = createGraphFromEnv(process.env);
const vector = createVectorClient({ chromaUrl: process.env.CHROMA_URL || '' });

const agent = createAgent({
  dataDir,
  listRooms,
  loadRoomTables,
  loadWeather,
  callGeminiChat,
  graph,
  vector
});

ensureDatastores()
  .then(() => {
    // Warm up LLM for lower-latency first response
    if (USE_LLM) {
      try {
        callGemini('Warmup: respond with OK', { schema: {}, sample: {} })
          .then(r => console.log('[startup][llm] Warmup ok:', (typeof r === 'string' ? r.slice(0,80) : JSON.stringify(r).slice(0,80))))
          .catch(e => console.warn('[startup][llm] Warmup failed:', String(e)));
      } catch (e) { console.warn('[startup][llm] Warmup failed:', String(e)); }
    }
    server.listen(PORT, () => {
      console.log(`Server listening on http://localhost:${PORT}`);
    });
  })
  .catch((e) => {
    console.error('[startup] Initialization failed:', e);
    process.exit(1);
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
