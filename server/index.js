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
const csvexDir = process.env.CSV_DIR
  ? path.resolve(root, process.env.CSV_DIR)
  : path.join(root, 'CSVex');

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

// S3 data source (lazy) — used when AWS_S3_ENABLED=1
let _s3 = null; // { client, bucket, prefix }
async function s3Ensure() {
  if (_s3) return _s3;
  const enabled = (process.env.AWS_S3_ENABLED || '0') === '1';
  if (!enabled) return null;
  const bucket = process.env.AWS_S3_BUCKET || '';
  const rawPrefix = (process.env.AWS_S3_PREFIX || '').replace(/^\/+|\/+$/g, '');
  const prefix = rawPrefix ? (rawPrefix + '/') : '';
  const region = process.env.AWS_S3_REGION || process.env.AWS_REGION || 'eu-west-2';
  if (!bucket) return null;
  try {
    const mod = await import('@aws-sdk/client-s3').catch(() => null);
    if (!mod) { console.warn('[s3] @aws-sdk/client-s3 not installed; falling back to local CSVex'); return null; }
    const { S3Client, ListObjectsV2Command, GetObjectCommand } = mod;
    const client = new S3Client({ region });
    _s3 = { client, bucket, prefix, ListObjectsV2Command, GetObjectCommand };
    return _s3;
  } catch (e) {
    console.warn('[s3] init failed:', String(e));
    return null;
  }
}

async function s3ListDeviceIds(limit = 1000) {
  const s3 = await s3Ensure(); if (!s3) return [];
  const { client, bucket, prefix, ListObjectsV2Command } = s3;
  let token = undefined; const out = new Set();
  try {
    while (out.size < limit) {
      const params = { Bucket: bucket, ContinuationToken: token, MaxKeys: 1000 };
      if (prefix) params.Prefix = prefix;
      const cmd = new ListObjectsV2Command(params);
      const res = await client.send(cmd);
      for (const o of (res.Contents || [])) {
        const key = o.Key || '';
        if (!key.endsWith('.csv')) continue;
        const fname = key.slice(key.lastIndexOf('/') + 1);
        const deviceId = fname.replace(/\.csv$/i, '');
        if (deviceId) out.add(deviceId);
        if (out.size >= limit) break;
      }
      if (!res.IsTruncated) break; token = res.NextContinuationToken;
    }
  } catch (e) { console.warn('[s3] list failed:', String(e)); }
  return Array.from(out);
}

async function s3FetchDeviceCSV(deviceId) {
  const s3 = await s3Ensure(); if (!s3) return null;
  const { client, bucket, prefix, GetObjectCommand } = s3;
  const key = `${prefix}${deviceId}.csv`;
  try {
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const buf = await res.Body?.transformToByteArray?.();
    if (!buf) return null;
    const text = new TextDecoder().decode(buf);
    return parseCSVText(text);
  } catch (e) {
    if (!String(e).includes('AccessDenied')) {
      if (String(e).includes('NoSuchKey')) return null;
      console.warn('[s3] get failed:', String(e));
    }
    // Fallback: try local mirror CSVex_s3
    try {
      const localDir = path.join(root, process.env.S3_LOCAL_DIR || 'CSVex_s3');
      const p = path.join(localDir, `${deviceId}.csv`);
      if (fs.existsSync(p)) return parseCSV(p);
    } catch {}
    return null;
  }
}

// Graph-derived telemetry whitelist per device
async function getAllowedTelemetryKeysForDevice(deviceId) {
  try {
    const g = createGraphFromEnv(process.env);
    if (!g || !g.runQuery) return [];
    const cy = `
      MATCH (d:Device)
      WHERE coalesce(toString(d.id), toString(d.cloud_id), toString(d.deviceId), toString(d.name)) = $id
      OPTIONAL MATCH (d)-[:HAS_TELEMETRY_KEY]->(k:TelemetryKey)
      RETURN collect(DISTINCT k.name) AS keys
    `;
    const { records } = await g.runQuery(cy, { id: String(deviceId) });
    const keys = (records && records[0] && records[0].get('keys')) || [];
    return (keys || []).filter(Boolean);
  } catch {
    return [];
  }
}

// In-memory graph snapshot + filtered cache to speed up UI graph
let GRAPH_SNAPSHOT_MEM = null; // { nodes, links, generatedAt }
const GRAPH_FILTER_CACHE = new Map(); // key: JSON.stringify({tenant, role}) -> { nodes, links, ts }
const GRAPH_FILTER_TTL_MS = 120000; // 2 min cache
const SNAPSHOT_REFRESH_MS = Number(process.env.NEO4J_SNAPSHOT_REFRESH_MS || 120000); // 2 min default
// CSV room mapping cache
let CSV_MAP_CACHE = null; // { ts, items, byKey }
const CSV_MAP_TTL_MS = 60000; // 60s

function slugify(s) { return String(s||'').trim().toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,''); }

function loadCsvAliases() {
  try {
    const p = path.join(root, 'graph_gen_data', 'csv_room_aliases.json');
    if (!fs.existsSync(p)) return null;
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return raw;
  } catch { return null; }
}

async function buildCsvMapping(g) {
  const now = Date.now();
  if (CSV_MAP_CACHE && (now - CSV_MAP_CACHE.ts) < CSV_MAP_TTL_MS) return CSV_MAP_CACHE;
  const ali = loadCsvAliases();
  const rooms = new Set(listRooms());
  const cypher = `
    MATCH (b:Building)
    OPTIONAL MATCH (f:Floor)-[:LOCATED_IN_BUILDING]->(b)
    OPTIONAL MATCH (z:Zone)-[:LOCATED_ON_FLOOR]->(f)
    WITH b,f,z
    WHERE z IS NOT NULL
    OPTIONAL MATCH (d:Device)-[:LOCATED_IN_ZONE]->(z)
    RETURN b.name AS building, f.name AS floor, z.name AS zone, z.roomId AS roomId, z.type AS zoneType, collect(d) AS devices
  `;
  const { records } = g && g.runQuery ? await g.runQuery(cypher, {}) : { records: [] };
  const items = [];
  function deriveCandidates({ building, floor, zone, roomId, zoneType }) {
    const out = [];
    if (roomId) out.push(String(roomId));
    const bInit = (String(building||'').match(/\b([A-Za-z])[A-Za-z]*$/) || [,''])[1].toUpperCase();
    // Extract integer floor index from names like "First Floor", "Floor 3", "3rd Floor"; fallback F1
    let fIndex = null;
    const mNum = String(floor||'').match(/(\d+)/);
    if (mNum) fIndex = mNum[1];
    // common words mapping
    const lower = String(floor||'').toLowerCase();
    if (!fIndex) {
      if (/ground/.test(lower)) fIndex = '0';
      else if (/first/.test(lower)) fIndex = '1';
      else if (/second/.test(lower)) fIndex = '2';
      else if (/third/.test(lower)) fIndex = '3';
    }
    const fCode = fIndex ? `F${fIndex}` : 'F1';
    const zSlug = slugify(zoneType || zone || 'room');
    if (bInit && fCode) out.push(`${bInit}_${fCode}_${zSlug}`);
    out.push(slugify(zone||''));
    return Array.from(new Set(out.filter(Boolean)));
  }
  function applyAlias(building, floor, zone, roomId) {
    if (!ali) return null;
    try {
      if (Array.isArray(ali)) {
        // Array of entries: {building?, floor?, zone?, roomId?, csv}
        for (const a of ali) {
          if (!a || !a.csv) continue;
          const okB = a.building ? String(a.building) === String(building) : true;
          const okF = a.floor ? String(a.floor) === String(floor) : true;
          const okZ = a.zone ? String(a.zone) === String(zone) : true;
          const okR = a.roomId ? String(a.roomId) === String(roomId) : true;
          if (okB && okF && okZ && okR) return String(a.csv);
        }
      } else if (typeof ali === 'object') {
        // Object map: "Zone:Reception:First Floor:Salford Office" -> "S_F1_reception"
        const key1 = `Zone:${zone}:${floor}:${building}`;
        const key2 = roomId ? `RoomId:${roomId}` : null;
        if (ali[key1]) return String(ali[key1]);
        if (key2 && ali[key2]) return String(ali[key2]);
      }
    } catch {}
    return null;
  }
  for (const r of (records || [])) {
    const building = r.get('building');
    const floor = r.get('floor');
    const zone = r.get('zone');
    const roomId = r.get('roomId');
    const zoneType = r.get('zoneType');
    const cands = deriveCandidates({ building, floor, zone, roomId, zoneType });
    let match = applyAlias(building, floor, zone, roomId);
    if (!match) match = cands.find(c => rooms.has(c)) || null;
    items.push({ building, floor, zone, roomId, zoneType, candidates: cands, match });
  }
  const byKey = new Map();
  for (const it of items) {
    const k1 = it.roomId ? `roomId:${it.roomId}` : null;
    const k2 = `k:${it.building}|${it.floor}|${it.zone}`;
    if (k1 && it.match) byKey.set(k1, it.match);
    if (it.match) byKey.set(k2, it.match);
  }
  CSV_MAP_CACHE = { ts: now, items, byKey };
  return CSV_MAP_CACHE;
}

