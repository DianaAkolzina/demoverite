import fs from 'fs';
import path from 'path';

const root = path.resolve(process.cwd());
const SRC_ROOTS = [path.join(root, 'csvex'), path.join(root, 'CSVex')];
const OUT_ROOT = path.join(root, 'csvex_enriched');

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function parseCsvLine(line) {
  const out = [];
  let i = 0, field = '', inQuotes = false;
  while (i < line.length) {
    const c = line[i++];
    if (inQuotes) {
      if (c === '"') {
        if (line[i] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { out.push(field); field = ''; }
      else field += c;
    }
  }
  out.push(field);
  return out;
}

function toNumber(x) {
  if (x == null || x === '') return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function findSrcRoot() {
  for (const p of SRC_ROOTS) if (fs.existsSync(p)) return p;
  throw new Error('csvex/ (or CSVex/) not found');
}

function detectTsColumn(headers) {
  const lower = headers.map(h => h.toLowerCase());
  let idx = lower.indexOf('ts');
  if (idx !== -1) return { name: headers[idx], type: 'ts' };
  idx = lower.indexOf('time'); if (idx !== -1) return { name: headers[idx], type: 'time' };
  idx = lower.indexOf('timestamp'); if (idx !== -1) return { name: headers[idx], type: 'timestamp' };
  return null;
}

function loadCsv(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/).filter(l => l.length > 0);
  if (!lines.length) return null;
  // Allow headers mid-file: keep first header and ignore re-appearing ones
  const header = parseCsvLine(lines[0]).map(h => h.trim());
  const tsInfo = detectTsColumn(header);
  if (!tsInfo) return null;
  const rawIdx = header.findIndex(h => h.toLowerCase() === 'raw_data');
  const cols = header.filter((h, i) => i !== rawIdx);
  const rows = [];
  for (let li = 1; li < lines.length; li++) {
    const colsArr = parseCsvLine(lines[li]);
    // Skip repeated headers
    if (colsArr[0] && colsArr[0].toLowerCase().includes('ts') && colsArr.join(',') === header.join(',')) continue;
    const rec = {};
    for (let ci = 0, wi = 0; ci < header.length; ci++) {
      if (ci === rawIdx) continue;
      rec[cols[wi++]] = colsArr[ci] ?? '';
    }
    rows.push(rec);
  }
  // Normalize ts to ms
  let tsName = tsInfo.name;
  for (const r of rows) {
    let v = toNumber(r[tsName]);
    if (v == null) {
      const p = Date.parse(r[tsName]);
      v = Number.isFinite(p) ? p : null;
    }
    if (v == null) { r.ts = null; continue; }
    const ms = v < 1e12 ? Math.round(v * 1000) : v;
    r.ts = ms;
  }
  return { header: cols, rows, tsName: 'ts' };
}

function enrichUniformGridStream(header, rows, writer, { MIN_STEP_MS = 60000, MAX_ROWS = 1_000_000, JITTER = 0.02 } = {}) {
  const valid = rows.filter(r => Number.isFinite(r.ts)).sort((a,b) => a.ts - b.ts);
  if (!valid.length) return;
  const tsList = valid.map(r => r.ts);
  // minimal positive delta
  let minDelta = Infinity;
  for (let i = 1; i < tsList.length; i++) {
    const d = tsList[i] - tsList[i-1];
    if (d > 0 && d < minDelta) minDelta = d;
  }
  if (!Number.isFinite(minDelta) || minDelta <= 0) minDelta = MIN_STEP_MS; // default
  if (minDelta < MIN_STEP_MS) minDelta = MIN_STEP_MS;
  const start = tsList[0];
  const end = tsList[tsList.length-1];
  let estRows = Math.floor((end - start) / minDelta) + 1;
  if (estRows > MAX_ROWS) {
    const factor = Math.ceil(estRows / MAX_ROWS);
    minDelta = minDelta * factor;
    estRows = Math.floor((end - start) / minDelta) + 1;
    console.log(`Adjusted step to ${Math.round(minDelta/1000)}s to cap rows at ~${MAX_ROWS} (est ${estRows}).`);
  }
  // Build index by ts
  const byTs = new Map();
  for (const r of valid) byTs.set(r.ts, r);
  // Determine numeric fields
  const fields = header.filter(h => h !== 'ts');
  const numericField = {};
  const integerField = {};
  for (const f of fields) {
    let isNum = false, isInt = true;
    for (const r of valid) {
      const n = toNumber(r[f]);
      if (n != null) { isNum = true; if (!Number.isInteger(n)) isInt = false; }
      if (isNum && !isInt) break;
    }
    numericField[f] = isNum;
    integerField[f] = isInt;
  }
  // Sorted known ts for neighbors
  const known = tsList;
  function findPrevNext(ts) {
    // binary search
    let lo = 0, hi = known.length - 1, prevIdx = -1, nextIdx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (known[mid] === ts) { prevIdx = nextIdx = mid; break; }
      if (known[mid] < ts) { prevIdx = mid; lo = mid + 1; }
      else { nextIdx = mid; hi = mid - 1; }
    }
    return { prevIdx, nextIdx };
  }
  for (let ts = start; ts <= end; ts += minDelta) {
    const existing = byTs.get(ts);
    if (existing) {
      const rec = { ts };
      for (const f of fields) rec[f] = existing[f] ?? '';
      writer(rec);
      continue;
    }
    const { prevIdx, nextIdx } = findPrevNext(ts);
    const rec = { ts };
    for (const f of fields) {
      if (!numericField[f]) {
        // carry forward non-numeric
        rec[f] = prevIdx >= 0 ? (valid[prevIdx][f] ?? '') : '';
        continue;
      }
      const prevVal = prevIdx >= 0 ? toNumber(valid[prevIdx][f]) : null;
      const nextVal = nextIdx >= 0 ? toNumber(valid[nextIdx][f]) : null;
      let synth = null;
      if (prevVal != null && nextVal != null) {
        const lo = Math.min(prevVal, nextVal);
        const hi = Math.max(prevVal, nextVal);
        const r = Math.random();
        synth = lo + r * (hi - lo);
      } else if (prevVal != null) {
        const jitter = Math.random() * JITTER - (JITTER/2);
        synth = prevVal * (1 + jitter);
      } else if (nextVal != null) {
        const jitter = Math.random() * JITTER - (JITTER/2);
        synth = nextVal * (1 + jitter);
      } else {
        synth = null;
      }
      if (synth != null && integerField[f]) synth = Math.round(synth);
      rec[f] = synth != null ? String(synth) : '';
    }
    writer(rec);
  }
  return;
}


function getArg(name, def = null) {
  const a = process.argv.find(x => x.startsWith(`--${name}=`));
  if (!a) return def;
  const v = a.split('=')[1];
  return v;
}

async function main() {
  const srcRoot = findSrcRoot();
  ensureDir(OUT_ROOT);
  const rooms = fs.readdirSync(srcRoot, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
  if (!rooms.length) {
    console.log('No room subfolders under', srcRoot);
    return;
  }
  const minStepSecArg = Number(getArg('min-step-seconds', '60'));
  const maxRowsArg = Number(getArg('max-output-rows', '1000000'));
  const jitterPctArg = Number(getArg('jitter', '0.02'));
  const MIN_STEP_MS = Number.isFinite(minStepSecArg) ? minStepSecArg * 1000 : 60000;
  const MAX_ROWS = Number.isFinite(maxRowsArg) ? maxRowsArg : 1_000_000;
  const JITTER = Number.isFinite(jitterPctArg) ? jitterPctArg : 0.02;
  for (const room of rooms) {
    const inDir = path.join(srcRoot, room);
    const outDir = path.join(OUT_ROOT, room);
    ensureDir(outDir);
    const files = fs.readdirSync(inDir).filter(f => f.toLowerCase().endsWith('.csv'));
    for (const f of files) {
      const src = path.join(inDir, f);
      const dst = path.join(outDir, f);
      try {
        const loaded = loadCsv(src);
        if (!loaded) { console.log('Skip (no ts):', src); continue; }
        const { header, rows } = loaded;
        // Streaming writer
        const ws = fs.createWriteStream(dst, { encoding: 'utf8' });
        // write header
        ws.write(header.join(',') + '\n');
        // Enrich streaming: may still keep input rows (valid) but not all output
        let written = 0;
        const writer = (rec) => {
          const line = header.map(h => {
            const v = rec[h] != null ? String(rec[h]) : '';
            return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
          }).join(',') + '\n';
          ws.write(line);
          written++;
          if (written % 200000 === 0) console.log('...written', written, 'rows for', dst);
        };
        // Enrich with caps
        enrichUniformGridStream(header, rows, writer, { MIN_STEP_MS, MAX_ROWS, JITTER });
        await new Promise(res => ws.end(res));
        console.log('Enriched ->', dst, `(${written} rows)`);
      } catch (e) {
        console.error('Failed:', src, e.message || e);
      }
    }
  }
}

main();
