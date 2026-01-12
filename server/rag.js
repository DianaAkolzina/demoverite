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
        const qDisp = '<redacted>';
        console.log(`[RAG] Search query="${qDisp}" -> top ${Math.min(k, scored.length)} of ${scored.length}`);
        for (const h of scored.slice(0, k)) {
          console.log(`[RAG] hit id=${h.id} score=${h.score.toFixed(3)} meta=${JSON.stringify(h.meta)}`);
        }
      }
      return scored.slice(0, k);
    }
  };
}

function safeReadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function listSnapshotFiles(dataDir) {
  try {
    const dir = path.resolve(dataDir || '.');
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((name) => /^graph_snapshot(\.|$)/.test(name) && name.endsWith('.json'))
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

function buildScopeDocsFromSnapshots(dataDir) {
  const docs = [];
  const files = listSnapshotFiles(dataDir);
  if (!files.length) return docs;
  const typeOf = (node) => (node?.nodeType || node?.label || null);
  const metricRels = new Set(['HAS_TELEMETRY_KEY', 'MEASURES', 'MEASURES_KEY']);

  for (const file of files) {
    const snap = safeReadJson(file);
    if (!snap || !Array.isArray(snap.nodes) || !Array.isArray(snap.links)) continue;
    const tenant = snap.tenant || snap.tenantName || (() => {
      const basename = path.basename(file);
      const parts = basename.split('.');
      return parts.length === 3 ? parts[1] : null;
    })();
    const nodesById = new Map();
    for (const node of snap.nodes) {
      if (!node || !node.id) continue;
      nodesById.set(node.id, node);
    }
    const floors = new Map();
    const buildings = new Map();
    const zones = new Map();
    const devices = new Map();
    const deviceByCloudId = new Map();
    snap.nodes.forEach((node) => {
      const type = typeOf(node);
      if (type === 'Floor') {
        floors.set(node.id, { id: node.id, name: node.name || null, buildingIds: new Set(), node });
      } else if (type === 'Building') {
        buildings.set(node.id, { id: node.id, name: node.name || null, node });
      } else if (type === 'Zone') {
        zones.set(node.id, {
          id: node.id,
          name: node.name || null,
          roomId: node.roomId != null ? String(node.roomId) : null,
          floorName: node.floorName || null,
          buildingName: node.buildingName || null,
          deviceIds: new Set(),
          node
        });
      } else if (type === 'Device') {
        const cloudId = node.cloudId || node.name || node.id;
        const record = {
          id: node.id,
          cloudId: cloudId ? String(cloudId) : null,
          name: node.name || null,
          type: node.deviceType || node.type || null,
          node
        };
        devices.set(node.id, record);
        if (record.cloudId) deviceByCloudId.set(record.cloudId, record);
      }
    });

    const deviceMetrics = new Map(); // cloudId -> Set(metrics)
    const ensureMetric = (cloudId, metric) => {
      if (!cloudId || !metric) return;
      const set = deviceMetrics.get(cloudId) || new Set();
      set.add(metric);
      deviceMetrics.set(cloudId, set);
    };

    for (const link of snap.links) {
      if (!link || !link.rel) continue;
      const { source, target, rel } = link;
      if (rel === 'LOCATED_IN_ZONE') {
        const zone = zones.get(target);
        const device = devices.get(source);
        if (zone && device && device.cloudId) zone.deviceIds.add(device.cloudId);
      } else if (rel === 'BELONGS_TO_FLOOR' || rel === 'PART_OF_FLOOR') {
        const zone = zones.get(source);
        const floor = floors.get(target);
        if (zone && floor) zone.floorName = zone.floorName || floor.name || null;
      } else if (rel === 'LOCATED_ON_FLOOR') {
        const device = devices.get(source);
        const floor = floors.get(target);
        if (device && floor && !device.floorName) device.floorName = floor.name || null;
      } else if (rel === 'BELONGS_TO_BUILDING' || rel === 'LOCATED_IN_BUILDING' || rel === 'PART_OF_BUILDING' || rel === 'IN_BUILDING') {
        const node = nodesById.get(source);
        const building = buildings.get(target);
        if (!building) continue;
        const type = typeOf(node);
        if (type === 'Zone') {
          const zone = zones.get(source);
          if (zone) zone.buildingName = zone.buildingName || building.name || null;
        } else if (type === 'Floor') {
          const floor = floors.get(source);
          if (floor) floor.buildingIds.add(building.id);
        } else if (type === 'Device') {
          const device = devices.get(source);
          if (device && !device.buildingName) device.buildingName = building.name || null;
        }
      } else if (metricRels.has(rel)) {
        const src = nodesById.get(source);
        const tgt = nodesById.get(target);
        const srcType = typeOf(src);
        const tgtType = typeOf(tgt);
        let deviceNode = null;
        let metricNode = null;
        if (srcType === 'Device' && tgtType === 'TelemetryKey') {
          deviceNode = src;
          metricNode = tgt;
        } else if (srcType === 'TelemetryKey' && tgtType === 'Device') {
          deviceNode = tgt;
          metricNode = src;
        }
        if (deviceNode) {
          const cloudId = deviceNode.cloudId || deviceNode.name || deviceNode.id;
          const metricName = metricNode?.name || metricNode?.metric || metricNode?.field || null;
          ensureMetric(cloudId ? String(cloudId) : null, metricName);
        }
      }
    }

    const zoneDocs = [];
    zones.forEach((zone) => {
        const deviceList = Array.from(zone.deviceIds);
        if (!zone.name && !deviceList.length) return;
      const tenantLabel = tenant ? `Owner Group ${tenant}` : 'Default Owner Group';
      const buildingLabel = zone.buildingName || 'Unknown Owner';
      const floorLabel = zone.floorName || 'Unknown Shop';
      const zoneLabel = zone.name || zone.roomId || zone.id;
      const deviceSummaries = [];
      for (const cloudId of deviceList.slice(0, 8)) {
        const deviceNode = deviceByCloudId.get(cloudId);
        if (!deviceNode) continue;
        const metrics = Array.from(deviceMetrics.get(cloudId) || []).slice(0, 5);
        const metricsText = metrics.length ? metrics.join(', ') : 'unknown KPIs';
        const typeHint = deviceNode.type ? `, ${deviceNode.type}` : '';
        deviceSummaries.push(`- ${deviceNode.name || cloudId} (${cloudId}${typeHint}) — KPIs: ${metricsText}`);
      }
      const aggregateMetrics = new Set();
      deviceList.forEach((cloudId) => {
        const set = deviceMetrics.get(cloudId);
        if (set) set.forEach((m) => aggregateMetrics.add(m));
      });
      const text = [
        `Scope Snapshot (${tenantLabel}): Owner ${buildingLabel}, Shop ${floorLabel}, Page ${zoneLabel}.`,
        zone.roomId ? `Page identifier: ${zone.roomId}.` : null,
        deviceSummaries.length ? `Products (${deviceList.length}):\n${deviceSummaries.join('\n')}` : 'Products: none recorded in snapshot.',
        deviceList.length > deviceSummaries.length
          ? `(+${deviceList.length - deviceSummaries.length} additional products omitted for brevity)`
          : null,
        `Primary KPIs: ${aggregateMetrics.size ? Array.from(aggregateMetrics).slice(0, 8).join(', ') : 'unknown'}.`
      ]
        .filter(Boolean)
        .join('\n');
      zoneDocs.push({
        text,
        meta: {
          type: 'scope_snapshot',
          tenant: tenant || 'default',
          building: buildingLabel,
          floor: floorLabel,
          zone: zoneLabel,
          zoneId: zone.id,
          deviceCount: deviceList.length
        }
      });
    });
    docs.push(...zoneDocs);
  }
  return docs;
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
      if (mm) {
        const key = mm[1].trim();
        let value = mm[2].trim();
        if (value.includes(',')) {
          value = value.split(',').map((v) => v.trim()).filter(Boolean);
        }
        meta[key] = value;
      }
    }
    return { meta, body: text.slice(m[0].length) };
  }

function chunkByHeadings(text, { maxLen = 1200, minLen = 400 } = {}) {
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
    // Merge undersized chunks with neighbors to preserve context
    const merged = [];
    for (const chunk of chunks) {
      const trimmed = chunk.trim();
      if (!trimmed) continue;
      if (!merged.length) {
        merged.push(trimmed);
        continue;
      }
      if (trimmed.length < minLen) {
        const prev = merged.pop();
        if ((prev.length + trimmed.length + 2) <= maxLen * 1.2) {
          merged.push(`${prev}\n\n${trimmed}`.trim());
        } else {
          merged.push(prev);
          merged.push(trimmed);
        }
      } else {
        merged.push(trimmed);
      }
    }
    return merged;
}

function shouldExcludeDoc(meta = {}) {
    const flag = String(meta.exclude || meta.flagged || '').toLowerCase();
    if (flag === 'true' || flag === '1') return true;
    const status = String(meta.status || '').toLowerCase();
    if (status === 'deprecated' || status === 'exclude') return true;
    return false;
  }

function buildTelemetrySummaries({ rooms, loadRoomTables, maxRooms = Number(process.env.RAG_MAX_SUMMARY_ROOMS || 150) }) {
  const summaries = [];
  if (!Array.isArray(rooms) || !rooms.length || typeof loadRoomTables !== 'function') return summaries;
  const roomSample = rooms.slice(0, maxRooms);
  for (const room of roomSample) {
    let tables = {};
    try {
      tables = loadRoomTables(room) || {};
    } catch {
      tables = {};
    }
    for (const [table, rows] of Object.entries(tables)) {
      if (!Array.isArray(rows) || !rows.length) continue;
      const tsMin = rows[0]?.ts ?? null;
      const tsMax = rows[rows.length - 1]?.ts ?? null;
      const metrics = Object.keys(rows[0] || {}).filter((k) => k !== 'ts');
      const sample = rows.slice(Math.max(0, rows.length - 120));
      const stats = {};
      for (const row of sample) {
        for (const metric of metrics) {
          const raw = row[metric];
          const value = Number(raw);
          if (!Number.isFinite(value)) continue;
          const store = stats[metric] || { min: value, max: value, sum: 0, count: 0 };
          store.min = Math.min(store.min, value);
          store.max = Math.max(store.max, value);
          store.sum += value;
          store.count += 1;
          stats[metric] = store;
        }
      }
      const statLines = Object.entries(stats)
        .map(([metric, info]) => {
          const avg = info.count ? info.sum / info.count : null;
          return `${metric}: min=${info.min?.toFixed?.(2) ?? info.min} max=${info.max?.toFixed?.(2) ?? info.max} avg=${avg?.toFixed?.(2) ?? avg}`;
        })
        .slice(0, 6)
        .join('; ');
      const text = `Telemetry summary for product ${room} table ${table}. KPIs: ${metrics.join(', ') || 'unknown'}. Coverage: ${tsMin ? new Date(tsMin).toISOString() : 'n/a'} → ${tsMax ? new Date(tsMax).toISOString() : 'n/a'}. Recent stats: ${statLines || 'insufficient numeric samples'}.`;
      summaries.push({
        id: `t_${room}_${table}_${summaries.length}`,
        text,
        meta: { type: 'telemetry_summary', room, table, metrics }
      });
    }
  }
  return summaries;
}

function buildWeatherDocs(dataDir) {
  const docs = [];
  const dir = path.join(dataDir, 'weather_buildings');
  if (!fs.existsSync(dir)) return docs;
  const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.json'));
  for (const file of files) {
    try {
      const payload = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      const rows = Array.isArray(payload) ? payload : payload?.data;
      if (!Array.isArray(rows) || !rows.length) continue;
      const temps = rows.map((r) => Number(r.temp ?? r.temperature)).filter(Number.isFinite);
      const humidity = rows.map((r) => Number(r.humidity)).filter(Number.isFinite);
      const tsMin = rows[0]?.ts ?? null;
      const tsMax = rows[rows.length - 1]?.ts ?? null;
      const building = payload?.building || file.replace(/\.[^.]+$/, '');
      const lineParts = [];
      if (temps.length) {
        temps.sort((a, b) => a - b);
        const avg = temps.reduce((a, b) => a + b, 0) / temps.length;
        lineParts.push(`temperature ${temps[0].toFixed(1)}–${temps.at(-1).toFixed(1)}°C (avg ${avg.toFixed(1)}°C)`);
      }
      if (humidity.length) {
        humidity.sort((a, b) => a - b);
        const avgH = humidity.reduce((a, b) => a + b, 0) / humidity.length;
        lineParts.push(`humidity ${humidity[0].toFixed(1)}–${humidity.at(-1).toFixed(1)}% (avg ${avgH.toFixed(1)}%)`);
      }
      const text = `Market signals cache for ${building}. Coverage: ${tsMin ? new Date(tsMin).toISOString() : 'unknown'} → ${tsMax ? new Date(tsMax).toISOString() : 'unknown'}. ${lineParts.join('. ')}`;
      docs.push({
        id: `w_${building}_${docs.length}`,
        text,
        meta: { type: 'weather', building }
      });
    } catch {}
  }
  return docs;
}

// Knowledge (recursive)
if (knowledgeDir && fs.existsSync(knowledgeDir)) {
  const files = walk(knowledgeDir).filter(f => /\.(md|txt)$/i.test(f));
  for (const abs of files) {
    const rel = path.relative(knowledgeDir, abs);
    const dirCategory = path.dirname(rel) === '.' ? null : path.dirname(rel);
    const fallbackCategory = path.basename(rel, path.extname(rel));
    const raw = fs.readFileSync(abs, 'utf8');
    const { meta: fm, body } = parseFrontMatter(raw);
    if (shouldExcludeDoc(fm)) continue;
    const chunks = chunkByHeadings(body, { maxLen: 1400 });
    chunks.forEach((c, idxChunk) => {
      const baseMeta = { ...fm };
      const docCategory = baseMeta.category || dirCategory || fallbackCategory || null;
      const meta = { type: 'knowledge', file: rel, chunk: idxChunk, ...baseMeta, category: docCategory };
      docs.push({ id: `k_${id++}`, text: c, meta });
    });
  }
}

// Scope snapshots (graph-derived)
const scopeDocs = buildScopeDocsFromSnapshots(dataDir);
for (const doc of scopeDocs) {
  docs.push({ id: `scope_${id++}`, text: doc.text, meta: doc.meta });
}

// Room schemas
for (const room of rooms) {
  const tables = loadRoomTables(room);
  for (const [t, rows] of Object.entries(tables)) {
    const first = rows?.[0] || {};
    const keys = Object.keys(first);
    const preview = JSON.stringify(rows.slice(0, 3));
    const text = `Product ${room} Table ${t} has keys ${keys.join(', ')}. Sample: ${preview}`;
    docs.push({ id: `s_${id++}`, text, meta: { type: 'schema', room, table: t } });
  }
}

// Telemetry and weather enrichments
const telemetryDocs = buildTelemetrySummaries({ rooms, loadRoomTables });
const weatherDocs = buildWeatherDocs(dataDir);
telemetryDocs.forEach((doc) => docs.push({ id: `ts_${id++}`, text: doc.text, meta: doc.meta }));
weatherDocs.forEach((doc) => docs.push({ id: `wx_${id++}`, text: doc.text, meta: doc.meta }));

return docs;
}

export function buildRagIndex(docs, { debug = false } = {}) {
  const index = buildTfidfIndex(docs, { debug });
  return {
    search: (q, k) => index.search(q, k)
  };
}