async function resolveCsvRoomsFromScope({ building = null, floor = null, zone = null, tenant = null }) {
  // If S3 mode is enabled, map scope -> device IDs from graph (match deviceId)
  const s3 = await s3Ensure();
  const g = createGraphFromEnv(process.env);
  if (s3 && g && g.devicesByScope) {
    try {
      const { devices = [] } = await g.devicesByScope({ tenant: tenant || null, building: building || null, floor: floor || null, zone: zone || null, type: null });
      const ids = (devices || []).map(d => String(d.id || d.name || '')).filter(Boolean);
      // Optionally, intersect with S3-listed IDs for accuracy without incurring per-key HEAD
      const available = new Set(await s3ListDeviceIds(5000));
      const filtered = ids.filter(id => available.size ? available.has(id) : true);
      return Array.from(new Set(filtered));
    } catch (e) { console.warn('[scope] device scope failed, fallback to zone mapping:', String(e)); }
  }
  // Fallback: Use graph zones, then map to local CSVex rooms
  const rs = g && g.roomsByScope ? await g.roomsByScope({ building, floor, tenant }) : { rooms: [] };
  let zones = (rs.rooms || []).filter(Boolean);
  // Fallback: if empty, use local snapshot to discover zones for fuzzy floor names (e.g., "1st Floor" vs "First Floor")
  if ((!zones || !zones.length) && (building || floor)) {
    try {
      const snap = loadGraphSnapshotMem();
      if (snap) {
        const nodes = snap.nodes || [];
        const links = snap.links || [];
        const byId = new Map(nodes.map(n => [n.id, n]));
        const buildingNode = nodes.find(n => n.nodeType==='Building' && n.name===building) || nodes.find(n => n.nodeType==='Building' && n.name===`Building ${building}`);
        const floorNodes = [];
        if (buildingNode) {
          for (const l of links) {
            if (l.target===buildingNode.id && (l.rel==='BELONGS_TO_BUILDING' || l.rel==='HAS_FLOOR' || l.rel==='IN_BUILDING' || l.rel==='PART_OF')) {
              const fn = byId.get(l.source);
              if (fn && fn.nodeType==='Floor') floorNodes.push(fn);
            }
          }
        } else {
          for (const n of nodes) if (n.nodeType==='Floor') floorNodes.push(n);
        }
        function sameFloorName(a,b) {
          if (!a||!b) return false; if (a===b) return true;
          const na = String(a).toLowerCase(); const nb=String(b).toLowerCase();
          const num = (s)=>{ const m = String(s).match(/(\d+)/); if (m) return m[1]; if (/ground/.test(String(s).toLowerCase())) return '0'; if(/first/.test(String(s).toLowerCase())) return '1'; if(/second/.test(String(s).toLowerCase())) return '2'; if(/third/.test(String(s).toLowerCase())) return '3'; return null; };
          const ia = num(na), ib = num(nb); return !!(ia && ib && ia===ib);
        }
        const targetFloors = floor ? floorNodes.filter(fn => sameFloorName(fn.name, floor)) : floorNodes;
        const zoneNames = new Set();
        for (const f of targetFloors) {
          for (const l of links) {
            if (l.target===f.id && (l.rel==='BELONGS_TO_FLOOR' || l.rel==='HAS_ZONE' || l.rel==='CONTAINS' || l.rel==='LOCATED_ON_FLOOR')) {
              const z = byId.get(l.source); if (z && z.nodeType==='Zone') zoneNames.add(z.roomId || z.name);
            }
          }
        }
        zones = Array.from(zoneNames);
      }
    } catch {}
  }
  const map = await buildCsvMapping(g);
  const out = new Set();
  for (const z of zones) {
    // try match by roomId key
    const k1 = `roomId:${z}`;
    const m1 = map.byKey.get(k1);
    if (m1) { out.add(m1); continue; }
    // try composed keys using each mapping item with same zone name (when roomsByScope returns names)
    for (const it of map.items) {
      if (it.roomId === z || it.zone === z) {
        if (it.match) out.add(it.match);
      }
    }
  }
  return Array.from(out);
}

// Load static building→tenant mapping from graph_gen_data/buildings.csv (id,name,tenantID,...)
let BUILDING_TENANT_MAP = null; // { byName: Map(name->tenantID), byId: Map(id->tenantID), namesByTenantId: Map(id->Set(names)) }
function loadBuildingTenantMap() {
  if (BUILDING_TENANT_MAP) return BUILDING_TENANT_MAP;
  try {
    const p = path.join(root, 'graph_gen_data', 'buildings.csv');
    if (!fs.existsSync(p)) { BUILDING_TENANT_MAP = { byName: new Map(), byId: new Map(), namesByTenantId: new Map() }; return BUILDING_TENANT_MAP; }
    const lines = fs.readFileSync(p, 'utf8').trim().split(/\r?\n/);
    const header = lines.shift().split(',');
    const idx = Object.fromEntries(header.map((h,i)=>[h.trim(), i]));
    const byName = new Map(); const byId = new Map(); const namesByTenantId = new Map();
    for (const line of lines) {
      const cols = line.split(',');
      const id = Number(cols[idx['id']]);
      const name = cols[idx['name']];
      const tenantID = Number(cols[idx['tenantID']]);
      byName.set(name, tenantID);
      byId.set(id, tenantID);
      if (!namesByTenantId.has(tenantID)) namesByTenantId.set(tenantID, new Set());
      namesByTenantId.get(tenantID).add(name);
    }
    BUILDING_TENANT_MAP = { byName, byId, namesByTenantId };
  } catch { BUILDING_TENANT_MAP = { byName: new Map(), byId: new Map(), namesByTenantId: new Map() }; }
  return BUILDING_TENANT_MAP;
}

// Tenant CSV map loader (graph_gen_data/tenants.csv: id,name,domain_name,is_active,reseller_id)
let TENANT_CSV_MAP = null; // { idByNameCI: Map(lowerName->id), nameById: Map(id->name) }
function loadTenantCsvMap() {
  if (TENANT_CSV_MAP) return TENANT_CSV_MAP;
  try {
    const p = path.join(root, 'graph_gen_data', 'tenants.csv');
    if (!fs.existsSync(p)) { TENANT_CSV_MAP = { idByNameCI: new Map(), nameById: new Map() }; return TENANT_CSV_MAP; }
    const lines = fs.readFileSync(p, 'utf8').trim().split(/\r?\n/);
    const header = lines.shift().split(',');
    const idx = Object.fromEntries(header.map((h,i)=>[h.trim(), i]));
    const idByNameCI = new Map();
    const nameById = new Map();
    for (const line of lines) {
      const cols = line.split(',');
      const id = Number(cols[idx['id']]);
      const name = cols[idx['name']];
      if (name) idByNameCI.set(String(name).toLowerCase(), id);
      nameById.set(id, name);
    }
    TENANT_CSV_MAP = { idByNameCI, nameById };
  } catch { TENANT_CSV_MAP = { idByNameCI: new Map(), nameById: new Map() }; }
  return TENANT_CSV_MAP;
}

async function resolveTenantIdGeneric({ tenant, g }) {
  // numeric -> id
  if (/^\d+$/.test(String(tenant))) return Number(tenant);
  // Try graph: name -> id
  try {
    const tq = await g.runQuery('MATCH (t:Tenant) WHERE t.name=$name RETURN t.id AS id', { name: tenant });
    const v = tq.records && tq.records[0] ? (tq.records[0].get('id') ?? null) : null;
    if (v != null) return typeof v === 'number' ? v : Number(v);
  } catch {}
  // Try CSV tenants map (case-insensitive by name)
  try {
    const m = loadTenantCsvMap();
    const id = m.idByNameCI.get(String(tenant).toLowerCase());
    if (id != null) return id;
  } catch {}
  return null;
}

function loadGraphSnapshotMem() {
  if (GRAPH_SNAPSHOT_MEM) return GRAPH_SNAPSHOT_MEM;
  const p = path.join(root, 'data', 'graph_snapshot.json');
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const snap = JSON.parse(raw);
    if (snap && Array.isArray(snap.nodes) && Array.isArray(snap.links)) {
      GRAPH_SNAPSHOT_MEM = { nodes: snap.nodes, links: snap.links, generatedAt: snap.generatedAt || Date.now() };
      return GRAPH_SNAPSHOT_MEM;
    }
  } catch {}
  return null;
}

async function maybeRefreshSnapshot(g, { force = false } = {}) {
  const now = Date.now();
  const snap = loadGraphSnapshotMem();
  const stale = !snap || ((now - (snap.generatedAt || 0)) > SNAPSHOT_REFRESH_MS);
  if (!force && !stale) return snap;
  if (!g || !g.fullHierarchy) return snap;
  try {
    const fresh = positionGraph(await g.fullHierarchy());
    const outDir = path.join(root, 'data');
    try { fs.mkdirSync(outDir, { recursive: true }); } catch {}
    const snapPath = path.join(outDir, 'graph_snapshot.json');
    fs.writeFileSync(snapPath, JSON.stringify({ generatedAt: Date.now(), ...fresh }, null, 2));
    GRAPH_SNAPSHOT_MEM = { ...fresh, generatedAt: Date.now() };
    GRAPH_FILTER_CACHE.clear();
    // Log S3 preview on startup: first line(s) of a few device CSVs
    try {
      if ((process.env.AWS_S3_ENABLED || '0') === '1') {
        const max = Number(process.env.S3_STARTUP_PREVIEW_MAX || 8);
        const ids = await s3ListDeviceIds(max);
        for (const id of ids) {
          try {
            const rows = await s3FetchDeviceCSV(String(id));
            const header = rows && rows[0] ? Object.keys(rows[0]) : [];
            const first = rows && rows[0] ? rows[0] : null;
            console.log('[startup][s3] preview', id, 'header=', header.join(','), 'first=', first ? JSON.stringify(first) : 'null');
          } catch (e) { console.warn('[startup][s3] preview failed for', id, String(e)); }
        }
      }
    } catch (e) { console.warn('[startup][s3] preview block failed:', String(e)); }
    // Warm per-tenant filtered cache to speed up first UI render
    try { await warmTenantGraphCache(g); } catch {}
    return GRAPH_SNAPSHOT_MEM;
  } catch { return snap; }
}

