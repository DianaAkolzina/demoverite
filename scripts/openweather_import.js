import fs from 'fs';
import path from 'path';
if (typeof fetch === 'undefined') {
  global.fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
}
const root = path.resolve(process.cwd());
const dataRoot = path.join(root, 'data');
const weatherDir = path.join(dataRoot, 'weather');

// Simple .env loader
const envPath = path.join(root, '.env');
if (fs.existsSync(envPath)) {
  const raw = fs.readFileSync(envPath, 'utf8');
  raw.split(/\r?\n/).forEach((line) => {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2];
  });
}

const PROVIDER = (process.env.WEATHER_PROVIDER || 'openweather').toLowerCase();
const KEY = process.env.OPENWEATHER_API_KEY || '';
const LAT = parseFloat(process.env.OPENWEATHER_LAT || '0');
const LON = parseFloat(process.env.OPENWEATHER_LON || '0');

if (PROVIDER !== 'openweather') {
  console.error('WEATHER_PROVIDER is not openweather. Aborting.');
  process.exit(1);
}
if (!KEY) {
  console.error('Missing OPENWEATHER_API_KEY in .env');
  process.exit(1);
}
if (!Number.isFinite(LAT) || !Number.isFinite(LON)) {
  console.error('Invalid OPENWEATHER_LAT/OPENWEATHER_LON in .env');
  process.exit(1);
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJson(url) {
  const res = await fetch(url);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { ok: res.ok, status: res.status, json, text };
}

async function fetchOneCallTimemachine(dtUnix, verbose = false) {
  const url30 = `https://api.openweathermap.org/data/3.0/onecall/timemachine?lat=${LAT}&lon=${LON}&dt=${dtUnix}&units=metric&appid=${KEY}`;
  const r30 = await fetchJson(url30);
  if (verbose) console.log(`[3.0] dt=${dtUnix} status=${r30.status} ok=${r30.ok}`);
  if (r30.ok && r30.json) return { data: r30.json, source: '3.0' };
  // fallback to 2.5 if 3.0 not available on plan
  const url25 = `https://api.openweathermap.org/data/2.5/onecall/timemachine?lat=${LAT}&lon=${LON}&dt=${dtUnix}&units=metric&appid=${KEY}`;
  const r25 = await fetchJson(url25);
  if (verbose) console.log(`[2.5] dt=${dtUnix} status=${r25.status} ok=${r25.ok}`);
  if (r25.ok && r25.json) return { data: r25.json, source: '2.5' };
  const detail = r30.text || r25.text || 'unknown error';
  const status = r30.status || r25.status || 'n/a';
  const err = new Error(`HTTP ${status}: ${detail.slice(0, 200)}`);
  err.status = status; err.detail = detail;
  throw err;
}

function normalizeWeatherArray(json) {
  // Support shapes: {hourly:[]}, {data:[]}, {list:[]}, {current:{}}
  if (!json || typeof json !== 'object') return [];
  if (Array.isArray(json.hourly)) return json.hourly;
  if (Array.isArray(json.data)) return json.data;
  if (Array.isArray(json.list)) return json.list;
  if (json.current) return [json.current];
  return [];
}

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

async function main() {
  ensureDir(weatherDir);
  const outFile = path.join(weatherDir, 'weather.csv');
  const pretty = process.argv.includes('--pretty');
  const verbose = process.argv.includes('--verbose');
  const maxDays = parseInt(process.argv.find(a => a.startsWith('--days='))?.split('=')[1] || '365', 10);

  // Load existing to avoid duplicates
  let existing = [];
  if (fs.existsSync(outFile)) {
    try { existing = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch {}
  }
  const seen = new Set(existing.map(r => r.ts));

  const nowSec = Math.floor(Date.now() / 1000);
  if (verbose) {
    console.log(`Provider=openweather lat=${LAT} lon=${LON} days=${maxDays}`);
  }
  let daysFetched = 0;
  const rows = [];
  for (let d = 0; d < maxDays; d++) {
    const ts = nowSec - d * 86400;
    // OpenWeather docs: timemachine usually supports up to 5 days back without paid plan
    try {
      const { data, source } = await fetchOneCallTimemachine(ts, verbose);
      const arr = normalizeWeatherArray(data);
      if (verbose) console.log(`d=${d} dt=${ts} source=${source} items=${arr.length}`);
      for (const h of arr) {
        // Support different shapes
        const dt = (h.dt || h.time || h.timestamp || 0);
        const temp = h.temp ?? h.main?.temp ?? null;
        const humidity = h.humidity ?? h.main?.humidity ?? null;
        const pressure = h.pressure ?? h.main?.pressure ?? null;
        const wind_speed = h.wind_speed ?? h.wind?.speed ?? null;
        const wind_deg = h.wind_deg ?? h.wind?.deg ?? null;
        const clouds = h.clouds?.all ?? h.clouds ?? null;
        const w0 = Array.isArray(h.weather) ? h.weather[0] : null;
        const rec = {
          ts: Number(dt) * 1000,
          temp, humidity, pressure, wind_speed, wind_deg, clouds,
          weather_id: w0?.id ?? null,
          weather_main: w0?.main ?? null,
          weather_desc: w0?.description ?? null
        };
        if (rec.ts && !seen.has(rec.ts)) { rows.push(rec); seen.add(rec.ts); }
      }
      daysFetched++;
      // Be gentle with rate limits
      await sleep(1100);
    } catch (e) {
      const msg = String(e?.message || e);
      if (verbose) console.error(`Fetch error for d=${d}: ${msg}`);
      if (msg.includes('HTTP 429')) {
        console.error('Rate limited. Sleeping 60s...');
        await sleep(60000);
        d--; // retry same day index
        continue;
      } else if (msg.includes('HTTP 400') || msg.includes('HTTP 404')) {
        console.error(`Stopping at d=${d}: API indicates no more history available or invalid dt.`);
        break;
      } else {
        console.error('Error:', msg);
        // Continue to next day on transient errors
      }
    }
  }

  const merged = existing.concat(rows);
  merged.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  fs.writeFileSync(outFile, JSON.stringify(merged, null, pretty ? 2 : 0), 'utf8');
  console.log(`Wrote ${outFile} with ${merged.length} records (${rows.length} new, ${daysFetched} day windows fetched)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
