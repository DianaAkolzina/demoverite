import http from 'http';
import fs from 'fs';
import path from 'path';
import url from 'url';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { createAgent } from './agent.js';
import { createGraphFromEnv } from './graph.js';
import { createVectorClient } from './vector.js';
import { ConversationStore } from './conversation_state.js';
import { classifyQuery } from './router.js';

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
const LLM_MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS ?? 8192); // Increased default for richer replies
const LLM_DEBUG = (process.env.LLM_DEBUG === '1') || (process.env.LOG_LEVEL === 'debug');

const USE_LLM = (process.env.USE_LLM || 'true').toLowerCase() === 'true';
const LLM_PROVIDER = process.env.LLM_PROVIDER || 'gemini';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'models/gemini-2.5-flash';

if (!USE_LLM) {
  console.error('[startup] USE_LLM must be true. Set USE_LLM=true to enable the Gemini agent.');
  process.exit(1);
}
if ((LLM_PROVIDER || '').toLowerCase() !== 'gemini') {
  console.error('[startup] LLM_PROVIDER must be "gemini" to run this assistant.');
  process.exit(1);
}
if (!GEMINI_API_KEY) {
  console.error('[startup] GEMINI_API_KEY is required. Set it in your environment or .env file.');
  process.exit(1);
}


const dataDir = path.join(root, 'data');
const WEATHER_BACKFILL_START = process.env.WEATHER_BACKFILL_START || '2024-09-01';
const WEATHER_BACKFILL_END = process.env.WEATHER_BACKFILL_END || '2024-10-31';
const WEATHER_USE_SYNTHETIC = (process.env.WEATHER_USE_SYNTHETIC || '1') === '1';
const DEFAULT_WEATHER_LAT = Number(process.env.WEATHER_DEFAULT_LAT ?? 53.4808);
const DEFAULT_WEATHER_LON = Number(process.env.WEATHER_DEFAULT_LON ?? -2.2426);
const conversationStore = new ConversationStore();