// Compute deterministic positions for graph nodes to avoid client-side simulation
function positionGraph(snap) {
  try {
    const nodes = snap.nodes || [];
    const links = snap.links || [];
    const byId = new Map(nodes.map(n => [n.id, n]));
    const children = new Map(); // parentId -> childIds
    function addChild(parent, child) { if (!children.has(parent)) children.set(parent, []); children.get(parent).push(child); }
    for (const l of links) {
      if (l.rel === 'BELONGS_TO_BUILDING' || l.rel === 'LOCATED_IN_BUILDING') {
        // floor -> building or zone -> building
        addChild(l.target, l.source);
      } else if (l.rel === 'BELONGS_TO_FLOOR') {
        addChild(l.target, l.source);
      } else if (l.rel === 'LOCATED_IN_ZONE') {
        addChild(l.target, l.source);
      } else if (l.rel === 'IN_BUILDING' || l.rel === 'HAS_FLOOR' || l.rel === 'HAS_ZONE' || l.rel === 'LOCATED_ON_FLOOR' || l.rel === 'LOCATED_IN_BUILDING') {
        addChild(l.target, l.source);
      }
    }
    const buildings = nodes.filter(n => (n.nodeType === 'Building'));
    // Layout constants
    const X_STEP_B = 300, Y_STEP = 220, X_STEP_F = 180, X_STEP_Z = 140, X_STEP_D = 100;
    // Place buildings in a row
    buildings.forEach((b, i) => { b.x = i * X_STEP_B; b.y = 0; });
    // Floors under each building
    for (const b of buildings) {
      const bids = (children.get(b.id) || []).filter(cid => (byId.get(cid)?.nodeType === 'Floor'));
      bids.forEach((fid, idx) => {
        const f = byId.get(fid); if (!f) return;
        f.x = b.x + (idx - (bids.length - 1) / 2) * X_STEP_F; f.y = b.y + Y_STEP;
        // Zones under floor
        const zids = (children.get(f.id) || []).filter(cid => (byId.get(cid)?.nodeType === 'Zone'));
        zids.forEach((zid, j) => {
          const z = byId.get(zid); if (!z) return;
          z.x = f.x + (j - (zids.length - 1) / 2) * X_STEP_Z; z.y = f.y + Y_STEP;
          // Devices near zone
          const dids = (children.get(z.id) || []).filter(cid => (byId.get(cid)?.nodeType === 'Device'));
          dids.forEach((did, k) => { const d = byId.get(did); if (!d) return; d.x = z.x + (k - (dids.length - 1) / 2) * X_STEP_D; d.y = z.y + Y_STEP; });
        });
      });
    }
    // Fallback: any nodes without position go to origin spread
    let rr = 0;
    for (const n of nodes) { if (typeof n.x !== 'number' || typeof n.y !== 'number') { n.x = rr * 50; n.y = 0; rr++; } }
  } catch {}
  return snap;
}

// Precompute filtered graphs per tenant into GRAPH_FILTER_CACHE
async function warmTenantGraphCache(g) {
  if (!g || !g.runQuery) return;
  const base = loadGraphSnapshotMem();
  if (!base) return;
  try {
    const { records } = await g.runQuery('MATCH (t:Tenant) RETURN DISTINCT t.name AS name ORDER BY name');
    const tenants = (records || []).map(r => r.get('name')).filter(Boolean);
    for (const tenant of tenants) {
      try {
        // Derive allowed buildings for tenant
        const cy = `
          MATCH (t:Tenant)
          WHERE t.name=$tenant OR toString(t.id)=$tenant
          OPTIONAL MATCH (b:Building)-[:BELONGS_TO_TENANT]->(t)
          WITH collect(DISTINCT b.name) AS names
          UNWIND names AS n WITH collect(DISTINCT n) AS names
          RETURN names
        `;
        const bq = await g.runQuery(cy, { tenant });
        const names = (bq.records && bq.records[0] && bq.records[0].get('names')) || [];
        const allowed = new Set((names || []).filter(Boolean));
        if (!allowed.size) continue;
        const nodes = base.nodes || [];
        const links = base.links || [];
        const byId = new Map(nodes.map(n => [n.id, n]));
        const adj = new Map();
        for (const l of links) { const a=l.source, b=l.target; if (!adj.has(a)) adj.set(a, new Set()); if (!adj.has(b)) adj.set(b, new Set()); adj.get(a).add(b); adj.get(b).add(a); }
        const keep = new Set();
        for (const n of nodes) if (n.nodeType==='Building' && allowed.has(n.name)) keep.add(n.id);
        const q = [...keep];
        while (q.length) { const cur = q.shift(); for (const nb of (adj.get(cur)||[])) if (!keep.has(nb)) { keep.add(nb); q.push(nb); } }
        const out = { nodes: nodes.filter(n => keep.has(n.id)), links: links.filter(l => keep.has(l.source) && keep.has(l.target)) };
        GRAPH_FILTER_CACHE.set(JSON.stringify({ tenant }), { nodes: out.nodes, links: out.links, ts: Date.now() });
      } catch {}
    }
  } catch {}
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

// ---- Role-based filtering disabled ----
function normRole(role) { return ''; }
function getRolePreset(role) { return { showDevices: true, allow: 'ALL' }; }
function roleAllowsField(role, field) { return true; }
function maskTablesByRole(tables, role) { return tables; }

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
  if ((process.env.NEO4J_SKIP_CHECK || '0') === '1') {
    console.warn('[startup] Skipping Neo4j readiness check (NEO4J_SKIP_CHECK=1)');
    return;
  }
  // Neo4j is REQUIRED
  const { NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD } = process.env;
  if (!NEO4J_URI || !NEO4J_USERNAME || !NEO4J_PASSWORD) {
    console.error('[startup] Neo4j env missing. Set NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD');
    process.exit(1);
  }
  let ok = false; let attempts = 0; const maxAttempts = Number(process.env.NEO4J_WAIT_ATTEMPTS || 150); // ~5 minutes at 2s
  while (!ok && attempts < maxAttempts) {
    attempts++;
    try {
      // Prefer direct verifyConnectivity (avoids cypher permissions/DB name mismatches)
      ok = await neo4jVerifyConnectivityFromEnv(process.env);
      if (!ok) {
        if (attempts % 5 === 0) console.log(`[startup] Waiting for Neo4j... attempt ${attempts}/${maxAttempts}`);
        await wait(2000);
      }
    } catch {
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
  // After Neo4j is reachable (and optionally populated), capture a lightweight graph snapshot for agent tools
  try {
    // Validate S3 or fall back to local mirror when offline
    if ((process.env.AWS_S3_ENABLED || '0') === '1') {
      let s3Ok = false;
      try {
        const s3 = await s3Ensure();
        if (!s3) throw new Error('S3 client not initialized');
        const { client, bucket, prefix, ListObjectsV2Command } = s3;
        const probe = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 1 }));
        if (!probe) throw new Error('S3 list failed');
        console.log('[startup] S3 ready:', bucket, prefix);
        s3Ok = true;
      } catch (e) {
        // Offline fallback: if a local mirror directory exists with CSVs, continue in offline mode
        const localDir = path.join(root, process.env.S3_LOCAL_DIR || 'CSVex_s3');
        let hasLocal = false;
        try {
          if (fs.existsSync(localDir)) {
            const files = fs.readdirSync(localDir).filter(f => f.toLowerCase().endsWith('.csv'));
            hasLocal = files.length > 0;
          }
        } catch {}
        if (hasLocal) {
          console.warn('[startup] S3 not reachable; proceeding with local mirror at', localDir);
          // Mark offline mode for downstream logs (functional paths already check local mirror in s3FetchDeviceCSV)
          process.env.AWS_S3_OFFLINE = '1';
        } else {
          console.error('[startup] S3 required but not reachable and no local mirror found:', String(e));
          process.exit(1);
        }
      }
      if (s3Ok && (process.env.S3_MIRROR_ON_START || '0') === '1') {
        // Optional: mirror S3 to local directory on startup
        const outDir = path.join(root, process.env.S3_LOCAL_DIR || 'CSVex_s3');
        try { fs.mkdirSync(outDir, { recursive: true }); } catch {}
        const ids = await s3ListDeviceIds(Number(process.env.S3_MIRROR_LIMIT || 0) || 1000000);
        console.log('[startup][s3] Mirroring', ids.length, 'device CSVs to', outDir);
        let ok=0, fail=0;
        for (const id of ids) {
          try {
            const rows = await s3FetchDeviceCSV(String(id));
            if (Array.isArray(rows) && rows.length) {
              const allowed = await getAllowedTelemetryKeysForDevice(String(id));
              const headers = ['ts'].concat(Array.from(new Set((allowed||[]).filter(k => k && k !== 'ts'))));
              const lines = [headers.join(',')].concat(rows.map(r => headers.map(h => r[h] ?? '').join(',')));
              const p = path.join(outDir, `${id}.csv`);
              fs.writeFileSync(p + '.tmp', lines.join('\n'));
              fs.renameSync(p + '.tmp', p);
              ok++;
            }
          } catch { fail++; }
        }
        console.log('[startup][s3] Mirror complete: ok=', ok, 'fail=', fail);
      }
    }
    const g = createGraphFromEnv(process.env);
    if (g && g.fullHierarchy) {
      // Mirror already handled above; swallow errors if any remain
      try {} catch (e) { console.warn('[startup][s3] mirror step failed:', String(e)); }

      // Always print sample headers for available telemetry tables (helps when S3 access is restricted)
      try {
        const maxRooms = Number(process.env.STARTUP_HEADER_SAMPLE_ROOMS || 5);
        const maxFilesPerRoom = Number(process.env.STARTUP_HEADER_FILES_PER_ROOM || 4);
        const printHeader = (filePath) => {
          try {
            const text = fs.readFileSync(filePath, 'utf8');
            const line = String(text).split(/\r?\n/).find(l => l.trim().length) || '';
            console.log('[startup][headers]', filePath.replace(root + '/', ''), '::', line);
          } catch {}
        };
        // S3 mirror headers (deviceId.csv)
        try {
          const s3LocalDir = path.join(root, process.env.S3_LOCAL_DIR || 'CSVex_s3');
          if (fs.existsSync(s3LocalDir)) {
            const files = fs.readdirSync(s3LocalDir).filter(f => f.endsWith('.csv')).slice(0, maxRooms);
            for (const f of files) printHeader(path.join(s3LocalDir, f));
          }
        } catch {}
        // Local CSVex headers (room tables)
        try {
          if (fs.existsSync(csvexDir)) {
            const rooms = fs.readdirSync(csvexDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).slice(0, maxRooms);
            for (const r of rooms) {
              const roomDir = path.join(csvexDir, r);
              const files = fs.readdirSync(roomDir).filter(f => f.endsWith('.csv')).slice(0, maxFilesPerRoom);
              for (const f of files) printHeader(path.join(roomDir, f));
            }
          }
        } catch {}
      } catch {}
      const snap = positionGraph(await g.fullHierarchy());
      const outDir = path.join(root, 'data');
      try { fs.mkdirSync(outDir, { recursive: true }); } catch {}
      const snapPath = path.join(outDir, 'graph_snapshot.json');
      fs.writeFileSync(snapPath, JSON.stringify({ generatedAt: Date.now(), ...snap }, null, 2));
      if (process.env.HTTP_DEBUG === '1' || process.env.LOG_LEVEL === 'debug') {
        console.log('[startup] Wrote graph snapshot to', snapPath, 'nodes', (snap.nodes||[]).length, 'links', (snap.links||[]).length);
      }
      // CSV generation from graph is handled in dev_controls pre-start to avoid blocking the server here.
      // Optionally prefetch weather for all buildings with lat/lon
      if ((process.env.WEATHER_FETCH_ALL_BUILDINGS || '0') === '1') {
        try {
          console.log('[startup] Fetching weather for all buildings with coordinates…');
          const { records } = await g.runQuery('MATCH (b:Building) RETURN b.name AS name, b.lat AS lat, b.long AS lon, b.longitude AS lon2, b.latitude AS lat2');
          const items = (records || []).map(r => ({ name: r.get('name'), lat: r.get('lat') ?? r.get('lat2'), lon: r.get('lon') ?? r.get('lon2') })).filter(x => x && x.name && x.lat != null && x.lon != null);
          for (const it of items) {
            try {
              const res = await fetchAndCacheWeatherForBuilding(it.name, it.lat, it.lon);
              if (res && res.ok) console.log(`[startup] Weather cached for ${it.name} → ${res.rows} rows`);
            } catch (e) { console.warn('[startup] Weather fetch failed for', it.name, String(e)); }
            await wait(300); // be polite to API
          }
        } catch (e) { console.warn('[startup] Weather prefetch step failed (continuing):', String(e)); }
      }
    }
  } catch (e) {
    console.warn('[startup] Graph snapshot failed:', String(e));
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
  const s3Enabled = (process.env.AWS_S3_ENABLED || '0') === '1';
  if (s3Enabled) {
    // In S3-only mode, list locally mirrored device CSVs if present
    const localDir = path.join(root, process.env.S3_LOCAL_DIR || 'CSVex_s3');
    try {
      if (!fs.existsSync(localDir)) return [];
      return fs.readdirSync(localDir)
        .filter(f => f.endsWith('.csv'))
        .map(f => f.replace(/\.csv$/i, ''));
    } catch { return []; }
  }
  if (!fs.existsSync(csvexDir)) return [];
  return fs.readdirSync(csvexDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
}

// Helper to parse CSV files
function splitCSVLine(line) {
  const out = []; let cur = ''; let inQ = false; for (let i=0;i<line.length;i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i+1] === '"') { cur += '"'; i++; } else { inQ = false; }
      } else { cur += ch; }
    } else {
      if (ch === '"') { inQ = true; }
      else if (ch === ',') { out.push(cur); cur = ''; }
      else { cur += ch; }
    }
  }
  out.push(cur);
  return out;
}

