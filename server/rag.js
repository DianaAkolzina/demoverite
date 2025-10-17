import fs from 'fs';
import path from 'path';

// Simple tokenizer
function tokens(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9_\s]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function buildTfidfIndex(docs, { debug = false } = {}) {
  const df = new Map();
  const tf = new Map(); // id -> Map(token -> count)
  for (const d of docs) {
    const counts = new Map();
    for (const t of tokens(d.text)) {
      counts.set(t, (counts.get(t) || 0) + 1);
    }
    tf.set(d.id, counts);
    for (const t of counts.keys()) df.set(t, (df.get(t) || 0) + 1);
  }
  const N = docs.length || 1;
  function vec(map) {
    const out = new Map();
    for (const [t, c] of map.entries()) {
      const idf = Math.log(1 + N / (1 + (df.get(t) || 0)));
      out.set(t, c * idf);
    }
    return out;
  }
  const docVecs = new Map();
  for (const d of docs) docVecs.set(d.id, vec(tf.get(d.id) || new Map()));
  function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (const [, v] of a) na += v * v;
    for (const [, v] of b) nb += v * v;
    const smaller = a.size < b.size ? a : b;
    const bigger = a.size < b.size ? b : a;
    for (const [k, v] of smaller) {
      const u = bigger.get(k);
      if (u) dot += v * u;
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    return denom ? dot / denom : 0;
  }
  return {
    search(q, k = 6) {
      const qVec = vec(new Map(tokens(q).map(t => [t, 1])));
      const scored = [];
      for (const d of docs) {
        const s = cosine(qVec, docVecs.get(d.id));
        if (s > 0) scored.push({ id: d.id, meta: d.meta, score: s, text: d.text });
      }
      scored.sort((a, b) => b.score - a.score);
      if (debug) {
        console.log(`[RAG] Search query="${q.slice(0,120)}" -> top ${Math.min(k, scored.length)} of ${scored.length}`);
        for (const h of scored.slice(0, k)) {
          console.log(`[RAG] hit id=${h.id} score=${h.score.toFixed(3)} meta=${JSON.stringify(h.meta)}`);
        }
      }
      return scored.slice(0, k);
    }
  };
}

export function buildDocsFromData({ dataDir, rooms, loadRoomTables, knowledgeDir }) {
  const docs = [];
  let id = 0;

  // Helpers: walk knowledge directory recursively, parse front-matter, chunk by headings
  function walk(dir) {
    const out = [];
    if (!dir || !fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name)));
      else out.push(path.join(dir, entry.name));
    }
    return out;
  }

  function parseFrontMatter(text) {
    const m = text.match(/^---\n([\s\S]*?)\n---\n/);
    if (!m) return { meta: {}, body: text };
    const yaml = m[1];
    const meta = {};
    for (const line of yaml.split(/\r?\n/)) {
      const mm = line.match(/^([A-Za-z0-9_\-]+):\s*(.*)$/);
      if (mm) meta[mm[1].trim()] = mm[2].trim();
    }
    return { meta, body: text.slice(m[0].length) };
  }

  function chunkByHeadings(text, { maxLen = 1200 } = {}) {
    // Split on ATX headings and keep them with their section; fallback to fixed-size
    const parts = text.split(/^#{1,6}\s.+$/m);
    if (parts.length <= 1) {
      const chunks = [];
      for (let i = 0; i < text.length; i += maxLen) chunks.push(text.slice(i, i + maxLen));
      return chunks;
    }
    // A more robust approach: iterate lines
    const lines = text.split(/\r?\n/);
    const chunks = [];
    let cur = [];
    for (const ln of lines) {
      if (/^#{1,6}\s+/.test(ln) && cur.join('\n').length >= maxLen) {
        chunks.push(cur.join('\n'));
        cur = [ln];
      } else {
        cur.push(ln);
        if (cur.join('\n').length >= maxLen) {
          chunks.push(cur.join('\n'));
          cur = [];
        }
      }
    }
    if (cur.length) chunks.push(cur.join('\n'));
    return chunks;
  }

  // Knowledge (recursive)
  if (knowledgeDir && fs.existsSync(knowledgeDir)) {
    const files = walk(knowledgeDir).filter(f => /\.(md|txt)$/i.test(f));
    for (const abs of files) {
      const rel = path.relative(knowledgeDir, abs);
      const category = path.dirname(rel) === '.' ? null : path.dirname(rel);
      const raw = fs.readFileSync(abs, 'utf8');
      const { meta: fm, body } = parseFrontMatter(raw);
      const chunks = chunkByHeadings(body, { maxLen: 1400 });
      for (const c of chunks) {
        docs.push({ id: `k_${id++}`, text: c, meta: { type: 'knowledge', file: rel, category, ...fm } });
      }
    }
  }
  
  // Room schemas
  for (const room of rooms) {
    const tables = loadRoomTables(room);
    for (const [t, rows] of Object.entries(tables)) {
      const first = rows?.[0] || {};
      const keys = Object.keys(first);
      const preview = JSON.stringify(rows.slice(0, 3));
      const text = `Room ${room} Table ${t} has keys ${keys.join(', ')}. Sample: ${preview}`;
      docs.push({ id: `s_${id++}`, text, meta: { type: 'schema', room, table: t } });
    }
  }
  
  // Weather schema and data info (from CSV in CSV_DIR)
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const csvDir = process.env.CSV_DIR ? path.resolve(root, process.env.CSV_DIR) : path.join(root, 'CSVex_enriched');
  const csvWeather1 = path.join(csvDir, 'weather', 'weather.csv');
  const csvWeather2 = path.join(csvDir, 'weather.csv');
  const csvPath = fs.existsSync(csvWeather1) ? csvWeather1 : (fs.existsSync(csvWeather2) ? csvWeather2 : null);
  if (csvPath && fs.existsSync(csvPath)) {
    try {
      const lines = fs.readFileSync(csvPath, 'utf8').trim().split(/\r?\n/);
      if (lines.length > 1) {
        const headers = lines[0].split(',');
        const firstRow = (lines[1] || '').split(',');
        const keys = headers.filter(h => h && h !== 'ts');
        const text = `Weather CSV available with fields: ${keys.join(', ')}. Use weather_fetch tool to retrieve weather data (temp, humidity, pressure, wind_speed, wind_deg, clouds, weather_main, weather_desc).`;
        docs.push({ id: `w_${id++}`, text, meta: { type: 'weather' } });
      }
    } catch {}
  }
  
  return docs;
}

export function buildRagIndex(docs, { debug = false } = {}) {
  const index = buildTfidfIndex(docs, { debug });
  return {
    search: (q, k) => index.search(q, k)
  };
}