// Simple in-memory cache (best-effort, short TTLs)
const __cache = {
  scopeMetrics: new Map(), // key -> { t, v }
  topology: new Map(),
  graphFull: new Map(),
};
function cacheKey(obj) { return JSON.stringify(obj); }
function cacheGet(map, key, ttlMs) {
  try {
    const ent = map.get(key);
    if (!ent) return null;
    if (Date.now() - ent.t > ttlMs) { map.delete(key); return null; }
    return ent.v;
  } catch { return null; }
}
function cacheSet(map, key, v) {
  try { map.set(key, { t: Date.now(), v }); } catch {}
}
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
    const allowDegraded = (process.env.NEO4J_ALLOW_DEGRADED || process.env.NEO4J_ALLOW_FALLBACK || '0') === '1';
    if (allowDegraded) {
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
      if ((process.env.WEATHER_FETCH_ALL_BUILDINGS || '1') === '1') {
        try {
          const { records } = await g.runQuery('MATCH (b:Building) RETURN b.name AS name, b.lat AS lat, b.long AS lon, b.latitude AS lat2, b.longitude AS lon2');
          const items = (records || []).map(r => ({
            name: r.get('name'),
            lat: r.get('lat') ?? r.get('lat2'),
            lon: r.get('lon') ?? r.get('lon2')
          })).filter(x => x && x.name);
          console.log('[startup][weather] Buildings discovered:', items.length);
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
    // Preserve existing snapshot if new one is empty
    if ((snap.nodes || []).length === 0 && (snap.links || []).length === 0 && fs.existsSync(snapPath)) {
      console.warn('[startup][graph] New snapshot is empty; preserving existing cache at', snapPath);
    } else {
      fs.writeFileSync(snapPath, JSON.stringify({ generatedAt: Date.now(), ...snap }, null, 2));
      console.log('[startup][graph] Wrote snapshot to', snapPath);
    }

    // Also create per-tenant snapshots best-effort
    try {
      if (g && g.runQuery) {
        const { records = [] } = await g.runQuery('MATCH (t:Tenant) RETURN DISTINCT t.name AS name ORDER BY name');
        const tenants = records.map(r => r.get('name')).filter(Boolean);
        const slug = (s) => String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'');
        for (const t of tenants) {
          try {
            const tsnap = await g.fullHierarchy(t);
            const file = path.join(outDir, `graph_snapshot.${slug(t)}.json`);
            if ((tsnap.nodes || []).length || (tsnap.links || []).length) {
              fs.writeFileSync(file, JSON.stringify({ generatedAt: Date.now(), tenant: t, ...tsnap }, null, 2));
              console.log('[startup][graph] Wrote tenant snapshot:', file);
            }
          } catch (e) { console.warn('[startup][graph] Tenant snapshot failed:', t, String(e)); }
        }
      }
    } catch (e) { console.warn('[startup][graph] Enumerating tenants failed:', String(e)); }
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
        console.log('[startup] Indexing Chroma…');
        await runCmd('python3', ['scripts/index_chroma.py']);
      } catch (e) {
        console.error('[startup] Chroma indexing failed (continuing):', String(e));
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

function splitCsvLine(line, expectedLength = null) {
  if (line.endsWith('\r')) line = line.slice(0, -1);
  const out = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      const next = line[i + 1];
      if (inQuotes && next === '"') {
        current += '"';
        i++;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && ch === ',') {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  if (expectedLength != null) {
    if (out.length < expectedLength) {
      while (out.length < expectedLength) out.push('');
    } else if (out.length > expectedLength) {
      out[expectedLength - 1] = out.slice(expectedLength - 1).join(',');
      out.length = expectedLength;
    }
  }
  return out;
}

// Helper to parse CSV files (filters columns that never contain data)
function parseCSV(filePath) {
  let rows = [];
  if (!fs.existsSync(filePath)) return rows;
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length < 2) return rows;
  const headers = splitCsvLine(lines[0]).map(h => h.trim());
  const colCount = headers.length;

  for (let i = 1; i < lines.length; i++) {
    const vals = splitCsvLine(lines[i], colCount);
    const row = {};
    let tsValid = true;

    headers.forEach((h, idx) => {
      let raw = vals[idx];
      if (raw === undefined || raw === null) raw = '';

      if (h === 'ts') {
        const num = Number(raw);
        if (Number.isFinite(num)) {
          row.ts = num;
        } else {
          tsValid = false;
        }
        return;
      }

      if (typeof raw === 'string') raw = raw.trim();
      let value = raw;
      if (typeof value === 'string') {
        const lower = value.toLowerCase();
        if (lower === 'true' || lower === 'yes' || lower === 'y') {
          value = 1;
        } else if (lower === 'false' || lower === 'no' || lower === 'n') {
          value = 0;
        }
      }
      if (value === '') {
        value = null;
      } else if (typeof value === 'string' && !Number.isNaN(Number(value))) {
        const num = Number(value);
        if (!Number.isNaN(num)) value = num;
      }

      row[h] = value;
    });

    if (tsValid && row.ts != null) rows.push(row);
  }

  rows = rows.filter((r) => {
    if (!Number.isFinite(r.ts)) return false;
    const d = new Date(r.ts);
    if (Number.isNaN(d.getTime())) return false;
    const cutoff = Date.UTC(d.getUTCFullYear(), 8, 1); // September of the row's year
    return r.ts >= cutoff;
  });
  if (!rows.length) return rows;

  const hasData = new Array(headers.length).fill(false);
  for (const row of rows) {
    headers.forEach((h, idx) => {
      if (h === 'ts') {
        if (Number.isFinite(row.ts)) hasData[idx] = true;
        return;
      }
      const value = row[h];
      if (value !== null && value !== undefined && value !== '') hasData[idx] = true;
    });
  }

  const emptyHeaders = headers.filter((h, idx) => h !== 'ts' && !hasData[idx]);
  if (emptyHeaders.length) {
    for (const row of rows) {
      for (const h of emptyHeaders) delete row[h];
    }
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

function toNumeric(value) {
  if (value == null) return null;
  if (typeof value === 'object') {
    if (typeof value.toNumber === 'function') {
      try { return value.toNumber(); } catch {}
    }
    if (Array.isArray(value) && value.length) return toNumeric(value[0]);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const numStr = Number(trimmed);
    return Number.isFinite(numStr) ? numStr : null;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function parseUtcDate(str) {
  if (!str) return null;
  const d = new Date(`${str}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function defaultWeatherCoords() {
  const lat = Number.isFinite(DEFAULT_WEATHER_LAT) ? DEFAULT_WEATHER_LAT : 53.4808;
  const lon = Number.isFinite(DEFAULT_WEATHER_LON) ? DEFAULT_WEATHER_LON : -2.2426;
  return { lat, lon };
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function seededRandom(...parts) {
  let seed = 0;
  for (const part of parts) {
    const str = `${part ?? ''}`;
    for (let i = 0; i < str.length; i += 1) {
      seed += str.charCodeAt(i) * (i + 1);
    }
  }
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function synthWeatherSample(lat, lon, ts, sourceMap = null) {
  const HOUR = 3600_000;
  const DAY = 24 * HOUR;
  const diurnalPhase = (ts % DAY) / DAY;
  const seasonalPhase = ((ts / DAY) % 30) / 30;

  let baseTemp = null;
  if (sourceMap && typeof sourceMap.forEach === 'function') {
    let total = 0;
    let count = 0;
    sourceMap.forEach((row, key) => {
      const rowTs = Number(key ?? row?.ts);
      if (!Number.isFinite(rowTs)) return;
      if (Math.abs(rowTs - ts) <= 12 * HOUR) {
        const temp = toNumeric(row?.temp ?? row?.temperature ?? row?.value);
        if (Number.isFinite(temp)) {
          total += temp;
          count += 1;
        }
      }
    });
    if (count) baseTemp = total / count;
  }

  const latAdjust = Number.isFinite(lat) ? clamp(15 - (Math.abs(lat) / 90) * 18, -15, 15) : 0;
  const randomDrift = (seededRandom(lat, lon, Math.floor(ts / HOUR)) - 0.5) * 3;
  const diurnalSwing = Math.sin(diurnalPhase * Math.PI * 2) * 5;
  const seasonalSwing = Math.sin(seasonalPhase * Math.PI * 2) * 3;
  const temp = clamp((baseTemp ?? (15 + latAdjust)) + diurnalSwing + seasonalSwing + randomDrift, -12, 36);

  const humidityBase = clamp(65 - (temp - 20) * 1.2 + (seededRandom(lat, ts, lon * 1.3) - 0.5) * 12, 25, 97);
  const pressure = clamp(1013 + (seededRandom(ts, lat * 2, lon * 2) - 0.5) * 12, 985, 1035);
  const windSpeed = clamp(2.5 + Math.abs(Math.sin(ts / (6 * HOUR))) * 3 + (seededRandom(lat * 3, lon * 5, ts) - 0.5) * 2, 0, 18);
  const windDeg = Math.floor((seededRandom(ts, lon, lat) * 360) % 360);
  const clouds = clamp(Math.round(humidityBase * 0.8 + (seededRandom(lat + ts, lon - ts) - 0.5) * 25), 0, 100);

  let weather_main = 'Clouds';
  let weather_desc = 'scattered clouds';
  if (clouds < 20 && humidityBase < 55) {
    weather_main = 'Clear';
    weather_desc = 'clear sky';
  } else if (humidityBase > 88 && temp <= 2) {
    weather_main = 'Snow';
    weather_desc = 'light snow showers';
  } else if (humidityBase > 90) {
    weather_main = 'Rain';
    weather_desc = 'light rain';
  } else if (clouds > 75) {
    weather_main = 'Clouds';
    weather_desc = 'overcast clouds';
  } else if (windSpeed >= 12) {
    weather_main = 'Clouds';
    weather_desc = 'windy with broken clouds';
  }

  return {
    ts,
    temp: Number(temp.toFixed(1)),
    humidity: Math.round(humidityBase),
    pressure: Math.round(pressure),
    wind_speed: Number(windSpeed.toFixed(1)),
    wind_deg: windDeg,
    clouds,
    weather_main,
    weather_desc
  };
}

function hasWeatherCoverage(map, startDt, endDt) {
  if (!map || typeof map.size !== 'number' || map.size === 0) return false;
  if (!startDt || !endDt) return false;
  const startMs = startDt.getTime();
  const endMs = endDt.getTime() + 24 * 60 * 60 * 1000;
  const timestamps = Array.from(map.keys()).map(Number).filter(Number.isFinite);
  if (!timestamps.length) return false;
  const minTs = Math.min(...timestamps);
  const maxTs = Math.max(...timestamps);
  if (minTs > startMs || maxTs < endMs) return false;
  const dayMs = 24 * 3600_000;
  const expectedDays = Math.floor((endMs - startMs) / dayMs) + 1;
  const coveredDays = new Set();
  for (const ts of timestamps) {
    if (ts < startMs || ts > endMs) continue;
    const offset = Math.floor((ts - startMs) / dayMs);
    coveredDays.add(offset);
  }
  return coveredDays.size >= expectedDays;
}

async function fetchHistoricalWeather({ lat, lon, start, end, existingMap }) {
  const startDt = parseUtcDate(start);
  const endDt = parseUtcDate(end);
  if (!startDt || !endDt || startDt > endDt) return [];

  const coverageStart = startDt.getTime();
  const coverageEnd = endDt.getTime() + 24 * 60 * 60 * 1000;

  const map = (existingMap && typeof existingMap.set === 'function') ? existingMap : new Map();
  const out = [];
  const STEP = 3600_000;
  for (let ts = coverageStart; ts <= coverageEnd; ts += STEP) {
    if (map.has(ts)) continue;
    const synthetic = synthWeatherSample(lat, lon, ts, map);
    out.push(synthetic);
    map.set(ts, synthetic);
  }
  return out;
}

function loadWeather(building = null) {
  try {
    const toWeatherRow = (row) => {
      if (!row) return null;
      const ts = Number(row.ts);
      if (!Number.isFinite(ts)) return null;
      return {
        ts,
        temp: toNumeric(row.temp),
        humidity: toNumeric(row.humidity),
        pressure: toNumeric(row.pressure),
        wind_speed: toNumeric(row.wind_speed),
        wind_deg: toNumeric(row.wind_deg),
        clouds: toNumeric(row.clouds),
        weather_main: row.weather_main ?? '',
        weather_desc: row.weather_desc ?? ''
      };
    };
    // Per-building weather cached under S3 local mirror
    if (building) {
      const bslug = buildingSlug(building);
      const csvS3 = path.join(s3LocalDir, 'weather_buildings', `${bslug}.csv`);
      const csvData = path.join(root, 'data', 'weather_buildings', `${bslug}.csv`);
      const file = fs.existsSync(csvS3) ? csvS3 : (fs.existsSync(csvData) ? csvData : null);
      if (file) {
        return parseCSV(file).map(toWeatherRow).filter(Boolean);
      }
      ensureWeatherFetchForBuilding(building);
    }
    // Generic fallback
    const csvGeneric = path.join(s3LocalDir, 'weather.csv');
    const csvGenericData = path.join(root, 'data', 'weather.csv');
    const f = fs.existsSync(csvGeneric) ? csvGeneric : (fs.existsSync(csvGenericData) ? csvGenericData : null);
    if (f) return parseCSV(f).map(toWeatherRow).filter(Boolean);
    if (building) ensureWeatherFetchForBuilding(building);
    return [];
  } catch { return []; }
}

// Fetch and cache per-building weather (synthetic generation using lat/lon from graph)
async function fetchAndCacheWeatherForBuilding(buildingName, lat, lon) {
  let latNum = toNumeric(lat);
  let lonNum = toNumeric(lon);
  const fallback = defaultWeatherCoords();
  const fallbackLat = fallback.lat;
  const fallbackLon = fallback.lon;
  let usedFallbackCoords = false;
  if (!Number.isFinite(latNum) || !Number.isFinite(lonNum)) {
    latNum = fallbackLat;
    lonNum = fallbackLon;
    usedFallbackCoords = true;
  }

  const slug = buildingSlug(buildingName);
  const outDir = path.join(s3LocalDir, 'weather_buildings');
  const dataDir = path.join(root, 'data', 'weather_buildings');
  try { fs.mkdirSync(outDir, { recursive: true }); } catch {}
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch {}
  const outFile = path.join(outDir, `${slug}.csv`);
  const outFileData = path.join(dataDir, `${slug}.csv`);

  const normaliseWeatherRow = (row) => {
    if (!row) return null;
    const ts = Number(row.ts ?? row.timestamp ?? row.time);
    if (!Number.isFinite(ts)) return null;
    const norm = {
      ts,
      temp: toNumeric(row.temp ?? row.temperature),
      humidity: toNumeric(row.humidity),
      pressure: toNumeric(row.pressure),
      wind_speed: toNumeric(row.wind_speed ?? row.windSpeed),
      wind_deg: toNumeric(row.wind_deg ?? row.windDirection),
      clouds: toNumeric(row.clouds),
      weather_main: row.weather_main ?? row.weatherMain ?? row.condition ?? '',
      weather_desc: row.weather_desc ?? row.weatherDesc ?? row.description ?? ''
    };
    if (typeof norm.weather_main === 'string') norm.weather_main = norm.weather_main.trim();
    if (typeof norm.weather_desc === 'string') norm.weather_desc = norm.weather_desc.trim();
    return norm;
  };

  const mergeWeatherRow = (map, row) => {
    const norm = normaliseWeatherRow(row);
    if (!norm) return;
    const existing = map.get(norm.ts);
    if (!existing) {
      map.set(norm.ts, norm);
      return;
    }
    const merged = { ...existing };
    for (const key of ['temp', 'humidity', 'pressure', 'wind_speed', 'wind_deg', 'clouds', 'weather_main', 'weather_desc']) {
      const value = norm[key];
      if (value === undefined || value === null || value === '') continue;
      merged[key] = value;
    }
    map.set(norm.ts, merged);
  };

  const ensureMirrorCopies = (preferred) => {
    if (!preferred) return;
    try {
      if (preferred !== outFile && fs.existsSync(preferred) && !fs.existsSync(outFile)) {
        fs.copyFileSync(preferred, outFile);
      }
    } catch {}
    try {
      if (preferred !== outFileData && fs.existsSync(preferred) && !fs.existsSync(outFileData)) {
        fs.copyFileSync(preferred, outFileData);
      }
    } catch {}
  };

  const existingMap = new Map();
  let primarySource = null;
  for (const candidate of [outFile, outFileData]) {
    if (!fs.existsSync(candidate)) continue;
    primarySource = primarySource || candidate;
    try {
      const parsed = parseCSV(candidate);
      for (const row of parsed) mergeWeatherRow(existingMap, row);
    } catch (err) {
      console.warn('[weather] failed to read cached file', candidate, String(err));
    }
  }

  const startDt = parseUtcDate(WEATHER_BACKFILL_START);
  const endDt = parseUtcDate(WEATHER_BACKFILL_END);
  const forceRefresh = WEATHER_USE_SYNTHETIC || (process.env.WEATHER_FORCE_REFRESH === '1');
  const alreadyCovered = hasWeatherCoverage(existingMap, startDt, endDt);

  if (alreadyCovered && !forceRefresh) {
    ensureMirrorCopies(primarySource);
    return { ok: true, rows: existingMap.size, file: primarySource || outFile, skipped: true };
  }

  try {
    const syntheticRows = await fetchHistoricalWeather({
      lat: latNum,
      lon: lonNum,
      start: WEATHER_BACKFILL_START,
      end: WEATHER_BACKFILL_END,
      existingMap
    });

    for (const row of syntheticRows) mergeWeatherRow(existingMap, row);

    if (!existingMap.size) {
      const fallbackStart = startDt ? startDt.getTime() : Date.now() - 7 * 24 * 3600_000;
      const fallbackEnd = endDt ? endDt.getTime() : Date.now();
      for (let ts = fallbackStart; ts <= fallbackEnd; ts += 3600_000) {
        mergeWeatherRow(existingMap, synthWeatherSample(latNum, lonNum, ts));
      }
    }

    const finalRows = Array.from(existingMap.values())
      .filter(r => Number.isFinite(r.ts))
      .sort((a, b) => (a.ts || 0) - (b.ts || 0));

    const sanitize = (value) => {
      if (value === undefined || value === null) return '';
      if (typeof value === 'number') return Number.isFinite(value) ? value : '';
      return String(value).replace(/"/g, '').replace(/,/g, ';');
    };

    const header = 'ts,temp,humidity,pressure,wind_speed,wind_deg,clouds,weather_main,weather_desc\n';
    const csvFull = header + finalRows.map(r => [
      r.ts ?? '',
      r.temp ?? '',
      r.humidity ?? '',
      r.pressure ?? '',
      r.wind_speed ?? '',
      r.wind_deg ?? '',
      r.clouds ?? '',
      sanitize(r.weather_main),
      sanitize(r.weather_desc)
    ].join(',')).join('\n') + '\n';

    fs.writeFileSync(outFile, csvFull);
    try { fs.writeFileSync(outFileData, csvFull); } catch {}
    if (usedFallbackCoords) {
      console.warn('[weather] using default coordinates for', buildingName, `(${latNum}, ${lonNum})`);
    }
    return { ok: true, rows: finalRows.length, file: outFile, synthetic: true, fallbackCoords: usedFallbackCoords };
  } catch (e) {
    console.warn('[weather] synthetic generation failed for', buildingName, String(e));
    if (existingMap.size) {
      ensureMirrorCopies(primarySource);
      return { ok: true, rows: existingMap.size, file: primarySource || outFile, warning: String(e) };
    }
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
  if (!USE_LLM) throw new Error('LLM disabled (set USE_LLM=true)');
  if (LLM_PROVIDER !== 'gemini') throw new Error(`Unsupported LLM provider: ${LLM_PROVIDER}`);
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY missing');
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

async function callGeminiChatOnce(messages, context) {
  if (!USE_LLM) throw new Error('LLM disabled (set USE_LLM=true)');
  if (LLM_PROVIDER !== 'gemini') throw new Error(`Unsupported LLM provider: ${LLM_PROVIDER}`);
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY missing');
  const contents = [];
  for (const m of messages.slice(-12)) {
    const role = m.role === 'assistant' || m.role === 'model' ? 'model' : 'user';
    contents.push({ role, parts: [{ text: m.content }] });
  }
  contents.push({ role: 'user', parts: [{ text: `Context JSON (truncated):\n${JSON.stringify(context).slice(0, 6000)}` }] });
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelIdBare(GEMINI_MODEL))}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  // Try SDK path first if installed
  const sdkText = await tryGeminiSDK(contents);
  if (sdkText && sdkText.trim()) return sdkText;
  const res = await fetchWithRetry(endpoint, { method: 'POST', body: JSON.stringify({ contents, generationConfig: buildGenerationConfig() }), timeoutMs: 25000 });
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('\n') || '';
  return text;
}

async function callGeminiChat(messages, context) {
  const maxAttempts = Math.max(1, Number(process.env.LLM_CHAT_RETRIES || 3));
  const baseDelay = Math.max(250, Number(process.env.LLM_CHAT_BACKOFF_MS || 750));
  let lastError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const reply = await callGeminiChatOnce(messages, context);
      if (reply && reply.trim()) {
        return reply;
      }
      lastError = new Error('Empty response from Gemini');
    } catch (e) {
      lastError = e;
      if (LLM_DEBUG) console.log(`[LLM] callGeminiChat attempt ${attempt + 1} failed:`, String(e));
    }

    if (attempt < maxAttempts - 1) {
      const delay = Math.min(10000, baseDelay * Math.pow(2, attempt));
      if (LLM_DEBUG) console.log(`[LLM] retrying Gemini call in ${delay}ms (attempt ${attempt + 2}/${maxAttempts})`);
      await wait(delay);
    }
  }

  if (LLM_DEBUG && lastError) console.log('[LLM] callGeminiChat exhausted retries:', String(lastError));
  return null;
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

  if (pathname.startsWith('/data/')) {
    const dataRoot = path.join(root, 'data');
    const relPath = pathname.replace(/^\/+/, '');
    const targetPath = path.join(root, relPath);
    if (!targetPath.startsWith(dataRoot)) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    try {
      const stat = fs.statSync(targetPath);
      if (!stat.isFile()) { res.writeHead(404); res.end('Not Found'); return; }
      const stream = fs.createReadStream(targetPath);
      stream.on('error', () => { res.writeHead(500); res.end('Read error'); });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      stream.pipe(res);
    } catch {
      res.writeHead(404); res.end('Not Found');
    }
    return;
  }

  if (pathname === '/api/rooms' && req.method === 'GET') {
    try {
      const g = createGraphFromEnv(process.env);
      if (g && g.runQuery) {
        const { records = [] } = await g.runQuery('MATCH (z:Zone) RETURN DISTINCT coalesce(z.roomId, toString(z.id), z.name) AS room ORDER BY room');
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

  // Testing: find building with most telemetry keys (only devices with S3 records)
  if (pathname === '/api/test/keys-top-building' && req.method === 'GET') {
    try {
      const tenant = String(query.tenant || '').trim() || null;
      const g = createGraphFromEnv(process.env);
      if (!g || !g.devicesByScope) return sendJson(res, 500, { error: 'graph_not_configured' });

      // S3 device set and quick file info
      const s3Dir = path.join(root, process.env.S3_LOCAL_DIR || 'CSVex_s3');
      const s3Set = new Set();
      const s3Files = new Map(); // id -> { path, hasRows, headers }
      try {
        if (fs.existsSync(s3Dir)) {
          for (const f of fs.readdirSync(s3Dir)) {
            if (!/\.csv$/i.test(f)) continue;
            const id = f.replace(/\.csv$/i, '');
            const p = path.join(s3Dir, f);
            let headers = [];
            let hasRows = false;
            try {
              const text = fs.readFileSync(p, 'utf8');
              const lines = text.split(/\r?\n/).filter(Boolean);
              headers = (lines[0] || '').split(',').map(h => h.trim()).filter(Boolean);
              hasRows = lines.length > 1; // any data rows
            } catch {}
            s3Set.add(id);
            s3Files.set(id, { path: p, hasRows, headers });
          }
        }
      } catch {}

      // Get all devices with meta (filtered to S3-present via devicesByScope)
      let devices = [];
      let devScopeErr = null;
      try {
        const resp = await g.devicesByScope({ tenant, building: null, floor: null, zone: null, type: null });
        devices = Array.isArray(resp?.devices) ? resp.devices : [];
        if (resp?.error) devScopeErr = resp.error;
      } catch (e) { devScopeErr = String(e); }
      const ids = Array.from(new Set(devices.map(d => String(d.id)).filter(Boolean)));

      // Prefer graph TelemetryKeys; fallback to CSV headers (sans ts)
      const graphKeys = new Map(); // id -> keys[]
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
        const { records } = await g.runQuery(cy, { ids });
        for (const r of (records || [])) graphKeys.set(String(r.get('id')), (r.get('keys') || []).filter(Boolean));
      } catch {}

      // Fallback path: if graph devices are empty or errored, infer from snapshot
      if ((!devices.length && s3Set.size) || devScopeErr) {
        try {
          const rootDir = path.join(root, 'data');
          const slug = s => String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'');
          const file = tenant ? path.join(rootDir, `graph_snapshot.${slug(tenant)}.json`) : path.join(rootDir, 'graph_snapshot.json');
          const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
          const nodes = Array.isArray(snap.nodes) ? snap.nodes : [];
          const links = Array.isArray(snap.links) ? snap.links : [];
          const nodesById = new Map(nodes.map(n => [n.id, n]));
          const devNodes = nodes.filter(n => (n.nodeType||n.label)==='Device' && n.cloudId);
          devices = [];
          for (const dn of devNodes) {
            const id = String(dn.cloudId);
            const s3 = s3Files.get(id);
            if (!s3 || !s3.hasRows) continue;
            // find zone
            const zLink = links.find(l => l.source===dn.id && l.rel==='LOCATED_IN_ZONE');
            const fLink = links.find(l => l.source===dn.id && l.rel==='LOCATED_ON_FLOOR');
            const bLink = links.find(l => l.source===dn.id && l.rel==='IN_BUILDING');
            const zNode = zLink ? nodesById.get(zLink.target) : null;
            const fNode = fLink ? nodesById.get(fLink.target) : null;
            let bNode = bLink ? nodesById.get(bLink.target) : null;
            if (!bNode && fNode) {
              const fToB = links.find(l => l.source===fNode.id && ['LOCATED_IN_BUILDING','PART_OF_BUILDING'].includes(l.rel));
              bNode = fToB ? nodesById.get(fToB.target) : bNode;
            }
            if (!bNode && zNode) {
              const zToB = links.find(l => l.source===zNode.id && ['LOCATED_IN_BUILDING','PART_OF_BUILDING'].includes(l.rel));
              bNode = zToB ? nodesById.get(zToB.target) : bNode;
            }
            devices.push({ id, name: dn.name || id, type: dn.deviceType || null, zone: zNode?.name || null, floor: fNode?.name || null, building: bNode?.name || null });
          }
          // derive keys via links if present
          graphKeys.clear();
          const devIdByNode = new Map(devNodes.map(dn => [dn.id, String(dn.cloudId)]));
          for (const l of links) {
            if (l.rel === 'HAS_TELEMETRY_KEY' || l.rel === 'MEASURES') {
              const a = nodesById.get(l.source); const b = nodesById.get(l.target);
              let kid=null, did=null;
              if ((a?.nodeType||a?.label)==='Device' && (b?.nodeType||b?.label)==='TelemetryKey') { did = devIdByNode.get(a.id); kid = b?.name; }
              else if ((a?.nodeType||a?.label)==='TelemetryKey' && (b?.nodeType||b?.label)==='Device') { did = devIdByNode.get(b.id); kid = a?.name; }
              if (did && kid) {
                if (!graphKeys.has(did)) graphKeys.set(did, []);
                if (!graphKeys.get(did).includes(kid)) graphKeys.get(did).push(kid);
              }
            }
          }
        } catch {}
      }

      // Aggregate per building/floor/zone
      const byBuilding = new Map();
      function bump(map, k, delta=1) { map.set(k, (map.get(k)||0) + delta); }

      for (const d of devices) {
        const id = String(d.id);
        const meta = { building: d.building || '(Unknown Building)', floor: d.floor || '(Unknown Floor)', zone: d.zone || '(Unknown Zone)', type: d.type || (d.name || '').split(' ')[0] || 'Device' };
        // Only include devices that have at least one data row in S3
        const s3 = s3Files.get(id);
        if (!s3 || !s3.hasRows) continue;
        let keys = graphKeys.get(id) || [];
        if (!keys.length) {
          const hdrs = (s3.headers || []).filter(h => h !== 'ts');
          keys = Array.from(new Set(hdrs));
        }
        const keyCount = keys.length;
        const bName = meta.building; const fName = meta.floor; const zName = meta.zone;
        if (!byBuilding.has(bName)) byBuilding.set(bName, { totalKeys: 0, devices: 0, deviceTypes: new Map(), floors: new Map() });
        const B = byBuilding.get(bName);
        B.totalKeys += keyCount; B.devices += 1; bump(B.deviceTypes, meta.type, 1);
        if (!B.floors.has(fName)) B.floors.set(fName, { totalKeys: 0, devices: 0, deviceTypes: new Map(), zones: new Map() });
        const F = B.floors.get(fName);
        F.totalKeys += keyCount; F.devices += 1; bump(F.deviceTypes, meta.type, 1);
        if (!F.zones.has(zName)) F.zones.set(zName, { totalKeys: 0, devices: 0, deviceTypes: new Map() });
        const Z = F.zones.get(zName);
        Z.totalKeys += keyCount; Z.devices += 1; bump(Z.deviceTypes, meta.type, 1);
      }

      // Pick top building by totalKeys
      const ranking = Array.from(byBuilding.entries()).map(([name, B]) => ({ name, totalKeys: B.totalKeys, devices: B.devices }));
      ranking.sort((a,b)=> b.totalKeys - a.totalKeys);
      const top = ranking[0] || null;
      if (!top) return sendJson(res, 200, { tenant, building: null, totals: { keys:0, devices:0 }, floors: [], deviceTypes: {}, compared: [] });

      const B = byBuilding.get(top.name);
      const deviceTypes = Object.fromEntries(Array.from(B.deviceTypes.entries()).sort((a,b)=>b[1]-a[1]));
      const floors = Array.from(B.floors.entries()).map(([floor, F]) => ({
        floor,
        keys: F.totalKeys,
        devices: F.devices,
        deviceTypes: Object.fromEntries(Array.from(F.deviceTypes.entries()).sort((a,b)=>b[1]-a[1])),
        zones: Array.from(F.zones.entries()).map(([zone, Z]) => ({
          zone,
          keys: Z.totalKeys,
          devices: Z.devices,
          deviceTypes: Object.fromEntries(Array.from(Z.deviceTypes.entries()).sort((a,b)=>b[1]-a[1]))
        })).sort((a,b)=> b.keys - a.keys)
      })).sort((a,b)=> b.keys - a.keys);

      return sendJson(res, 200, {
        tenant,
        building: top.name,
        totals: { keys: B.totalKeys, devices: B.devices },
        deviceTypes,
        floors,
        compared: ranking.slice(0, 10)
      });
    } catch (e) {
      return sendJson(res, 500, { error: 'keys_top_failed', detail: String(e) });
    }
  }

  if (pathname === '/api/graph/full' && req.method === 'GET') {
    try {
      const tenant = String(query.tenant || '').trim() || null;
      // 1) Try snapshot file for instant response
      try {
        const slug = (s) => String(s||'').trim().toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'');
        const file = tenant ? path.join(dataDir, `graph_snapshot.${slug(tenant)}.json`) : path.join(dataDir, 'graph_snapshot.json');
        if (fs.existsSync(file)) {
          const raw = fs.readFileSync(file, 'utf8');
          const snap = JSON.parse(raw);
          if (Array.isArray(snap.nodes) && Array.isArray(snap.links)) {
            if (DEBUG_HTTP) console.log('[HTTP] /api/graph/full -> served from snapshot file');
            return sendJson(res, 200, { nodes: snap.nodes, links: snap.links, tenant: snap.tenant || tenant || null });
          }
        }
      } catch {}
      // 2) Try in-memory cache
      const key = cacheKey({ kind: 'graphFull', tenant });
      const cached = cacheGet(__cache.graphFull, key, 20000);
      if (cached) return sendJson(res, 200, cached);
      // 3) Fallback to live graph
      const g = createGraphFromEnv(process.env);
      if (!g || !g.fullHierarchy) return sendJson(res, 500, { error: 'graph_not_configured' });
      const out = await g.fullHierarchy(tenant);
      const payload = { nodes: out.nodes || [], links: out.links || [], tenant };
      cacheSet(__cache.graphFull, key, payload);
      if (DEBUG_HTTP) console.log('[HTTP] /api/graph/full -> recomputed nodes', payload.nodes.length, 'links', payload.links.length);
      return sendJson(res, 200, payload);
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
      const slug = (s) => String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'');
      const fileName = tenant ? `graph_snapshot.${slug(tenant)}.json` : 'graph_snapshot.json';
      const snapPath = path.join(outDir, fileName);
      fs.writeFileSync(snapPath, JSON.stringify({ generatedAt: Date.now(), tenant: tenant || null, ...snap }, null, 2));
      // Hot-reload in-memory index for this tenant
      updateIndexForTenant(tenant || null);
      return sendJson(res, 200, { ok: true, nodes: (snap.nodes||[]).length, links: (snap.links||[]).length, file: `data/${fileName}` });
    } catch (e) {
      return sendJson(res, 500, { error: 'snapshot_failed', detail: String(e) });
    }
  }

  if (pathname === '/api/meta' && req.method === 'GET') {
    const room = query.room;
    const building = String(query.building || '').trim() || null;
    const floor = String(query.floor || '').trim() || null;
    if (!room) return sendJson(res, 400, { error: 'room required' });
    const start = query.start ? Number(query.start) : null;
    const end = query.end ? Number(query.end) : null;

    // If room === ALL and a scope is provided, compute union of metrics across devices on this floor/building
    if ((room === 'ALL') && (building || floor)) {
      try {
        const g = createGraphFromEnv(process.env);
        if (!g || !g.devicesByScope) return sendJson(res, 500, { error: 'graph_not_configured' });
        const { devices = [] } = await g.devicesByScope({ tenant: null, building, floor, zone: null, type: null });
        const deviceIds = Array.from(new Set(devices.map(d => String(d.id)).filter(Boolean)));
        const dir = path.join(root, process.env.S3_LOCAL_DIR || 'CSVex_s3');
        const fieldSet = new Set();
        let tsMin = Infinity, tsMax = -Infinity;
        let inRangeCount = 0;
        for (const id of deviceIds) {
          try {
            const p = path.join(dir, `${id}.csv`);
            if (!fs.existsSync(p)) continue;
            const text = fs.readFileSync(p, 'utf8');
            const lines = text.split(/\r?\n/).filter(Boolean);
            if (!lines.length) continue;
            const headers = lines[0].split(',').map(h => h.trim()).filter(Boolean);
            headers.filter(h => h !== 'ts').forEach(h => fieldSet.add(h));
            // Update overall ts range and in-range count roughly
            for (let i = 1; i < lines.length; i++) {
              const parts = lines[i].split(',');
              const ts = Number(parts[0]);
              if (Number.isFinite(ts)) {
                if (ts < tsMin) tsMin = ts;
                if (ts > tsMax) tsMax = ts;
                if (withinRange(ts, start, end)) inRangeCount += 1;
              }
            }
          } catch {}
        }
        const fields = Array.from(fieldSet).sort();
        return sendJson(res, 200, {
          scope: { building, floor },
          devices: deviceIds,
          tables: {
            telemetry: {
              count: null,
              tsMin: isFinite(tsMin) ? tsMin : null,
              tsMax: isFinite(tsMax) ? tsMax : null,
              fields,
              fieldSpans: {},
              types: {},
              inRangeCount
            }
          }
        });
      } catch (e) {
        return sendJson(res, 500, { error: 'scope_meta_failed', detail: String(e) });
      }
    }

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
    // Weather meta (respect building param)
    const weatherArr = loadWeather(building || null);
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

  // Series extract across a scope (tenant/building/floor/zone) for a given metric
  if (pathname === '/api/scope/series' && req.method === 'GET') {
    try {
      const tenant = String(query.tenant || '').trim() || null;
      const building = String(query.building || '').trim() || null;
      const floor = String(query.floor || '').trim() || null;
      const zone = String(query.zone || '').trim() || null;
      const field = String(query.field || '').trim();
      const start = query.start ? Number(query.start) : null;
      const end = query.end ? Number(query.end) : null;
      let limit = 1000;
      if (query.limit != null) {
        const rawLimit = Number(query.limit);
        if (Number.isFinite(rawLimit)) {
          limit = rawLimit <= 0 ? Infinity : Math.max(1, Math.min(20000, rawLimit));
        }
      }
      if (!field) return sendJson(res, 400, { error: 'field required' });

      // Weather support: if building provided and field prefixed with weather.
      if (building && field.startsWith('weather.')) {
        const weatherKey = field.split('.').slice(1).join('.') || '';
        const arr = loadWeather(building) || [];
        const rows = [];
        for (const r of arr) {
          const ts = Number(r.ts);
          if (!Number.isFinite(ts)) continue;
          if (!withinRange(ts, start, end)) continue;
          const v = r[weatherKey];
          const y = Number(v);
          if (!Number.isFinite(y)) continue;
          rows.push({ ts, value: y, device: '(weather)' });
          if (rows.length >= limit) break;
        }
        rows.sort((a,b)=>a.ts-b.ts);
        return sendJson(res, 200, { scope: { tenant, building, floor, zone }, field, count: rows.length, rows });
      }

      // Determine device IDs in scope (favor snapshot, fallback to graph)
      const deviceIds = [];
      const devMeta = new Map();
      try {
        const slug = (s) => String(s||'').trim().toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'');
        const snapFile = tenant ? path.join(root, 'data', `graph_snapshot.${slug(tenant)}.json`) : path.join(root, 'data', 'graph_snapshot.json');
        if (fs.existsSync(snapFile)) {
          const snap = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
          const nodes = snap.nodes || []; const links = snap.links || [];
          const byId = new Map(nodes.map(n => [n.id, n]));
          const typeOf = (n) => (n?.nodeType || n?.label);
          const buildings = nodes.filter(n => typeOf(n)==='Building');
          const floors = nodes.filter(n => typeOf(n)==='Floor');
          const zones = nodes.filter(n => typeOf(n)==='Zone');
          const bNode = building ? buildings.find(b => String(b.name) === String(building)) : null;
          const fNode = floor && bNode ? floors.find(f => String(f.name) === String(floor) && links.some(l => l.source===f.id && ['LOCATED_IN_BUILDING','PART_OF_BUILDING'].includes(l.rel) && l.target===bNode.id)) : null;
          const zNode = zone && ((fNode && zones.find(z => String(z.name)===String(zone) && links.some(l => l.source===z.id && ['BELONGS_TO_FLOOR','PART_OF_FLOOR'].includes(l.rel) && l.target===fNode.id)))
                                  || (!fNode && bNode && zones.find(z => String(z.name)===String(zone) && links.some(l => l.source===z.id && ['LOCATED_IN_BUILDING','PART_OF_BUILDING'].includes(l.rel) && l.target===bNode.id)))
                                  || zones.find(z => String(z.name)===String(zone))) || null;
          const pushDev = (devId) => {
            const d = byId.get(devId); if (!d) return;
            const id = String(d.cloudId || d.id || d.deviceId || d.name || '').trim(); if (!id) return;
            if (!deviceIds.includes(id)) deviceIds.push(id);
          };
          if (zNode) {
            for (const l of links) if (l.rel==='LOCATED_IN_ZONE' && l.target===zNode.id) pushDev(l.source);
          } else if (fNode) {
            const zIds = new Set(links.filter(l => ['BELONGS_TO_FLOOR','PART_OF_FLOOR'].includes(l.rel) && l.target===fNode.id).map(l => l.source));
            for (const l of links) if (l.rel==='LOCATED_IN_ZONE' && zIds.has(l.target)) pushDev(l.source);
            for (const l of links) if (l.rel==='LOCATED_ON_FLOOR' && l.target===fNode.id) pushDev(l.source);
          } else if (bNode) {
            const fIds = new Set(links.filter(l => ['LOCATED_IN_BUILDING','PART_OF_BUILDING'].includes(l.rel) && l.target===bNode.id).map(l => l.source));
            const zIds = new Set(links.filter(l => ['BELONGS_TO_FLOOR','PART_OF_FLOOR'].includes(l.rel) && fIds.has(l.target)).map(l => l.source));
            for (const l of links) if (l.rel==='LOCATED_IN_ZONE' && zIds.has(l.target)) pushDev(l.source);
            for (const l of links) if (l.rel==='LOCATED_ON_FLOOR' && fIds.has(l.target)) pushDev(l.source);
            for (const l of links) if (l.rel==='IN_BUILDING' && l.target===bNode.id) pushDev(l.source);
          }
        }
      } catch {}
      if (!deviceIds.length) {
        try {
          const g = createGraphFromEnv(process.env);
          if (g && g.devicesByScope) {
            const { devices = [] } = await g.devicesByScope({ tenant, building, floor, zone, type: null });
            for (const d of devices) { const id = String(d.id || '').trim(); if (id && !deviceIds.includes(id)) deviceIds.push(id); }
          }
        } catch {}
      }
      // Filter to S3-present devices only
      let ids = deviceIds.slice();
      try {
        const dir = path.join(root, process.env.S3_LOCAL_DIR || 'CSVex_s3');
        if (fs.existsSync(dir)) {
          const s3set = new Set(fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.csv')).map(f => f.replace(/\.csv$/i, '')));
          ids = ids.filter(id => s3set.has(String(id)));
        }
      } catch {}

      // Collect rows across devices
      const rows = [];
      const dir = path.join(root, process.env.S3_LOCAL_DIR || 'CSVex_s3');
      for (const id of ids) {
        try {
          const file = path.join(dir, `${id}.csv`);
          if (!fs.existsSync(file)) continue;
          const text = fs.readFileSync(file, 'utf8');
          const lines = text.split(/\r?\n/).filter(Boolean);
          if (lines.length < 2) continue;
          const headers = lines[0].split(',');
          const colIndex = headers.indexOf(field);
          if (colIndex === -1) continue;
          for (let i = 1; i < lines.length; i++) {
            const parts = lines[i].split(',');
            const ts = Number(parts[0]); if (!Number.isFinite(ts)) continue;
            if (!withinRange(ts, start, end)) continue;
            const y = Number(parts[colIndex]); if (!Number.isFinite(y)) continue;
            rows.push({ ts, value: y, device: id });
            if (rows.length >= limit) break;
          }
          if (rows.length >= limit) break;
        } catch {}
      }
      rows.sort((a,b)=>a.ts-b.ts);
      return sendJson(res, 200, { scope: { tenant, building, floor, zone }, field, count: rows.length, rows });
    } catch (e) { return sendJson(res, 500, { error: 'scope_series_failed', detail: String(e) }); }
  }

  if (pathname === '/api/chat' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const { messages = [], room, range, selection } = payload;
        let conversationId = String(payload.conversationId || '').trim();
        if (!conversationId) conversationId = randomUUID();
        let conversationState = conversationStore.ensure(conversationId);
        if (DEBUG_HTTP) console.log('[API/chat] selection:', selection, 'conversationId=', conversationId);
        // Compute effective scope from UI selection (building/floor/room(zone))
        // In S3-only mode, a "room" is a deviceId; zones are mapped to devices via graph.
        let effRoom = room || null;
        let scopeNote = '';
        let selectionRooms = [];
        let selectionZones = [];
        let selectionFloors = [];
        try {
          if (selection && (selection.building || selection.floor || selection.room)) {
            const g = createGraphFromEnv(process.env);
            // If a specific zone (room) is selected, gather devices in that zone
            if (selection.room && g && g.devicesByScope) {
              const { devices = [] } = await g.devicesByScope({ tenant: selection.tenant || null, building: selection.building || null, floor: selection.floor || null, zone: selection.room || null, type: null });
              const devIds = Array.from(new Set(devices.map(d => String(d.id)).filter(Boolean)));
              effRoom = 'ALL';
              selectionRooms = devIds;
              // Include zones list for scope; omit devices from note
              let roomsList = [];
              try {
                  // Always resolve zone names under the current selection
                  try {
                    const cyZ = `
                      OPTIONAL MATCH (t:Tenant)
                      WHERE $tenant IS NULL OR t.name=$tenant OR toString(t.id)=$tenant
                      MATCH (b:Building)
                      WHERE ($tenant IS NULL OR (b)-[:BELONGS_TO_TENANT]->(t)) AND ($building IS NULL OR b.name=$building OR toString(b.id)=$building OR toString(b.buildingID)=$building)
                      OPTIONAL MATCH (f:Floor)
                      WHERE ($floor IS NULL OR f.name=$floor OR toString(f.id)=$floor OR toString(f.floorID)=$floor)
                        AND ( ($building IS NULL) OR ( (f)-[:LOCATED_IN_BUILDING|PART_OF_BUILDING]->(b) ) )
                      MATCH (z:Zone)
                      WHERE ( ($building IS NULL) OR ((z)-[:LOCATED_IN_BUILDING|PART_OF_BUILDING]->(b)) )
                        AND ( ($floor IS NULL) OR EXISTS { MATCH (z)-[:BELONGS_TO_FLOOR|PART_OF_FLOOR]->(f) } )
                      RETURN DISTINCT z.name AS name
                    `;
                    const { records: zrecs } = await g.runQuery(cyZ, { tenant: selection.tenant || null, building: selection.building || null, floor: selection.floor || null });
                    roomsList = (zrecs || []).map(r => r.get('name')).filter(Boolean);
                    // Force the explicitly selected zone to be first and unique
                    const selZ = selection.room ? [String(selection.room)] : [];
                    selectionZones = Array.from(new Set([...selZ, ...roomsList]));
                  } catch {}
                } catch {}
              // Also include floors list for this building scope
              let floorsList = [];
              try {
                const cyF = `
                  MATCH (b:Building)
                  WHERE toLower(b.name)=toLower($building) OR toString(b.id)=$building OR toString(b.buildingID)=$building
                  OPTIONAL MATCH (f:Floor)-[:LOCATED_IN_BUILDING|PART_OF_BUILDING]->(b)
                  RETURN DISTINCT f.name AS name
                `;
                const rrF = await g.runQuery(cyF, { building: selection.building });
                floorsList = (rrF.records || []).map(rec => rec.get('name')).filter(Boolean);
              } catch {}
              const floorsOut = floorsList.length ? floorsList : (selection.floor ? [selection.floor] : []);
              selectionFloors = floorsOut.slice();
              scopeNote = `Scope: ${selection.tenant ? 'tenant='+selection.tenant+' ' : ''}building=${selection.building||''} floor=${selection.floor||''} floors=[${floorsOut.slice(0,30).map(x=>`"${x}"`).join(', ')}${floorsOut.length>30?' …':''}] zones=[${roomsList.slice(0,30).map(z=>`"${z}"`).join(', ')}${roomsList.length>30?' …':''}]`;
            } else if (g && (selection.building || selection.floor)) {
              // Building/floor scope: list zones by name and gather devices
              let roomsList = [];
              try {
                const cyZ = `
                  OPTIONAL MATCH (t:Tenant)
                  WHERE $tenant IS NULL OR t.name=$tenant OR toString(t.id)=$tenant
                  MATCH (b:Building)
                  WHERE ($tenant IS NULL OR (b)-[:BELONGS_TO_TENANT]->(t)) AND ($building IS NULL OR b.name=$building OR toString(b.id)=$building OR toString(b.buildingID)=$building)
                  OPTIONAL MATCH (f:Floor)
                  WHERE ($floor IS NULL OR f.name=$floor OR toString(f.id)=$floor OR toString(f.floorID)=$floor)
                    AND ( ($building IS NULL) OR ( (f)-[:LOCATED_IN_BUILDING|PART_OF_BUILDING]->(b) ) )
                  MATCH (z:Zone)
                  WHERE ( ($building IS NULL) OR ((z)-[:LOCATED_IN_BUILDING|PART_OF_BUILDING]->(b)) )
                    AND ( ($floor IS NULL) OR EXISTS { MATCH (z)-[:BELONGS_TO_FLOOR|PART_OF_FLOOR]->(f) } )
                  RETURN DISTINCT z.name AS name
                `;
                const { records: zrecs } = await g.runQuery(cyZ, { tenant: selection.tenant || null, building: selection.building || null, floor: selection.floor || null });
                roomsList = (zrecs || []).map(r => r.get('name')).filter(Boolean);
                // Fallback: ignore floor filter if no zones matched (floor name mismatch like "Default")
                if (!roomsList.length) {
                  const cyZ2 = `
                    OPTIONAL MATCH (t:Tenant)
                    WHERE $tenant IS NULL OR t.name=$tenant OR toString(t.id)=$tenant
                    MATCH (b:Building)
                    WHERE ($tenant IS NULL OR (b)-[:BELONGS_TO_TENANT]->(t)) AND ($building IS NULL OR b.name=$building OR toString(b.id)=$building OR toString(b.buildingID)=$building)
                    MATCH (z:Zone)-[:LOCATED_IN_BUILDING|PART_OF_BUILDING]->(b)
                    RETURN DISTINCT z.name AS name
                  `;
                  const { records: zrecs2 } = await g.runQuery(cyZ2, { tenant: selection.tenant || null, building: selection.building || null });
                  roomsList = (zrecs2 || []).map(r => r.get('name')).filter(Boolean);
                }
                selectionZones = roomsList;
              } catch {}
              // Gather devices
              let devIds = [];
              try {
                if (g.devicesByScope) {
                  const { devices = [] } = await g.devicesByScope({ tenant: selection.tenant || null, building: selection.building || null, floor: selection.floor || null, zone: null, type: null });
                  devIds = Array.from(new Set(devices.map(d => String(d.id)).filter(Boolean)));
                }
              } catch {}
              effRoom = 'ALL';
              selectionRooms = devIds;
              let floorsList2 = [];
              try {
                if (selection.building) {
                  const cyF = `
                    MATCH (b:Building)
                  WHERE toLower(b.name)=toLower($building) OR toString(b.id)=$building OR toString(b.buildingID)=$building
                  OPTIONAL MATCH (f:Floor)-[:LOCATED_IN_BUILDING|PART_OF_BUILDING]->(b)
                  RETURN DISTINCT f.name AS name
                  `;
                  const rrF = await g.runQuery(cyF, { building: selection.building });
                  floorsList2 = (rrF.records || []).map(rec => rec.get('name')).filter(Boolean);
                }
              } catch {}
              const floorsOut2 = (floorsList2.length ? floorsList2 : (selection.floor ? [selection.floor] : []));
              selectionFloors = floorsOut2.slice();
              scopeNote = `Scope: ${selection.tenant ? 'tenant='+selection.tenant+' ' : ''}${selection.building ? 'building='+selection.building+' ' : ''}${selection.floor ? 'floor='+selection.floor+' ' : ''}${floorsOut2.length ? ('floors=['+floorsOut2.slice(0,30).map(x=>`"${x}"`).join(', ')+(floorsOut2.length>30?' …':'')+'] ') : ''}zones=[${roomsList.slice(0,30).map(z=>`"${z}"`).join(', ')}${roomsList.length>30?' …':''}]`;
            }
          }
        } catch (e) { if (DEBUG_HTTP) console.warn('[API/chat] selection resolution failed:', String(e)); }
        // If still nothing, default to ALL and include all S3 devices
        if (!effRoom) {
          effRoom = 'ALL';
          try {
            const g = createGraphFromEnv(process.env);
            let buildingsList = [];
            let floorsListAll = [];
            if (g && g.roomsByScope) {
              const r = await g.roomsByScope({});
              selectionZones = (r && Array.isArray(r.rooms)) ? r.rooms : [];
            }
            try {
              const br = await g.runQuery('MATCH (b:Building) RETURN DISTINCT b.name AS name ORDER BY name');
              buildingsList = (br.records || []).map(rec => rec.get('name')).filter(Boolean);
            } catch {}
            try {
              const fr = await g.runQuery('MATCH (f:Floor)-[:LOCATED_IN_BUILDING|PART_OF_BUILDING]->(:Building) RETURN DISTINCT f.name AS name ORDER BY name');
              floorsListAll = (fr.records || []).map(rec => rec.get('name')).filter(Boolean);
            } catch {}
            const zList = selectionZones || [];
            selectionFloors = floorsListAll.slice();
            scopeNote = `Scope: buildings=[${buildingsList.slice(0,30).map(x=>`"${x}"`).join(', ')}${buildingsList.length>30?' …':''}] floors=[${floorsListAll.slice(0,30).map(x=>`"${x}"`).join(', ')}${floorsListAll.length>30?' …':''}] zones=[${zList.slice(0,30).map(z=>`"${z}"`).join(', ')}${zList.length>30?' …':''}]`;
          } catch {}
        }
        if ((!selectionRooms || !selectionRooms.length) && selection && Array.isArray(selection.devices)) {
          selectionRooms = selection.devices.map((d) => String(d)).filter(Boolean);
        }
        if ((!selectionZones || !selectionZones.length) && selection && Array.isArray(selection.zones)) {
          selectionZones = selection.zones.map((z) => String(z)).filter(Boolean);
        }
        if (selection && Array.isArray(selection.floors)) {
          selectionFloors = selection.floors.map((f) => String(f)).filter(Boolean);
        }
        const selectionDeviceZones = selection && selection.deviceZones && typeof selection.deviceZones === 'object' ? selection.deviceZones : {};

        conversationState = conversationStore.recordScope(conversationId, {
          tenant: selection?.tenant || null,
          building: selection?.building || null,
          floor: selection?.floor || null,
          zone: selection?.room || selection?.roomLabel || null,
          devices: selectionRooms,
          zones: selectionZones,
          floors: selectionFloors,
          range: range || null
        }) || conversationState;

        if (payload?.preferences) {
          conversationState = conversationStore.recordPreferences(conversationId, payload.preferences) || conversationState;
        }
        if (!selectionZones.length && selection && selection.labels && selection.labels.room) {
          selectionZones = [String(selection.labels.room)];
        }
        if (!scopeNote && (selectionRooms.length || selectionZones.length || selectionFloors.length)) {
          scopeNote = `Scope: ${selection && selection.labels && selection.labels.tenant ? 'tenant='+selection.labels.tenant+' ' : ''}${selection && selection.labels && selection.labels.building ? 'building='+selection.labels.building+' ' : ''}${selection && selection.labels && selection.labels.floor ? 'floor='+selection.labels.floor+' ' : ''}floors=[${selectionFloors.slice(0,30).map(x=>`"${x}"`).join(', ')}${selectionFloors.length>30?' …':''}] zones=[${selectionZones.slice(0,30).map(z=>`"${z}"`).join(', ')}${selectionZones.length>30?' …':''}] devices=[${selectionRooms.slice(0,20).map(d=>`"${d}"`).join(', ')}${selectionRooms.length>20?' …':''}]`;
        }

        if (DEBUG_HTTP) console.log('[API/chat] effective room=', effRoom, 'note=', scopeNote);

        const userLast = [...messages].reverse().find(m => m.role === 'user' || m.role === 'User' || m.role === 'human');
        const question = userLast?.content || '';
        const routingPreview = classifyQuery(question || '');
        conversationState = conversationStore.recordQuestion(conversationId, question, {
          metrics: routingPreview.metrics,
          intents: routingPreview.intents,
          timeHints: routingPreview.timeHints
        }) || conversationState;
        const tables = effRoom && effRoom !== 'ALL' ? loadRoomTables(effRoom) : {};
        const context = {
          instruction: 'You are a building analytics chat assistant. Answer succinctly. If plotting helps, include a JSON HighchartsOptions with yAxis as time and xAxis as chosen metric. Do not include code fences in the JSON.',
          tables: Object.keys(tables),
          sampleRows: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.slice(0, 5)])),
          range: range || {},
          knowledge: loadKnowledge(),
          weatherSample: loadWeather().slice(-50)
        };

        // Use the tool-enabled agent (RAG + tools). Retry once with a richer mode if the first attempt
        // does not produce a substantive answer or required chart.
        const effMessages = scopeNote ? [{ role: 'user', content: scopeNote }, ...messages, { role: 'user', content: question }] : messages.concat({ role: 'user', content: question });

    function expectsChartFromQuestion(q) {
      return /(plot|chart|graph|visualize|heatmap|compare|forecast|correlat)/i.test(q || '');
    }

    function chartHasRenderableSeries(res) {
      const series = res?.chart?.series;
      if (!Array.isArray(series) || !series.length) return false;
      return series.some((s) => s && (s.data || s.dataRef));
    }

    function resultNeedsRetry(res) {
      if (!res) return true;
      const text = (res.message && res.message.content) ? String(res.message.content).trim() : '';
      if (!text) return true;
      const lower = text.toLowerCase();
      if (/unable to/.test(lower) || /no data available/.test(lower)) return true;
      if (expectsChartFromQuestion(question) && !chartHasRenderableSeries(res)) return true;
      return false;
    }

    const conversationSummary = conversationStore.summarize(conversationState);
    const maxAttempts = Number(process.env.AGENT_MAX_ATTEMPTS || 2);
    let agentResult = null;
    for (let attempt = 0; attempt < Math.max(1, maxAttempts); attempt += 1) {
      const runResult = await agent.run(effMessages, {
        room: effRoom,
        range,
        selectionRooms,
        selectionZones,
        tenant: (selection && selection.tenant) ? String(selection.tenant) : null,
        building: (selection && selection.building) ? String(selection.building) : null,
        floor: (selection && selection.floor) ? String(selection.floor) : null,
        zone: (selection && selection.room) ? String(selection.room) : null,
        scopeLabels: selection && selection.labels ? selection.labels : null,
        scopeFloors: selectionFloors,
        scopeDeviceZones: selectionDeviceZones,
        attempt,
        conversationSummary
      });
      if (!resultNeedsRetry(runResult)) {
        agentResult = runResult;
        break;
      }
      if (DEBUG_HTTP) console.warn(`[API/chat] attempt ${attempt} delivered incomplete result; retrying`);
      if (attempt === Math.max(1, maxAttempts) - 1) {
        agentResult = runResult; // give best-effort result after final attempt
      }
    }

    const { message, chart, trace, extras } = agentResult || {};
    try {
      if (Array.isArray(trace)) {
        console.log(`[Agent][trace] ${trace.length} entries`);
        for (const t of trace) {
          if (t && t.tool) console.log('[Agent][tool]', t.tool, 'args=', JSON.stringify(t.args||{}).slice(0,200));
        }
      }
    } catch {}

    // Optional: persist full trace for audit if TRACE_DIR is configured (defaults to ./data/traces)
    try {
      const TRACE_DIR = process.env.TRACE_DIR || path.join(root, 'data', 'traces');
      if (TRACE_DIR) {
        fs.mkdirSync(TRACE_DIR, { recursive: true });
        const ts = new Date();
        const pad = (n)=>String(n).padStart(2,'0');
        const stamp = `${ts.getFullYear()}-${pad(ts.getMonth()+1)}-${pad(ts.getDate())}_${pad(ts.getHours())}-${pad(ts.getMinutes())}-${pad(ts.getSeconds())}`;
        // Build a concise file name with scope
        const parts = [];
        if (selection && selection.building) parts.push(`b-${String(selection.building).replace(/[^a-z0-9]+/gi,'_').slice(0,40)}`);
        if (selection && selection.floor) parts.push(`f-${String(selection.floor).replace(/[^a-z0-9]+/gi,'_').slice(0,40)}`);
        if (selection && selection.room) parts.push(`z-${String(selection.room).replace(/[^a-z0-9]+/gi,'_').slice(0,40)}`);
        const fname = `trace_${stamp}${parts.length?('_'+parts.join('_')):''}.json`;
        const record = {
          timestamp: ts.toISOString(),
          selection: selection || null,
          effective: { room: effRoom, range },
          selectionRooms,
          selectionZones,
          question: (messages && messages.length) ? (messages[messages.length-1]?.content || '') : '',
          answer: message?.content || '',
          hasChart: !!chart,
          chart: chart || null,
          extras: extras || [],
          trace: Array.isArray(trace) ? trace : []
        };
        fs.writeFileSync(path.join(TRACE_DIR, fname), JSON.stringify(record, null, 2));
        console.log('[Agent][trace] saved to', path.join(TRACE_DIR, fname));
      }
    } catch (e) { console.warn('[Agent][trace] save failed:', String(e)); }
        if (!message || !message.content) {
          return sendJson(res, 502, { conversationId, error: 'agent_empty', detail: 'Agent returned no answer after retries.' });
        }
        const insightSummary =
          (message?.content || '')
            .split('\n')
            .map((line) => line.trim())
            .find((line) => line.length) || '';
        conversationState = conversationStore.recordInsight(conversationId, {
          summary: insightSummary,
          metrics: routingPreview.metrics
        }) || conversationState;
        if (expectsChartFromQuestion(question) && !chartHasRenderableSeries(agentResult)) {
          return sendJson(res, 502, { conversationId, error: 'agent_no_chart', detail: 'Agent did not deliver chart data after retries.' });
        }
        return sendJson(res, 200, { conversationId, message, chart, extras: extras || ((agent && agent.extras) ? agent.extras : undefined), trace, mode: 'agent' });
      } catch (e) {
        try { console.error('[API/chat] FAILED:', e?.stack || String(e)); } catch {}
        return sendJson(res, 500, { conversationId, error: 'bad_request', detail: String(e?.message || e || 'unknown') });
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
        try {
          if (range && (range.start != null || range.end != null)) {
            const sOk = (typeof range.start === 'number' && Number.isFinite(range.start));
            const eOk = (typeof range.end === 'number' && Number.isFinite(range.end));
            console.log('[API/query] Start:', range.start, sOk ? new Date(range.start).toISOString() : '(none)');
            console.log('[API/query] End:', range.end, eOk ? new Date(range.end).toISOString() : '(none)');
          }
        } catch {}
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

        return sendJson(res, 502, { error: 'analysis_failed', detail: 'Unable to generate analysis for the requested query.' });
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

  // Lightweight diagnostics
  if (pathname === '/api/diag' && req.method === 'GET') {
    try {
      const snapPath = path.join(root, 'data', 'graph_snapshot.json');
      const haveSnap = fs.existsSync(snapPath);
      const s3Weather = path.join(s3LocalDir, 'weather_buildings');
      const dataWeather = path.join(root, 'data', 'weather_buildings');
      const out = {
        env: {
          LOG_LEVEL: process.env.LOG_LEVEL || '',
          HTTP_DEBUG: process.env.HTTP_DEBUG || '',
          USE_LLM, LLM_PROVIDER, GEMINI_MODEL
        },
        paths: { s3LocalDir, dataDir, publicDir },
        snapshot: { haveSnap, file: haveSnap ? 'data/graph_snapshot.json' : null },
        weather: {
          s3Exists: fs.existsSync(s3Weather),
          dataExists: fs.existsSync(dataWeather),
          s3Files: fs.existsSync(s3Weather) ? fs.readdirSync(s3Weather).filter(f=>f.endsWith('.csv')).slice(0,20) : [],
          dataFiles: fs.existsSync(dataWeather) ? fs.readdirSync(dataWeather).filter(f=>f.endsWith('.csv')).slice(0,20) : []
        }
      };
      return sendJson(res, 200, out);
    } catch (e) { return sendJson(res, 500, { error: 'diag_failed', detail: String(e) }); }
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
        OPTIONAL MATCH (f:Floor)-[:LOCATED_IN_BUILDING|PART_OF_BUILDING|BELONGS_TO_BUILDING|IN_BUILDING]->(b)
        OPTIONAL MATCH (z1:Zone)-[:LOCATED_ON_FLOOR|BELONGS_TO_FLOOR|PART_OF_FLOOR]->(f)
        OPTIONAL MATCH (z2:Zone)-[:LOCATED_IN_BUILDING|PART_OF_BUILDING|BELONGS_TO_BUILDING]->(b)
        WITH b, collect(DISTINCT f) AS fs, collect(DISTINCT coalesce(z1,z2)) AS zs
        OPTIONAL MATCH (d:Device)-[:IN_BUILDING|LOCATED_IN_BUILDING]->(b)
        OPTIONAL MATCH (d2:Device)-[:LOCATED_IN_ZONE]->(:Zone)-[:LOCATED_IN_BUILDING|PART_OF_BUILDING|BELONGS_TO_BUILDING]->(b)
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
      const key = cacheKey({ kind: 'topology', tenant });
      const cached = cacheGet(__cache.topology, key, 15000);
      if (cached) return sendJson(res, 200, cached);
      const g = createGraphFromEnv(process.env);
      if (!g || !g.runQuery) return sendJson(res, 500, { error: 'graph_not_configured' });
      const cy = `
        OPTIONAL MATCH (t:Tenant)
        WHERE $tenant IS NULL OR t.name=$tenant OR toString(t.id)=$tenant
        MATCH (b:Building)
        WHERE $tenant IS NULL OR (b)-[:BELONGS_TO_TENANT]->(t)
        OPTIONAL MATCH (f:Floor)-[:LOCATED_IN_BUILDING|PART_OF_BUILDING]->(b)
        OPTIONAL MATCH (z:Zone)-[:LOCATED_IN_BUILDING|PART_OF_BUILDING]->(b)
        WITH b, f, z
        OPTIONAL MATCH (d:Device)
        WHERE (z IS NOT NULL AND (d)-[:LOCATED_IN_ZONE]->(z))
           OR (f IS NOT NULL AND (d)-[:LOCATED_ON_FLOOR]->(f))
           OR (z IS NULL AND f IS NULL AND (d)-[:IN_BUILDING]->(b))
        RETURN b.name AS building,
               f.name AS floor,
               coalesce(z.roomId, toString(z.id), z.name) AS zone,
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
      const payload = { tenant, buildings: out };
      cacheSet(__cache.topology, key, payload);
      return sendJson(res, 200, payload);
    } catch (e) { return sendJson(res, 500, { error: 'topology_failed', detail: String(e) }); }
  }

  // Metrics available in a scope (tenant/building/floor/zone)
  if (pathname === '/api/scope/metrics' && req.method === 'GET') {
    try {
      const tenant = String(query.tenant || '').trim() || null;
      const building = String(query.building || '').trim() || null;
      const floor = String(query.floor || '').trim() || null;
      const zone = String(query.zone || '').trim() || null;
      const key = cacheKey({ kind: 'scopeMetrics', tenant, building, floor, zone });
      const cached = cacheGet(__cache.scopeMetrics, key, 12000);
      if (cached) return sendJson(res, 200, cached);
      const devMeta = new Map();
      let deviceIds = [];
      // FAST PATH: derive devices by scope from graph snapshot + S3 presence
      try {
        const slug = (s) => String(s||'').trim().toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'');
        const snapFile = tenant ? path.join(root, 'data', `graph_snapshot.${slug(tenant)}.json`) : path.join(root, 'data', 'graph_snapshot.json');
        if (fs.existsSync(snapFile)) {
          const snap = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
          const nodes = snap.nodes || []; const links = snap.links || [];
          const byId = new Map(nodes.map(n => [n.id, n]));
          const typeOf = (n) => (n?.nodeType || n?.label);
          const buildings = nodes.filter(n => typeOf(n)==='Building');
          const floors = nodes.filter(n => typeOf(n)==='Floor');
          const zones = nodes.filter(n => typeOf(n)==='Zone');
          const devices = nodes.filter(n => typeOf(n)==='Device');
          const bNode = building ? buildings.find(b => String(b.name) === String(building)) : null;
          const fNode = floor && bNode ? floors.find(f => String(f.name) === String(floor) && links.some(l => l.source===f.id && ['LOCATED_IN_BUILDING','PART_OF_BUILDING'].includes(l.rel) && l.target===bNode.id)) : null;
          const zNode = zone && ((fNode && zones.find(z => String(z.name)===String(zone) && links.some(l => l.source===z.id && ['BELONGS_TO_FLOOR','PART_OF_FLOOR'].includes(l.rel) && l.target===fNode.id)))
                                  || (!fNode && bNode && zones.find(z => String(z.name)===String(zone) && links.some(l => l.source===z.id && ['LOCATED_IN_BUILDING','PART_OF_BUILDING'].includes(l.rel) && l.target===bNode.id)))
                                  || zones.find(z => String(z.name)===String(zone))) || null;
          const s3Dir = path.join(root, process.env.S3_LOCAL_DIR || 'CSVex_s3');
          const s3set = fs.existsSync(s3Dir) ? new Set(fs.readdirSync(s3Dir).filter(f=>/\.csv$/i.test(f)).map(f=>f.replace(/\.csv$/i,''))) : new Set();
          const pushDev = (devId) => {
            const d = byId.get(devId);
            if (!d) return;
            const id = String(d.cloudId || d.id || d.deviceId || d.name || '').trim();
            if (!id || !s3set.has(id)) return; // must have S3 data
            const meta = { name: d.name || id, type: d.deviceType || d.type || null, zone: null, floor: null, building: null };
            // derive labels via links
            const rels = links.filter(l => l.source===devId || l.target===devId);
            for (const l of rels) {
              const other = (l.source===devId) ? l.target : l.source;
              const nn = byId.get(other);
              const t = typeOf(nn);
              if (t==='Zone') meta.zone = nn.name || meta.zone;
              if (t==='Floor') meta.floor = nn.name || meta.floor;
              if (t==='Building') meta.building = nn.name || meta.building;
            }
            // also propagate from zone/floor if missing
            if (!meta.floor && meta.zone) {
              const zn = zones.find(z => z.name===meta.zone);
              const fl = links.find(l => l.source===zn?.id && ['BELONGS_TO_FLOOR','PART_OF_FLOOR'].includes(l.rel));
              const fn = byId.get(fl?.target); if (typeOf(fn)==='Floor') meta.floor = fn.name || meta.floor;
            }
            if (!meta.building && meta.floor) {
              const fn = floors.find(f => f.name===meta.floor);
              const bl = links.find(l => l.source===fn?.id && ['LOCATED_IN_BUILDING','PART_OF_BUILDING'].includes(l.rel));
              const bn = byId.get(bl?.target); if (typeOf(bn)==='Building') meta.building = bn.name || meta.building;
            }
            devMeta.set(id, meta);
            if (!deviceIds.includes(id)) deviceIds.push(id);
          };
          if (zNode) {
            for (const l of links) if (l.rel==='LOCATED_IN_ZONE' && l.target===zNode.id) pushDev(l.source);
          } else if (fNode) {
            const zIds = new Set(links.filter(l => ['BELONGS_TO_FLOOR','PART_OF_FLOOR'].includes(l.rel) && l.target===fNode.id).map(l => l.source));
            for (const l of links) if (l.rel==='LOCATED_IN_ZONE' && zIds.has(l.target)) pushDev(l.source);
            for (const l of links) if (l.rel==='LOCATED_ON_FLOOR' && l.target===fNode.id) pushDev(l.source);
          } else if (bNode) {
            // include any device in building via zone/floor/building edges
            const fIds = new Set(links.filter(l => ['LOCATED_IN_BUILDING','PART_OF_BUILDING'].includes(l.rel) && l.target===bNode.id).map(l => l.source));
            const zIds = new Set(links.filter(l => ['BELONGS_TO_FLOOR','PART_OF_FLOOR'].includes(l.rel) && fIds.has(l.target)).map(l => l.source));
            for (const l of links) if (l.rel==='LOCATED_IN_ZONE' && zIds.has(l.target)) pushDev(l.source);
            for (const l of links) if (l.rel==='LOCATED_ON_FLOOR' && fIds.has(l.target)) pushDev(l.source);
            for (const l of links) if (l.rel==='IN_BUILDING' && l.target===bNode.id) pushDev(l.source);
          }
          // Strict filter by explicit scope if provided
          const filt = (arr) => arr.filter(id => {
            const meta = devMeta.get(id);
            if (!meta) return true;
            if (zone && String(meta.zone||'').toLowerCase() !== String(zone).toLowerCase()) return false;
            if (floor && String(meta.floor||'').toLowerCase() !== String(floor).toLowerCase()) return false;
            if (building && String(meta.building||'').toLowerCase() !== String(building).toLowerCase()) return false;
            return true;
          });
          deviceIds = filt(deviceIds);
        }
      } catch {}
      // If snapshot produced nothing, fallback to graph adapter
      if (!deviceIds.length) {
        const g = createGraphFromEnv(process.env);
        if (!g || !g.devicesByScope) return sendJson(res, 500, { error: 'graph_not_configured' });
        const { devices = [] } = await g.devicesByScope({ tenant, building, floor, zone, type: null });
        for (const d of devices) {
          const id = String(d.id || '').trim(); if (!id) continue;
          devMeta.set(id, { name: d.name || id, type: d.type || null, zone: d.zone || null, floor: d.floor || null, building: d.building || null });
          if (!deviceIds.includes(id)) deviceIds.push(id);
        }
      }
      const allDevIds = deviceIds.slice();
      // Filter to S3-present devices (cloud_id-based filenames)
      try {
        const dir = path.join(root, process.env.S3_LOCAL_DIR || 'CSVex_s3');
        if (fs.existsSync(dir)) {
          const s3set = new Set(fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.csv')).map(f => f.replace(/\.csv$/i, '')));
          deviceIds = deviceIds.filter(id => s3set.has(String(id)));
        }
      } catch {}
      const byDevice = {};
      const union = new Map();
      const zonesSet = new Set();
      const floorsSet = new Set();
      const byZoneFields = new Map(); // zone -> Set(fields)
      const byFloorFields = new Map(); // floor -> Set(fields)
      const coverage = new Map(); // metric -> {zones:Set, floors:Set}
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
        const g = createGraphFromEnv(process.env);
        const { records } = g ? await g.runQuery(cy, { ids: allDevIds }) : { records: [] };
        for (const r of (records || [])) graphKeys.set(String(r.get('id')), (r.get('keys') || []).filter(Boolean));
      } catch {}
      // 2) Fallback to S3 headers when no graph keys present
      const dir = path.join(root, process.env.S3_LOCAL_DIR || 'CSVex_s3');
      const idsForFields = deviceIds.length ? deviceIds : allDevIds;
      for (const id of idsForFields) {
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

        // Aggregate zone/floor per metric
        const meta = devMeta.get(id) || {};
        const z = meta.zone || null;
        const fl = meta.floor || null;
        if (z) zonesSet.add(z);
        if (fl) floorsSet.add(fl);
        for (const m of uniq) {
          if (!coverage.has(m)) coverage.set(m, { zones: new Set(), floors: new Set() });
          const c = coverage.get(m);
          if (z) c.zones.add(z);
          if (fl) c.floors.add(fl);
        }
        // byZoneFields and byFloorFields
        if (z) {
          const set = byZoneFields.get(z) || new Set();
          uniq.forEach(x => set.add(x));
          byZoneFields.set(z, set);
        }
        if (fl) {
          const set = byFloorFields.get(fl) || new Set();
          uniq.forEach(x => set.add(x));
          byFloorFields.set(fl, set);
        }
      }
      // Add weather.* fields to union (count as 1 for scope)
      for (const wf of weatherFields) union.set(wf, (union.get(wf) || 0) + 1);
      const metrics = Array.from(new Set([...union.keys()])).sort();
      const counts = Object.fromEntries(metrics.map(k => [k, union.get(k)]));
      const zones = Array.from(zonesSet);
      const floorsArr = Array.from(floorsSet);
      const byZone = Object.fromEntries(Array.from(byZoneFields.entries()).map(([k,v])=>[k, Array.from(v).sort()]));
      const byFloor = Object.fromEntries(Array.from(byFloorFields.entries()).map(([k,v])=>[k, Array.from(v).sort()]));
      const perMetricCoverage = Object.fromEntries(metrics.map(m => [m, {
        zones: Array.from((coverage.get(m)?.zones || new Set()).values()).sort(),
        floors: Array.from((coverage.get(m)?.floors || new Set()).values()).sort()
      }]));
      // Build device index and hierarchical groups for UI rendering
      const deviceIndex = deviceIds.map(id => {
        const meta = devMeta.get(id) || {};
        return {
          id,
          name: meta.name || id,
          type: meta.type || null,
          building: meta.building || null,
          floor: meta.floor || null,
          zone: meta.zone || null,
          metrics: byDevice[id] || []
        };
      });
      const byB = new Map();
      for (const d of deviceIndex) {
        const b = d.building || '(Unknown Building)';
        const f = d.floor || '(Unknown Floor)';
        const z = d.zone || '(Unknown Zone)';
        if (!byB.has(b)) byB.set(b, new Map());
        const byF = byB.get(b);
        if (!byF.has(f)) byF.set(f, new Map());
        const byZ = byF.get(f);
        if (!byZ.has(z)) byZ.set(z, []);
        byZ.get(z).push({ id: d.id, name: d.name, type: d.type, metrics: d.metrics });
      }
      const groups = Array.from(byB.entries()).map(([b, byF]) => ({
        building: b,
        floors: Array.from(byF.entries()).map(([f, byZ]) => ({
          floor: f,
          zones: Array.from(byZ.entries()).map(([z, devs]) => ({ zone: z, devices: devs }))
        }))
      }));
      const payload = { scope: { tenant, building, floor, zone }, devices: deviceIds, metrics, counts, byDevice, zones, floors: floorsArr, byZone, byFloor, coverage: perMetricCoverage, weather: weatherFields, deviceIndex, groups };
      cacheSet(__cache.scopeMetrics, key, payload);
      return sendJson(res, 200, payload);
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

// -------- Persistent In-Memory Index (Snapshot-first O(1) resolution) --------
const __indexStore = {
  tenants: new Map(), // tenantKey -> { floorsByBuilding, zonesByBF, deviceIdsByScope, devicesMeta, keysByDevice, buildings, buildingCoords }
};

let __buildingCoordsCache = null;
const __weatherFetchPromises = new Map();

function resetBuildingCoordsCache() {
  __buildingCoordsCache = null;
}

function getAllIndexedBuildingCoords() {
  if (__buildingCoordsCache) return __buildingCoordsCache;
  const coords = new Map();
  const fallback = defaultWeatherCoords();
  const addEntry = (name, value) => {
    if (!name) return;
    const slug = buildingSlug(name);
    if (!slug || coords.has(slug)) return;
    let lat = value ? toNumeric(value.lat ?? value.latitude) : null;
    let lon = value ? toNumeric(value.lon ?? value.longitude ?? value.long) : null;
    let fallbackUsed = false;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      lat = fallback.lat;
      lon = fallback.lon;
      fallbackUsed = true;
    }
    coords.set(slug, { name, lat, lon, fallback: fallbackUsed });
  };

  for (const idx of __indexStore.tenants.values()) {
    if (!idx) continue;
    if (idx.buildings && typeof idx.buildings.forEach === 'function') {
      idx.buildings.forEach((name) => {
        const coord = idx.buildingCoords?.get?.(name) ?? idx.buildingCoords?.get?.(String(name));
        addEntry(name, coord);
      });
    }
    if (idx.buildingCoords && typeof idx.buildingCoords.forEach === 'function') {
      idx.buildingCoords.forEach((value, name) => addEntry(name, value));
    }
  }

  __buildingCoordsCache = coords;
  return coords;
}

function findIndexedBuildingCoord(buildingName) {
  if (!buildingName) return null;
  const slug = buildingSlug(buildingName);
  const coords = getAllIndexedBuildingCoords();
  if (coords.has(slug)) return coords.get(slug);
  const targetLower = String(buildingName).trim().toLowerCase();
  for (const entry of coords.values()) {
    if (String(entry.name).trim().toLowerCase() === targetLower) return entry;
  }
  const fallback = defaultWeatherCoords();
  return { name: buildingName, lat: fallback.lat, lon: fallback.lon, fallback: true };
}

async function prefetchWeatherForAllBuildings() {
  try {
    const coords = getAllIndexedBuildingCoords();
    for (const { name, lat, lon } of coords.values()) {
      try {
        const res = await fetchAndCacheWeatherForBuilding(name, lat, lon);
        if (res?.error) console.warn('[startup][weather] Prefetch failed for', name, res.error);
      } catch (e) {
        console.warn('[startup][weather] Prefetch error:', name, String(e));
      }
    }
  } catch (e) {
    console.warn('[startup][weather] Prefetch index error:', String(e));
  }
}

function ensureWeatherFetchForBuilding(buildingName) {
  if (!buildingName) return;
  const slug = buildingSlug(buildingName);
  const csvS3 = path.join(s3LocalDir, 'weather_buildings', `${slug}.csv`);
  const csvData = path.join(root, 'data', 'weather_buildings', `${slug}.csv`);
  const files = [csvS3, csvData].filter((file) => fs.existsSync(file));
  if (files.length) {
    const tsMap = new Map();
    for (const file of files) {
      try {
        const parsed = parseCSV(file);
        for (const row of parsed) {
          const ts = Number(row?.ts);
          if (Number.isFinite(ts)) tsMap.set(ts, true);
        }
      } catch (err) {
        console.warn('[weather] unable to inspect cached file', file, String(err));
      }
    }
    const startDt = parseUtcDate(WEATHER_BACKFILL_START);
    const endDt = parseUtcDate(WEATHER_BACKFILL_END);
    if (hasWeatherCoverage(tsMap, startDt, endDt)) return;
  }
  if (__weatherFetchPromises.has(slug)) return;
  const coord = findIndexedBuildingCoord(buildingName);
  if (!coord) return;
  const promise = fetchAndCacheWeatherForBuilding(coord.name, coord.lat, coord.lon)
    .catch((err) => {
      console.warn('[weather] async fetch failed for', coord.name, String(err));
    })
    .finally(() => {
      __weatherFetchPromises.delete(slug);
    });
  __weatherFetchPromises.set(slug, promise);
}

function buildTenantIndexFromSnapshot(snap, tenant = null) {
  try {
    const nodes = Array.isArray(snap?.nodes) ? snap.nodes : [];
    const links = Array.isArray(snap?.links) ? snap.links : [];
    const byId = new Map(nodes.map(n => [n.id, n]));
    const typeOf = (n) => (n?.nodeType || n?.label);
    const s = {
      floorsByBuilding: new Map(),
      zonesByBF: new Map(),
      deviceIdsByScope: new Map(),
      devicesMeta: new Map(),
      keysByDevice: new Map(),
      buildings: new Set(),
      buildingCoords: new Map(),
    };
    // Telemetry keys mapping
    for (const l of links) {
      if (l.rel === 'HAS_TELEMETRY_KEY' || l.rel === 'MEASURES') {
        const a = byId.get(l.source), b = byId.get(l.target);
        const dev = typeOf(a)==='Device' ? a : (typeOf(b)==='Device' ? b : null);
        const key = typeOf(a)==='TelemetryKey' ? a : (typeOf(b)==='TelemetryKey' ? b : null);
        if (dev && key && key.name) {
          const id = String(dev.cloudId || dev.id || dev.deviceId || dev.name || '').trim();
          if (id) { const set = s.keysByDevice.get(id) || new Set(); set.add(String(key.name)); s.keysByDevice.set(id, set); }
        }
      }
    }
    function pushDevice(devId, metaB, metaF, metaZ) {
      const dn = byId.get(devId); if (!dn) return;
      const id = String(dn.cloudId || dn.id || dn.deviceId || dn.name || '').trim();
      if (!id) return;
      s.devicesMeta.set(id, { name: dn.name || id, type: dn.deviceType || dn.type || null, building: metaB || null, floor: metaF || null, zone: metaZ || null });
      if (metaB) s.buildings.add(String(metaB));
      const keyB = `${metaB||''}||`;
      const keyBF = `${metaB||''}||${metaF||''}||`;
      const keyBFZ = `${metaB||''}||${metaF||''}||${metaZ||''}`;
      for (const k of [keyB, keyBF, keyBFZ]) { if (!s.deviceIdsByScope.has(k)) s.deviceIdsByScope.set(k, new Set()); s.deviceIdsByScope.get(k).add(id); }
      if (metaB && metaF) { const fb = s.floorsByBuilding.get(metaB) || new Set(); fb.add(metaF); s.floorsByBuilding.set(metaB, fb); }
      if (metaB && metaF) { const k = `${metaB}||${metaF}`; const zs = s.zonesByBF.get(k) || new Set(); if (metaZ) zs.add(metaZ); s.zonesByBF.set(k, zs); }
    }
    for (const n of nodes) {
      if (typeOf(n) !== 'Building') continue;
      const name = n.name || n.id;
      if (!name) continue;
      s.buildings.add(String(name));
      const props = n.properties || {};
      const latRaw = n.lat ?? n.latitude ?? props.lat ?? props.latitude;
      const lonRaw = n.long ?? n.lon ?? n.longitude ?? props.long ?? props.lon ?? props.longitude;
      const latNum = toNumeric(latRaw);
      const lonNum = toNumeric(lonRaw);
      if (Number.isFinite(latNum) && Number.isFinite(lonNum)) {
        s.buildingCoords.set(String(name), { lat: latNum, lon: lonNum });
      }
    }
    for (const n of nodes) {
      if (typeOf(n) !== 'Device') continue;
      let metaB = null, metaF = null, metaZ = null;
      for (const l of links) {
        if (l.source === n.id || l.target === n.id) {
          const other = l.source === n.id ? l.target : l.source;
          const on = byId.get(other);
          const t = typeOf(on);
          if (t === 'Building' && !metaB) metaB = on.name || metaB;
          if (t === 'Floor' && !metaF) metaF = on.name || metaF;
          if (t === 'Zone' && !metaZ) metaZ = on.name || metaZ;
        }
      }
      pushDevice(n.id, metaB, metaF, metaZ);
    }
    return s;
  } catch { return null; }
}
function prefetchSnapshotsAtStartup() {
  try {
    const dir = path.join(root, 'data');
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      if (!/^graph_snapshot(\.|$)/.test(f) || !/\.json$/i.test(f)) continue;
      const full = path.join(dir, f);
      try {
        const snap = JSON.parse(fs.readFileSync(full, 'utf8'));
        const tenant = snap.tenant || null;
        const idx = buildTenantIndexFromSnapshot(snap, tenant);
        if (idx) __indexStore.tenants.set(tenant || '__default__', idx);
        resetBuildingCoordsCache();
      } catch {}
    }
  } catch {}
}
function updateIndexForTenant(tenant) {
  try {
    const slug = (s) => String(s||'').trim().toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'');
    const file = tenant ? path.join(root, 'data', `graph_snapshot.${slug(tenant)}.json`) : path.join(root, 'data', 'graph_snapshot.json');
    if (fs.existsSync(file)) {
      const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
      const idx = buildTenantIndexFromSnapshot(snap, tenant);
      if (idx) __indexStore.tenants.set(tenant || '__default__', idx);
      resetBuildingCoordsCache();
    }
  } catch {}
}

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
  .then(async () => {
    // Prefetch snapshot indexes for fast scope resolution
    prefetchSnapshotsAtStartup();
    await prefetchWeatherForAllBuildings();
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