function parseCSV(filePath) {
  const rows = [];
  if (!fs.existsSync(filePath)) return rows;
  const text = fs.readFileSync(filePath, 'utf8');
  return parseCSVText(text);
}

function parseCSVText(text) {
  const rows = [];
  if (!text) return rows;
  const lines = String(text).split(/\r?\n/);
  while (lines.length && lines[0].trim()==='') lines.shift();
  if (lines.length < 2) return rows;
  const headers = splitCSVLine(lines[0]);
  for (let i = 1; i < lines.length; i++) {
    const ln = lines[i]; if (!ln || !ln.trim()) continue;
    const vals = splitCSVLine(ln);
    const row = {};
    headers.forEach((h, idx) => {
      let v = vals[idx];
      if (h === 'ts') v = Number(v);
      else if (v != null && v !== '' && !isNaN(Number(v))) v = Number(v);
      row[h] = v;
    });
    rows.push(row);
  }
  return rows;
}

function loadRoomTables(room) {
  // If S3 mode: interpret room as deviceId and return a single table 'telemetry' from local mirror if available
  const enabled = (process.env.AWS_S3_ENABLED || '0') === '1';
  if (enabled) {
    try {
      const localDir = path.join(root, process.env.S3_LOCAL_DIR || 'CSVex_s3');
      const filePath = path.join(localDir, `${room}.csv`);
      if (!fs.existsSync(filePath)) return {};
      const out = { telemetry: parseCSV(filePath) };
      const arr = (out.telemetry || []).filter(r => r && r.ts != null);
      arr.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
      out.telemetry = arr;
      return out;
    } catch { return {}; }
  }
  const roomDir = path.join(csvexDir, room);
  if (!fs.existsSync(roomDir)) return {};
  const files = fs.readdirSync(roomDir).filter(f => f.endsWith('.csv'));
  const out = {};
  files.forEach(f => {
    const table = f.replace(/\.csv$/, '');
    const filePath = path.join(roomDir, f);
    out[table] = parseCSV(filePath);
  });
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

function buildingSlug(name) { return String(name||'').trim().toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,''); }

function loadWeather(building = null) {
  try {
    if (building) {
      const bslug = buildingSlug(building);
      const csvb = path.join(csvexDir, 'weather_buildings', `${bslug}.csv`);
      if (fs.existsSync(csvb)) {
        return parseCSV(csvb).map(r => ({ ts: Number(r.ts), temp: Number(r.temp), humidity: Number(r.humidity), pressure: Number(r.pressure), wind_speed: Number(r.wind_speed), wind_deg: Number(r.wind_deg), clouds: Number(r.clouds), weather_main: r.weather_main, weather_desc: r.weather_desc }));
      }
    }
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

// Fetch and cache weather for a building (OpenWeather 5-day/3-hour forecast + current)
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
    // Write CSV
    const outDir = path.join(csvexDir, 'weather_buildings');
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
    return sendJson(res, 200, { rooms: listRooms() });
  }

  if (pathname === '/api/weather' && req.method === 'GET') {
    const building = String(query.building || '').trim();
    if (building) {
      const g = createGraphFromEnv(process.env);
      const snap = loadGraphSnapshotMem();
      // Find building lat/lon from snapshot or via a quick query
      let lat = null, lon = null;
      if (snap) {
        const b = (snap.nodes || []).find(n => n.nodeType==='Building' && n.name===building);
        lat = b?.lat ?? null; lon = b?.lon ?? null;
      }
      if (!lat || !lon) {
        try {
          const { records } = await g.runQuery('MATCH (b:Building {name:$name}) RETURN b.lat AS lat, b.long AS lon, b.longitude AS lon2, b.latitude AS lat2', { name: building });
          const r0 = records?.[0];
          lat = r0?.get('lat') ?? r0?.get('lat2') ?? null; lon = r0?.get('lon') ?? r0?.get('lon2') ?? null;
        } catch {}
      }
      if (lat && lon) await fetchAndCacheWeatherForBuilding(building, lat, lon);
      const rows = loadWeather(building);
      return sendJson(res, 200, { building, count: rows.length, latest: rows.at(-1) || null, rows: rows.slice(-50) });
    } else {
      const weather = loadWeather();
      return sendJson(res, 200, { count: weather.length, latest: weather.at(-1) || null });
    }
  }

  if (pathname === '/api/auth/options' && req.method === 'GET') {
    try {
      const g = createGraphFromEnv(process.env);
      const tenants = [];
      const roles = [];
      if (g && g.runQuery) {
        try {
          const tr = await g.runQuery('MATCH (t:Tenant) RETURN DISTINCT t.name AS name ORDER BY name');
          for (const r of tr.records || []) { const n = r.get('name'); if (n) tenants.push(String(n)); }
        } catch {}
        try {
          const rr = await g.runQuery('MATCH (r:Role) RETURN DISTINCT r.name AS name ORDER BY name');
          for (const r of rr.records || []) { const n = r.get('name'); if (n) roles.push(String(n)); }
        } catch {}
      }
      if (!roles.length) roles.push('Guest','Host','Analyst','Admin');
      return sendJson(res, 200, { tenants, roles });
    } catch (e) {
      return sendJson(res, 500, { error: 'options_failed', detail: String(e) });
    }
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
    const role = '';
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

  // Read-only Neo4j schema summary to help adapt to live Aura schemas.
  if (pathname === '/api/graph/schema' && req.method === 'GET') {
    try {
      const g = createGraphFromEnv(process.env);
      if (!g || !g.runQuery) return sendJson(res, 500, { error: 'graph_not_configured' });
      const results = {};
      const out = {};
      // Node labels
      const labelsRes = await g.runQuery('SHOW NODE LABELS YIELD label RETURN label ORDER BY label');
      out.nodeLabels = (labelsRes.records || []).map(r => r.get('label'));
      // Relationship types
      const relTypesRes = await g.runQuery('SHOW RELATIONSHIP TYPES YIELD relationshipType RETURN relationshipType ORDER BY relationshipType');
      out.relationshipTypes = (relTypesRes.records || []).map(r => r.get('relationshipType'));
      // Global counts
      const nodesCnt = await g.runQuery('MATCH (n) RETURN count(n) AS c');
      const relsCnt = await g.runQuery('MATCH ()-[r]->() RETURN count(r) AS c');
      out.counts = {
        nodes: nodesCnt.records?.[0]?.get('c') ?? 0,
        relationships: relsCnt.records?.[0]?.get('c') ?? 0
      };
      // Nodes by label (counts)
      const nbl = await g.runQuery('MATCH (n) UNWIND labels(n) AS label RETURN label, count(*) AS c ORDER BY c DESC');
      out.nodesByLabel = (nbl.records || []).map(r => ({ label: r.get('label'), count: r.get('c') }));
      // Relationships by type (counts)
      const rbt = await g.runQuery('MATCH ()-[r]->() RETURN type(r) AS type, count(r) AS c ORDER BY c DESC');
      out.relsByType = (rbt.records || []).map(r => ({ type: r.get('type'), count: r.get('c') }));
      // Top label-rel-label triples (to see hierarchy shape)
      const triples = await g.runQuery(`
        MATCH (a)-[r]->(b)
        RETURN head(labels(a)) AS from, type(r) AS rel, head(labels(b)) AS to, count(*) AS c
        ORDER BY c DESC LIMIT 200
      `);
      out.topTriples = (triples.records || []).map(r => ({ from: r.get('from'), rel: r.get('rel'), to: r.get('to'), count: r.get('c') }));
      // Property keys by primary label (sampled)
      const props = await g.runQuery(`
        MATCH (n)
        WITH head(labels(n)) AS label, n
        WITH label, collect(n)[0..500] AS ns
        UNWIND ns AS n1
        WITH label, keys(n1) AS ks
        UNWIND ks AS k
        WITH label, collect(DISTINCT k) AS keys
        RETURN label, keys ORDER BY size(keys) DESC LIMIT 50
      `);
      out.propertyKeysByLabel = (props.records || []).map(r => ({ label: r.get('label'), keys: r.get('keys') }));
      return sendJson(res, 200, out);
    } catch (e) {
      return sendJson(res, 500, { error: 'schema_summary_failed', detail: String(e) });
    }
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
      const role = '';
      const tenant = String(query.tenant || '').trim();
      const force = String(query.force || '').trim() === '1';

      // Fast path: use local snapshot + cached filtered views when possible
      const baseSnap = await maybeRefreshSnapshot(g, { force });
      let out = null;
      if (baseSnap) {
        // cache by tenant+role
        const cacheKey = JSON.stringify({ tenant });
        const now = Date.now();
        const cached = GRAPH_FILTER_CACHE.get(cacheKey);
        if (cached && (now - cached.ts) < GRAPH_FILTER_TTL_MS) {
          out = { nodes: cached.nodes, links: cached.links };
        } else {
          out = { nodes: baseSnap.nodes.slice(), links: baseSnap.links.slice() };
        }
      } else {
        if (!g || !g.fullHierarchy) return sendJson(res, 500, { error: 'graph_not_configured' });
        out = await g.fullHierarchy();
      }
      // Role-based scope discovery disabled

      // Tenant filter → restrict buildings and descendants
      if (tenant) {
        try {
          const qTen = `
            MATCH (t:Tenant)
            WHERE t.name=$tenant OR toString(t.id)=$tenant
            OPTIONAL MATCH (b1:Building)-[:BELONGS_TO_TENANT]->(t)
            WITH t, collect(DISTINCT b1.name) AS names
            OPTIONAL MATCH (t)<-[:BELONGS_TO_TENANT]-(b2:Building)
            WITH names + collect(DISTINCT b2.name) AS names
            UNWIND names AS n WITH collect(DISTINCT n) AS names
            RETURN names
          `;
          const bq = g && g.runQuery ? await g.runQuery(qTen, { tenant }) : { records: [] };
          const names = (bq.records && bq.records[0] && bq.records[0].get('names')) || [];
          let allowed = new Set((names || []).filter(Boolean));
          if (!allowed.size) {
            // Property-based fallback: match buildings by tenantID present in snapshot
            try {
              const nodesAll = out.nodes || [];
              const linksAll = out.links || [];
              const byId = new Map(nodesAll.map(n => [n.id, n]));
              let tenantId = null;
              if (/^\d+$/.test(String(tenant))) {
                tenantId = Number(tenant);
              } else {
                try {
                  const tq = await g.runQuery('MATCH (t:Tenant) WHERE t.name=$name RETURN t.id AS id', { name: tenant });
                  tenantId = tq.records && tq.records[0] ? (tq.records[0].get('id') ?? null) : null;
                  if (tenantId != null && typeof tenantId !== 'number') tenantId = Number(tenantId);
                } catch {}
              }
              if (tenantId != null) {
                for (const n of nodesAll) {
                  if (n.nodeType === 'Building' && Number(n.tenantID) === tenantId) allowed.add(n.name);
                }
                // Also derive via floors/zones tenantID
                for (const l of linksAll) {
                  if (l.rel === 'IN_BUILDING') {
                    const f = byId.get(l.source); const b = byId.get(l.target);
                    if (f && b && f.nodeType==='Floor' && Number(f.tenantID)===tenantId) allowed.add(b.name);
                  }
                  if (l.rel === 'LOCATED_ON_FLOOR') {
                    const z = byId.get(l.source); const f = byId.get(l.target);
                    if (z && f && z.nodeType==='Zone' && Number(z.tenantID)===tenantId) {
                      const lb = linksAll.find(x => x.source===f.id && x.rel==='IN_BUILDING');
                      const bb = lb ? byId.get(lb.target) : null; if (bb) allowed.add(bb.name);
                    }
                  }
                  if (l.rel === 'LOCATED_IN_BUILDING') {
                    const z = byId.get(l.source); const b = byId.get(l.target);
                    if (z && b && z.nodeType==='Zone' && Number(z.tenantID)===tenantId) allowed.add(b.name);
                  }
                }
                // Static mapping fallback from graph_gen_data/buildings.csv
                try {
                  const map = loadBuildingTenantMap();
                  const namesSet = map.namesByTenantId.get(tenantId);
                  if (namesSet && namesSet.size) { for (const nm of namesSet) allowed.add(nm); }
                } catch {}
              }
            } catch {}
          }
          if (allowed.size) {
            const nodes = out.nodes || [];
            const links = out.links || [];
            const byId = new Map(nodes.map(n => [n.id, n]));
            const adj = new Map();
            for (const l of links) {
              const a = l.source, b = l.target; if (!adj.has(a)) adj.set(a, new Set()); if (!adj.has(b)) adj.set(b, new Set());
              adj.get(a).add(b); adj.get(b).add(a);
            }
            const keep = new Set();
            // seed with allowed buildings
            for (const n of nodes) if (n.nodeType === 'Building' && allowed.has(n.name)) keep.add(n.id);
            // BFS to include neighbors
            const q = [...keep];
            while (q.length) {
              const cur = q.shift();
              for (const nb of (adj.get(cur) || [])) if (!keep.has(nb)) { keep.add(nb); q.push(nb); }
            }
            out = {
              nodes: nodes.filter(n => keep.has(n.id)),
              links: links.filter(l => keep.has(l.source) && keep.has(l.target))
            };
          } else {
            // Strict tenant selection: if no buildings matched, show nothing
            out = { nodes: [], links: [] };
          }
        } catch {}
      }
      // Role filter → optionally hide devices and apply scope allowlists
      // Role-based node filtering disabled
      // Attach csvRoom (local CSV) or deviceIds (S3) to Zone nodes for instant UI selection mapping
      try {
        const s3Enabled = (process.env.AWS_S3_ENABLED || '0') === '1';
        const nodes = out.nodes || [];
        const links = out.links || [];
        const byId = new Map(nodes.map(n => [n.id, n]));
        if (s3Enabled) {
          for (const n of nodes) {
            if (n.nodeType === 'Zone') {
              const devIds = [];
              for (const l of links) {
                if (l.target === n.id && l.rel === 'LOCATED_IN_ZONE') {
                  const d = byId.get(l.source);
                  if (d && d.nodeType === 'Device') {
                    const deviceId = d.idProp || (d.name || '').split(':').slice(1).join(':') || null;
                    if (deviceId) devIds.push(deviceId);
                  }
                }
              }
              n.deviceIds = Array.from(new Set(devIds));
            }
          }
        } else {
          const map = await buildCsvMapping(g);
          const items = map && Array.isArray(map.items) ? map.items : [];
          const tripleMap = new Map();
          for (const it of items) {
            const key = `${it.building}|${it.floor}|${it.zone}`;
            if (it.match) tripleMap.set(key, it.match);
            if (it.roomId && it.match) tripleMap.set(`roomId:${it.roomId}`, it.match);
          }
          for (const n of nodes) {
            if (n.nodeType === 'Zone') {
              let floorName = null, buildingName = null;
              const lf = links.find(l => l.source === n.id && (l.rel === 'LOCATED_ON_FLOOR' || l.rel === 'BELONGS_TO_FLOOR'));
              const f = lf ? byId.get(lf.target) : null;
              floorName = f ? f.name : null;
              if (f) {
                const lb = links.find(l => l.source === f.id && (l.rel === 'IN_BUILDING' || l.rel === 'BELONGS_TO_BUILDING' || l.rel === 'LOCATED_IN_BUILDING'));
                const b = lb ? byId.get(lb.target) : null; buildingName = b ? b.name : null;
              } else {
                const lb2 = links.find(l => l.source === n.id && (l.rel === 'LOCATED_IN_BUILDING' || l.rel === 'IN_BUILDING' || l.rel === 'BELONGS_TO_BUILDING'));
                const b2 = lb2 ? byId.get(lb2.target) : null; buildingName = b2 ? b2.name : null;
              }
              let csv = null;
              if (n.roomId) csv = tripleMap.get(`roomId:${n.roomId}`) || null;
              if (!csv && buildingName && floorName) csv = tripleMap.get(`${buildingName}|${floorName}|${n.name}`) || null;
              n.csvRoom = csv || null;
            }
          }
        }
      } catch {}
      if (baseSnap) {
        // store filtered view to cache
        const cacheKey = JSON.stringify({ tenant });
        GRAPH_FILTER_CACHE.set(cacheKey, { nodes: out.nodes, links: out.links, ts: Date.now() });
      }
      if (DEBUG_HTTP) console.log('[HTTP] /api/graph/full -> nodes', out.nodes?.length || 0, 'links', out.links?.length || 0);
      return sendJson(res, 200, out);
    } catch (e) {
      return sendJson(res, 500, { error: 'graph_failed', detail: String(e) });
    }
  }

  // Resolve current selection (tenant/building/floor) to CSV room IDs
  if (pathname === '/api/scope/csv-rooms' && req.method === 'GET') {
    try {
      const tenant = String(query.tenant || '').trim() || null;
      const building = String(query.building || '').trim() || null;
      const floor = String(query.floor || '').trim() || null;
      const zone = String(query.zone || '').trim() || null;
      const rooms = await resolveCsvRoomsFromScope({ building, floor, zone, tenant });
      return sendJson(res, 200, { tenant, building, floor, zone, rooms });
    } catch (e) {
      return sendJson(res, 500, { error: 'scope_map_failed', detail: String(e) });
    }
  }

  // Devices present on a specific floor (by type and list), optionally filtered by tenant and role
  if (pathname === '/api/graph/floor-devices' && req.method === 'GET') {
    try {
      const building = String(query.building || '').trim();
      const floor = String(query.floor || '').trim();
      const tenant = String(query.tenant || '').trim();
      const role = '';
      if (!building || !floor) return sendJson(res, 400, { error: 'building and floor required' });
      // Role-based device visibility disabled; always return devices
      const g = createGraphFromEnv(process.env);
      if (!g || !g.runQuery) return sendJson(res, 500, { error: 'graph_not_configured' });
      const cypher = `
        MATCH (b:Building {name:$building})
        MATCH (f:Floor {name:$floor})-[:LOCATED_IN_BUILDING]->(b)
        OPTIONAL MATCH (z:Zone)-[:LOCATED_ON_FLOOR]->(f)
        OPTIONAL MATCH (d:Device)-[:LOCATED_IN_ZONE]->(z)
        ${tenant ? 'MATCH (b)-[:BELONGS_TO_TENANT]->(t:Tenant) WHERE t.name=$tenant OR toString(t.id)=$tenant' : ''}
        RETURN z, collect(d) AS devs
      `;
      const { records, error } = await g.runQuery(cypher, { building, floor, tenant: tenant || null });
      if (error) return sendJson(res, 500, { error: 'graph_failed', detail: String(error) });
      const zones = [];
      const typeTally = new Map();
      for (const r of (records || [])) {
        const z = r.get('z');
        if (!z) continue;
        const zname = z.properties?.name || null;
        const roomId = z.properties?.roomId || null;
        const devs = (r.get('devs') || []).map(d => ({ id: (d.properties?.id ?? d.properties?.cloud_id ?? d.properties?.deviceId ?? d.properties?.name ?? null), name: d.properties?.name || null, type: d.properties?.type || null }));
        for (const d of devs) if (d.type) typeTally.set(d.type, (typeTally.get(d.type)||0)+1);
        zones.push({ zone: zname, roomId, devices: devs });
      }
      const byType = Array.from(typeTally.entries()).map(([type, count]) => ({ type, count }));
      // CSV mapping: in S3 mode, expose device IDs; otherwise map to local CSV rooms
      const s3Enabled = (process.env.AWS_S3_ENABLED || '0') === '1';
      let zonesOut = [];
      let byCsvRoom = [];
      if (s3Enabled) {
        const idCounts = new Map();
        zonesOut = zones.map(z => {
          for (const d of z.devices || []) {
            const id = d.id || d.name; if (!id) continue;
            idCounts.set(id, (idCounts.get(id)||0) + 1);
          }
          return { zone: z.zone, roomId: z.roomId, csvRoom: null, count: z.devices?.length || 0, deviceIds: (z.devices||[]).map(dd => dd.id).filter(Boolean) };
        });
        byCsvRoom = Array.from(idCounts.entries()).map(([csvRoom, count]) => ({ csvRoom, count }));
      } else {
        const map = await buildCsvMapping(g);
        const csvCounts = new Map();
        zonesOut = zones.map(z => {
          let csv = null;
          if (z.roomId) csv = map.byKey.get(`roomId:${z.roomId}`) || null;
          if (!csv) csv = (map.items||[]).find(it => it.building===building && it.floor===floor && it.zone===z.zone)?.match || null;
          if (csv) csvCounts.set(csv, (csvCounts.get(csv)||0) + (z.devices?.length || 0));
          return { zone: z.zone, roomId: z.roomId, csvRoom: csv, count: z.devices?.length || 0, deviceIds: (z.devices||[]).map(dd => dd.id).filter(Boolean) };
        });
        byCsvRoom = Array.from(csvCounts.entries()).map(([csvRoom, count]) => ({ csvRoom, count }));
      }
      return sendJson(res, 200, { building, floor, byType, zones: zonesOut, byCsvRoom });
    } catch (e) {
      return sendJson(res, 500, { error: 'graph_failed', detail: String(e) });
    }
  }

  if (pathname === '/api/graph/csv-map' && req.method === 'GET') {
    try {
      const g = createGraphFromEnv(process.env);
      const map = await buildCsvMapping(g);
      return sendJson(res, 200, { count: (map.items||[]).length, mapped: (map.items||[]).filter(x => x.match).length, items: map.items });
    } catch (e) {
      return sendJson(res, 500, { error: 'graph_failed', detail: String(e) });
    }
  }

  if (pathname === '/api/graph/tenant-buildings' && req.method === 'GET') {
    try {
      const g = createGraphFromEnv(process.env);
      const tenant = String(query.tenant || '').trim();
      if (!tenant) return sendJson(res, 400, { error: 'tenant required' });
      const cypher = `
        MATCH (t:Tenant)
        WHERE t.name=$tenant OR toString(t.id)=$tenant
        OPTIONAL MATCH (b:Building)-[:BELONGS_TO_TENANT]->(t)
        WITH t, collect(DISTINCT b.name) AS names
        OPTIONAL MATCH (t)<-[:BELONGS_TO_TENANT]-(b2:Building)
        WITH names + collect(DISTINCT b2.name) AS names
        UNWIND names AS n WITH collect(DISTINCT n) AS names
        RETURN names
      `;
      const { records } = await g.runQuery(cypher, { tenant });
      let names = (records && records[0] && records[0].get('names')) || [];
      names = (names || []).filter(Boolean);
      // Fallback: property-based match by Building.tenantID in snapshot
      if (!names.length) {
        try {
          const snap = loadGraphSnapshotMem();
          if (snap && Array.isArray(snap.nodes)) {
            let tenantId = null;
            if (/^\d+$/.test(tenant)) {
              tenantId = Number(tenant);
            } else {
              const tq = await g.runQuery('MATCH (t:Tenant) WHERE t.name=$name RETURN t.id AS id', { name: tenant });
              tenantId = tq.records && tq.records[0] ? (tq.records[0].get('id') ?? null) : null;
              if (tenantId != null && typeof tenantId !== 'number') tenantId = Number(tenantId);
            }
            if (tenantId != null) {
              names = (snap.nodes || [])
                .filter(n => n.nodeType === 'Building' && Number(n.tenantID) === tenantId)
                .map(n => n.name);
            }
          }
        } catch {}
      }
      return sendJson(res, 200, { tenant, buildings: names });
    } catch (e) {
      return sendJson(res, 500, { error: 'tenant_buildings_failed', detail: String(e) });
    }
  }

  // Dump relationships (debug): list of edges with labels and names
  if (pathname === '/api/graph/relations' && req.method === 'GET') {
    try {
      const g = createGraphFromEnv(process.env);
      const limit = Number(query.limit || 1000);
      const cypher = `
        MATCH (a)-[r]->(b)
        RETURN labels(a) AS fromLabels, a.name AS fromName, type(r) AS rel, labels(b) AS toLabels, b.name AS toName
        LIMIT $limit
      `;
      const { records, error } = await g.runQuery(cypher, { limit });
      if (error) return sendJson(res, 500, { error: 'graph_failed', detail: String(error) });
      const items = (records || []).map(r => ({ fromLabels: r.get('fromLabels'), fromName: r.get('fromName'), rel: r.get('rel'), toLabels: r.get('toLabels'), toName: r.get('toName') }));
      return sendJson(res, 200, { count: items.length, items });
    } catch (e) {
      return sendJson(res, 500, { error: 'graph_failed', detail: String(e) });
    }
  }

  // Dump nodes (debug): list node names by label
  if (pathname === '/api/graph/nodes' && req.method === 'GET') {
    try {
      const g = createGraphFromEnv(process.env);
      const label = String(query.label || '').trim();
      if (!label) return sendJson(res, 400, { error: 'label required' });
      const cypher = `
        MATCH (n:` + label + `)
        RETURN DISTINCT n.name AS name LIMIT 5000
      `;
      const { records, error } = await g.runQuery(cypher, {});
      if (error) return sendJson(res, 500, { error: 'graph_failed', detail: String(error) });
      const items = (records || []).map(r => r.get('name')).filter(Boolean);
      return sendJson(res, 200, { label, count: items.length, items });
    } catch (e) {
      return sendJson(res, 500, { error: 'graph_failed', detail: String(e) });
    }
  }

  // Telemetry key inspection: list keys from Neo4j
  if (pathname === '/api/graph/telemetry-keys' && req.method === 'GET') {
    try {
      const g = createGraphFromEnv(process.env);
      if (!g || !g.runQuery) return sendJson(res, 500, { error: 'graph_not_configured' });
      const deviceId = String(query.deviceId || '').trim();
      if (deviceId) {
        const cy = `
          MATCH (d:Device)
          WHERE coalesce(toString(d.id), toString(d.cloud_id), toString(d.deviceId), toString(d.name)) = $id
          OPTIONAL MATCH (d)-[:HAS_TELEMETRY_KEY]->(k:TelemetryKey)
          OPTIONAL MATCH (d)-[:HAS_DEVICE_PROFILE]->(p:DeviceProfile)
          RETURN coalesce(d.id, d.cloud_id, d.deviceId, d.name) AS deviceId,
                 d.name AS name,
                 p.name AS profile,
                 collect(DISTINCT k.name) AS keys
        `;
        const { records } = await g.runQuery(cy, { id: deviceId });
        if (!records || !records.length) return sendJson(res, 404, { error: 'device_not_found', deviceId });
        const r = records[0];
        return sendJson(res, 200, {
          deviceId: r.get('deviceId'),
          name: r.get('name') || null,
          profile: r.get('profile') || null,
          keys: (r.get('keys') || []).filter(Boolean)
        });
      }
      // No deviceId → return distinct keys across graph
      const { records } = await g.runQuery('MATCH (k:TelemetryKey) RETURN collect(DISTINCT k.name) AS keys', {});
      const keys = (records && records[0] && records[0].get('keys')) || [];
      return sendJson(res, 200, { keys: (keys || []).filter(Boolean).sort() });
    } catch (e) {
      return sendJson(res, 500, { error: 'telemetry_keys_failed', detail: String(e) });
    }
  }

  // Scope inventory: return buildings, floors, zones, devices, and keysByDevice for a given scope
  if (pathname === '/api/scope/inventory' && req.method === 'GET') {
    try {
      const tenant = String(query.tenant || '').trim() || null;
      const building = String(query.building || '').trim() || null;
      const floor = String(query.floor || '').trim() || null;
      const zone = String(query.zone || '').trim() || null;
      const g = createGraphFromEnv(process.env);
      if (!g || !g.runQuery) return sendJson(res, 500, { error: 'graph_not_configured' });
      const cy = `
        // Anchor tenant if provided
        OPTIONAL MATCH (t:Tenant)
        WHERE $tenant IS NULL OR t.name=$tenant OR toString(t.id)=$tenant
        // Buildings under tenant (or all if tenant null)
        OPTIONAL MATCH (b:Building)
        WHERE ($tenant IS NULL OR (b)-[:BELONGS_TO_TENANT]->(t))
          AND ($building IS NULL OR b.name=$building)
        // Floors under building
        OPTIONAL MATCH (f:Floor)-[:LOCATED_IN_BUILDING]->(b)
        WHERE ($floor IS NULL OR f.name=$floor)
        // Zones (rooms) under floor
        OPTIONAL MATCH (z:Zone)-[:LOCATED_ON_FLOOR]->(f)
        WHERE ($zone IS NULL OR z.name=$zone OR toString(z.roomId)=$zone)
        // Devices attached by zone/floor/building (any of the three)
        OPTIONAL MATCH (d:Device)
        WHERE (
          ($zone IS NULL) OR ( (d)-[:LOCATED_IN_ZONE]->(z) )
        ) AND (
          ($floor IS NULL) OR ( (d)-[:LOCATED_ON_FLOOR]->(f) )
        ) AND (
          ($building IS NULL) OR ( (d)-[:IN_BUILDING]->(b) )
        ) AND (
          ($tenant IS NULL) OR ( (d)-[:BELONGS_TO_TENANT]->(t) )
        )
        // Keys per device
        OPTIONAL MATCH (d)-[:HAS_TELEMETRY_KEY]->(k:TelemetryKey)
        WITH DISTINCT
          collect(DISTINCT b.name) AS buildings,
          collect(DISTINCT f.name) AS floors,
          collect(DISTINCT coalesce(z.roomId, z.name)) AS zones,
          collect(DISTINCT coalesce(d.id, d.cloud_id, d.deviceId, d.name)) AS devices,
          collect(DISTINCT {
            deviceId: coalesce(d.id, d.cloud_id, d.deviceId, d.name),
            key: k.name
          }) AS devKeys
        RETURN buildings, floors, zones, devices, devKeys
      `;
      const { records } = await g.runQuery(cy, { tenant, building, floor, zone });
      const r = (records && records[0]) || null;
      const buildingsOut = (r?.get('buildings') || []).filter(Boolean);
      const floorsOut = (r?.get('floors') || []).filter(Boolean);
      const zonesOut = (r?.get('zones') || []).filter(Boolean);
      const devicesOut = (r?.get('devices') || []).filter(Boolean);
      const devKeysArr = (r?.get('devKeys') || []).filter(x => x && x.deviceId);
      const keysByDevice = {};
      for (const it of devKeysArr) {
        const id = String(it.deviceId);
        const key = it.key;
        if (!keysByDevice[id]) keysByDevice[id] = new Set();
        if (key) keysByDevice[id].add(key);
      }
      const keysObj = Object.fromEntries(Object.entries(keysByDevice).map(([id, s]) => [id, Array.from(s).sort()]));
      return sendJson(res, 200, {
        scope: { tenant, building, floor, zone },
        buildings: Array.from(new Set(buildingsOut)).sort(),
        floors: Array.from(new Set(floorsOut)).sort(),
        zones: Array.from(new Set(zonesOut)).sort(),
        devices: Array.from(new Set(devicesOut)).sort(),
        keysByDevice: keysObj
      });
    } catch (e) {
      return sendJson(res, 500, { error: 'scope_inventory_failed', detail: String(e) });
    }
  }

  // Return field lists per device id (S3 or local). Query: /api/devices/fields?ids=id1,id2&limit=50
  if (pathname === '/api/devices/fields' && req.method === 'GET') {
    try {
      const raw = String(query.ids || '').trim();
      if (!raw) return sendJson(res, 400, { error: 'ids required' });
      const limit = Math.max(1, Math.min(200, Number(query.limit || 50)));
      const ids = raw.split(',').map(s => s.trim()).filter(Boolean).slice(0, limit);
      const byId = {};
      const union = new Set();
      // Prefer graph TelemetryKeys; fall back to CSV/S3 header introspection only if no keys found
      const g = createGraphFromEnv(process.env);
      for (const id of ids) {
        let fields = [];
        let profile = null;
        if (g && g.runQuery) {
          try {
            const cy = `
              MATCH (d:Device)
              WHERE coalesce(toString(d.id), toString(d.cloud_id), toString(d.deviceId), toString(d.name)) = $id
              OPTIONAL MATCH (d)-[:HAS_TELEMETRY_KEY]->(k:TelemetryKey)
              OPTIONAL MATCH (d)-[:HAS_DEVICE_PROFILE]->(p:DeviceProfile)
              RETURN collect(DISTINCT k.name) AS keys, p.name AS profile
            `;
            const { records } = await g.runQuery(cy, { id: String(id) });
            if (records && records[0]) {
              fields = (records[0].get('keys') || []).filter(Boolean);
              profile = records[0].get('profile') || null;
            }
          } catch {}
        }
        if (!fields || fields.length === 0) {
          const s3Enabled = (process.env.AWS_S3_ENABLED || '0') === '1';
          if (s3Enabled) {
            const rows = await s3FetchDeviceCSV(String(id));
            const first = rows && rows[0] ? rows[0] : null;
            if (first) fields = Object.keys(first).filter(k => k !== 'ts');
          } else {
            const tables = loadRoomTables(id);
            const keys = new Set();
            for (const arr of Object.values(tables)) {
              const first = Array.isArray(arr) && arr[0] ? arr[0] : null;
              if (first) Object.keys(first).forEach(k => { if (k !== 'ts') keys.add(k); });
            }
            fields = Array.from(keys);
          }
        }
        byId[id] = { fields, profile };
        for (const f of (fields||[])) union.add(f);
      }
      return sendJson(res, 200, { count: ids.length, byId, union: Array.from(union).sort() });
    } catch (e) {
      return sendJson(res, 500, { error: 'devices_fields_failed', detail: String(e) });
    }
  }

  if (pathname === '/api/meta' && req.method === 'GET') {
    const room = query.room;
    if (!room) return sendJson(res, 400, { error: 'room required' });
    const start = query.start ? Number(query.start) : null;
    const end = query.end ? Number(query.end) : null;
    const role = String(query.role || '').trim();
    const s3Enabled = (process.env.AWS_S3_ENABLED || '0') === '1';
    let tables = {};
    if (s3Enabled) {
      const rows = await s3FetchDeviceCSV(String(room));
      const arr = Array.isArray(rows) ? rows.filter(r => r && r.ts != null).sort((a,b)=>(a.ts??0)-(b.ts??0)) : [];
      tables = { telemetry: arr };
    } else {
      tables = loadRoomTables(room);
    }
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
      let fields = Array.from(fieldSet);
      if (role) fields = fields.filter(f => roleAllowsField(role, f));
      info.fields = fields;
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
    const role = String(query.role || '').trim();
    const start = query.start ? Number(query.start) : null;
    const end = query.end ? Number(query.end) : null;
    if (!room || !field) return sendJson(res, 400, { error: 'room and field required' });
    // Role-based field restriction disabled
    const s3Enabled = (process.env.AWS_S3_ENABLED || '0') === '1';
    if (s3Enabled) {
      const rows = await s3FetchDeviceCSV(String(room));
      if (!Array.isArray(rows) || rows.length === 0) return sendJson(res, 404, { error: 'no_data' });
      // find field directly in telemetry
      const headers = Object.keys(rows[0] || {}).filter(k => k !== 'ts');
      let matched = headers.find(h => String(h).toLowerCase() === String(field).toLowerCase());
      if (!matched) matched = headers.find(h => String(h).toLowerCase().includes(String(field).toLowerCase()));
      if (!matched) return sendJson(res, 404, { error: 'field_not_found' });
      const data = [];
      for (const r of rows) {
        if (r?.ts == null || r?.[matched] == null) continue;
        if (!withinRange(r.ts, start, end)) continue;
        const y = Number(r[matched]);
        if (!Number.isFinite(y)) continue;
        data.push([Number(r.ts), y]);
      }
      return sendJson(res, 200, { room, table: 'telemetry', field: matched, count: data.length, data });
    } else {
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
      return sendJson(res, 200, { room, table: match.table, field: match.field, count: data.length, data });
    }
  }

  if (pathname === '/api/chat' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { messages = [], room, range, selection } = JSON.parse(body || '{}');
        const DEBUG_CHAT = (process.env.HTTP_DEBUG === '1') || (process.env.LOG_LEVEL === 'debug');
        if (DEBUG_CHAT) console.log('[API/chat] selection:', selection);
        // Compute effective scope/room from selection (building/floor/room)
        let effRoom = room || null;
        let scopeNote = '';
        let selectionRooms = [];
        try {
          if ((!effRoom || effRoom === 'ALL') && selection && (selection.building || selection.floor || selection.room || (Array.isArray(selection.rooms) && selection.rooms.length))) {
            const g = createGraphFromEnv(process.env);
            if (Array.isArray(selection.rooms) && selection.rooms.length) {
              selectionRooms = selection.rooms.filter(Boolean);
              effRoom = 'ALL';
              scopeNote = `Scope: rooms=[${selectionRooms.slice(0,30).join(', ')}${selectionRooms.length>30?' …':''}]`;
            } else 
            if (selection.room) {
              // Prefer mapping zone -> deviceIds via Neo4j devicesByScope when S3 is enabled
              let mapped = null;
              try {
                const s3 = await s3Ensure();
                if (s3 && g && g.devicesByScope) {
                  const { devices = [] } = await g.devicesByScope({ tenant: selection.tenant || null, building: selection.building || null, floor: selection.floor || null, zone: selection.room || null, type: null });
                  const ids = (devices || []).map(d => String(d.id||'')).filter(Boolean);
                  const available = new Set(await s3ListDeviceIds(5000));
                  const filtered = ids.filter(id => available.size ? available.has(id) : true);
                  if (filtered.length) {
                    selectionRooms = Array.from(new Set(filtered));
                    effRoom = 'ALL';
                    scopeNote = `Scope: room=${selection.room} devices=[${selectionRooms.slice(0,30).join(', ')}${selectionRooms.length>30?' …':''}]`;
                  }
                }
              } catch {}
              if (!selectionRooms.length) {
                // Legacy mapping: If room matches a CSV folder, use it; otherwise map via csv-map
                const known = new Set(listRooms());
                if (!known.has(selection.room)) {
                  try {
                    const map = await buildCsvMapping(g);
                    const zslug = String(selection.room).toLowerCase();
                    const k1 = `roomId:${selection.room}`;
                    mapped = map.byKey.get(k1) || null;
                    if (!mapped && selection.building && selection.floor) {
                      const k2 = `k:${selection.building}|${selection.floor}|${selection.room}`;
                      mapped = map.byKey.get(k2) || null;
                    }
                    if (!mapped) {
                      for (const it of map.items) {
                        const zsl = (it.zone ? it.zone.toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'') : '');
                        if (zsl === zslug && it.match) { mapped = it.match; break; }
                      }
                    }
                  } catch {}
                }
                effRoom = mapped || selection.room;
                scopeNote = `Scope: room=${selection.room}${mapped ? ` (csv=${mapped})` : ''}`;
              }
            } else if (g) {
              const csvRooms = await resolveCsvRoomsFromScope({ building: selection.building || null, floor: selection.floor || null, tenant: selection.tenant || null });
              if (csvRooms && csvRooms.length) {
                effRoom = 'ALL';
                scopeNote = `Scope: ${selection.tenant? 'tenant='+selection.tenant+' ' : ''}${selection.building ? 'building='+selection.building+' ' : ''}${selection.floor ? 'floor='+selection.floor+' ' : ''}rooms=[${csvRooms.slice(0,30).join(', ')}${csvRooms.length>30?' …':''}]`;
                selectionRooms = csvRooms;
              }
            }
          }
        } catch {}
        if (!effRoom) {
          // Allow broad queries without explicit room; tools can narrow via selection/tenant/role
          effRoom = 'ALL';
        }
        if (DEBUG_CHAT) console.log('[API/chat] effective room=', effRoom, 'note=', scopeNote, 'selectionRooms=', selectionRooms);

        // --- LOGGING ADDED HERE ---
        console.log('[API/chat] Received range:', range);
        if (range) {
          console.log('[API/chat] Start:', range.start, new Date(range.start).toISOString());
          console.log('[API/chat] End:', range.end, new Date(range.end).toISOString());
        }
        // --------------------------

        const userLast = [...messages].reverse().find(m => m.role === 'user' || m.role === 'User' || m.role === 'human');
        const question = userLast?.content || '';
        const role = '';
        const tablesRaw = effRoom && effRoom !== 'ALL' ? loadRoomTables(effRoom) : {};
        const tables = tablesRaw;
        const context = {
          instruction: 'You are a building analytics chat assistant. Answer succinctly. If plotting helps, include a JSON HighchartsOptions with yAxis as time and xAxis as chosen metric. Do not include code fences in the JSON.',
          tables: Object.keys(tables),
          sampleRows: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.slice(0, 5)])),
          range: range || {},
          knowledge: loadKnowledge(),
          // Auto-include building-specific weather context when a building is selected
          weatherSample: loadWeather(selection?.building || null).slice(-50),
          building: selection?.building || null
        };

        // Use the tool-enabled agent (RAG + tools). If it can't complete, fall back to heuristics.
        const effMessages = scopeNote ? [{ role: 'user', content: scopeNote }, ...messages, { role: 'user', content: question }] : messages.concat({ role: 'user', content: question });
        const { message, chart, trace, extras } = await agent.run(effMessages, { room: effRoom, range, selectionRooms, tenant: selection?.tenant || null, role: null });
        // If S3 is enabled, resolve any chart.dataRef locally using S3 to make datarefs work without local CSV mirror
        async function resolveChartDataRefsIfNeeded(chartObj) {
          try {
            const s3Enabled = (process.env.AWS_S3_ENABLED || '0') === '1';
            if (!s3Enabled) return chartObj;
            if (!chartObj || !Array.isArray(chartObj.series)) return chartObj;
            const rr = range || {};
            const start = rr.start || null;
            const end = rr.end || null;
            const out = { ...chartObj, series: (chartObj.series || []).map(s => ({ ...s })) };
            // If compare_series_cross_room is used, we may need to expand into multiple series
            const expandedSeries = [];
            for (const s of out.series) {
              const ref = s.dataRef;
              if (!ref) continue;
              // fetch_timeseries: one room, one field
              if (ref.tool === 'fetch_timeseries') {
                const yField = ref.yField || ref.field || s.name || '';
                // infer room: prefer explicit ref.room; else effRoom if not ALL; else first selectionRooms
                let roomForRef = ref.room || (effRoom && effRoom !== 'ALL' ? effRoom : (Array.isArray(selectionRooms) && selectionRooms[0] ? selectionRooms[0] : null));
                if (!roomForRef || !yField) { s.data = []; delete s.dataRef; continue; }
                const rows = await s3FetchDeviceCSV(String(roomForRef));
                const data = [];
                if (Array.isArray(rows) && rows.length) {
                  let matched = Object.keys(rows[0]).filter(k => k !== 'ts').find(h => String(h).toLowerCase() === String(yField).toLowerCase());
                  if (!matched) matched = Object.keys(rows[0]).filter(k => k !== 'ts').find(h => String(h).toLowerCase().includes(String(yField).toLowerCase()));
                  if (matched) {
                    for (const r of rows) {
                      if (r?.ts == null || r?.[matched] == null) continue;
                      if (start && r.ts < start) continue; if (end && r.ts > end) continue;
                      const y = Number(r[matched]); if (!Number.isFinite(y)) continue;
                      data.push([Number(r.ts), y]);
                    }
                  }
                }
                s.data = data; delete s.dataRef; continue;
              }
              // compare_series_cross_room: many rooms, one field
              if (ref.tool === 'compare_series_cross_room') {
                const field = ref.yField || ref.field || 'temperature';
                const roomsList = (Array.isArray(selectionRooms) && selectionRooms.length) ? selectionRooms.slice(0, 8) : (effRoom && effRoom !== 'ALL' ? [effRoom] : []);
                if (!roomsList.length) { s.data = []; delete s.dataRef; continue; }
                for (const rid of roomsList) {
                  const rows = await s3FetchDeviceCSV(String(rid));
                  const data = [];
                  if (Array.isArray(rows) && rows.length) {
                    let matched = Object.keys(rows[0]).filter(k => k !== 'ts').find(h => String(h).toLowerCase() === String(field).toLowerCase());
                    if (!matched) matched = Object.keys(rows[0]).filter(k => k !== 'ts').find(h => String(h).toLowerCase().includes(String(field).toLowerCase()));
                    if (matched) {
                      for (const r of rows) {
                        if (r?.ts == null || r?.[matched] == null) continue;
                        if (start && r.ts < start) continue; if (end && r.ts > end) continue;
                        const y = Number(r[matched]); if (!Number.isFinite(y)) continue;
                        data.push([Number(r.ts), y]);
                      }
                    }
                  }
                  expandedSeries.push({ name: `${rid} ${field}`, data });
                }
                continue;
              }
              // pair_timeseries: scatter points between two fields from same device
              if (ref.tool === 'pair_timeseries') {
                // Determine room/device
                let roomForRef = ref.room || (effRoom && effRoom !== 'ALL' ? effRoom : (Array.isArray(selectionRooms) && selectionRooms[0] ? selectionRooms[0] : null));
                if (!roomForRef) { s.data = []; delete s.dataRef; continue; }
                const f1 = ref.field1 || (s.name ? String(s.name).split(/\s+vs\s+|\s+and\s+/)[0] : null);
                const f2 = ref.field2 || (s.name ? String(s.name).split(/\s+vs\s+|\s+and\s+/)[1] : null);
                const rows = await s3FetchDeviceCSV(String(roomForRef));
                const data = [];
                if (Array.isArray(rows) && rows.length) {
                  // Find actual headers for both fields
                  const cols = Object.keys(rows[0] || {}).filter(k => k !== 'ts');
                  function matchCol(want) {
                    if (!want) return null;
                    let m = cols.find(h => String(h).toLowerCase() === String(want).toLowerCase());
                    if (!m) m = cols.find(h => String(h).toLowerCase().includes(String(want).toLowerCase()));
                    return m || null;
                  }
                  const c1 = matchCol(f1);
                  const c2 = matchCol(f2);
                  if (c1 && c2) {
                    for (const r of rows) {
                      if (start && r.ts < start) continue; if (end && r.ts > end) continue;
                      const x = Number(r[c1]); const y = Number(r[c2]);
                      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
                      data.push([x, y]);
                    }
                  }
                }
                s.data = data; delete s.dataRef; continue;
              }
            }
            // If we expanded compare_series into multiple series, replace series array
            if (expandedSeries.length) out.series = expandedSeries;
            return out;
          } catch { return chartObj; }
        }
        try {
          if (DEBUG_CHAT) {
            const tools = Array.isArray(trace) ? trace.map(t => t.tool).filter(Boolean) : [];
            console.log('[API/chat] tools used:', tools);
            if (Array.isArray(trace)) {
              for (const t of trace.slice(-6)) {
                console.log('[API/chat] trace:', JSON.stringify({ tool: t.tool, args: t.args, result_keys: t.result ? Object.keys(t.result).slice(0,8) : null }).slice(0, 1500));
              }
            }
          }
        } catch (e) { console.warn('[API/chat] debug trace print failed:', String(e)); }

        // If no CSV-mapped rooms but a selection exists, surface graph rooms for visibility
        let scopeExtras = [];
        try {
          if ((!Array.isArray(selectionRooms) || selectionRooms.length === 0) && (selection && (selection.building || selection.floor || selection.tenant))) {
            const g = createGraphFromEnv(process.env);
            if (g && g.roomsByScope) {
              const rs2 = await g.roomsByScope({ building: selection.building || null, floor: selection.floor || null, tenant: selection.tenant || null });
              const rooms2 = (rs2.rooms || []).filter(Boolean).slice(0, 50);
              if (rooms2.length) {
                scopeExtras.push({ message: { role: 'assistant', content: `Graph scope rooms (${rooms2.length}):\n- ${rooms2.join('\n- ')}` }, chart: null });
              }
            }
          }
        } catch {}

        if (!message || !message.content || /^Unable to complete tool-based reasoning/i.test(message.content)) {
          const fb = answerWithFallback(question, room, range || {});
          return sendJson(res, 200, { message: { role: 'assistant', content: fb.answer }, chart: fb.chart, mode: 'fallback', trace: [] });
        }
        const chartResolved = await resolveChartDataRefsIfNeeded(chart);
        return sendJson(res, 200, { message, chart: chartResolved, extras: (scopeExtras.length ? scopeExtras.concat(extras || []) : (extras || ((agent && agent.extras) ? agent.extras : undefined))), trace, mode: 'agent' });
      } catch (e) {
        console.error('[API/chat] error:', e?.stack || String(e));
        return sendJson(res, 500, { error: 'bad_request', detail: e?.stack || String(e) });
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

// Start server immediately; finish initialization in background for faster readiness
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
});

ensureDatastores()
  .then(() => {
    console.log('[startup] Datastores ready');
  })
  .catch((e) => {
    console.error('[startup] Initialization failed (continuing):', e);
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
