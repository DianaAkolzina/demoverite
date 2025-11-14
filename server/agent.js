import { buildDocsFromData, buildRagIndex } from './rag.js';
import { classifyQuery, suggestRetrievalFilters } from './router.js';
import { hybridRetrieve } from './retrieval.js';
import { evaluateQA } from './eval.js';
import fs from 'fs';
import path from 'path';

export function createAgent({ dataDir, listRooms, loadRoomTables: loadRoomTablesRaw, loadWeather, callGeminiChat, graph = null, vector = null, connectors = null, llmProviders = [] }) {
  const DEBUG = process.env.RAG_DEBUG === '1' || process.env.LOG_LEVEL === 'debug';
  const log = (...a) => { if (DEBUG) console.log('[Agent]', ...a); };
  
  const knowledgeDir = path.join(path.dirname(dataDir), 'knowledge');
  const csvDir = path.join(path.dirname(dataDir), 'CSVex_s3');

  function fingerprintSources() {
    const targets = [knowledgeDir, dataDir, csvDir];
    const bits = [];
    for (const target of targets) {
      try {
        if (!target) continue;
        const stat = fs.statSync(target);
        if (stat.isDirectory()) {
          const sample = fs.readdirSync(target, { withFileTypes: true }).slice(0, 32);
          bits.push(`${target}:dir:${stat.mtimeMs}:${stat.size}:${sample.length}`);
        } else {
          bits.push(`${target}:file:${stat.mtimeMs}:${stat.size}`);
        }
      } catch {
        bits.push(`${target || 'unknown'}:missing`);
      }
    }
    return bits.join('|');
  }

  function createRagManager() {
    let state = { docs: [], index: null, signature: null };
    const rebuild = (reason = 'manual') => {
      const rooms = listRooms();
      const docs = buildDocsFromData({ dataDir, rooms, loadRoomTables, knowledgeDir });
      const index = buildRagIndex(docs, { debug: DEBUG });
      state = { docs, index, signature: fingerprintSources() };
      log(`[RAG] rebuilt (${docs.length} docs) reason=${reason}`);
      return state;
    };
    const ensure = () => {
      const sig = fingerprintSources();
      if (!state.index || state.signature !== sig) return rebuild('auto');
      return state;
    };
    return {
      ensure,
      rebuild,
      stats: () => ({ docs: state.docs.length })
    };
  }

  const ragManager = createRagManager();

  const repoRoot = path.dirname(dataDir);
  const s3LocalDir = path.join(repoRoot, 'CSVex_s3');
  const CHART_COLORS = [
    '#1f78d1',
    '#12b76a',
    '#f48024',
    '#9b51e0',
    '#ff6b6b',
    '#0ea5e9',
    '#fde047',
    '#6b7280'
  ];
  const UI_LOCALE = process.env.UI_LOCALE || 'en-GB';
  const UI_TIMEZONE = process.env.UI_TIMEZONE || 'Europe/London';
  const dateTimeFormatter = new Intl.DateTimeFormat(UI_LOCALE, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: UI_TIMEZONE
  });

const DAY_MS = 24 * 60 * 60 * 1000;
const DAYPART_WINDOWS = [
  { id: '08-12', startHour: 8, endHour: 12 },
  { id: '12-16', startHour: 12, endHour: 16 },
  { id: '16-20', startHour: 16, endHour: 20 }
];
const ZONE_SYNONYM_STOPWORDS = [
  'iaq',
  'co2',
  'temperature',
  'temp',
  'humidity',
  'occupancy',
  'people',
  'count',
  'energy',
  'kwh',
  'sensor',
  'sensors',
  'data',
  'plot',
  'chart',
  'graph',
  'vs',
  'versus'
];
const ZONE_STOPWORD_REGEX = new RegExp(`\\b(?:${ZONE_SYNONYM_STOPWORDS.join('|')})\\b`, 'gi');
const PEOPLE_FALLBACK_FIELDS = ['line_periodic_data', 'line_total_data', 'people_count', 'count', 'value', 'dwell'];
const DEFAULT_TIME_ZONE = 'Europe/London';
  const tzFormatterCache = new Map();
  const getTimeZoneFormatter = (timeZone = DEFAULT_TIME_ZONE) => {
    const key = timeZone || DEFAULT_TIME_ZONE;
    if (!tzFormatterCache.has(key)) {
      tzFormatterCache.set(
        key,
        new Intl.DateTimeFormat('en-GB', {
          timeZone: key,
          hourCycle: 'h23',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        })
      );
    }
    return tzFormatterCache.get(key);
  };
  const getTimeZoneParts = (ts, timeZone = DEFAULT_TIME_ZONE) => {
    const formatter = getTimeZoneFormatter(timeZone);
    const parts = formatter.formatToParts(ts);
    const lookup = {};
    for (const { type, value } of parts) {
      lookup[type] = value;
    }
    const year = Number(lookup.year);
    const month = Number(lookup.month);
    const day = Number(lookup.day);
    const hour = Number(lookup.hour);
    const minute = Number(lookup.minute);
    const second = Number(lookup.second);
    const localUtc = Date.UTC(year, month - 1, day, hour, minute, second || 0, 0);
    const offset = localUtc - ts;
    return { year, month, day, hour, minute, second: second || 0, offset };
  };
  const alignTimestampToBucket = (ts, bucketMinutes = 5, timeZone = DEFAULT_TIME_ZONE) => {
    if (!Number.isFinite(ts)) return ts;
    const parts = getTimeZoneParts(ts, timeZone);
    const totalMinutes = parts.hour * 60 + parts.minute;
    const floored = Math.floor(totalMinutes / bucketMinutes) * bucketMinutes;
    const floorHour = Math.floor(floored / 60);
    const floorMinute = floored % 60;
    const localUtc = Date.UTC(parts.year, parts.month - 1, parts.day, floorHour, floorMinute, 0, 0);
    return localUtc - parts.offset;
  };
  const startOfDayLocal = (ts, timeZone = DEFAULT_TIME_ZONE) => {
    if (!Number.isFinite(ts)) return null;
    const parts = getTimeZoneParts(ts, timeZone);
    const localUtc = Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0, 0);
    return localUtc - parts.offset;
  };
  const percentileValue = (inputValues, percentile = 0.5) => {
    if (!Array.isArray(inputValues) || !inputValues.length) return null;
    const values = inputValues.filter((v) => Number.isFinite(v));
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    if (percentile <= 0) return sorted[0];
    if (percentile >= 1) return sorted[sorted.length - 1];
    const position = (sorted.length - 1) * percentile;
    const baseIndex = Math.floor(position);
    const fraction = position - baseIndex;
    if (baseIndex + 1 >= sorted.length) return sorted[baseIndex];
    return sorted[baseIndex] + (sorted[baseIndex + 1] - sorted[baseIndex]) * fraction;
  };
const medianValue = (values) => percentileValue(values, 0.5);
const coerceNumber = (value) => {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const coerceBooleanUsage = (value) => {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value > 0 ? 1 : 0;
  if (typeof value === 'string') {
    const norm = value.trim().toLowerCase();
    if (!norm) return 0;
    if (['1', 'true', 'yes', 'occupied', 'active'].includes(norm)) return 1;
    if (['0', 'false', 'no', 'inactive'].includes(norm)) return 0;
  }
  return value ? 1 : 0;
};
const pearson = (xs = [], ys = []) => {
  if (!Array.isArray(xs) || !Array.isArray(ys)) return { corr: null, n: 0 };
  const pairs = [];
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i];
    const y = ys[i];
    if (Number.isFinite(x) && Number.isFinite(y)) pairs.push({ x, y });
  }
  if (pairs.length < 2) return { corr: null, n: pairs.length };
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumYY = 0;
  let sumXY = 0;
  for (const { x, y } of pairs) {
    sumX += x;
    sumY += y;
    sumXX += x * x;
    sumYY += y * y;
    sumXY += x * y;
  }
  const n = pairs.length;
  const numerator = n * sumXY - sumX * sumY;
  const denom = Math.sqrt((n * sumXX - sumX * sumX) * (n * sumYY - sumY * sumY));
  return { corr: denom ? numerator / denom : null, n };
};
const extractFieldValue = (row, fieldOrList) => {
  if (!row) return null;
  if (!fieldOrList) return null;
  if (Array.isArray(fieldOrList)) {
    for (const f of fieldOrList) {
      const val = extractFieldValue(row, f);
      if (val != null) return val;
    }
    return null;
  }
  const raw = row[fieldOrList];
  return coerceNumber(raw);
};
  const computeBoxplot = (values) => {
    const sorted = (values || []).filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) {
      return { min: null, q1: null, median: null, q3: null, max: null, count: 0 };
    }
    return {
      min: sorted[0],
      q1: percentileValue(sorted, 0.25),
      median: percentileValue(sorted, 0.5),
      q3: percentileValue(sorted, 0.75),
      max: sorted[sorted.length - 1],
      count: sorted.length
    };
  };
  const linearRegression = (points) => {
    const valid = (points || []).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    const n = valid.length;
    if (n < 2) return { slope: null, intercept: null, r2: null, n: 0 };
    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumXX = 0;
    let sumYY = 0;
    for (const { x, y } of valid) {
      sumX += x;
      sumY += y;
      sumXY += x * y;
      sumXX += x * x;
      sumYY += y * y;
    }
    const denominator = n * sumXX - sumX * sumX;
    if (denominator === 0) return { slope: null, intercept: null, r2: null, n };
    const slope = (n * sumXY - sumX * sumY) / denominator;
    const intercept = (sumY - slope * sumX) / n;
    const numerator = (n * sumXY - sumX * sumY) ** 2;
    const denomR = (n * sumXX - sumX * sumX) * (n * sumYY - sumY * sumY);
    const r2 = denomR > 0 ? numerator / denomR : null;
    return { slope, intercept, r2: Number.isFinite(r2) ? r2 : null, n };
  };
  const startOfDayUtc = (ts) => {
    if (!Number.isFinite(ts)) return null;
    const date = new Date(ts);
    date.setUTCHours(0, 0, 0, 0);
    return date.getTime();
  };
  const resolveDaypart = (ts, timeZone = DEFAULT_TIME_ZONE, windows = DAYPART_WINDOWS) => {
    if (!Number.isFinite(ts)) return null;
    const parts = getTimeZoneParts(ts, timeZone);
    const hour = parts.hour;
    for (const window of windows || []) {
      if (hour >= window.startHour && hour < window.endHour) return window.id;
    }
    return null;
  };
  const normalizeId = (val) => String(val ?? '').trim();
  const normalizeName = (val) => String(val ?? '').trim().toLowerCase();
  const canonicalizeBuildingToken = (val) => {
    const normalized = normalizeName(val);
    return normalized.replace(/^building[\s:_-]*/, '');
  };
  const buildingMatchesSelection = (selection, candidate) => {
    if (!selection) return true;
    const normalizedSelection = normalizeName(selection);
    const strippedSelection = canonicalizeBuildingToken(selection);
    const values = [];
    const push = (val) => {
      const norm = normalizeName(val);
      if (!norm) return;
      values.push(norm, canonicalizeBuildingToken(val));
    };
    if (candidate && typeof candidate === 'object') {
      push(candidate.name);
      push(candidate.id);
    } else {
      push(candidate);
    }
    return values.some((val) => val === normalizedSelection || val === strippedSelection);
  };
  const floorMatchesSelection = (selection, candidate) => {
    if (!selection) return true;
    const normalizedSelection = normalizeName(selection);
    const strippedSelection = normalizedSelection.replace(/^floor[\s:_-]*/, '');
    const values = [];
    const push = (val) => {
      if (!val) return;
      const raw = String(val);
      const norm = normalizeName(raw);
      if (norm) values.push(norm);
      const stripped = norm.replace(/^floor[\s:_-]*/, '');
      if (stripped) values.push(stripped);
      const digits = raw.match(/\d+/);
      if (digits) values.push(digits[0]);
    };
    if (candidate && typeof candidate === 'object') {
      push(candidate.name);
      push(candidate.id);
    } else {
      push(candidate);
    }
    return values.some((val) => val === normalizedSelection || val === strippedSelection);
  };
  const zoneCompositeKey = (zoneId, buildingId, floorId, tenantId) => [
    normalizeName(zoneId),
    normalizeName(buildingId),
    normalizeName(floorId),
    normalizeName(tenantId)
  ].join('::');

  // Graph snapshot loader for sync graph-aware tools
  function loadGraphSnapshot() {
    try {
      const rootDir = path.join(path.dirname(dataDir));
      const p = path.join(rootDir, 'data', 'graph_snapshot.json');
      const raw = fs.readFileSync(p, 'utf8');
      return JSON.parse(raw);
    } catch { return null; }
  }

  function findSnapshotZone(label, { building, floor } = {}) {
    if (!snapshotIndex) return null;
    const raw = String(label || '').trim();
    if (!raw) return null;
    const key = raw.toLowerCase();
    const nameMatches = snapshotIndex.zoneByName?.get(key) || [];
    const roomMatches = snapshotIndex.zoneByRoomId?.get(key) || [];
    const combined = [...nameMatches, ...roomMatches];
    if (!combined.length && snapshotIndex.zoneById?.has(raw)) {
      combined.push(snapshotIndex.zoneById.get(raw));
    }
    if (!combined.length) return null;
    if (!building && !floor) return combined[0];
    const buildingKey = building ? String(building).trim().toLowerCase() : null;
    const floorKey = floor ? String(floor).trim().toLowerCase() : null;
    for (const info of combined) {
      if (!info) continue;
      const matchesBuilding = !buildingKey || (info.buildingName && info.buildingName.toLowerCase() === buildingKey);
      const matchesFloor = !floorKey || (info.floorName && info.floorName.toLowerCase() === floorKey);
      if (matchesBuilding && matchesFloor) return info;
    }
    return combined[0];
  }

  function findSnapshotFloor(label, { building } = {}) {
    if (!snapshotIndex || !label) return null;
    const key = String(label).trim().toLowerCase();
    if (!key) return null;
    const matches = snapshotIndex.floorByName?.get(key) || [];
    if (!matches.length && snapshotIndex.floorById?.has(label)) {
      matches.push(snapshotIndex.floorById.get(label));
    }
    if (!matches.length) return null;
    if (!building) return matches[0];
    const buildingKey = String(building).trim().toLowerCase();
    for (const info of matches) {
      if (!info) continue;
      if (info.buildingName && info.buildingName.toLowerCase() === buildingKey) return info;
    }
    return matches[0];
  }

  function findSnapshotBuilding(label) {
    if (!snapshotIndex || !label) return null;
    const key = String(label).trim().toLowerCase();
    if (!key) return null;
    const matches = snapshotIndex.buildingByName?.get(key) || [];
    if (!matches.length && snapshotIndex.buildingById?.has(label)) {
      matches.push(snapshotIndex.buildingById.get(label));
    }
    return matches.length ? matches[0] : null;
  }

  function findSnapshotDevice(deviceId) {
    if (!snapshotIndex || !deviceId) return null;
    const raw = String(deviceId).trim();
    if (!raw) return null;
    const direct = snapshotIndex.deviceMeta?.get(raw);
    if (direct) return direct;
    const canon = snapshotIndex.deviceMetaCanonical?.get(raw.toLowerCase());
    if (canon) return canon;
    return null;
  }

  function buildDeviceEntriesFromSnapshotZone(zoneInfo) {
    if (!zoneInfo || !snapshotIndex) return [];
    const out = [];
    const devices = Array.isArray(zoneInfo.devices) ? zoneInfo.devices : [];
    for (const cloudId of devices) {
      const meta = findSnapshotDevice(cloudId);
      if (!meta) continue;
      const zoneId = meta.zoneId || zoneInfo.id || null;
      const floorId = meta.floorId || zoneInfo.floorId || null;
      const buildingId = meta.buildingId || zoneInfo.buildingId || null;
      const tenantId = meta.tenantId || zoneInfo.tenantId || null;
      out.push({
        primaryId: meta.cloudId,
        cloudId: meta.cloudId,
        deviceId: meta.cloudId,
        numericId: meta.cloudId,
        name: meta.name || meta.cloudId,
        type: meta.type || null,
        zoneId,
        zoneName: meta.zoneName || zoneInfo.name || null,
        floorId,
        floorName: meta.floorName || zoneInfo.floorName || null,
        buildingId,
        buildingName: meta.buildingName || zoneInfo.buildingName || null,
        tenantId,
        zoneKey: zoneCompositeKey(zoneId, buildingId, floorId, tenantId),
        raw: meta.node || {}
      });
    }
    return out;
  }

  function metricsPreviewForDevice(deviceId, limit = 4) {
    const metrics = new Set();
    const csvMetrics = CSV_DEVICE_METRICS.get(deviceId);
    if (Array.isArray(csvMetrics)) {
      for (const m of csvMetrics) {
        if (m && typeof m === 'string') metrics.add(m);
      }
    }
    return Array.from(metrics).slice(0, limit);
  }

  function describeDeviceForScopeSummary(deviceId) {
    if (!deviceId) return null;
    const meta = snapshotIndex?.deviceMeta?.get(deviceId) || null;
    const metrics = metricsPreviewForDevice(deviceId).map(humanizeMetricName);
    const baseName = meta?.name || deviceId;
    const typeText = meta?.type ? ` (${meta.type})` : '';
    const locationBits = [];
    if (meta?.zoneName) locationBits.push(meta.zoneName);
    if (meta?.floorName) locationBits.push(meta.floorName);
    if (meta?.buildingName) locationBits.push(meta.buildingName);
    const locationText = locationBits.length ? ` — ${locationBits.join(' · ')}` : '';
    const metricsText = metrics.length ? metrics.join(', ') : 'unknown metrics';
    return `${baseName}${typeText} [${deviceId}]${locationText} metrics: ${metricsText}`;
  }

  function summarizeZoneRecordForScope(zoneRecord, { maxDevices = 4 } = {}) {
    if (!zoneRecord) return null;
    const deviceIds = Array.isArray(zoneRecord.devices) ? zoneRecord.devices.filter(Boolean) : [];
    const header = `Zone ${zoneRecord.name || zoneRecord.id} · Floor ${zoneRecord.floorName || 'n/a'} · Building ${zoneRecord.buildingName || 'n/a'}`;
    const deviceLines = [];
    for (const deviceId of deviceIds.slice(0, maxDevices)) {
      const summary = describeDeviceForScopeSummary(deviceId);
      if (summary) deviceLines.push(summary);
    }
    const extra = deviceIds.length > maxDevices ? ` (+${deviceIds.length - maxDevices} more)` : '';
    if (!deviceLines.length && !extra) return header;
    return `${header} — devices: ${deviceLines.join(' | ') || 'none'}${extra}.`;
  }

  function formatScopeHeaderLine(scopeLabels = {}, selectionFloors = [], selectionZones = []) {
    const parts = [];
    const tenant = scopeLabels?.tenant ? String(scopeLabels.tenant).trim() : '';
    const building = scopeLabels?.building ? String(scopeLabels.building).trim() : '';
    const roomLabel = scopeLabels?.room ? String(scopeLabels.room).trim() : '';
    const floorLabel = scopeLabels?.floor ? String(scopeLabels.floor).trim() : '';
    const scopeSegment = tenant && building ? `${tenant} › ${building}` : (building || tenant || '');
    if (scopeSegment) parts.push(scopeSegment);
    const floors = Array.from(new Set([floorLabel, ...selectionFloors].filter(Boolean)));
    if (floors.length) parts.push(`Floors: ${floors.slice(0, 4).join(', ')}${floors.length > 4 ? '…' : ''}`);
    const zones = Array.from(new Set([roomLabel, ...selectionZones].filter(Boolean)));
    if (zones.length) parts.push(`Zones: ${zones.slice(0, 4).join(', ')}${zones.length > 4 ? '…' : ''}`);
    return parts.length ? `Scope: ${parts.join(' · ')}` : '';
  }

  function applyScopeHeaderText(text, scopeHeaderLine) {
    if (!scopeHeaderLine) return text;
    const base = typeof text === 'string' ? text.trim() : '';
    if (!base) return scopeHeaderLine;
    const normalizedHeader = scopeHeaderLine.toLowerCase();
    if (base.toLowerCase().includes(normalizedHeader)) return text;
    return `${scopeHeaderLine}\n\n${base}`;
  }

  function buildScopeSnapshotContextSummary({
    selectionZones = [],
    selectionRooms = [],
    selectionFloors = [],
    scopeDeviceZones = {},
    scopeLabels = {},
    limit = 3
  } = {}) {
    if (!snapshotIndex) return '';
    const lines = [];
    const headerParts = [];
    if (scopeLabels?.tenant) headerParts.push(`tenant: ${scopeLabels.tenant}`);
    if (scopeLabels?.building) headerParts.push(`building: ${scopeLabels.building}`);
    const floorSet = new Set();
    (selectionFloors || []).forEach((f) => { if (f) floorSet.add(String(f)); });
    if (scopeLabels?.floor) floorSet.add(String(scopeLabels.floor));
    if (floorSet.size) headerParts.push(`floors: ${Array.from(floorSet).join(', ')}`);
    if (selectionZones?.length) {
      const zoneList = selectionZones.slice(0, 6).join(', ');
      headerParts.push(`zones: ${zoneList}${selectionZones.length > 6 ? '…' : ''}`);
    }
    const seenZones = new Set();
    const pushZone = (zoneRecord) => {
      if (!zoneRecord || !zoneRecord.id || seenZones.has(zoneRecord.id)) return;
      const summary = summarizeZoneRecordForScope(zoneRecord);
      if (summary) {
        lines.push(summary);
        seenZones.add(zoneRecord.id);
      }
    };
    (selectionZones || []).forEach((label) => pushZone(findSnapshotZone(label, scopeLabels)));
    if (scopeLabels?.room) pushZone(findSnapshotZone(scopeLabels.room, scopeLabels));
    if (scopeLabels?.zone) pushZone(findSnapshotZone(scopeLabels.zone, scopeLabels));
    if (!lines.length && scopeDeviceZones && typeof scopeDeviceZones === 'object') {
      const zoneNames = new Set(Object.values(scopeDeviceZones).filter(Boolean));
      zoneNames.forEach((name) => pushZone(findSnapshotZone(name, scopeLabels)));
    }
    if (!lines.length && Array.isArray(selectionRooms)) {
      for (const deviceId of selectionRooms) {
        const meta = snapshotIndex?.deviceMeta?.get(deviceId);
        if (meta?.zoneId) pushZone(snapshotIndex.zoneById?.get(meta.zoneId));
      }
    }
    const trimmedZones = lines.slice(0, limit);
    const deviceHighlights = [];
    if (Array.isArray(selectionRooms)) {
      const seenDevices = new Set();
      for (const deviceId of selectionRooms) {
        if (seenDevices.has(deviceId)) continue;
        const summary = describeDeviceForScopeSummary(deviceId);
        if (summary) {
          deviceHighlights.push(summary);
          seenDevices.add(deviceId);
          if (deviceHighlights.length >= limit) break;
        }
      }
    }
    const sections = [];
    if (headerParts.length) {
      sections.push(`Scope focus → ${headerParts.join(' · ')}`);
    }
    if (trimmedZones.length) {
      sections.push('Scope snapshot:');
      sections.push(...trimmedZones);
    }
    if (deviceHighlights.length) {
      sections.push(`Device highlights: ${deviceHighlights.join(' | ')}`);
    }
    const text = sections.join('\n').trim();
    if (!text) return '';
    return text.length > 1200 ? `${text.slice(0, 1200)}…` : text;
  }

  const graphHierarchy = loadGraphFormHierarchy();
  const snapshotIndex = buildSnapshotIndex();
  let currentScopeContext = {
    selectionRooms: [],
    selectionZones: [],
    selectionFloors: [],
    scopeDeviceZones: {},
    scopeLabels: {},
    range: null
  };

  function hydrateScopeDeviceZones(scope = {}) {
    const source = scope.scopeDeviceZones && typeof scope.scopeDeviceZones === 'object'
      ? { ...scope.scopeDeviceZones }
      : {};
    const rooms = Array.isArray(scope.selectionRooms) ? scope.selectionRooms : [];
    const looksGenericLabel = (value) => {
      if (value == null) return true;
      const str = String(value).trim();
      if (!str) return true;
      if (/^(unknown|default)$/i.test(str)) return true;
      if (/^\d+$/.test(str)) return true;
      if (/^zone\s*\d+$/i.test(str)) return true;
      return false;
    };
    for (const deviceId of rooms) {
      const key = String(deviceId || '').trim();
      if (!key || source[key]) continue;
      const meta = lookupDeviceHierarchy(deviceId);
      if (meta?.zoneName) {
        source[key] = meta.zoneName;
      } else if (meta?.name) {
        source[key] = meta.name;
      }
    }
    for (const [deviceId, label] of Object.entries(source)) {
      const needsHydration = looksGenericLabel(label);
      if (!needsHydration) continue;
      const meta = lookupDeviceHierarchy(deviceId);
      if (meta?.zoneName) {
        source[deviceId] = meta.zoneName;
      } else if (meta?.name) {
        source[deviceId] = meta.name;
      }
    }
    return source;
  }

  function resolveDeviceForZoneAlias(zoneName) {
    if (!zoneName) return null;
    const normalizedTarget = normalizeName(zoneName);
    const scopeMap = currentScopeContext.scopeDeviceZones || {};
    for (const [deviceId, zoneLabel] of Object.entries(scopeMap)) {
      if (!zoneLabel) continue;
      if (normalizeName(zoneLabel) === normalizedTarget) return deviceId;
    }
    const entries = collectDevicesForZone(zoneName, currentScopeContext.scopeLabels || {});
    if (entries && entries.length) {
      const candidate = entries.find((entry) => deviceTablesAvailable(entry.cloudId || entry.id)) || entries[0];
      return candidate?.cloudId || candidate?.id || null;
    }
    return null;
  }

  function rebuildDynamicScopeAliases(scope = currentScopeContext) {
    DYNAMIC_SCOPE_ALIASES.clear();
    const scopeMap = scope.scopeDeviceZones || {};
    for (const [deviceId, zoneName] of Object.entries(scopeMap)) {
      if (zoneName) registerDynamicAlias(zoneName, deviceId);
    }
    const rooms = Array.isArray(scope.selectionRooms) ? scope.selectionRooms : [];
    for (const deviceId of rooms) {
      const meta = lookupDeviceHierarchy(deviceId);
      if (!meta) continue;
      if (meta.name) registerDynamicAlias(meta.name, deviceId);
      if (meta.zoneName) registerDynamicAlias(meta.zoneName, deviceId);
      if (meta.zoneName && meta.floorName) registerDynamicAlias(`${meta.zoneName} (${meta.floorName})`, deviceId);
      if (meta.zoneName && meta.buildingName) registerDynamicAlias(`${meta.zoneName} (${meta.buildingName})`, deviceId);
      if (meta.cloudId) registerDynamicAlias(meta.cloudId, deviceId);
    }
    if (Array.isArray(scope.selectionZones)) {
      for (const zone of scope.selectionZones) {
        const deviceId = resolveDeviceForZoneAlias(zone);
        if (deviceId) registerDynamicAlias(zone, deviceId);
      }
    }
  }

  function setScopeContext(ctx = {}) {
    currentScopeContext = {
      selectionRooms: Array.isArray(ctx.selectionRooms) ? [...ctx.selectionRooms] : [],
      selectionZones: Array.isArray(ctx.selectionZones) ? [...ctx.selectionZones] : [],
      selectionFloors: Array.isArray(ctx.selectionFloors) ? [...ctx.selectionFloors] : [],
      scopeDeviceZones: hydrateScopeDeviceZones(ctx),
      scopeLabels: ctx.scopeLabels && typeof ctx.scopeLabels === 'object' ? { ...ctx.scopeLabels } : {},
      range: ctx.range && typeof ctx.range === 'object' ? { ...ctx.range } : null
    };
    rebuildDynamicScopeAliases(currentScopeContext);
  }

  function gatherCandidateDevices(room, { includeSelection = true } = {}) {
    const out = new Set();
    const raw = String(room ?? '').trim();
    const scopeMap = currentScopeContext.scopeDeviceZones || {};
    const normalizedRoom = normalizeName(raw);
    function pushIfValid(id) {
      if (!id) return;
      const val = String(id).trim();
      if (!val) return;
      if (val === 'ALL') return;
      if (!deviceTablesAvailable(val)) return;
      out.add(val);
    }
    if (!raw || raw === 'ALL') {
      if (includeSelection && Array.isArray(currentScopeContext.selectionRooms)) {
        currentScopeContext.selectionRooms.forEach(pushIfValid);
      }
      if (!out.size && snapshotIndex?.deviceMeta?.size) {
        snapshotIndex.deviceMeta.forEach((meta) => pushIfValid(meta?.cloudId));
      }
      return Array.from(out);
    }
    if (deviceTablesAvailable(raw)) pushIfValid(raw);
    const alias = friendlyLookup(raw);
    if (alias) pushIfValid(alias);
    for (const [deviceId, zoneName] of Object.entries(scopeMap)) {
      if (!zoneName) continue;
      if (normalizeName(zoneName) === normalizedRoom) pushIfValid(deviceId);
    }
    const snapZone = findSnapshotZone(raw, currentScopeContext.scopeLabels || {});
    if (snapZone) {
      const entries = buildDeviceEntriesFromSnapshotZone(snapZone);
      entries.forEach((entry) => pushIfValid(entry.cloudId));
    }
    return Array.from(out);
  }

  function scopedRoomIds(roomsInput, { limit = 48 } = {}) {
    const resolved = [];
    const seen = new Set();
    const addRoom = (value) => {
      if (!value) return;
      const trimmed = String(value).trim();
      if (!trimmed || trimmed === 'ALL' || trimmed === '*') return;
      const normalized = normalizeRoomId(trimmed);
      const candidate = deviceTablesAvailable(normalized) ? normalized : (deviceTablesAvailable(trimmed) ? trimmed : null);
      if (!candidate) return;
      const key = candidate.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      resolved.push(candidate);
    };
    const addFromZoneLabel = (label) => {
      if (!label) return;
      const devices = collectDevicesForZone(label, currentScopeContext.scopeLabels || {});
      for (const entry of devices) {
        addRoom(entry.cloudId || entry.primaryId || entry.id);
      }
    };
    if (Array.isArray(roomsInput)) {
      for (const entry of roomsInput) {
        if (!entry) continue;
        addRoom(entry);
        addFromZoneLabel(entry);
      }
    }
    if (!resolved.length && Array.isArray(currentScopeContext.selectionRooms)) {
      currentScopeContext.selectionRooms.forEach(addRoom);
    }
    if (!resolved.length && currentScopeContext.scopeDeviceZones) {
      Object.keys(currentScopeContext.scopeDeviceZones).forEach(addRoom);
    }
    if (!resolved.length) {
      try {
        listRooms().forEach(addRoom);
      } catch {}
    }
    return (limit && resolved.length > limit) ? resolved.slice(0, limit) : resolved;
  }

  function resolveDeviceForFields(room, preferredFields = [], candidates = []) {
    const list = candidates.length ? candidates : gatherCandidateDevices(room);
    if (!list.length) return room;
    const desired = (preferredFields || []).map((f) => String(f || '').trim()).filter(Boolean);
    if (!desired.length) return list[0];
    for (const deviceId of list) {
      try {
        const tablesSets = availableFieldsByTable(deviceId);
        const matches = desired.every((field) => {
          const resolved = inferFieldName(field, tablesSets);
          return !!resolved;
        });
        if (matches) return deviceId;
      } catch {}
    }
    return list[0];
  }

  function fieldsForTool(tool, args = {}) {
    const name = String(tool || '').toLowerCase();
    switch (name) {
      case 'pair_timeseries':
        return [args.field1, args.field2];
      case 'correlate':
      case 'correlate_weather_room':
        return [args.field1, args.field2];
      case 'fetch_timeseries':
        return Array.isArray(args.fields) ? args.fields : [];
      case 'hourly_timeseries':
      case 'daily_avg':
      case 'stats':
      case 'hour_of_day_stats':
      case 'histogram':
      case 'latest_value':
      case 'latest_per_room':
      case 'scope_daily_percentile':
      case 'compare_metrics_in_room':
        return [args.field];
      case 'compare_rooms_on_metric':
      case 'compare_series_cross_room':
        return [args.field || args.metric];
      default:
        return [];
    }
  }

  function prepareToolArgs(tool, args) {
    if (!args) return;
    const originalRoom = args.room;
    const candidates = gatherCandidateDevices(originalRoom || (args.devices && args.devices[0]) || null);
    if (!args.devices && candidates.length) args.devices = [...candidates];
    const desiredFields = fieldsForTool(tool, args);
    if (originalRoom && originalRoom !== 'ALL') {
      const resolved = resolveDeviceForFields(originalRoom, desiredFields, candidates);
      if (resolved) args.room = resolved;
    } else if ((!originalRoom || originalRoom === 'ALL') && candidates.length) {
      const resolved = resolveDeviceForFields(originalRoom, desiredFields, candidates);
      if (resolved) args.room = resolved;
    }
    if (!args.scopeRoomLabel && originalRoom && originalRoom !== args.room) {
      args.scopeRoomLabel = originalRoom;
    }

    const normalizeRoomRef = (value) => {
      if (!value || typeof value !== 'string') return value;
      return normalizeRoomId(value) || value;
    };

    const fieldSetCache = new Map();
    const getFieldSets = (roomId) => {
      const key = typeof roomId === 'string' ? roomId : (roomId && roomId.id) ? String(roomId.id) : roomId;
      const normalized = normalizeRoomId(key || args.room || originalRoom);
      if (!normalized) return null;
      if (fieldSetCache.has(normalized)) return fieldSetCache.get(normalized);
      let sets = null;
      try {
        sets = availableFieldsByTable(normalized);
      } catch {
        sets = null;
      }
      fieldSetCache.set(normalized, sets);
      return sets;
    };

    const normalizeFieldBinding = (value, roomId) => {
      if (!value || typeof value !== 'string') return value;
      const sets = getFieldSets(roomId);
      if (!sets) return value;
      return inferFieldName(value, sets) || value;
    };

    const roomKeys = ['room', 'room1', 'room2', 'room3', 'roomA', 'roomB', 'roomC', 'room_a', 'room_b', 'room_c'];
    for (const key of roomKeys) {
      if (typeof args[key] === 'string') {
        const resolved = normalizeRoomRef(args[key]);
        if (resolved) args[key] = resolved;
      }
    }
    if (Array.isArray(args.rooms)) {
      args.rooms = args.rooms.map((room) => (typeof room === 'string' ? normalizeRoomRef(room) : room)).filter(Boolean);
    }
    if (typeof args.field === 'string') {
      args.field = normalizeFieldBinding(args.field, args.room || originalRoom);
    }
    if (Array.isArray(args.fields)) {
      args.fields = args.fields.map((field) => (typeof field === 'string' ? normalizeFieldBinding(field, args.room || originalRoom) : field)).filter(Boolean);
    }
    const fieldKeys = ['field1', 'field2', 'metric', 'metric1', 'metric2'];
    for (const key of fieldKeys) {
      if (typeof args[key] === 'string') {
        args[key] = normalizeFieldBinding(args[key], args.room || originalRoom);
      }
    }
    if (Array.isArray(args.series)) {
      args.series = args.series.map((entry) => {
        if (!entry || typeof entry !== 'object') return entry;
        const clone = { ...entry };
        if (typeof clone.room === 'string') {
          const resolved = normalizeRoomRef(clone.room);
          if (resolved) clone.room = resolved;
        }
        if (typeof clone.field === 'string') {
          clone.field = normalizeFieldBinding(clone.field, clone.room || args.room || originalRoom);
        }
        for (const key of fieldKeys) {
          if (typeof clone[key] === 'string') {
            clone[key] = normalizeFieldBinding(clone[key], clone.room || args.room || originalRoom);
          }
        }
        if (!clone.name) {
          clone.name = friendlySeriesLabel(
            clone.room || args.room || originalRoom,
            clone.field || args.field || '',
            entry?.room || entry?.name || originalRoom
          );
        }
        return clone;
      });
    }
    if (Array.isArray(args.queries)) {
      args.queries = args.queries.map((query) => {
        if (!query || typeof query !== 'object') return query;
        const clone = { ...query };
        const requestedRoom = typeof clone.room === 'string'
          ? clone.room
          : (typeof clone.room_name === 'string' ? clone.room_name : null);
        if (requestedRoom) {
          const resolvedRoom = normalizeRoomRef(requestedRoom);
          if (resolvedRoom) {
            clone.room = resolvedRoom;
          }
        }
        if (!clone.field && clone.metric_name) clone.field = clone.metric_name;
        if (!clone.table && clone.field) {
          const guess = inferDefaultTableForMetric(clone.field);
          if (guess) clone.table = guess;
        }
        return clone;
      });
      if (!args.room && args.queries[0]?.room) args.room = args.queries[0].room;
      if (!args.table && args.queries[0]?.table) args.table = args.queries[0].table;
      if (!args.field && args.queries[0]?.field) args.field = args.queries[0].field;
    }
    if (!args.field && typeof args.metric === 'string') {
      const resolvedMetric = normalizeFieldBinding(args.metric, args.room || originalRoom) || args.metric;
      args.field = resolvedMetric;
    }
    if (!args.table && typeof args.field === 'string') {
      const guess = inferDefaultTableForMetric(args.field);
      if (guess) args.table = guess;
    }
  }

  function loadFriendlyToCloudMap() {
    const map = new Map();
    const knownDeviceIds = new Set();
    const csvDir = path.join(repoRoot, 'CSVex_s3');

    const registerAlias = (alias, deviceId) => {
      if (!alias || !deviceId) return;
      const raw = String(alias).trim();
      if (!raw) return;
      const lower = raw.toLowerCase();
      const slug = lower.replace(/[^a-z0-9]/g, '');
      for (const key of [raw, lower, slug]) {
        if (!key) continue;
        if (!map.has(key)) map.set(key, deviceId);
      }
    };

    const registerDeviceId = (deviceId) => {
      if (!deviceId) return;
      const trimmed = String(deviceId).trim();
      if (!trimmed) return;
      knownDeviceIds.add(trimmed);
      registerAlias(trimmed, trimmed);
    };

    const deviceFileExists = (deviceId) => {
      if (!deviceId) return false;
      try {
        return fs.existsSync(path.join(csvDir, `${deviceId}.csv`));
      } catch {
        return false;
      }
    };

    if (snapshotIndex) {
      snapshotIndex.deviceMeta?.forEach((meta) => {
        if (!meta) return;
        registerDeviceId(meta.cloudId);
        if (meta.node?.id) registerDeviceId(meta.node.id);
        if (meta.name) registerAlias(meta.name, meta.cloudId);
        const contextualAliases = new Set();
        if (meta.zoneName) contextualAliases.add(meta.zoneName);
        if (meta.zoneName && meta.floorName) contextualAliases.add(`${meta.zoneName} (${meta.floorName})`);
        if (meta.zoneName && meta.buildingName) contextualAliases.add(`${meta.zoneName} (${meta.buildingName})`);
        if (meta.zoneName && meta.floorName && meta.buildingName) {
          contextualAliases.add(`${meta.zoneName} (${meta.floorName}, ${meta.buildingName})`);
        }
        contextualAliases.forEach((alias) => registerAlias(alias, meta.cloudId));
      });

      snapshotIndex.zoneById?.forEach((zone) => {
        if (!zone || !Array.isArray(zone.devices) || !zone.devices.length) return;
        const preferredDevice = zone.devices.find((id) => id && String(id).trim()) || null;
        if (!preferredDevice) return;
        registerDeviceId(preferredDevice);
        registerAlias(zone.id, preferredDevice);
        if (zone.roomId != null) registerAlias(String(zone.roomId), preferredDevice);
        if (zone.name) registerAlias(zone.name, preferredDevice);
        if (zone.name && zone.floorName) registerAlias(`${zone.name} (${zone.floorName})`, preferredDevice);
        if (zone.name && zone.buildingName) registerAlias(`${zone.name} (${zone.buildingName})`, preferredDevice);
        if (zone.name && zone.floorName && zone.buildingName) {
          registerAlias(`${zone.name} (${zone.floorName}, ${zone.buildingName})`, preferredDevice);
        }
      });
    }

    try {
      if (fs.existsSync(csvDir)) {
        const files = fs.readdirSync(csvDir).filter((f) => f.toLowerCase().endsWith('.csv'));
        for (const file of files) {
          const deviceId = file.replace(/\.csv$/i, '');
          registerDeviceId(deviceId);
        }
      }
    } catch (err) {
      if (DEBUG) log('failed to scan CSV directory for aliases:', String(err));
    }

    try {
      const aliasPath = path.join(repoRoot, 'data', 'device_aliases.json');
      if (fs.existsSync(aliasPath)) {
        const raw = JSON.parse(fs.readFileSync(aliasPath, 'utf8'));
        if (raw && typeof raw === 'object') {
          for (const [alias, values] of Object.entries(raw)) {
            if (!alias) continue;
            const list = Array.isArray(values) ? values : [values];
            const primary = list.find((v) => v && String(v).trim().length);
            if (!primary) continue;
            if (!knownDeviceIds.has(primary) && !deviceFileExists(primary)) continue;
            registerAlias(alias, primary);
            registerAlias(alias.toLowerCase(), primary);
            for (const extra of list) {
              if (!extra) continue;
              const key = String(extra).trim();
              if (!key) continue;
              if (!knownDeviceIds.has(key) && !deviceFileExists(key)) continue;
              registerAlias(key, primary);
            }
          }
        }
      }
    } catch (err) {
      if (DEBUG) log('failed to load device aliases:', String(err));
    }

    try {
      const knowledgeDir = path.join(repoRoot, 'knowledge');
      if (fs.existsSync(knowledgeDir)) {
        const scopeFiles = fs.readdirSync(knowledgeDir).filter((f) => f.endsWith('_scope.md'));
        for (const file of scopeFiles) {
          const full = path.join(knowledgeDir, file);
          let text;
          try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
          if (!text) continue;
          const lines = text.split(/\r?\n/);
          let buildingName = null;
          const titleMatch = text.match(/^#\s+([^\n]+)$/m);
          if (titleMatch) {
            buildingName = titleMatch[1]
              .replace(/Building Scope.*$/i, '')
              .replace(/\(.*?\)/g, '')
              .trim();
          }
          let currentFloor = null;
          for (const line of lines) {
            const headerMatch = line.match(/^\|\s*Zone\s*\(([^)]+)\)\s*\|/i);
            if (headerMatch) {
              currentFloor = headerMatch[1].trim();
              continue;
            }
            if (!line.startsWith('|') || /^|[-\s]+|$/i.test(line)) continue;
            const cellMatch = line.match(/^\|\s*([^|]+?)\s*\|\s*`([^`]+)`/);
            if (!cellMatch) continue;
            const zoneLabel = cellMatch[1].trim();
            const deviceId = cellMatch[2].trim();
            if (!deviceId) continue;
            if (!knownDeviceIds.has(deviceId) && !deviceFileExists(deviceId)) continue;
            const aliases = new Set([zoneLabel, deviceId]);
            if (currentFloor) aliases.add(`${zoneLabel} (${currentFloor})`);
            if (buildingName) aliases.add(`${zoneLabel} (${buildingName})`);
            if (currentFloor && buildingName) aliases.add(`${zoneLabel} (${currentFloor}, ${buildingName})`);
            for (const alias of aliases) registerAlias(alias, deviceId);
          }
        }
      }
    } catch (err) {
      if (DEBUG) log('failed to parse scope knowledge for aliases:', String(err));
    }

    return map;
  }

  function buildCsvMetadata() {
    const stats = new Map();
    const metrics = new Map();
    try {
      if (!fs.existsSync(s3LocalDir)) return { stats, metrics };
      const files = fs.readdirSync(s3LocalDir).filter((f) => f.toLowerCase().endsWith('.csv'));
      for (const file of files) {
        const deviceId = file.replace(/\.csv$/i, '');
        const full = path.join(s3LocalDir, file);
        let headerLine = '';
        try {
          const fd = fs.openSync(full, 'r');
          const buf = Buffer.alloc(4096);
          const len = fs.readSync(fd, buf, 0, buf.length, 0);
          fs.closeSync(fd);
          headerLine = buf.toString('utf8', 0, len).split(/\r?\n/)[0] || '';
        } catch {
          headerLine = '';
        }
        if (headerLine) {
          const cols = headerLine.split(',').map((c) => c.trim()).filter((c) => c && c !== 'ts');
          metrics.set(deviceId, cols);
        } else {
          metrics.set(deviceId, []);
        }
        if (!stats.has(deviceId)) stats.set(deviceId, null);
      }
    } catch (err) {
      if (DEBUG) log('buildCsvMetadata failed', String(err));
    }
    return { stats, metrics };
  }

  const FRIENDLY_TO_CLOUD = loadFriendlyToCloudMap();
  const DYNAMIC_SCOPE_ALIASES = new Map();
  const MAX_DYNAMIC_ALIASES = 512;

  const aliasKeyVariants = (value) => {
    const raw = String(value ?? '').trim();
    if (!raw) return [];
    const lower = raw.toLowerCase();
    const slug = lower.replace(/[^a-z0-9]/g, '');
    return Array.from(new Set([raw, lower, slug].filter(Boolean)));
  };

  function registerDynamicAlias(alias, deviceId) {
    if (!alias || !deviceId) return;
    for (const key of aliasKeyVariants(alias)) {
      if (!key) continue;
      DYNAMIC_SCOPE_ALIASES.set(key, deviceId);
    }
    if (DYNAMIC_SCOPE_ALIASES.size > MAX_DYNAMIC_ALIASES) {
      const excess = DYNAMIC_SCOPE_ALIASES.size - MAX_DYNAMIC_ALIASES;
      const keys = Array.from(DYNAMIC_SCOPE_ALIASES.keys());
      for (let i = 0; i < excess; i += 1) {
        const key = keys[i];
        if (key) DYNAMIC_SCOPE_ALIASES.delete(key);
      }
    }
  }

  function lookupDynamicAlias(label) {
    for (const key of aliasKeyVariants(label)) {
      if (DYNAMIC_SCOPE_ALIASES.has(key)) return DYNAMIC_SCOPE_ALIASES.get(key);
    }
    return null;
  }
  const { stats: CSV_DEVICE_STATS, metrics: CSV_DEVICE_METRICS } = buildCsvMetadata();
  const CSV_STATS_CACHE = CSV_DEVICE_STATS;
  const friendlyLookup = (label) => {
    if (!label) return null;
    const raw = String(label).trim();
    if (!raw) return null;
    const lower = raw.toLowerCase();
    const slug = lower.replace(/[^a-z0-9]/g, '');
    const dynamic = lookupDynamicAlias(raw) || lookupDynamicAlias(lower) || lookupDynamicAlias(slug);
    if (dynamic) return dynamic;
    return FRIENDLY_TO_CLOUD.get(raw)
      || FRIENDLY_TO_CLOUD.get(lower)
      || FRIENDLY_TO_CLOUD.get(slug)
      || null;
  };

  function inferBuildingFromContext(room = null) {
    const labels = currentScopeContext.scopeLabels || {};
    if (labels.building && String(labels.building).trim()) return labels.building;
    if (room) {
      const meta = lookupDeviceHierarchy(room);
      if (meta?.buildingName) return meta.buildingName;
    }
    if (Array.isArray(currentScopeContext.selectionRooms)) {
      for (const deviceId of currentScopeContext.selectionRooms) {
        const meta = lookupDeviceHierarchy(deviceId);
        if (meta?.buildingName) return meta.buildingName;
      }
    }
    return null;
  }

  function loadWeatherScoped(room = null, opts = {}) {
    const buildingName = inferBuildingFromContext(room);
    const rangeOverride = opts.range || currentScopeContext.range || null;
    return loadWeather(buildingName, { range: rangeOverride });
  }

  function loadWeatherFor(room = null, building = null, opts = {}) {
    const rangeOverride = opts.range || currentScopeContext.range || null;
    if (building && String(building).trim()) {
      return loadWeather(String(building).trim(), { range: rangeOverride });
    }
    return loadWeatherScoped(room, { range: rangeOverride });
  }

  function sanitizeAnswerText(text) {
    if (!text) return '';
    let out = String(text).trim();
    if (!out) return '';
    out = out.replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, ' ').trim();
    if (!out) return '';
    const lower = out.toLowerCase();
    const looksJson = (lower.startsWith('{') && lower.endsWith('}')) || (lower.startsWith('[') && lower.endsWith(']'));
    if (looksJson) return '';
    if (lower.includes('"action":') || lower.includes('"chart":') || lower.includes('"tool":')) return '';
    return out;
  }

  const assistantMessage = (content) => ({ role: 'assistant', content: sanitizeAnswerText(content) || 'Unable to produce an answer with the available data.' });
  const CSV_HAS_METRICS_CACHE = new Map();

  function csvHasMetricColumns(deviceId) {
    const id = String(deviceId || '').trim();
    if (!id) return false;
    if (CSV_HAS_METRICS_CACHE.has(id)) return CSV_HAS_METRICS_CACHE.get(id);

    const cachedMetrics = CSV_DEVICE_METRICS.get(id);
    let hasMetrics = Array.isArray(cachedMetrics) && cachedMetrics.some((col) => col && col !== 'ts');

    if (!hasMetrics) {
      const filePath = path.join(s3LocalDir, `${id}.csv`);
      if (fs.existsSync(filePath)) {
        try {
          const text = fs.readFileSync(filePath, 'utf8');
          const lines = text.split(/\r?\n/).filter(Boolean);
          if (lines.length >= 2) {
            const headers = lines[0].split(',');
            const tracked = headers
              .map((h, idx) => ({ name: (h || '').trim(), index: idx }))
              .filter(({ name }) => name && name !== 'ts');
            if (tracked.length) {
              for (let i = 1; i < lines.length && !hasMetrics; i += 1) {
                const parts = lines[i].split(',');
                for (const entry of tracked) {
                  const raw = parts[entry.index] != null ? parts[entry.index].trim() : '';
                  if (raw && raw !== '[]' && raw !== '{}') {
                    hasMetrics = true;
                    break;
                  }
                }
              }
            }
          }
        } catch (err) {
          if (DEBUG) log('csvHasMetricColumns failed', id, String(err));
        }
      }
    }

    CSV_HAS_METRICS_CACHE.set(id, hasMetrics);
    return hasMetrics;
  }

  const normalizeDeviceKey = (value, removePunctuation = false) => {
    const key = String(value ?? '').trim().toLowerCase();
    return removePunctuation ? key.replace(/[^a-z0-9]/g, '') : key;
  };

  function lookupDeviceHierarchy(deviceId) {
    if (!deviceId) return null;
    const raw = String(deviceId).trim();
    if (!raw) return null;

    const candidateIds = [];
    const seen = new Set();
    const pushCandidate = (val) => {
      if (!val) return;
      const str = String(val).trim();
      if (!str || seen.has(str)) return;
      seen.add(str);
      candidateIds.push(str);
    };

    pushCandidate(raw);
    const direct = friendlyLookup(raw);
    if (direct) pushCandidate(direct);
    const lower = raw.toLowerCase();
    if (snapshotIndex) {
      const snapDirect = findSnapshotDevice(raw);
      if (snapDirect) {
        pushCandidate(snapDirect.cloudId);
      } else if (snapshotIndex.deviceMeta) {
        for (const meta of snapshotIndex.deviceMeta.values()) {
          if (!meta || !meta.name) continue;
          if (meta.name.toLowerCase() === lower) {
            pushCandidate(meta.cloudId);
            break;
          }
        }
      }
    }

    let info = null;
    if (graphHierarchy) {
      for (const id of candidateIds) {
        const keyA = normalizeDeviceKey(id, false);
        const keyB = normalizeDeviceKey(id, true);
        const match = graphHierarchy.deviceByKey.get(keyA) || graphHierarchy.deviceByKey.get(keyB);
        if (match) {
          info = { ...match };
          if (!info.name && match.raw?.name) info.name = match.raw.name;
          if (snapshotIndex) {
            const snapMeta = findSnapshotDevice(match.cloudId || match.primaryId || id);
            if (snapMeta) {
              info.zoneName = snapMeta.zoneName || info.zoneName || null;
              info.floorName = snapMeta.floorName || info.floorName || null;
              info.buildingName = snapMeta.buildingName || info.buildingName || null;
              info.zoneId = snapMeta.zoneId || info.zoneId || null;
              info.floorId = snapMeta.floorId || info.floorId || null;
              info.buildingId = snapMeta.buildingId || info.buildingId || null;
              if (!info.primaryId) info.primaryId = snapMeta.cloudId;
              if (!info.cloudId) info.cloudId = snapMeta.cloudId;
              if (!info.deviceId) info.deviceId = snapMeta.cloudId;
              if (!info.numericId) info.numericId = snapMeta.cloudId;
            }
          }
          break;
        }
      }
    }

    if (!info && snapshotIndex) {
      for (const id of candidateIds) {
        const meta = findSnapshotDevice(id);
        if (meta) {
          info = {
            primaryId: meta.cloudId,
            cloudId: meta.cloudId,
            deviceId: meta.cloudId,
            numericId: meta.cloudId,
            name: meta.name || meta.cloudId,
            type: meta.type || null,
            zoneName: meta.zoneName || null,
            floorName: meta.floorName || null,
            buildingName: meta.buildingName || null,
            zoneId: meta.zoneId || null,
            floorId: meta.floorId || null,
            buildingId: meta.buildingId || null,
            raw: meta.node || null
          };
          break;
        }
      }
    }

    if (!info) {
      const fallbackCloud = candidateIds.find((id) => CSV_DEVICE_STATS.has(id)) || candidateIds[1] || candidateIds[0];
      if (!fallbackCloud) return null;
      info = {
        primaryId: fallbackCloud,
        cloudId: fallbackCloud,
        deviceId: fallbackCloud,
        numericId: fallbackCloud,
        name: candidateIds[0] || fallbackCloud,
        type: null,
        zoneName: null,
        floorName: null,
        buildingName: null,
        zoneId: null,
        floorId: null,
        buildingId: null
      };
    } else {
      const fallbackCloud = info.cloudId
        || candidateIds.find((id) => CSV_DEVICE_STATS.has(id))
        || candidateIds.find((id) => id !== raw)
        || candidateIds[0];
      if (fallbackCloud) {
        info.primaryId = info.primaryId || fallbackCloud;
        info.cloudId = info.cloudId || fallbackCloud;
        info.deviceId = info.deviceId || fallbackCloud;
        info.numericId = info.numericId || fallbackCloud;
      }
      if (!info.name) info.name = candidateIds[0] || info.cloudId;
    }

    return info;
  }

  function deviceFriendlyName(deviceId) {
    const entry = lookupDeviceHierarchy(deviceId);
    if (!entry) return String(deviceId || 'unknown device');
    const name = entry.name || entry.cloudId || entry.deviceId || entry.numericId || deviceId;
    if (entry.zoneName && entry.buildingName) {
      return `${entry.zoneName} — ${name}`;
    }
    if (entry.zoneName) return `${entry.zoneName} — ${name}`;
    if (entry.buildingName) return `${entry.buildingName} — ${name}`;
    return name;
  }

  function friendlySeriesLabel(deviceId, field = '', fallback = null) {
    const base = deviceFriendlyName(deviceId);
    const metric = field ? humanizeMetricName(field) : '';
    if (metric && base) return `${base} (${metric})`;
    if (base) return base;
    if (metric) return metric;
    return fallback || deviceId || 'unknown';
  }

  function normalizeFieldName(field) {
    return String(field || '').trim().toLowerCase();
  }

  function inferDefaultTableForMetric(metric) {
    if (!metric) return null;
    const key = normalizeFieldName(metric);
    if (!key) return null;
    if (['co2', 'concentration', 'temperature', 'temp', 'humidity', 'lux', 'virusrisk', 'airchangerate', 'air_exchange_rate'].includes(key)) {
      return 'iaq';
    }
    if (['people_count', 'occupants', 'occupancy', 'people'].includes(key)) {
      return 'people';
    }
    if (['total_kwh', 'value', 'energy', 'kw', 'kwh'].includes(key)) {
      return 'energy';
    }
    return null;
  }

  function detectUnavailableMetricResponse(question, selectionRooms, fallbackRoom) {
    const q = String(question || '').toLowerCase();
    if (!q) return null;
    const requested = [];
    if (/\bpit\b/.test(q)) requested.push('pit');
    if (q.includes('pir') || q.includes('passive infrared')) requested.push('pir');
    if (!requested.length) return null;
    const available = aggregateAvailableFields(selectionRooms, fallbackRoom);
    const missing = requested.filter((metric) => !available.has(metric));
    if (!missing.length) return null;
    const label = friendlySeriesLocation(selectionRooms?.[0] || fallbackRoom, selectionRooms?.[0] || fallbackRoom) || 'the selected scope';
    const availableList = available.size
      ? Array.from(available).slice(0, 12).map(humanizeMetricName).join(', ')
      : 'no instrumented metrics';
    const metricList = missing.map((m) => humanizeMetricName(m)).join(', ');
    const content = `${metricList} is not logged for ${label}. Available metrics are: ${availableList}. PIR/PIT sensors behave like binary motion flags (1 = motion detected, 0 = idle); use people_count or occupancy feeds if you need utilization charts.`;
    return { message: assistantMessage(content), chart: null, trace: [] };
  }

  function aggregateAvailableFields(selectionRooms = [], fallbackRoom = null) {
    const cacheKey = JSON.stringify({ rooms: selectionRooms, fallback: fallbackRoom });
    if (!aggregateAvailableFields._cache) aggregateAvailableFields._cache = new Map();
    if (aggregateAvailableFields._cache.has(cacheKey)) return aggregateAvailableFields._cache.get(cacheKey);
    const available = new Set();
    const pushFields = (roomId) => {
      if (!roomId) return;
      fieldsForRoom(roomId).forEach((f) => {
        const key = normalizeFieldName(f);
        if (key && key !== 'ts') available.add(key);
      });
    };
    (selectionRooms || []).forEach(pushFields);
    if (!available.size && fallbackRoom && !isAllRooms(fallbackRoom)) pushFields(fallbackRoom);
    aggregateAvailableFields._cache.set(cacheKey, available);
    return available;
  }

  function resolveZoneEntry(label, { building, floor } = {}) {
    if (!label) return null;
    const raw = String(label).trim();
    if (!raw) return null;
    const buildingNameNorm = building ? normalizeName(building) : null;
    const floorNameNorm = floor ? normalizeName(floor) : null;
    const buildingIdNorm = building ? normalizeId(building) : null;
    const floorIdNorm = floor ? normalizeId(floor) : null;
    let entry = null;
    if (graphHierarchy) {
      const selectZoneCandidate = (candidates) => {
        if (!Array.isArray(candidates) || !candidates.length) return null;
        let filtered = candidates.filter(Boolean);
        if (!filtered.length) return null;
        if (buildingNameNorm || buildingIdNorm) {
          const byBuilding = filtered.filter((candidate) => {
            const candBuildingId = normalizeId(candidate.buildingId);
            const candBuildingName = candidate.buildingName ? normalizeName(candidate.buildingName) : null;
            return (buildingIdNorm && candBuildingId && candBuildingId === buildingIdNorm)
              || (buildingNameNorm && candBuildingName && candBuildingName === buildingNameNorm);
          });
          if (byBuilding.length) filtered = byBuilding;
        }
        if (floorNameNorm || floorIdNorm) {
          const byFloor = filtered.filter((candidate) => {
            const candFloorId = normalizeId(candidate.floorId);
            const candFloorName = candidate.floorName ? normalizeName(candidate.floorName) : null;
            return (floorIdNorm && candFloorId && candFloorId === floorIdNorm)
              || (floorNameNorm && candFloorName && candFloorName === floorNameNorm);
          });
          if (byFloor.length) filtered = byFloor;
        }
        return filtered[0] || candidates[0];
      };

      const byId = graphHierarchy.zoneById.get(raw);
      if (byId) entry = selectZoneCandidate([byId]) || byId;
      if (!entry && graphHierarchy.zoneIndexById) {
        const byList = graphHierarchy.zoneIndexById.get(raw);
        const match = selectZoneCandidate(byList);
        if (match) entry = match;
      }
      if (!entry) {
        const lower = raw.toLowerCase();
        const keys = new Set();
        const buildingNorm = buildingNameNorm || '';
        const floorNorm = floorNameNorm || '';
        if (buildingNorm || floorNorm) keys.add(`${buildingNorm}::${floorNorm}::${lower}`);
        if (buildingNorm) keys.add(`${buildingNorm}::${lower}`);
        if (buildingIdNorm || floorIdNorm) keys.add(`${buildingIdNorm}::${floorIdNorm}::${lower}`);
        if (buildingIdNorm) keys.add(`${buildingIdNorm}::${lower}`);
        keys.add(lower);
        for (const key of keys) {
          if (!key) continue;
          const list = graphHierarchy.zoneNameIndex.get(key);
          if (list && list.length) {
            const match = selectZoneCandidate(list);
            if (match) { entry = match; break; }
          }
        }
      }
      if (!entry) {
        const lowercase = raw.toLowerCase();
        const candidates = [];
        if (graphHierarchy.zoneNameIndex) {
          for (const [, list] of graphHierarchy.zoneNameIndex.entries()) {
            for (const candidate of list) {
              if (!candidate || !candidate.name) continue;
              if (candidate.name.toLowerCase() === lowercase) candidates.push(candidate);
            }
          }
        }
        if (!candidates.length) {
          for (const candidate of graphHierarchy.zoneById.values()) {
            if (!candidate || !candidate.name) continue;
            if (candidate.name.toLowerCase() === lowercase) candidates.push(candidate);
          }
        }
        if (candidates.length) entry = selectZoneCandidate(candidates);
      }
      if (entry) {
        if (!entry.zoneKey) entry.zoneKey = zoneCompositeKey(entry.id, entry.buildingId, entry.floorId, entry.tenantId);
        entry.__source = 'graph';
        if (snapshotIndex) {
          const snapZone = findSnapshotZone(entry.name || raw, { building, floor });
          if (snapZone) entry.__snapshot = snapZone;
        }
        return entry;
      }
    }
    if (snapshotIndex) {
      const snapZone = findSnapshotZone(raw, { building, floor });
      if (snapZone) {
        return {
          id: snapZone.id,
          name: snapZone.name || raw,
          zone: snapZone.name || raw,
          floorId: snapZone.floorId || null,
          floorName: snapZone.floorName || null,
          buildingId: snapZone.buildingId || null,
          buildingName: snapZone.buildingName || null,
          tenantId: snapZone.tenantId || null,
          zoneKey: zoneCompositeKey(snapZone.id, snapZone.buildingId, snapZone.floorId, snapZone.tenantId),
          __source: 'snapshot',
          __snapshot: snapZone
        };
      }
    }
    return null;
  }

  function collectDevicesForZone(zoneLabel, context = {}) {
    const zoneEntry = resolveZoneEntry(zoneLabel, context);
    if (!zoneEntry) return [];
    const results = [];
    const seen = new Set();
    const zoneLabelResolved = zoneEntry.name || zoneEntry.zone || zoneLabel || null;
    const addDevice = (entry) => {
      if (!entry) return;
      const cloudId = entry.cloudId || entry.primaryId || entry.id;
      if (!cloudId || seen.has(cloudId)) return;
      if (!deviceTablesAvailable(cloudId)) return;
      seen.add(cloudId);
      results.push({
        id: cloudId,
        cloudId,
        primaryId: cloudId,
        name: entry.name || entry.friendlyName || entry.id || cloudId,
        zone: entry.zoneName || entry.zone || zoneLabelResolved,
        floor: entry.floorName || entry.floor || zoneEntry.floorName || context.floor || null,
        building: entry.buildingName || entry.building || zoneEntry.buildingName || context.building || null,
        type: entry.type || entry.deviceType || null
      });
    };

    if (graphHierarchy && zoneEntry) {
      const candidateKeys = [];
      const fullKey = zoneEntry.zoneKey || zoneCompositeKey(zoneEntry.id, zoneEntry.buildingId, zoneEntry.floorId, zoneEntry.tenantId);
      if (fullKey) candidateKeys.push(fullKey);
      if (zoneEntry.id) candidateKeys.push(zoneEntry.id);
      for (const key of candidateKeys) {
        const list = graphHierarchy.zoneDevices.get(key);
        if (!Array.isArray(list)) continue;
        for (const entry of list) {
          if (zoneEntry.tenantId && entry.tenantId && entry.tenantId !== zoneEntry.tenantId) continue;
          if (zoneEntry.buildingId && entry.buildingId && entry.buildingId !== zoneEntry.buildingId) continue;
          if (zoneEntry.floorId && entry.floorId && entry.floorId !== zoneEntry.floorId) continue;
          addDevice(entry);
        }
      }
    }

    const includeSnapshotDevices = (snapZone) => {
      const snapDevices = buildDeviceEntriesFromSnapshotZone(snapZone);
      snapDevices.forEach(addDevice);
    };
    if (zoneEntry.__snapshot) includeSnapshotDevices(zoneEntry.__snapshot);
    else if (snapshotIndex) {
      const snapZone = findSnapshotZone(zoneEntry.name || zoneLabel, context);
      if (snapZone) includeSnapshotDevices(snapZone);
    }

    if (!results.length) {
      const aliasLabels = new Set();
      if (zoneLabelResolved) aliasLabels.add(zoneLabelResolved);
      if (zoneLabel) aliasLabels.add(zoneLabel);
      if (context?.floor && zoneLabelResolved) aliasLabels.add(`${zoneLabelResolved} (${context.floor})`);
      if (context?.building && zoneLabelResolved) aliasLabels.add(`${zoneLabelResolved} (${context.building})`);
      if (context?.floor && context?.building && zoneLabelResolved) {
        aliasLabels.add(`${zoneLabelResolved} (${context.floor}, ${context.building})`);
      }
      for (const label of aliasLabels) {
        const fallbackId = friendlyLookup(label);
        if (!fallbackId) continue;
        if (!deviceTablesAvailable(fallbackId)) continue;
        const meta = lookupDeviceHierarchy(fallbackId);
        addDevice({
          cloudId: fallbackId,
          primaryId: fallbackId,
          name: meta?.name || fallbackId,
          zoneName: meta?.zoneName || zoneEntry?.name || zoneLabelResolved,
          floorName: meta?.floorName || zoneEntry?.floorName || context?.floor || null,
          buildingName: meta?.buildingName || zoneEntry?.buildingName || context?.building || null,
          type: meta?.type || null
        });
        if (results.length) break;
      }
    }

    return results;
  }

  function collectDevicesForFloor(floorLabel, context = {}) {
    if (!floorLabel) return [];
    const floorName = String(floorLabel).trim();
    const buildingName = context?.building ? String(context.building).trim() : null;
    const floorIds = new Set();
    const zoneNames = new Set();

    if (graphHierarchy) {
      if (graphHierarchy.floorById.has(floorLabel)) {
        floorIds.add(floorLabel);
      }
      const normalizedFloor = floorName.toLowerCase();
      for (const entry of graphHierarchy.floorById.values()) {
        if (!entry || !entry.name) continue;
        if (entry.name.toLowerCase() !== normalizedFloor) continue;
        if (buildingName) {
          const entryBuilding = String(entry.buildingId || entry.buildingName || '').toLowerCase();
          if (entryBuilding && entryBuilding !== buildingName.toLowerCase()) continue;
        }
        floorIds.add(entry.id);
      }
      for (const zone of graphHierarchy.zoneById.values()) {
        if (!zone || !zone.name) continue;
        const zoneFloor = String(zone.floorId || '').toLowerCase();
        for (const fid of floorIds) {
          if (zoneFloor === String(fid).toLowerCase()) {
            zoneNames.add(zone.name);
            break;
          }
        }
      }
    }

    if (snapshotIndex) {
      const snapFloor = findSnapshotFloor(floorName, { building: buildingName });
      if (snapFloor) {
        const zoneIds = snapFloor.zoneIds || [];
        for (const zoneId of zoneIds) {
          const zoneInfo = snapshotIndex.zoneById?.get(zoneId);
          if (zoneInfo?.name) zoneNames.add(zoneInfo.name);
        }
        if ((snapFloor.id || snapFloor.floorId) && !floorIds.size) {
          floorIds.add(snapFloor.id || snapFloor.floorId);
        }
      }
    }

    const results = [];
    const seen = new Set();
    const addDevice = (entry) => {
      if (!entry) return;
      const cloudId = entry.cloudId || entry.primaryId || entry.id;
      if (!cloudId || seen.has(cloudId)) return;
      if (!deviceTablesAvailable(cloudId)) return;
      seen.add(cloudId);
      results.push({
        id: cloudId,
        cloudId,
        primaryId: cloudId,
        name: entry.name || entry.friendlyName || entry.id || cloudId,
        zone: entry.zoneName || entry.zone || null,
        floor: entry.floorName || entry.floor || floorName,
        building: entry.buildingName || entry.building || buildingName,
        type: entry.type || entry.deviceType || null
      });
    };

    for (const zoneName of zoneNames) {
      const entries = collectDevicesForZone(zoneName, { building: buildingName, floor: floorName });
      entries.forEach(addDevice);
    }

    if (!results.length && graphHierarchy && floorIds.size) {
      for (const [zoneId, entries] of graphHierarchy.zoneDevices.entries()) {
        if (String(zoneId).includes('::')) continue;
        const zone = graphHierarchy.zoneById.get(zoneId);
        if (!zone) continue;
        const zoneFloor = String(zone.floorId || '').toLowerCase();
        for (const fid of floorIds) {
          if (zoneFloor === String(fid).toLowerCase()) {
            entries.forEach(addDevice);
            break;
          }
        }
      }
    }

    if (!results.length && snapshotIndex) {
      const snapFloor = findSnapshotFloor(floorName, { building: buildingName });
      const deviceIds = snapFloor?.deviceIds || [];
      for (const deviceNodeId of deviceIds) {
        const meta = findSnapshotDevice(deviceNodeId) || findSnapshotDevice(String(deviceNodeId));
        if (meta) addDevice(meta);
      }
    }

    return results;
  }

  function collectDevicesForBuilding(buildingLabel) {
    if (!buildingLabel) return [];
    const buildingName = String(buildingLabel).trim();
    const floorNames = new Set();
    const zoneNames = new Set();

    if (graphHierarchy) {
      const normalized = buildingName.toLowerCase();
      const buildingIds = [];
      if (graphHierarchy.buildingById.has(buildingLabel)) {
        buildingIds.push(buildingLabel);
      }
      for (const [id, entry] of graphHierarchy.buildingById.entries()) {
        if (!entry || !entry.name) continue;
        if (entry.name.toLowerCase() === normalized) buildingIds.push(id);
      }
      for (const entry of graphHierarchy.floorById.values()) {
        if (!entry || !entry.name) continue;
        const entryBuilding = String(entry.buildingId || entry.buildingName || '').toLowerCase();
        for (const bid of buildingIds) {
          if (entryBuilding === String(bid).toLowerCase() || entryBuilding === normalized) {
            floorNames.add(entry.name);
            break;
          }
        }
      }
      for (const zone of graphHierarchy.zoneById.values()) {
        if (!zone || !zone.name) continue;
        const zoneBuilding = String(zone.buildingId || zone.buildingName || '').toLowerCase();
        const zoneFloor = graphHierarchy.floorById.get(zone.floorId || '');
        for (const bid of buildingIds) {
          if (zoneBuilding === String(bid).toLowerCase() || zoneBuilding === normalized) {
            zoneNames.add(zone.name);
            break;
          }
          if (zoneFloor && zoneFloor.buildingId && String(zoneFloor.buildingId).toLowerCase() === String(bid).toLowerCase()) {
            zoneNames.add(zone.name);
            break;
          }
        }
      }
    }

    if (snapshotIndex) {
      const snapBuilding = findSnapshotBuilding(buildingName);
      if (snapBuilding) {
        const floorIds = snapBuilding.floorIds || [];
        for (const floorId of floorIds) {
          const floorInfo = snapshotIndex.floorById?.get(floorId);
          if (floorInfo?.name) floorNames.add(floorInfo.name);
        }
        const zoneIds = snapBuilding.zoneIds || [];
        for (const zoneId of zoneIds) {
          const zoneInfo = snapshotIndex.zoneById?.get(zoneId);
          if (zoneInfo?.name) zoneNames.add(zoneInfo.name);
        }
      }
    }

    const results = [];
    const seen = new Set();
    const addDevice = (entry) => {
      if (!entry) return;
      const cloudId = entry.cloudId || entry.primaryId || entry.id;
      if (!cloudId || seen.has(cloudId)) return;
      if (!deviceTablesAvailable(cloudId)) return;
      seen.add(cloudId);
      results.push({
        id: cloudId,
        cloudId,
        primaryId: cloudId,
        name: entry.name || entry.friendlyName || entry.id || cloudId,
        zone: entry.zoneName || entry.zone || null,
        floor: entry.floorName || entry.floor || null,
        building: entry.buildingName || entry.building || buildingName,
        type: entry.type || entry.deviceType || null
      });
    };

    for (const floorName of floorNames) {
      const entries = collectDevicesForFloor(floorName, { building: buildingName });
      entries.forEach(addDevice);
    }

    for (const zoneName of zoneNames) {
      const entries = collectDevicesForZone(zoneName, { building: buildingName });
      entries.forEach(addDevice);
    }

    if (!results.length && snapshotIndex) {
      const snapBuilding = findSnapshotBuilding(buildingName);
      const deviceIds = snapBuilding?.deviceIds || [];
      for (const nodeId of deviceIds) {
        const meta = findSnapshotDevice(nodeId) || findSnapshotDevice(String(nodeId));
        if (meta) addDevice(meta);
      }
    }

    return results;
  }

  function formatLocal(ts) {
    if (!Number.isFinite(ts)) return 'n/a';
    try {
      return dateTimeFormatter.format(new Date(ts));
    } catch {
      const d = new Date(ts);
      if (Number.isNaN(d.getTime())) return 'n/a';
      return d.toLocaleString('en-GB', { hour12: false });
    }
  }

  function describeRange(range) {
    if (!range || !Number.isFinite(range.start) || !Number.isFinite(range.end)) return 'the selected window';
    return `${formatLocal(range.start)} — ${formatLocal(range.end)}`;
  }

  function formatUtc(ts) {
    if (!Number.isFinite(ts)) return 'n/a';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return 'n/a';
    return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  }

  function normalizeText(str) {
    return String(str || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function summarizeChart(chart) {
    if (!chart || !Array.isArray(chart.series) || !chart.series.length) return '';
    const type = (chart.chart && chart.chart.type) ? chart.chart.type : 'line';
    const title = chart.title && typeof chart.title.text === 'string' && chart.title.text.trim()
      ? chart.title.text.trim()
      : null;
    const seriesNames = chart.series
      .map((s) => (s && s.name) ? String(s.name).trim() : '')
      .filter(Boolean);
    if (title) return `Plotted ${title} using a ${type} chart.`;
    if (seriesNames.length === 1) return `Plotted ${seriesNames[0]} using a ${type} chart.`;
    if (seriesNames.length > 1) {
      const listed = seriesNames.slice(0, 2).join(', ');
      const suffix = seriesNames.length > 2 ? ' and others' : '';
      return `Plotted ${listed}${suffix} using a ${type} chart.`;
    }
    return `Plotted the requested data using a ${type} chart.`;
  }

  function cloneChart(chart) {
    if (!chart) return null;
    try {
      return JSON.parse(JSON.stringify(chart));
    } catch {
      return Array.isArray(chart) ? [...chart] : { ...chart };
    }
  }

  function traceInsight(trace) {
    if (!Array.isArray(trace)) return '';
    for (let i = trace.length - 1; i >= 0; i--) {
      const t = trace[i];
      if (!t || !t.tool) continue;
      if (t.tool === 'correlate' || t.tool === 'correlate_weather_room' || t.tool === 'correlate_cross_room') {
        const corr = t.result?.corr;
        const n = t.result?.n || 0;
        if (Number.isFinite(corr)) {
          const strength = Math.abs(corr) > 0.7 ? 'strong' : Math.abs(corr) > 0.4 ? 'moderate' : 'weak';
          const direction = corr > 0 ? 'positive' : 'negative';
          return `Correlation is ${corr.toFixed(3)}, indicating a ${strength} ${direction} relationship (n=${n}).`;
        }
      } else if (t.tool === 'stats') {
        const stats = t.result;
        if (stats && Number.isFinite(stats.avg)) {
          const min = Number.isFinite(stats.min) ? stats.min.toFixed(2) : 'n/a';
          const max = Number.isFinite(stats.max) ? stats.max.toFixed(2) : 'n/a';
          const minTs = stats.minTs ? formatLocal(stats.minTs) : null;
          const maxTs = stats.maxTs ? formatLocal(stats.maxTs) : null;
          const tsNote = [
            minTs ? `min at ${minTs}` : null,
            maxTs ? `max at ${maxTs}` : null
          ].filter(Boolean).join(', ');
          const tsSuffix = tsNote ? ` (${tsNote})` : '';
          return `Average value ${stats.avg.toFixed(2)} with range ${min}–${max} across ${stats.count || 0} samples${tsSuffix}.`;
        }
      } else if (t.tool === 'detect_spikes') {
        const field = t.args?.field || 'the selected metric';
        if (Array.isArray(t.result)) {
          if (!t.result.length) return `No anomalies detected in ${field} within the available data.`;
          return `Detected ${t.result.length} anomaly${t.result.length === 1 ? '' : 'ies'} in ${field}.`;
        }
      } else if (t.tool === 'hour_of_day_stats') {
        const best = t.result?.best_hour;
        if (Number.isFinite(best)) {
          return `Peak hour appears to be ${best}:00 based on hour-of-day analysis.`;
        }
      } else if (t.tool === 'energy_delta_kwh') {
        const delta = t.result?.delta_kwh;
        if (Number.isFinite(delta)) {
          return `Energy use changed by ${delta.toFixed(2)} kWh across the selected window.`;
        }
      }
    }
    return '';
  }

  function traceHasData(trace) {
    if (!Array.isArray(trace)) return false;
    for (const entry of trace) {
      const result = entry?.result;
      if (!result) continue;
      if (Array.isArray(result) && result.length) return true;
      if (typeof result === 'object') {
        if (entry?.tool === 'compare_series_cross_room' && !Array.isArray(result)) {
          const seriesArrays = Object.values(result).filter((val) => Array.isArray(val) && val.length);
          if (seriesArrays.length) return true;
        }
      if (Array.isArray(result.rows) && result.rows.length) return true;
      if (Array.isArray(result.data) && result.data.length) return true;
      if (Array.isArray(result.series) && result.series.some((s) => Array.isArray(s?.data) && s.data.length)) return true;
      if (Array.isArray(result.groups) && result.groups.some((g) => Array.isArray(g?.devices) && g.devices.length)) return true;
      if (Array.isArray(result.scatter) && result.scatter.length) return true;
      if (Array.isArray(result.scatter_series) && result.scatter_series.length) return true;
      if (typeof result.count === 'number' && result.count > 0) return true;
      if (typeof result.n === 'number' && result.n > 0) return true;
      if (typeof result.total === 'number' || typeof result.sum === 'number') return true;
      if (typeof result.delta_kwh === 'number' && Number.isFinite(result.delta_kwh)) return true;
    }
  }
    return false;
  }

  function traceHasHistogramData(trace) {
    if (!Array.isArray(trace)) return false;
    return trace.some((entry) => {
      if (!entry || !entry.tool) return false;
      if (entry.tool !== 'histogram' && entry.tool !== 'field_histogram') return false;
      const rows = entry.result;
      if (!Array.isArray(rows) || !rows.length) return false;
      return rows.some((bin) => Number(bin?.count) > 0);
    });
  }

  function countTraceToolExecutions(trace) {
    if (!Array.isArray(trace)) return 0;
    let count = 0;
    for (const entry of trace) {
      if (entry && entry.tool && entry.tool !== 'plan') count += 1;
    }
    return count;
  }

  const PLACEHOLDER_ANSWER_PATTERNS = [
    /^plotted\b/i,
    /^compared series/i,
    /^see chart/i,
    /^chart:/i,
    /^unable to produce/i,
    /^no data available/i,
    /^i analyzed the available data/i
  ];

  function runDefinitionFallback(question) {
    const q = String(question || '').toLowerCase();
    if (!q) return null;
    const answers = [];
    if (q.includes('pir')) {
      answers.push('Overview: PIR stands for Passive Infrared. PIR sensors passively watch for changes in infrared radiation (heat) within their field of view, so a rising PIR value simply means a person moved through the zone.');
      answers.push('Details: When the sensor detects motion, it sets the PIR metric to 1 (motion detected) or a non-zero pulse; when no motion is detected the value returns to 0. Facilities commonly use PIR states to toggle lighting, drive HVAC setbacks, or feed occupancy dashboards.');
      return { message: assistantMessage(answers.join(' ')), chart: null, trace: [] };
    }
    if (q.includes('co2')) {
      answers.push('Overview: CO2 (carbon dioxide) is the gas people exhale; indoors it accumulates as occupancy increases.');
      answers.push('Details: Because humans are the dominant source indoors, CO2 concentration—reported in parts per million (ppm)—is a direct indicator of how well the ventilation system is diluting exhaled air. Levels above ~1,000 ppm suggest the space needs additional outdoor air to keep occupants alert and comfortable.');
      return { message: assistantMessage(answers.join(' ')), chart: null, trace: [] };
    }
    return null;
  }

  function isPlaceholderAnswer(text) {
    const raw = String(text || '').trim();
    if (!raw) return true;
    return PLACEHOLDER_ANSWER_PATTERNS.some((pattern) => pattern.test(raw));
  }

  const MONTH_NAME_TO_INDEX = {
    january: 0,
    february: 1,
    march: 2,
    april: 3,
    may: 4,
    june: 5,
    july: 6,
    august: 7,
    september: 8,
    october: 9,
    november: 10,
    december: 11
  };

  const METRIC_UPPERCASE = new Map([
    ['co2', 'CO2'],
    ['tvoc', 'TVOC'],
    ['pm2_5', 'PM2.5'],
    ['pm10', 'PM10']
  ]);

  const MAX_TARGET_DELTA_MS = 3 * 60 * 60 * 1000; // 3 hours tolerance

  function formatNumericValue(value) {
    if (!Number.isFinite(value)) return 'n/a';
    const abs = Math.abs(value);
    let formatted;
    if (abs >= 1000) formatted = value.toFixed(0);
    else if (abs >= 100) formatted = value.toFixed(1);
    else if (abs >= 10) formatted = value.toFixed(1);
    else if (abs >= 1) formatted = value.toFixed(2);
    else formatted = value.toFixed(3);
    return formatted.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
  }

  function formatTableValue(column, value) {
    if (value === null || value === undefined || value === '') return '—';
    if (column === 'ts') {
      return Number.isFinite(value) ? formatLocal(value) : String(value);
    }
    if (typeof value === 'number') return formatNumericValue(value);
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    return String(value);
  }

function humanizeMetricName(raw) {
  if (!raw) return '';
  const lower = String(raw).toLowerCase();
  if (METRIC_UPPERCASE.has(lower)) return METRIC_UPPERCASE.get(lower);
  const cleaned = String(raw).replace(/[_-]+/g, ' ').trim();
  return cleaned.split(' ').map((part) => {
    if (!part) return part;
    if (part.length === 1) return part.toUpperCase();
    return part[0].toUpperCase() + part.slice(1);
  }).join(' ');
}

function summarizeCrossRoomResult(result, metricLabel = '') {
  try {
    const stats = [];
    for (const [name, rows] of Object.entries(result || {})) {
      if (!Array.isArray(rows) || !rows.length) continue;
      const values = rows
        .map((pt) => {
          if (pt == null) return null;
          if (typeof pt === 'number') return pt;
          if (typeof pt === 'object') return Number(pt.y ?? pt.value ?? pt.avg ?? pt.data);
          return null;
        })
        .filter((v) => Number.isFinite(v));
      if (!values.length) continue;
      const avg = values.reduce((a, b) => a + b, 0) / values.length;
      const latest = values[values.length - 1];
      stats.push({ name, avg, latest });
    }
    if (!stats.length) return '';
    stats.sort((a, b) => b.avg - a.avg);
    const top = stats[0];
    const labelSuffix = metricLabel ? ` ${metricLabel}` : '';
    if (stats.length === 1) {
      const latestText = Number.isFinite(top.latest) ? ` (latest ${formatNumericValue(top.latest)})` : '';
      return `${top.name} averaged ${formatNumericValue(top.avg)}${labelSuffix}${latestText}.`;
    }
    const bottom = stats[stats.length - 1];
    const delta = Number.isFinite(top.avg - bottom.avg) ? top.avg - bottom.avg : null;
    const deltaText = Number.isFinite(delta)
      ? `, roughly ${formatNumericValue(delta)}${labelSuffix || ' units'} higher than ${bottom.name}`
      : '';
    return `${top.name} averaged ${formatNumericValue(top.avg)}${labelSuffix}${deltaText}.`;
  } catch {
    return '';
  }
}

function summarizeFieldComparison(entries = []) {
  try {
    const filtered = (entries || [])
      .filter((row) => row && row.field && Number.isFinite(Number(row.value)))
      .map((row) => ({ field: humanizeMetricName(row.field), value: Number(row.value) }));
    if (!filtered.length) return '';
    filtered.sort((a, b) => b.value - a.value);
    const top = filtered[0];
    if (filtered.length === 1) {
      return `${top.field} measured ${formatNumericValue(top.value)}.`;
    }
    const bottom = filtered[filtered.length - 1];
    return `${top.field} was highest (${formatNumericValue(top.value)}), while ${bottom.field} was lowest at ${formatNumericValue(bottom.value)}.`;
  } catch {
    return '';
  }
}

  function friendlySeriesLocation(deviceId, defaultLabel = '') {
    if (!deviceId) return defaultLabel;
    const info = lookupDeviceHierarchy(deviceId);
    if (info) {
      const zone = info.zoneName || info.name || null;
      const floor = info.floorName || null;
      const building = info.buildingName || null;
      if (zone && floor && building) return `${zone} (${floor}, ${building})`;
      if (zone && building) return `${zone} (${building})`;
      if (zone) return zone;
      if (info.name) return info.name;
    }
    let friendly = deviceFriendlyName(deviceId);
    if (friendly && friendly.includes(' — ')) friendly = friendly.split(' — ')[0];
    return friendly || defaultLabel || String(deviceId);
  }

  function buildSeriesLabel({ deviceId, field, defaultName }) {
    const metric = humanizeMetricName(field || defaultName || '');
    const location = friendlySeriesLocation(deviceId, defaultName || '');
    if (metric && location) return `${metric} in ${location}`;
    if (metric) return metric;
    return location || defaultName || 'series';
  }

  function describeRangeWindow(range) {
    if (!range || (!Number.isFinite(range?.start) && !Number.isFinite(range?.end))) return 'during the selected window';
    const startText = Number.isFinite(range.start) ? formatLocal(range.start) : null;
    const endText = Number.isFinite(range.end) ? formatLocal(range.end) : null;
    if (startText && endText) return `from ${startText} to ${endText}`;
    if (startText) return `after ${startText}`;
    if (endText) return `up to ${endText}`;
    return 'during the selected window';
  }

  function parseOrdinalDay(text) {
    return Number(String(text || '').replace(/(st|nd|rd|th)$/i, ''));
  }

  function parseQuestionTimestamp(question, range = null) {
    if (!question) return null;
    const lower = question.toLowerCase();
    let year = null;
    let monthIndex = null;
    let day = null;
    const dateMatch = lower.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}(?:st|nd|rd|th)?)(?:,?\s*(\d{4}))?/);
    if (dateMatch) {
      monthIndex = MONTH_NAME_TO_INDEX[dateMatch[1]];
      day = parseOrdinalDay(dateMatch[2]);
      if (dateMatch[3]) year = Number(dateMatch[3]);
    }
    if ((year == null || monthIndex == null || day == null) && range) {
      const start = Number(range.start);
      if (Number.isFinite(start)) {
        const d = new Date(start);
        if (year == null) year = d.getUTCFullYear();
        if (monthIndex == null) monthIndex = d.getUTCMonth();
        if (day == null) day = d.getUTCDate();
      }
    }
    const explicitTimeMatch = lower.match(/\b(?:at|around|by|after|before)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
    const numericTimeMatch = !explicitTimeMatch ? lower.match(/\b(\d{1,2})(?::(\d{2}))\b/) : null;
    let hour = null;
    let minute = 0;
    if (explicitTimeMatch) {
      hour = Number(explicitTimeMatch[1]);
      minute = explicitTimeMatch[2] != null ? Number(explicitTimeMatch[2]) : 0;
      const meridiem = explicitTimeMatch[3];
      if (meridiem === 'pm' && hour < 12) hour += 12;
      if (meridiem === 'am' && hour === 12) hour = 0;
    } else if (numericTimeMatch) {
      hour = Number(numericTimeMatch[1]);
      minute = Number(numericTimeMatch[2] || 0);
    }
    if (hour == null || monthIndex == null || day == null || year == null) return null;
    const ts = Date.UTC(year, monthIndex, day, hour, minute);
    return { ts, label: formatLocal(ts) };
  }

  function summarizeSeries({ label, points, question, range }) {
    if (!Array.isArray(points) || !points.length) return null;
    const samples = points
      .filter((p) => p && Number.isFinite(Number(p.ts)) && Number.isFinite(Number(p.value)))
      .map((p) => ({ ts: Number(p.ts), value: Number(p.value) }))
      .sort((a, b) => a.ts - b.ts);
    if (!samples.length) return null;
    const values = samples.map((p) => p.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const sum = values.reduce((acc, v) => acc + v, 0);
    const avg = sum / values.length;
    const minPoint = samples[values.indexOf(min)];
    const maxPoint = samples[values.indexOf(max)];
    const latestPoint = samples[samples.length - 1];
    const windowStart = (range && Number.isFinite(range.start)) ? Number(range.start) : samples[0].ts;
    const windowEnd = (range && Number.isFinite(range.end)) ? Number(range.end) : samples[samples.length - 1].ts;
    const windowText = `between ${formatLocal(windowStart)} and ${formatLocal(windowEnd)}`;

    let summary = `${label || 'The metric'} ${windowText} ranged from ${formatNumericValue(min)} (at ${formatLocal(minPoint.ts)}) to ${formatNumericValue(max)} (at ${formatLocal(maxPoint.ts)}), averaging ${formatNumericValue(avg)} across ${samples.length} sample${samples.length === 1 ? '' : 's'}.`;

    const target = parseQuestionTimestamp(question, range);
    if (target) {
      let closest = null;
      let bestDelta = Infinity;
      for (const sample of samples) {
        const delta = Math.abs(sample.ts - target.ts);
        if (delta < bestDelta) {
          bestDelta = delta;
          closest = sample;
        }
      }
      if (closest && bestDelta <= MAX_TARGET_DELTA_MS) {
        summary += ` Closest reading to ${target.label} was ${formatNumericValue(closest.value)} at ${formatLocal(closest.ts)}.`;
      } else if (latestPoint) {
        summary += ` Latest sample was ${formatNumericValue(latestPoint.value)} at ${formatLocal(latestPoint.ts)}.`;
      }
    } else if (latestPoint) {
      summary += ` Latest sample was ${formatNumericValue(latestPoint.value)} at ${formatLocal(latestPoint.ts)}.`;
    }

    return summary;
  }

  function extractForecastPoints(result) {
    if (!result || typeof result !== 'object') return [];
    const collected = [];
    const normPoint = (entry, valueKey = 'forecast') => {
      if (!entry || typeof entry !== 'object') return null;
      const ts = entry.ts ?? entry.timestamp ?? entry.t ?? null;
      const valCandidate = entry[valueKey] ?? entry.value ?? entry.y ?? entry.prediction ?? entry.point ?? null;
      const value = Number(valCandidate);
      if (!Number.isFinite(value)) return null;
      const tsNum = ts == null ? null : Number(ts);
      return {
        ts: Number.isFinite(tsNum) ? tsNum : null,
        value
      };
    };
    const pushAll = (arr, valueKey) => {
      if (!Array.isArray(arr)) return;
      for (const entry of arr) {
        const norm = normPoint(entry, valueKey);
        if (norm) collected.push(norm);
      }
    };
    pushAll(result.forecast, 'forecast');
    pushAll(result.prediction, 'value');
    pushAll(result.predictions, 'value');
    pushAll(result.values, 'value');
    pushAll(result.points, 'y');
    pushAll(result.timeline, 'value');
    if (!collected.length && Array.isArray(result.profile)) {
      result.profile.forEach((val, idx) => {
        const num = Number(val);
        if (Number.isFinite(num)) {
          collected.push({ ts: null, value: num, hour: idx });
        }
      });
    }
    return collected;
  }

  function summarizeForecastResult({ tool, args = {}, result }) {
    const points = extractForecastPoints(result);
    const hist = Array.isArray(result?.historical) ? result.historical : [];
    const histWithValues = hist.filter((p) => {
      if (!p || p.ts == null) return false;
      const val = p.avg ?? p.value ?? p.forecast ?? p.y ?? null;
      return Number.isFinite(Number(val));
    });
    const sorted = points.slice().sort((a, b) => {
      if (a.ts == null && b.ts == null) return 0;
      if (a.ts == null) return -1;
      if (b.ts == null) return 1;
      return a.ts - b.ts;
    });
    const field = args.field || args.metric || args.targetField || 'forecast';
    const label = buildSeriesLabel({
      deviceId: args.room,
      field,
      defaultName: humanizeMetricName(field)
    });
    if (!points.length) {
      if (result && typeof result.summary === 'string' && result.summary.trim()) {
        return `${label} forecast: ${result.summary.trim()}`;
      }
      if (result && result.error) {
        const msg = String(result.error).replace(/^error:\s*/i, '');
        return `${label} forecast failed: ${msg}.`;
      }
      if (histWithValues.length === 0) {
        return `${label} forecast unavailable because no telemetry samples were found in the requested window.`;
      }
      return `${label} forecast unavailable — insufficient historical depth (${histWithValues.length} hourly sample${histWithValues.length === 1 ? '' : 's'}).`;
    }
    const values = sorted.map((p) => p.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const latest = sorted[sorted.length - 1];
    const windowPhrase = latest && Number.isFinite(latest.ts)
      ? `through ${formatLocal(latest.ts)}`
      : 'for the requested horizon';
    return `${label} forecast spans ${formatNumericValue(min)}–${formatNumericValue(max)} ${windowPhrase} (n=${points.length}).`;
  }

  function deriveTimeseriesInsights({ trace = [], question = '', range = null }) {
    const collected = [];
    const insights = [];
    const seenTags = new Set();
    for (const entry of trace || []) {
      if (!entry || !entry.result) continue;
      const tool = entry.tool;
      if (tool === 'compare_series_cross_room') {
        const seriesArgs = Array.isArray(entry.args?.series) ? entry.args.series : [];
        const resultObj = entry.result && typeof entry.result === 'object' ? entry.result : {};
        seriesArgs.forEach((seriesArg, idx) => {
          const nameCandidates = [];
          if (seriesArg?.name) nameCandidates.push(seriesArg.name);
          if (seriesArg?.room && seriesArg?.field) nameCandidates.push(`${seriesArg.room} ${seriesArg.field}`);
          const resultKeys = Object.keys(resultObj);
          if (resultKeys[idx]) nameCandidates.push(resultKeys[idx]);
          const foundKey = nameCandidates.find((key) => key && Array.isArray(resultObj[key]));
          const key = foundKey || resultKeys[0];
          const values = key ? resultObj[key] : null;
          if (!Array.isArray(values) || !values.length) return;
          const points = values
            .map((p) => ({ ts: p.ts ?? p.timestamp ?? null, value: p.y ?? p.value ?? null }))
            .filter((p) => p.ts != null && Number.isFinite(Number(p.value)));
          if (!points.length) return;
          const label = buildSeriesLabel({ deviceId: seriesArg.room, field: seriesArg.field, defaultName: seriesArg.name || key });
          collected.push({ label, points });
        });
      } else if ((tool === 'fetch_timeseries' || tool === 'hourly_timeseries' || tool === 'daily_avg') && Array.isArray(entry.result)) {
        const arr = entry.result;
        const first = arr[0] || {};
        const numericFields = Object.keys(first).filter((k) => k !== 'ts' && Number.isFinite(Number(first[k])));
        if (!numericFields.length && first.avg != null) numericFields.push('avg');
        if (numericFields.length === 1) {
          const field = numericFields[0];
          const points = arr
            .map((p) => ({ ts: p.ts ?? p.timestamp ?? null, value: p[field] != null ? Number(p[field]) : Number(p.avg) }))
            .filter((p) => p.ts != null && Number.isFinite(p.value));
          if (points.length) {
            const label = buildSeriesLabel({ deviceId: entry.args?.room, field, defaultName: field });
            collected.push({ label, points });
          }
        }
      } else if (tool === 'weather_fetch' && Array.isArray(entry.result)) {
        const arr = entry.result;
        if (!arr.length) continue;
        const numericFields = Object.keys(arr[0] || {}).filter((k) => k !== 'ts' && Number.isFinite(Number(arr[0][k])));
        for (const field of numericFields.slice(0, 3)) {
          const points = arr
            .map((p) => ({ ts: p.ts ?? p.timestamp ?? null, value: Number(p[field]) }))
            .filter((p) => p.ts != null && Number.isFinite(p.value));
          if (!points.length) continue;
          const label = `Weather ${humanizeMetricName(field)}`;
          collected.push({ label, points });
        }
      } else if (tool === 'pair_timeseries' && entry.result) {
        const key = `pair:${entry.args?.room || ''}:${entry.args?.field1 || ''}:${entry.args?.field2 || ''}`;
        if (seenTags.has(key)) continue;
        const corr = typeof entry.result.corr === 'number' ? entry.result.corr : null;
        if (corr != null && Number.isFinite(corr)) {
          const samples = Array.isArray(entry.result.pairs) ? entry.result.pairs.length : entry.result.n;
          const left = humanizeMetricName(entry.args?.field1 || 'Metric A');
          const right = entry.args?.table2 === 'weather'
            ? `outside ${humanizeMetricName(entry.args?.field2 || 'Metric B')}`
            : humanizeMetricName(entry.args?.field2 || 'Metric B');
          const location = entry.args?.room ? friendlySeriesLocation(entry.args.room, entry.args.room) : 'scope';
          const magnitude = Math.abs(corr);
          let qualifier = 'weak';
          if (magnitude >= 0.8) qualifier = 'very strong';
          else if (magnitude >= 0.6) qualifier = 'strong';
          else if (magnitude >= 0.4) qualifier = 'moderate';
          const direction = corr >= 0 ? 'positive' : 'negative';
          let text = `Correlation between ${left} and ${right} in ${location} is ${corr.toFixed(2)}, indicating a ${qualifier} ${direction} relationship`;
          if (Number.isFinite(samples)) text += ` (n=${samples})`;
          text += '.';
          insights.push(text);
          seenTags.add(key);
        }
      } else if (tool === 'weather_correlate' && entry.result) {
        const key = `weather:${entry.args?.field1 || ''}:${entry.args?.field2 || ''}:${entry.args?.building || ''}`;
        if (seenTags.has(key)) continue;
        const corr = typeof entry.result.corr === 'number' ? entry.result.corr : null;
        if (corr != null && Number.isFinite(corr)) {
          const samples = entry.result.n;
          const left = humanizeMetricName(entry.args?.field1 || 'Metric A');
          const right = humanizeMetricName(entry.args?.field2 || 'Metric B');
          const location = entry.args?.building ? `in ${entry.args.building}` : 'for the selected scope';
          const magnitude = Math.abs(corr);
          let qualifier = 'weak';
          if (magnitude >= 0.8) qualifier = 'very strong';
          else if (magnitude >= 0.6) qualifier = 'strong';
          else if (magnitude >= 0.4) qualifier = 'moderate';
          const direction = corr >= 0 ? 'positive' : 'negative';
          let text = `Correlation between ${left} and ${right} ${location} is ${corr.toFixed(2)}, indicating a ${qualifier} ${direction} relationship`;
          if (Number.isFinite(samples)) text += ` (n=${samples})`;
          text += '.';
          insights.push(text);
          seenTags.add(key);
        }
      } else if (tool === 'correlation_matrix' && entry.result && Array.isArray(entry.result.fields) && Array.isArray(entry.result.matrix)) {
        const key = `matrix:${entry.args?.room || ''}:${entry.args?.table || ''}`;
        if (seenTags.has(key)) continue;
        const { fields, matrix } = entry.result;
        let best = null;
        for (let i = 0; i < fields.length; i++) {
          for (let j = i + 1; j < fields.length; j++) {
            const value = matrix[i]?.[j];
            if (!Number.isFinite(value)) continue;
            const magnitude = Math.abs(value);
            if (!best || magnitude > best.magnitude) {
              best = { i, j, value, magnitude };
            }
          }
        }
        if (best) {
          const left = humanizeMetricName(fields[best.i]);
          const right = humanizeMetricName(fields[best.j]);
          const magnitude = best.magnitude;
          let qualifier = 'weak';
          if (magnitude >= 0.8) qualifier = 'very strong';
          else if (magnitude >= 0.6) qualifier = 'strong';
          else if (magnitude >= 0.4) qualifier = 'moderate';
          const direction = best.value >= 0 ? 'positive' : 'negative';
          const location = entry.args?.room ? friendlySeriesLocation(entry.args.room, entry.args.room) : 'scope';
          insights.push(`Strongest correlation in ${location} is between ${left} and ${right}: ${best.value.toFixed(2)} (${qualifier} ${direction}).`);
          seenTags.add(key);
        }
      } else if (typeof tool === 'string' && /^forecast/.test(tool)) {
        const key = `forecast:${tool}:${entry.args?.room || ''}:${entry.args?.field || entry.args?.metric || ''}`;
        if (seenTags.has(key)) continue;
        const summary = summarizeForecastResult({ tool, args: entry.args || {}, result: entry.result });
        if (summary) {
          insights.unshift(summary);
          seenTags.add(key);
        }
      } else if (tool === 'building_temp_weather_corr' && entry.result) {
        const key = `building_temp_weather_corr:${entry.args?.building || ''}`;
        if (seenTags.has(key)) continue;
        const corrVal = Number(entry.result.corr);
        if (Number.isFinite(corrVal)) {
          const magnitude = Math.abs(corrVal);
          let qualifier = 'weak';
          if (magnitude >= 0.8) qualifier = 'very strong';
          else if (magnitude >= 0.6) qualifier = 'strong';
          else if (magnitude >= 0.4) qualifier = 'moderate';
          const direction = corrVal >= 0 ? 'positive' : 'negative';
          const roomsCount = Array.isArray(entry.result.rooms) ? entry.result.rooms.length : null;
          let text = `Average internal temperature vs outside temperature correlation is ${corrVal.toFixed(2)}, indicating a ${qualifier} ${direction} relationship (n=${entry.result.n || 0}).`;
          if (roomsCount) text += ` Based on ${roomsCount} room${roomsCount === 1 ? '' : 's'}.`;
          insights.push(text);
          seenTags.add(key);
        }
      } else if (tool === 'scope_heatmap' && entry.result && entry.result.summary) {
        const key = `heatmap:${(entry.args?.rooms || []).join(',')}:${entry.args?.field || ''}`;
        if (!seenTags.has(key)) {
          insights.push(entry.result.summary);
          seenTags.add(key);
        }
      }
    }
    if (collected.length) {
      const limit = Math.min(collected.length, 3);
      for (let i = 0; i < limit; i += 1) {
        const summary = summarizeSeries({ ...collected[i], question, range });
        if (summary && !insights.includes(summary)) {
          insights.unshift(summary);
        }
      }
    }
    return insights;
  }

  const normalizeMatchString = (value) => String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  function selectRoomsForHeatmap(question, rooms = [], limit = 6) {
    if (!Array.isArray(rooms) || rooms.length === 0) return [];
    const qNorm = normalizeMatchString(question);
    if (!qNorm) return rooms.slice(0, limit);

    const matches = [];
    const seen = new Set();

    const consider = (roomId, text) => {
      const norm = normalizeMatchString(text);
      if (!norm || norm.length < 3) return;
      if (qNorm.includes(norm) && !seen.has(roomId)) {
        matches.push(roomId);
        seen.add(roomId);
      }
    };

    for (const roomId of rooms) {
      const info = lookupDeviceHierarchy(roomId) || {};
      const aliases = new Set([
        info.zoneName,
        info.name,
        info.deviceId,
        info.cloudId,
        deviceFriendlyName(roomId)
      ].filter(Boolean));
      for (const alias of aliases) consider(roomId, alias);
    }

    if (matches.length) return matches.slice(0, limit);
    return rooms.slice(0, limit);
  }

  function shortenKnowledgeSnippet(snippet, limit = 240) {
    const raw = String(snippet || '').trim();
    if (!raw) return '';
    const sentenceMatch = raw.split(/(?<=[.!?])\s+/).filter(Boolean);
    let snippetText = sentenceMatch.length ? sentenceMatch[0] : raw;
    if (snippetText.length > limit) {
      snippetText = snippetText.slice(0, limit).trim();
      if (!snippetText.endsWith('…')) snippetText += '…';
    }
    return snippetText;
  }

  function questionRequiresScatter(question) {
    const q = String(question || '').toLowerCase();
    if (!q) return false;
    if (q.includes('scatterplot') || /\bscatter\s*plot\b/.test(q)) return true;
    if (q.includes('scatter') && (q.includes('plot') || q.includes('chart') || q.includes('graph'))) return true;
    if (/\bcorrelation\b/.test(q) && (q.includes('plot') || q.includes('chart') || q.includes('graph'))) return true;
    return false;
  }

  function questionRequiresChart(question) {
    const q = String(question || '').toLowerCase();
    if (!q) return false;
    if (q.includes('plot') || q.includes('chart') || q.includes('graph')) return true;
    if (/(line|bar|column|area)\s+chart/.test(q)) return true;
    if (/show\s+(me\s+)?(the\s+)?(trend|timeseries|time series)/.test(q)) return true;
    return false;
  }

  function questionRequiresRoomRanking(question) {
    const q = String(question || '').toLowerCase();
    if (!q) return false;
    if (/\bwhich\b.+\b(room|zone)\b.+\b(busiest|busy|most|highest|unused)\b/.test(q)) return true;
    if (/\brooms?\b.+\b(busiest|busy|unused|most used|most people|most occupied)\b/.test(q)) return true;
    if (q.includes('busiest room') || q.includes('room will be the busiest') || q.includes('rooms are being used the most')) return true;
    if (q.includes('meeting rooms') && (q.includes('used the most') || q.includes('busiest'))) return true;
    if (q.includes('rooms not been used') || q.includes('unused rooms')) return true;
    return false;
  }

  function buildAnalysisDirectives(routing = {}) {
    const intents = routing.intents || {};
    const metrics = routing.metrics || [];
    const chartHint = routing.chartHint || null;
    const questionLower = String(routing.original || '').toLowerCase();
    const lines = [];

    if (intents.comparison) {
      lines.push('- Comparison focus detected: call compare_series_cross_room or compare_rooms_on_metric to contrast rooms/zones, and describe which leads/lags.');
    }
    if (intents.correlation) {
      lines.push('- Correlation intent: call correlate or correlate_cross_room to quantify relationships and mention the coefficient.');
    }
    if (Array.isArray(routing.namedRooms) && routing.namedRooms.length) {
      lines.push(`- User explicitly mentioned: ${routing.namedRooms.join(', ')}. Prioritize these rooms in your comparisons and cite their values.`);
    }
    if (routing.chartHintStrict && chartHint) {
      lines.push(`- The user explicitly asked for a ${chartHint} chart; do not substitute another chart type.`);
    }
    if (intents.histogram || chartHint === 'histogram') {
      lines.push('- Histogram requested: call histogram (or field_histogram) and return a column chart showing distribution, noting the dominant bin.');
    }
    if (intents.scatter || chartHint === 'scatter') {
      lines.push('- Scatter/VS intent: call pair_timeseries (or building_temp_weather_scatter) to generate paired points and render a scatter plot.');
    }
    if (intents.heatmap || chartHint === 'heatmap') {
      lines.push('- Heatmap requested: use scope_heatmap or correlation_matrix to produce a heatmap-style chart.');
    }
    if (intents.aggregate) {
      lines.push('- Aggregation requested: compute stats (stats/compare_rooms_on_metric/compare_metrics_in_room) and cite min/avg/max values.');
    }
    if (intents.table) {
      lines.push('- Tabular data requested: call table_sample (or latest_value) and return a Markdown table with headers.');
    }
    if (intents.forecast) {
      lines.push('- Forecast intent: call a forecast_* tool and describe the projected trend and range.');
    }
    if (intents.anomaly) {
      lines.push('- Anomaly intent: call detect_spikes or stats to highlight outliers.');
    }
    if (intents.weather || metrics.includes('weather')) {
      lines.push('- Weather mentioned: include weather_fetch or building_temp_weather_corr so indoor vs outdoor context is provided.');
    }
    if (intents.energy || metrics.includes('energy')) {
      lines.push('- Energy metric detected: incorporate stats or compare_rooms_on_metric over energy/total_kwh.');
    }
    if (intents.occupancy || metrics.includes('occupancy')) {
      lines.push('- Occupancy metric detected: use stats/compare_rooms_on_metric on people_count to show utilization.');
    }
    const comfortQuestion = /comfort|comfortable|target temperature|temperature should we target/.test(questionLower);
    if (comfortQuestion && metrics.includes('temperature')) {
      lines.push('- Comfort analysis needed: call comfort_band_summary (adjust minComfort/maxComfort if specified) to report the % of readings within the comfort band and highlight any rooms that fall outside.');
    }
    if (chartHint === 'bar') {
      lines.push('- Bar/column chart requested: compare aggregate values (e.g., stats or compare_rooms_on_metric) and plot them as a column chart.');
    } else if (chartHint === 'line') {
      lines.push('- Line chart intent: fetch a timeseries (fetch_timeseries/hourly_timeseries) and show the trend over time.');
    } else if (intents.requiresChart && chartHint === null) {
      lines.push('- A chart was requested; choose the most expressive option (e.g., area for cumulative energy, column for rankings, heatmap for matrices) instead of defaulting to a plain line chart.');
    }
    if (intents.wantsLatest) {
      lines.push('- Provide the latest value via latest_value or stats before deeper analysis.');
    }

    return lines.length ? `\nDirected Analysis Requirements:\n${lines.join('\n')}\n` : '';
  }

  function questionRequiresRoomComparison(question) {
    const q = String(question || '').toLowerCase();
    if (!q) return false;
    if (q.includes('compare') && (q.includes('room') || q.includes('zone'))) return true;
    if (/\bvs\b/.test(q) || q.includes(' versus ') || q.includes(' vs ')) return true;
    if (q.includes('difference between') && (q.includes('room') || q.includes('suite') || q.includes('zone'))) return true;
    return false;
  }

  function normalizeExplicitRoomLabel(label) {
    if (!label) return null;
    const cleaned = String(label)
      .replace(/["']/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) return null;
    return cleaned
      .split(' ')
      .map((word, idx) => {
        if (!word) return '';
        if (/^\d/.test(word)) return word;
        return idx === 0
          ? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
          : word.toLowerCase();
      })
      .join(' ');
  }

  function extractQuestionRooms(question) {
    const q = String(question || '');
    if (!q.trim()) return [];
    const matches = new Set();
    const add = (value) => {
      const label = normalizeExplicitRoomLabel(value);
      if (label) matches.add(label);
    };

    const betweenRegex = /\bbetween\s+([^,.;!?]+?)\s+and\s+([^,.;!?]+?)(?=[,.;!?]|$)/gi;
    let pair;
    while ((pair = betweenRegex.exec(q)) !== null) {
      add(pair[1]);
      add(pair[2]);
    }

    const patterns = [
      /\b(?:suite|room|zone|office|studio)\s+[0-9]+(?:\.[0-9]+)?\b/gi,
      /\b(?:suite|room|zone|office|studio)\s+[A-Za-z0-9]+(?:[\.\-][A-Za-z0-9]+)?\b/gi,
      /\bmeeting\s+room\s+[A-Za-z0-9]+\b/gi,
      /\bsuite\s+[A-Za-z]+\b/gi
    ];
    for (const re of patterns) {
      let m;
      while ((m = re.exec(q)) !== null) {
        add(m[0]);
      }
    }
    return Array.from(matches).slice(0, 6);
  }

  function runEmergencyAnalysis({ question, selectionRooms, room, range }) {
    try {
      const rr = range || {};
      const targetRoom = (selectionRooms && selectionRooms.length)
        ? selectionRooms[0]
        : (!isAllRooms(room) && room ? room : null);
      if (!targetRoom) return null;
      const tablesSets = availableFieldsByTable(targetRoom);
      const fields = parseFieldsFromQuestion(question, tablesSets);
      let field = fields[0];
      if (!field) field = inferFieldFromQuestionKeywords(question);
      if (!field) {
        const qLower = String(question || '').toLowerCase();
        if (qLower.includes('co2') || qLower.includes('co₂')) field = 'co2';
        else if (qLower.includes('occupancy') || qLower.includes('people')) field = 'people_count';
        else if (qLower.includes('humidity')) field = 'humidity';
        else if (qLower.includes('lux') || qLower.includes('light')) field = 'lux';
      }
      if (!field) field = inferFieldName(question, tablesSets) || 'temperature';
      let binding = resolveFieldBinding(field, selectionRooms, targetRoom) || resolveFieldBinding(field, [targetRoom], targetRoom);
      if (!binding) {
        try {
          binding = resolveFieldBinding(field, listRooms(), targetRoom);
        } catch {}
      }
      if (!binding || !binding.fieldName) return null;
      const fetchArgs = {
        room: binding.room || targetRoom,
        table: binding.table || resolveTable(binding.room || targetRoom, field === 'people_count' ? 'people' : 'iaq'),
        fields: [binding.fieldName],
        start: Number.isFinite(rr.start) ? rr.start : undefined,
        end: Number.isFinite(rr.end) ? rr.end : undefined,
        limit: 500
      };
      const friendlyRoom = friendlySeriesLocation(fetchArgs.room, deviceFriendlyName(fetchArgs.room));
      const metricLabel = humanizeMetricName(binding.fieldName);
      const planSteps = [
        { index: 1, text: `Collect ${metricLabel} samples for ${friendlyRoom || 'the selected scope'} using fetch_timeseries.` },
        { index: 2, text: `Summarize ${metricLabel} min/avg/max for ${friendlyRoom || 'the selected scope'}.` }
      ];
      const emergencyTrace = [{ tool: 'plan', args: { steps: planSteps }, result: null }];
      const rows = tools.fetch_timeseries(fetchArgs);
      if (!Array.isArray(rows) || !rows.length) return null;
      const numericValues = [];
      let min = Infinity;
      let max = -Infinity;
      let sum = 0;
      let peakTs = null;
      for (const row of rows) {
        const value = Number(row[binding.fieldName]);
        if (!Number.isFinite(value)) continue;
        numericValues.push(value);
        sum += value;
        if (value < min) min = value;
        if (value > max) {
          max = value;
          peakTs = row.ts;
        }
      }
      if (!numericValues.length) return null;
      const avg = sum / numericValues.length;
      const chart = {
        chart: { type: 'line' },
        title: { text: `${humanizeMetricName(binding.fieldName)} trend` },
        xAxis: { type: 'datetime' },
        yAxis: { title: { text: humanizeMetricName(binding.fieldName) } },
        series: [{
          name: `${friendlyRoom} ${humanizeMetricName(binding.fieldName)}`,
          dataRef: { tool: 'fetch_timeseries', room: fetchArgs.room, table: fetchArgs.table, xField: 'ts', yField: binding.fieldName }
        }]
      };
      const summaryRange = describeRangeWindow(rr);
      const overview = `Overview: ${humanizeMetricName(binding.fieldName)} ranged from ${formatNumericValue(min)} to ${formatNumericValue(max)} ${summaryRange}.`;
      const details = [
        `Details: analyzed ${numericValues.length} samples for ${friendlyRoom} via fetch_timeseries.`,
        `Average ${humanizeMetricName(binding.fieldName)} was ${formatNumericValue(avg)}; peak ${formatNumericValue(max)} at ${peakTs ? formatLocal(peakTs) : 'n/a'}.`
      ];
      const answer = `${overview} ${details.join(' ')}`.trim();
      emergencyTrace.push({ tool: 'fetch_timeseries', args: fetchArgs, result: rows });
      ensureChartData(chart, { question, room: fetchArgs.room, selectionRooms, range: rr, trace: emergencyTrace });
      return {
        message: assistantMessage(answer),
        chart,
        trace: emergencyTrace
      };
    } catch (err) {
      log('Emergency analysis failed:', String(err));
      return null;
    }
  }

  function inferDeviceFromQuestion(question) {
    const q = String(question || '').toLowerCase();
    if (!q) return null;
    try {
      for (const [alias, cloudId] of FRIENDLY_TO_CLOUD.entries()) {
        if (!alias || !cloudId) continue;
        const normAlias = String(alias).trim().toLowerCase();
        if (!normAlias || normAlias.length < 3) continue;
        if (q.includes(normAlias)) return cloudId;
        const sanitized = normAlias.replace(/[^a-z0-9]/g, '');
        if (sanitized.length >= 3 && q.replace(/[^a-z0-9]/g, '').includes(sanitized)) return cloudId;
      }
    } catch {}
    return null;
  }

  function buildDefaultAnswer({
    question,
    chart,
    trace,
    fallbackText = '',
    knowledgeSnippets = '',
    includeKnowledge = false,
    notes = [],
    range = null
  }) {
    const qNorm = normalizeText(question);
    let base = typeof fallbackText === 'string' ? fallbackText.trim() : '';
    if (base && (base.startsWith('{') || base.startsWith('['))) base = '';
    if (base && normalizeText(base) === qNorm) base = '';
    if (base && PLACEHOLDER_ANSWER_PATTERNS.some((pattern) => pattern.test(base))) base = '';

    const parts = [];
    const addPart = (text) => {
      const trimmed = (text || '').trim();
      if (!trimmed) return;
      if (parts.some((existing) => existing.includes(trimmed) || trimmed.includes(existing))) return;
      parts.push(trimmed);
    };

    const hasData = traceHasData(trace);
    const timeseriesInsights = deriveTimeseriesInsights({ trace, question, range });
    timeseriesInsights.forEach(addPart);

    if (base && !/^Reminder:/i.test(base) && !/^MANDATORY:/i.test(base)) addPart(base);

    const hasToolFailure = Array.isArray(trace) && trace.some((t) => {
      if (!t || !t.result) return false;
      if (t.result.error) return true;
      if (typeof t.result.n === 'number' && t.result.n === 0 && String(t.tool || '').startsWith('correlate')) return true;
      return false;
    });

    const chartSummary = hasToolFailure ? '' : summarizeChart(chart);
    addPart(chartSummary);

    const insight = traceInsight(trace);
    addPart(insight);

    if (Array.isArray(notes) && notes.length) {
      addPart(notes.filter(Boolean).join(' '));
    }

    if (!hasData) {
      parts.length = 0;
      addPart('No telemetry data was available for the selected scope and time window; adjust the range or choose a different scope.');
    }

    if (!parts.length) {
      addPart('I analyzed the available data for the selected scope and time window.');
    }

    let answer = parts.join(' ');
    if (includeKnowledge && knowledgeSnippets && knowledgeSnippets.trim()) {
      const hint = shortenKnowledgeSnippet(knowledgeSnippets);
      if (hint) {
        answer += `\nHint: ${hint}`;
      }
    }
    return answer;
  }

  function formatPlanSummary(planStatus = []) {
    if (!Array.isArray(planStatus) || !planStatus.length) return '';
    return planStatus
      .map((step, idx) => {
        if (!step) return null;
        const marker = step.done ? 'x' : ' ';
        const label = step.text || step.description || step.goal || '';
        const index = step.index ?? step.id ?? idx + 1;
        return `[${marker}] Step ${index}: ${label}`;
      })
      .filter(Boolean)
      .join(' | ');
  }

  function enforceOverviewDetails(answer, { range = null, trace = [], planStatus = [] } = {}) {
    let out = String(answer || '').trim();
    if (!out) out = 'No findings were produced for the selected scope.';
    const rangeText = describeRangeWindow(range);
    if (!/^overview:/i.test(out)) {
      const suffix = rangeText ? ` (${rangeText})` : '';
      out = `Overview: ${out}${suffix}`;
    }
    if (!/Details:/i.test(out)) {
      const detailParts = [];
      const insight = traceInsight(trace);
      if (insight) detailParts.push(insight);
      const planSummary = formatPlanSummary(planStatus);
      if (planSummary) detailParts.push(`Plan status: ${planSummary}`);
      if (!detailParts.length) {
        detailParts.push('Derived from the executed tools for the current selection.');
      }
      out += `\nDetails: ${detailParts.join(' ')}`;
    }
    return out;
  }

  function summarizeDeviceMetrics(deviceId) {
    const info = lookupDeviceHierarchy(deviceId);
    const candidates = [];
    const primaryId = info?.cloudId || info?.deviceId || info?.numericId || String(deviceId).trim();
    const addCandidate = (value) => {
      if (!value) return;
      const key = String(value).trim();
      if (!key) return;
      if (!candidates.includes(key)) candidates.push(key);
    };
    addCandidate(deviceId);
    if (info?.cloudId) addCandidate(info.cloudId);
    if (info?.deviceId) addCandidate(info.deviceId);
    if (info?.numericId) addCandidate(info.numericId);
    if (info?.name && FRIENDLY_TO_CLOUD.has(info.name)) addCandidate(FRIENDLY_TO_CLOUD.get(info.name));

    for (const id of candidates) {
      const metrics = CSV_DEVICE_METRICS.get(id);
      if (metrics && metrics.length) {
        const arr = Array.from(new Set(metrics)).sort();
        if (id !== primaryId && arr.length) CSV_DEVICE_METRICS.set(primaryId, arr);
        return arr;
      }
    }

    for (const id of candidates) {
      try {
        const tables = loadRoomTablesRaw(id);
        const fields = new Set();
        for (const rows of Object.values(tables || {})) {
          if (!Array.isArray(rows) || !rows.length) continue;
          const first = rows[0] || {};
          for (const key of Object.keys(first)) {
            if (key && key !== 'ts') fields.add(key);
          }
        }
        if (fields.size) {
          const arr = Array.from(fields).sort();
          CSV_DEVICE_METRICS.set(id, arr);
          if (id !== primaryId) CSV_DEVICE_METRICS.set(primaryId, arr);
          return arr;
        }
      } catch {}
    }

    return [];
  }

  function buildScopeSummary({
    selectionRooms = [],
    selectionZones = [],
    selectionFloors = [],
    scopeDeviceZones = {},
    selectionLabels = {},
    range = {},
    maxDevices = 60
  }) {
    const rr = range || {};
    const adaptationNotes = [];
    const tenantLabel = selectionLabels?.tenant || null;
    const buildingLabel = selectionLabels?.building || null;
    const floorLabel = selectionLabels?.floor || null;
    const zoneLabel = selectionLabels?.room || null;

    const deviceMap = new Map();
    const addDeviceEntry = (deviceId) => {
      if (!deviceId || deviceMap.size >= maxDevices) return;
      if (String(deviceId).trim().toLowerCase() === 'all') return;
      const info = lookupDeviceHierarchy(deviceId) || {};
      const primaryId = info.cloudId || String(deviceId).trim();
      const key = normalizeDeviceKey(primaryId, true);
      if (!key || deviceMap.has(key)) return;

      const snapMeta = (!info.zoneName || !info.buildingName || !info.floorName)
        ? (findSnapshotDevice(primaryId) || findSnapshotDevice(deviceId))
        : null;
      const zoneEntry = (info.zoneId && graphHierarchy) ? graphHierarchy.zoneById.get(info.zoneId) : null;
      const floorEntry = ((zoneEntry?.floorId || info.floorId) && graphHierarchy)
        ? graphHierarchy.floorById.get(zoneEntry?.floorId || info.floorId)
        : null;
      const buildingEntry = ((zoneEntry?.buildingId || info.buildingId) && graphHierarchy)
        ? graphHierarchy.buildingById.get(zoneEntry?.buildingId || info.buildingId)
        : null;

      const buildingName =
        info.buildingName ||
        buildingEntry?.name ||
        snapMeta?.buildingName ||
        buildingLabel ||
        '—';
      const floorName =
        info.floorName ||
        floorEntry?.name ||
        snapMeta?.floorName ||
        floorLabel ||
        '—';
      const derivedZoneName =
        scopeDeviceZones?.[primaryId] ||
        scopeDeviceZones?.[deviceId] ||
        info.zoneName ||
        snapMeta?.zoneName ||
        zoneLabel ||
        '—';
      const metrics = summarizeDeviceMetrics(primaryId).slice(0, 12);
      const shortId = primaryId && primaryId.length > 12 ? `${primaryId.slice(0, 12)}…` : primaryId;
      deviceMap.set(key, {
        id: primaryId,
        shortId,
        name: info.name || snapMeta?.name || primaryId,
        friendlyName: deviceFriendlyName(primaryId),
        type: info.type || snapMeta?.type || null,
        buildingName,
        floorName,
        zoneName: derivedZoneName,
        metrics
      });
    };

    selectionRooms.forEach((id) => addDeviceEntry(id));

    if (deviceMap.size === 0 && selectionZones.length) {
      for (const zone of selectionZones) {
        const devices = collectDevicesForZone(zone, { building: selectionLabels?.building, floor: selectionLabels?.floor });
        for (const entry of devices) addDeviceEntry(entry.cloudId || entry.primaryId);
      }
    }

    if (deviceMap.size === 0 && selectionFloors.length) {
      for (const floor of selectionFloors) {
        const devices = collectDevicesForFloor(floor, { building: selectionLabels?.building });
        for (const entry of devices) addDeviceEntry(entry.cloudId || entry.primaryId);
      }
    }

    if (deviceMap.size === 0 && selectionLabels?.building) {
      const devices = collectDevicesForBuilding(selectionLabels.building);
      for (const entry of devices) addDeviceEntry(entry.cloudId || entry.primaryId);
    }

    if (deviceMap.size === 0 && graphHierarchy) {
      // As a final fallback, include the first N devices we know about
      let count = 0;
      for (const entry of graphHierarchy.deviceByKey.values()) {
        if (entry && entry.cloudId) {
          addDeviceEntry(entry.cloudId);
          count += 1;
          if (count >= maxDevices) break;
        }
      }
    }

    const grouped = new Map();
    for (const info of deviceMap.values()) {
      const buildingName = info.buildingName || '—';
      if (!grouped.has(buildingName)) grouped.set(buildingName, new Map());
      const floorMap = grouped.get(buildingName);
      const floorName = info.floorName || '—';
      if (!floorMap.has(floorName)) floorMap.set(floorName, new Map());
      const zoneMap = floorMap.get(floorName);
      const zoneName = info.zoneName || '—';
      if (!zoneMap.has(zoneName)) zoneMap.set(zoneName, []);
      zoneMap.get(zoneName).push(info);
    }

    const normalizeLabel = (val) => String(val || '').trim().toLowerCase();
    if (buildingLabel) {
      const buildingNorm = normalizeLabel(buildingLabel);
      for (const key of Array.from(grouped.keys())) {
        if (normalizeLabel(key) !== buildingNorm) grouped.delete(key);
      }
    }

    const sortByName = (arr) => arr.sort((a, b) => String(a).localeCompare(String(b)));

    const buildingNames = sortByName(Array.from(grouped.keys()));
    const formatLines = [];
    formatLines.push('Scope:');
    if (tenantLabel) formatLines.push(`Tenant: ${tenantLabel}`);
    if (buildingLabel && !buildingNames.includes(buildingLabel)) formatLines.push(`Building (selected): ${buildingLabel}`);
    if (floorLabel) formatLines.push(`Floor (selected): ${floorLabel}`);
    if (zoneLabel) formatLines.push(`Zone (selected): ${zoneLabel}`);
    if (formatLines[formatLines.length - 1] !== 'Scope:') formatLines.push('');

    for (const buildingName of buildingNames) {
      formatLines.push(buildingName);
      const floorMap = grouped.get(buildingName);
      if (floorLabel) {
        const floorNorm = normalizeLabel(floorLabel);
        for (const key of Array.from(floorMap.keys())) {
          if (normalizeLabel(key) !== floorNorm) floorMap.delete(key);
        }
      }
      const floorNames = sortByName(Array.from(floorMap.keys()));
      for (const floorName of floorNames) {
        formatLines.push(`  ${floorName}`);
        const zoneMap = floorMap.get(floorName);
        if (zoneLabel) {
          const zoneNorm = normalizeLabel(zoneLabel);
          for (const key of Array.from(zoneMap.keys())) {
            if (normalizeLabel(key) !== zoneNorm) zoneMap.delete(key);
          }
        }
        const zoneNames = sortByName(Array.from(zoneMap.keys()));
        for (const zoneName of zoneNames) {
          formatLines.push(`    ${zoneName}`);
          const devices = zoneMap.get(zoneName).slice(0, 8);
          for (const device of devices) {
            const typeSuffix = device.type ? ` [${device.type}]` : '';
            const metricsPreview = device.metrics.length ? device.metrics.slice(0, 12).join(', ') : 'n/a';
            const stats = getCsvStats(device.id);
            const telemetryNote = describeTelemetryCoverage(stats, rr);
            formatLines.push(`      ${device.name}${typeSuffix} (${device.shortId}) — metrics: ${metricsPreview} | ${telemetryNote}`);
          }
          if (zoneMap.get(zoneName).length > devices.length) {
            formatLines.push(`      … ${zoneMap.get(zoneName).length - devices.length} more devices`);
          }
        }
        formatLines.push('');
      }
    }

    if (!deviceMap.size) {
      formatLines.push('No devices resolved for the current scope (CSV data missing or mapping incomplete).');
      formatLines.push('');
    }

    formatLines.push('Time window:');
    if (rr.start != null && rr.end != null) {
      formatLines.push(`- Local: ${formatLocal(rr.start)} → ${formatLocal(rr.end)}`);
      formatLines.push(`- UTC: ${formatUtc(rr.start)} → ${formatUtc(rr.end)}`);
    } else if (rr.start != null) {
      formatLines.push(`- Local start: ${formatLocal(rr.start)}`);
      formatLines.push(`- UTC start: ${formatUtc(rr.start)}`);
    } else if (rr.end != null) {
      formatLines.push(`- Local end: ${formatLocal(rr.end)}`);
      formatLines.push(`- UTC end: ${formatUtc(rr.end)}`);
    } else {
      formatLines.push('- Local: not set');
    }
    formatLines.push(`- Epoch (ms): start=${rr.start ?? 'none'}, end=${rr.end ?? 'none'}`);

    return formatLines.join('\n');
  }

  function summarizeConnectorStatus(connectors = []) {
    if (!Array.isArray(connectors) || !connectors.length) return '';
    const parts = connectors
      .filter(Boolean)
      .map((entry) => {
        const name = entry.label || entry.id || 'connector';
        const status = String(entry.status || 'unknown').toUpperCase();
        return `${name}:${status}${entry.detail ? ` (${entry.detail})` : ''}`;
      });
    return parts.length ? `Connector health — ${parts.join(' | ')}` : '';
  }

  function getCsvStats(deviceId) {
    const id = String(deviceId || '').trim();
    if (!id) return { tsMin: null, tsMax: null, count: 0 };
    const cached = CSV_STATS_CACHE.get(id);
    if (cached && cached !== null) return cached;
    const filePath = path.join(s3LocalDir, `${id}.csv`);
    let stats = { tsMin: null, tsMax: null, count: 0 };
    if (fs.existsSync(filePath)) {
      try {
        const text = fs.readFileSync(filePath, 'utf8');
        const lines = text.split(/\r?\n/);
        for (let i = 1; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;
          const [tsRaw] = line.split(',');
          const ts = Number(tsRaw);
          if (!Number.isFinite(ts)) continue;
          stats.count += 1;
          if (stats.tsMin == null || ts < stats.tsMin) stats.tsMin = ts;
          if (stats.tsMax == null || ts > stats.tsMax) stats.tsMax = ts;
        }
      } catch (err) {
        if (DEBUG) log('getCsvStats failed', id, String(err));
        stats = { tsMin: null, tsMax: null, count: 0 };
      }
    }
    CSV_STATS_CACHE.set(id, stats);
    return stats;
  }

  function rangesOverlap(aStart, aEnd, bStart, bEnd) {
    if (!Number.isFinite(aStart) || !Number.isFinite(aEnd) || !Number.isFinite(bStart) || !Number.isFinite(bEnd)) {
      return true;
    }
    return aStart <= bEnd && bStart <= aEnd;
  }

  function describeTelemetryCoverage(stats, range = {}) {
    if (!stats || !Number.isFinite(stats.tsMin) || !Number.isFinite(stats.tsMax)) {
      return 'telemetry: missing (no CSV rows)';
    }
    const coverageRange = { start: stats.tsMin, end: stats.tsMax };
    const coverageText = describeRangeWindow(coverageRange);
    const hasSelection = Number.isFinite(range?.start) || Number.isFinite(range?.end);
    if (hasSelection) {
      const overlaps = rangesOverlap(range.start ?? stats.tsMin, range.end ?? stats.tsMax, stats.tsMin, stats.tsMax);
      return overlaps
        ? `telemetry: ${coverageText} (covers selection)`
        : `telemetry: ${coverageText} (no data within selected window)`;
    }
    return `telemetry: ${coverageText}`;
  }

  function aggregateSelectionCoverage({ selectionRooms = [], selectionZones = [], scopeLabels = {}, fallbackRoom = null } = {}) {
    const spans = [];
    const seen = new Set();
    const pushDevice = (deviceId) => {
      if (!deviceId) return;
      const normalized = normalizeRoomId(deviceId) || deviceId;
      if (!normalized || seen.has(normalized)) return;
      if (!deviceTablesAvailable(normalized)) return;
      seen.add(normalized);
      const stats = getCsvStats(normalized);
      if (!stats || !Number.isFinite(stats.tsMin) || !Number.isFinite(stats.tsMax)) return;
      spans.push({ start: stats.tsMin, end: stats.tsMax });
    };
    if (Array.isArray(selectionRooms) && selectionRooms.length) {
      selectionRooms.forEach(pushDevice);
    }
    if (!spans.length && Array.isArray(selectionZones)) {
      for (const zone of selectionZones) {
        const entries = collectDevicesForZone(zone, scopeLabels);
        entries.forEach((entry) => pushDevice(entry.cloudId || entry.primaryId || entry.id));
        if (spans.length) break;
      }
    }
    if (!spans.length && currentScopeContext.scopeDeviceZones) {
      Object.keys(currentScopeContext.scopeDeviceZones).forEach(pushDevice);
    }
    if (!spans.length && Array.isArray(currentScopeContext.selectionRooms)) {
      currentScopeContext.selectionRooms.forEach(pushDevice);
    }
    if (!spans.length && fallbackRoom) {
      pushDevice(fallbackRoom);
    }
    if (!spans.length) return null;
    return {
      start: Math.min(...spans.map((s) => s.start)),
      end: Math.max(...spans.map((s) => s.end))
    };
  }

  function alignRangeToTelemetry(range = {}, { selectionRooms = [], selectionZones = [], scopeLabels = {}, fallbackRoom = null } = {}) {
    const coverage = aggregateSelectionCoverage({ selectionRooms, selectionZones, scopeLabels, fallbackRoom });
    if (!coverage) return { range: range || {}, changed: false, coverage: null };
    let start = Number.isFinite(range?.start) ? Number(range.start) : coverage.end - 7 * DAY_MS;
    let end = Number.isFinite(range?.end) ? Number(range.end) : coverage.end;
    if (!Number.isFinite(start)) start = coverage.start;
    if (!Number.isFinite(end)) end = coverage.end;
    let changed = false;
    if (end < coverage.start || start > coverage.end) {
      end = coverage.end;
      start = Math.max(coverage.start, coverage.end - 7 * DAY_MS);
      changed = true;
    }
    const clampedStart = Math.max(start, coverage.start);
    const clampedEnd = Math.min(end, coverage.end);
    if (clampedStart !== start || clampedEnd !== end) changed = true;
    return {
      range: { start: clampedStart, end: clampedEnd },
      changed,
      coverage
    };
  }

  function deviceTablesAvailable(deviceId) {
    if (!deviceId) return false;
    const candidates = new Set();
    const direct = String(deviceId).trim();
    if (direct) candidates.add(direct);
    const mapped = friendlyLookup(deviceId);
    if (mapped) candidates.add(mapped);
    const hier = lookupDeviceHierarchy(deviceId);
    if (hier?.cloudId) candidates.add(String(hier.cloudId).trim());
    if (hier?.deviceId) candidates.add(String(hier.deviceId).trim());
    if (hier?.numericId) candidates.add(String(hier.numericId).trim());
    for (const val of candidates) {
      if (!val) continue;
      const stats = getCsvStats(val);
      if (stats.count > 0 && csvHasMetricColumns(val)) return true;
    }
    return false;
  }

  function resolveDeviceIdForRoom(room) {
    const raw = String(room ?? '').trim();
    if (!raw) return null;
    const candidates = [];
    const lower = raw.toLowerCase();
    const cleaned = raw.replace(/\s*\(.*?\)\s*$/, '').trim();
    const cleanedLower = cleaned.toLowerCase();
    const pushCandidate = (id) => {
      if (!id) return;
      const val = String(id).trim();
      if (!val) return;
      if (!candidates.includes(val)) candidates.push(val);
    };
    pushCandidate(raw);
    const aliasRaw = friendlyLookup(raw);
    if (aliasRaw) pushCandidate(aliasRaw);
    if (cleaned && cleaned !== raw) {
      pushCandidate(cleaned);
      const aliasClean = friendlyLookup(cleaned);
      if (aliasClean) pushCandidate(aliasClean);
    }
    const hier = lookupDeviceHierarchy(raw);
    if (hier?.cloudId) pushCandidate(hier.cloudId);
    if (hier?.deviceId && hier.deviceId !== hier.cloudId) pushCandidate(hier.deviceId);
    const scopeMap = currentScopeContext.scopeDeviceZones || {};
    for (const [deviceId, zoneName] of Object.entries(scopeMap)) {
      if (!zoneName) continue;
      const zoneLabel = resolveZoneLabelDisplay(zoneName, currentScopeContext.scopeLabels || {});
      const variants = new Set();
      variants.add(String(zoneName).trim().toLowerCase());
      if (zoneLabel) variants.add(String(zoneLabel).trim().toLowerCase());
      for (const zoneLower of variants) {
        if (!zoneLower) continue;
        if (lower === zoneLower || cleanedLower === zoneLower || lower.includes(zoneLower) || zoneLower.includes(lower)) {
          pushCandidate(deviceId);
          const alias = friendlyLookup(zoneLabel || zoneName);
          if (alias) pushCandidate(alias);
          break;
        }
      }
    }
    try {
      const match = raw.match(/^\s*([^(]+?)\s*(?:\(([^,]+),\s*([^)]+)\))?\s*$/);
      if (match) {
        const zoneLabel = match[1]?.trim();
        const floorLabel = match[2]?.trim();
        const buildingLabel = match[3]?.trim();
        if (zoneLabel) {
          const zoneDevices = collectDevicesForZone(zoneLabel, { building: buildingLabel, floor: floorLabel });
          zoneDevices.forEach((entry) => pushCandidate(entry.cloudId || entry.id));
        }
      }
    } catch {}
    const scopeRooms = currentScopeContext.selectionRooms || [];
    for (const deviceId of scopeRooms) pushCandidate(deviceId);
    const zoneDevices = collectDevicesForZone(raw, currentScopeContext.scopeLabels || {});
    zoneDevices.forEach((entry) => pushCandidate(entry.cloudId || entry.primaryId || entry.id));
    if (snapshotIndex) {
      const snapZone = findSnapshotZone(raw, currentScopeContext.scopeLabels || {});
      if (snapZone) {
        const snapEntries = buildDeviceEntriesFromSnapshotZone(snapZone);
        snapEntries.forEach((entry) => pushCandidate(entry.cloudId || entry.primaryId || entry.id));
      }
    }
    for (const candidate of candidates) {
      if (deviceTablesAvailable(candidate)) return candidate;
      const meta = lookupDeviceHierarchy(candidate);
      if (meta?.cloudId && deviceTablesAvailable(meta.cloudId)) return meta.cloudId;
    }
    return candidates.find((c) => deviceTablesAvailable(c)) || candidates.find((c) => c !== raw) || raw;
  }

  function normalizeRoomId(room) {
    if (!room) return room;
    const resolved = resolveDeviceIdForRoom(room);
    if (resolved && resolved !== room && deviceTablesAvailable(resolved)) return resolved;
    return room;
  }

  function loadRoomTables(room) {
    const tables = loadRoomTablesRaw(room);
    if (tables && Object.keys(tables).length) return tables;
    const resolved = normalizeRoomId(room);
    if (resolved && resolved !== room) {
      const fallback = loadRoomTablesRaw(resolved);
      if (fallback && Object.keys(fallback).length) return fallback;
    }
    return tables;
  }

  function loadGraphFormHierarchy() {
  // GraphForm exports are deprecated; rely solely on the live Neo4j snapshot.
  return null;
}

function buildSnapshotIndex() {
    try {
      const snap = loadGraphSnapshot();
      if (!snap || !Array.isArray(snap.nodes) || !Array.isArray(snap.links)) return null;
      const nodesById = new Map();
      for (const node of snap.nodes) {
        if (!node || !node.id) continue;
        nodesById.set(node.id, node);
      }
      const typeOf = (node) => (node?.nodeType || node?.label || null);
      const zoneInfos = new Map();
      const floorInfos = new Map();
      const buildingInfos = new Map();
      const deviceInfos = new Map();
      const pickSingleId = (inputSet, infoMap, contextLabel) => {
        if (!inputSet || !inputSet.size) return null;
        if (inputSet.size === 1) return inputSet.values().next().value;
        const entries = Array.from(inputSet);
        entries.sort((a, b) => {
          const nameA = infoMap?.get?.(a)?.name || '';
          const nameB = infoMap?.get?.(b)?.name || '';
          return nameA.localeCompare(nameB);
        });
        const chosen = entries[0];
        inputSet.clear();
        inputSet.add(chosen);
        console.warn(`[graph][snapshot] ${contextLabel} had multiple attachments; defaulting to ${chosen}`);
        return chosen;
      };
      const resolveGraphFormZone = (zone) => {
        if (!graphHierarchy || !zone) return null;
        const roomId = normalizeId(zone.roomId);
        if (roomId && graphHierarchy.zoneById?.has(roomId)) {
          return graphHierarchy.zoneById.get(roomId);
        }
        const zoneName = normalizeName(zone.name);
        if (!zoneName) return null;
        const matches = graphHierarchy.zoneNameIndex?.get(zoneName) || [];
        if (!matches.length) return null;
        if (zone.buildingIds?.size) {
          const buildingNameSet = new Set(
            Array.from(zone.buildingIds)
              .map((buildingId) => {
                const building = buildingInfos.get(buildingId);
                return building?.name ? normalizeName(building.name) : null;
              })
              .filter(Boolean)
          );
          const filtered = matches.filter((entry) => {
            const entryName = entry.buildingName ? normalizeName(entry.buildingName) : null;
            if (!entryName || !buildingNameSet.size) return true;
            return buildingNameSet.has(entryName);
          });
          if (filtered.length === 1) return filtered[0];
          if (filtered.length > 1) return filtered[0];
        }
        return matches[0] || null;
      };
      const matchesFloorCandidate = (floorId, targetFloorName, targetBuildingName) => {
        const floor = floorInfos.get(floorId);
        if (!floor) return false;
        if (targetFloorName) {
          const name = floor.name ? normalizeName(floor.name) : null;
          if (!name || name !== targetFloorName) return false;
        }
        if (targetBuildingName) {
          const hasMatch = Array.from(floor.buildingIds || []).some((buildingId) => {
            const building = buildingInfos.get(buildingId);
            if (!building?.name) return false;
            return normalizeName(building.name) === targetBuildingName;
          });
          if (!hasMatch) return false;
        }
        return true;
      };
      const preferGraphFormAttachmentsForZone = (zone) => {
        if (!graphHierarchy || !zone) return;
        const zoneEntry = resolveGraphFormZone(zone);
        if (!zoneEntry) return;
        const targetFloorName = zoneEntry.floorName ? normalizeName(zoneEntry.floorName) : null;
        const targetBuildingName = zoneEntry.buildingName ? normalizeName(zoneEntry.buildingName) : null;
        if (targetBuildingName && zone.buildingIds && zone.buildingIds.size > 1) {
          const matches = Array.from(zone.buildingIds).filter((buildingId) => {
            const building = buildingInfos.get(buildingId);
            if (!building?.name) return false;
            return normalizeName(building.name) === targetBuildingName;
          });
          if (matches.length === 1) {
            zone.buildingIds.clear();
            zone.buildingIds.add(matches[0]);
          }
        }
        if (targetFloorName && zone.floorIds && zone.floorIds.size > 1) {
          const matches = Array.from(zone.floorIds).filter((floorId) =>
            matchesFloorCandidate(floorId, targetFloorName, targetBuildingName)
          );
          if (matches.length === 1) {
            zone.floorIds.clear();
            zone.floorIds.add(matches[0]);
          }
        }
      };
      for (const node of snap.nodes) {
        const type = typeOf(node);
        if (type === 'Zone') {
          zoneInfos.set(node.id, {
            id: node.id,
            name: node.name || null,
            roomId: node.roomId != null ? String(node.roomId) : null,
            node,
            floorIds: new Set(),
            buildingIds: new Set(),
            deviceIds: new Set()
          });
        } else if (type === 'Floor') {
          floorInfos.set(node.id, {
            id: node.id,
            name: node.name || null,
            node,
            buildingIds: new Set(),
            zoneIds: new Set(),
            deviceIds: new Set()
          });
        } else if (type === 'Building') {
          buildingInfos.set(node.id, {
            id: node.id,
            name: node.name || null,
            node,
            floorIds: new Set(),
            zoneIds: new Set(),
            deviceIds: new Set()
          });
        } else if (type === 'Device') {
          const cloudId = node.cloudId || node.name || node.id || null;
          deviceInfos.set(node.id, {
            id: node.id,
            name: node.name || null,
            cloudId: cloudId ? String(cloudId) : null,
            type: node.deviceType || node.type || null,
            node,
            zoneIds: new Set(),
            floorIds: new Set(),
            buildingIds: new Set()
          });
        }
      }
      for (const link of snap.links) {
        if (!link) continue;
        const { source, target, rel } = link;
        if (!source || !target || !rel) continue;
        if (rel === 'LOCATED_IN_ZONE') {
          const zone = zoneInfos.get(target);
          const device = deviceInfos.get(source);
          if (zone && device && device.cloudId) {
            zone.deviceIds.add(device.cloudId);
            device.zoneIds.add(zone.id);
          }
        } else if (rel === 'BELONGS_TO_FLOOR') {
          const zone = zoneInfos.get(source);
          const floor = floorInfos.get(target);
          if (zone && floor) {
            zone.floorIds.add(floor.id);
            floor.zoneIds.add(zone.id);
          }
        } else if (rel === 'LOCATED_ON_FLOOR') {
          const device = deviceInfos.get(source);
          const floor = floorInfos.get(target);
          if (device && floor) {
            device.floorIds.add(floor.id);
            floor.deviceIds.add(device.id);
          }
        } else if (rel === 'LOCATED_IN_BUILDING') {
          const building = buildingInfos.get(target);
          if (!building) continue;
          const srcType = typeOf(nodesById.get(source));
          if (srcType === 'Zone') {
            const zone = zoneInfos.get(source);
            if (zone) {
              zone.buildingIds.add(building.id);
              building.zoneIds.add(zone.id);
            }
          } else if (srcType === 'Floor') {
            const floor = floorInfos.get(source);
            if (floor) {
              floor.buildingIds.add(building.id);
              building.floorIds.add(floor.id);
            }
          } else if (srcType === 'Device') {
            const device = deviceInfos.get(source);
            if (device) {
              device.buildingIds.add(building.id);
              building.deviceIds.add(device.id);
            }
          }
        } else if (rel === 'IN_BUILDING') {
          const device = deviceInfos.get(source);
          const building = buildingInfos.get(target);
          if (device && building) {
            device.buildingIds.add(building.id);
            building.deviceIds.add(device.id);
          }
        }
      }
      buildingInfos.forEach((building, id) => {
        if (!building.floorIds.size) {
          for (const [floorId, floor] of floorInfos.entries()) {
            if (floor.buildingIds.has(id)) building.floorIds.add(floorId);
          }
        }
        if (!building.zoneIds.size) {
          for (const [zoneId, zone] of zoneInfos.entries()) {
            if (zone.buildingIds.has(id)) building.zoneIds.add(zoneId);
          }
        }
      });
      floorInfos.forEach((floor, id) => {
        if (!floor.buildingIds.size) {
          for (const [buildingId, building] of buildingInfos.entries()) {
            if (building.floorIds.has(id)) floor.buildingIds.add(buildingId);
          }
        }
        pickSingleId(floor.buildingIds, buildingInfos, `Floor ${id} building`);
      });
      zoneInfos.forEach((zone) => {
        if (!zone.buildingIds.size) {
          zone.floorIds.forEach((floorId) => {
            const floor = floorInfos.get(floorId);
            if (floor) {
              floor.buildingIds.forEach((buildingId) => zone.buildingIds.add(buildingId));
            }
          });
        }
        preferGraphFormAttachmentsForZone(zone);
        pickSingleId(zone.floorIds, floorInfos, `Zone ${zone.id} floor`);
        pickSingleId(zone.buildingIds, buildingInfos, `Zone ${zone.id} building`);
      });
      const zoneRecords = new Map();
      const zoneByName = new Map();
      const zoneByRoomId = new Map();
      const addToMapList = (map, key, value) => {
        if (!key) return;
        const list = map.get(key) || [];
        list.push(value);
        map.set(key, list);
      };
      zoneInfos.forEach((zone, zoneId) => {
        const floorId = zone.floorIds.values().next().value || null;
        const floor = floorId ? floorInfos.get(floorId) : null;
        const buildingId = zone.buildingIds.values().next().value || null;
        const building = buildingId ? buildingInfos.get(buildingId) : null;
        const record = {
          id: zoneId,
          name: zone.name || null,
          roomId: zone.roomId || null,
          floorId,
          floorName: floor?.name || null,
          buildingId,
          buildingName: building?.name || null,
          devices: Array.from(zone.deviceIds || []),
          node: zone.node || null
        };
        zoneRecords.set(zoneId, record);
        if (record.name) addToMapList(zoneByName, record.name.toLowerCase(), record);
        if (record.roomId) addToMapList(zoneByRoomId, String(record.roomId).toLowerCase(), record);
      });
      const deviceMetaById = new Map();
      const deviceMetaCanonical = new Map();
      deviceInfos.forEach((device) => {
        const cloudId = device.cloudId ? String(device.cloudId) : null;
        if (!cloudId) return;
        const zoneId = device.zoneIds.values().next().value || null;
        const zoneRecord = zoneId ? zoneRecords.get(zoneId) : null;
        let floorId = device.floorIds.values().next().value || null;
        let floorRecord = floorId ? floorInfos.get(floorId) : null;
        if (!floorRecord && zoneRecord?.floorId) {
          floorId = zoneRecord.floorId;
          floorRecord = floorInfos.get(floorId);
        }
        let buildingId = device.buildingIds.values().next().value || null;
        let buildingRecord = buildingId ? buildingInfos.get(buildingId) : null;
        if (!buildingRecord && zoneRecord?.buildingId) {
          buildingId = zoneRecord.buildingId;
          buildingRecord = buildingInfos.get(buildingId);
        } else if (!buildingRecord && floorRecord) {
          const bId = floorRecord.buildingIds.values().next().value || null;
          if (bId && buildingInfos.has(bId)) {
            buildingId = bId;
            buildingRecord = buildingInfos.get(bId);
          }
        }
        const meta = {
          cloudId,
          name: device.name || cloudId,
          type: device.type || null,
          zoneId,
          zoneName: zoneRecord?.name || null,
          floorId,
          floorName: floorRecord?.name || null,
          buildingId,
          buildingName: buildingRecord?.name || null,
          node: device.node || null
        };
        deviceMetaById.set(cloudId, meta);
        if (device.node?.id) deviceMetaById.set(device.node.id, meta);
        deviceMetaCanonical.set(cloudId.toLowerCase(), meta);
      });
      const floorRecords = new Map();
      const floorByName = new Map();
      floorInfos.forEach((floor, floorId) => {
        const buildingId = floor.buildingIds.values().next().value || null;
        const building = buildingId ? buildingInfos.get(buildingId) : null;
        const record = {
          id: floorId,
          name: floor.name || null,
          buildingId,
          buildingName: building?.name || null,
          zoneIds: Array.from(floor.zoneIds || []),
          node: floor.node || null
        };
        floorRecords.set(floorId, record);
        if (record.name) addToMapList(floorByName, record.name.toLowerCase(), record);
      });
      const buildingRecords = new Map();
      const buildingByName = new Map();
      buildingInfos.forEach((building, buildingId) => {
        const record = {
          id: buildingId,
          name: building.name || null,
          floorIds: Array.from(building.floorIds || []),
          zoneIds: Array.from(building.zoneIds || []),
          deviceIds: Array.from(building.deviceIds || []),
          node: building.node || null
        };
        buildingRecords.set(buildingId, record);
        if (record.name) addToMapList(buildingByName, record.name.toLowerCase(), record);
      });
      return {
        raw: snap,
        nodesById,
        zoneById: zoneRecords,
        zoneByName,
        zoneByRoomId,
        deviceMeta: deviceMetaById,
        deviceMetaCanonical,
        floorById: floorRecords,
        floorByName,
        buildingById: buildingRecords,
        buildingByName
      };
    } catch (err) {
      if (DEBUG) log('snapshot index build failed:', String(err));
      return null;
    }
  }

  function toolDefs() {
    return [
      { name: 'list_rooms', args: {}, desc: 'List available rooms' },
      { name: 'list_tables', args: { room: 'string' }, desc: 'List available tables in a room' },
      { name: 'get_schema', args: { room: 'string', table: 'string' }, desc: 'Get first row keys for a table' },
      { name: 'fetch_timeseries', args: { room: 'string', table: 'string', fields: 'string[]', start: 'number?', end: 'number?', limit: 'number?', after_ts: 'number?' }, desc: 'Fetch timeseries points as [{ts, field1, ...}] with optional paging using after_ts' },
      { name: 'compare_series_cross_room', args: { series: '[{room:string,table:string,field:string,name?:string}]', start: 'number?', end: 'number?' }, desc: 'Compare arbitrary series across rooms. Returns an object of arrays keyed by series name: {"name": [{ts, y}], ...}' },
      { name: 'pair_timeseries', args: { room: 'string', table1: 'string', field1: 'string', table2: 'string', field2: 'string', start: 'number?', end: 'number?', time_window_ms: 'number?' }, desc: 'Pair two fields by nearest timestamps within a time window (default ±30min). Returns [{x, y, ts1, ts2, dt}] for scatter plots' },
      { name: 'compute_ratio', args: { room: 'string', table1: 'string', field1: 'string', table2: 'string', field2: 'string', start: 'number?', end: 'number?', time_window_ms: 'number?', zero_if_denominator_zero: 'boolean?' }, desc: 'Compute ratio of field1/field2 with time-window matching. Returns [{ts, ratio}]. If zero_if_denominator_zero=true, returns 0 when denominator is 0, otherwise skips that point' },
      { name: 'stats', args: { room: 'string', table: 'string', field: 'string', start: 'number?', end: 'number?' }, desc: 'Compute count,min,max,avg,sum' },
      { name: 'get_time_for_value', args: { room: 'string?', table: 'string?', field: 'string?', metric: 'string?', value: 'number?', mode: 'string?', agg: 'string?', start: 'number?', end: 'number?' }, desc: 'Locate the timestamp for a metric value (or its min/max when value omitted). Returns { ts, value, mode }' },
      { name: 'correlate', args: { room: 'string', table1: 'string', field1: 'string', table2: 'string', field2: 'string', start: 'number?', end: 'number?', time_window_ms: 'number?' }, desc: 'Pearson correlation between two fields from room tables. Uses time-window matching (default ±30min) to handle different sampling rates' },
      { name: 'correlate_cross_room', args: { room1: 'string', table1: 'string', field1: 'string', room2: 'string', table2: 'string', field2: 'string', start: 'number?', end: 'number?', time_window_ms: 'number?' }, desc: 'Correlate metrics between different rooms with time-window matching' },
      { name: 'correlate_weather_room', args: { room: 'string', table: 'string', field_room: 'string', field_weather: 'string', start: 'number?', end: 'number?', time_window_ms: 'number?' }, desc: 'Correlate room metric with weather metric (temp, humidity, wind_speed, clouds, etc)' },
      { name: 'weather_correlate', args: { field1: 'string', field2: 'string', start: 'number?', end: 'number?', room: 'string?', building: 'string?' }, desc: 'Pearson correlation between two weather fields (temp, humidity, wind_speed, clouds, etc) scoped to current building when available' },
      { name: 'building_temp_weather_corr', args: { rooms: 'string[]?', building: 'string?', field: 'string?', weather_field: 'string?', start: 'number?', end: 'number?', bucket_minutes: 'number?' }, desc: 'Aggregate average internal temperature across rooms and correlate it with outside weather temperature. Returns scatter-ready data and correlation stats.' },
      { name: 'building_temp_weather_scatter', args: { rooms: 'string[]?', building: 'string?', field: 'string?', weather_field: 'string?', start: 'number?', end: 'number?', bucket_minutes: 'number?' }, desc: 'Alias of building_temp_weather_corr that exposes the scatter pairing for plotting internal vs outside temperatures.' },
      { name: 'weather_fetch', args: { room: 'string?', building: 'string?', fields: 'string[]', start: 'number?', end: 'number?', limit: 'number?' }, desc: 'Fetch weather rows scoped to the current building or provided overrides' },
      { name: 'latest_value', args: { room: 'string', table: 'string', field: 'string', start: 'number?', end: 'number?' }, desc: 'Latest ts and value for a field in a table within range' },
      { name: 'latest_per_room', args: { table: 'string', field: 'string', start: 'number?', end: 'number?' }, desc: 'Latest value per room for a field' },
      { name: 'scope_multiline', args: { tenant: 'string?', building: 'string?', floor: 'string?', zone: 'string?', metric: 'string', start: 'number?', end: 'number?', limit_per_series: 'number?' }, desc: 'Multi-line plotting: for a scope (tenant/building/floor/zone), returns a series per device for the given metric. Uses S3 telemetry and graph mapping.' },
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
      { name: 'weekday_exceedance', args: { room: 'string', table: 'string', field: 'string', threshold: 'number', start: 'number?', end: 'number?' }, desc: 'Counts per weekday where field > threshold. Returns [{day, total, exceed, ratio}]' },
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
      { name: 'forecast_polyfit', args: { room: 'string', table: 'string', field: 'string', start: 'number?', end: 'number?', degree: 'number?', horizon_hours: 'number?' }, desc: 'Polynomial regression forecast (degree 2)' },
      { name: 'graph_rooms_by_tenant', args: { tenant: 'string' }, desc: 'List rooms permitted for a tenant from Neo4j' },
      { name: 'graph_devices_by_scope', args: { tenant: 'string?', building: 'string?', floor: 'string?', zone: 'string?', type: 'string?' }, desc: 'List devices within the provided scope from Neo4j' },
      { name: 'graph_rooms_by_scope', args: { building: 'string?', floor: 'string?' }, desc: 'List room IDs within a building and/or floor scope (uses graph snapshot if available, else local inference)' },
      { name: 'scope_list_buildings', args: {}, desc: 'List buildings from graph snapshot (fallback: infer from room IDs)' },
      { name: 'scope_list_floors', args: { building: 'string' }, desc: 'List floors for a building (graph snapshot fallback: infer from room IDs)' },
      { name: 'scope_list_rooms', args: { building: 'string?', floor: 'string?' }, desc: 'List rooms filtered by building and/or floor' },
      { name: 'scope_list_detectors', args: { room: 'string' }, desc: 'List detectors/sensor types present in a room based on available tables' },
      { name: 'graph_zone_devices', args: { room: 'string' }, desc: 'List devices and measured metric types for a room (from graph snapshot)' },
      { name: 'vector_search_docs', args: { query: 'string', k: 'number?' }, desc: 'Search documentation via vector store (fallbacks to TF-IDF if unavailable)' },
      { name: 'aggregate_stats_across_rooms', args: { table: 'string', field: 'string', agg: 'string?', start: 'number?', end: 'number?' }, desc: 'Aggregate a metric across all rooms (sum, avg, min, max) over the selected window' },
      { name: 'aggregate_hourly_across_rooms', args: { table: 'string', field: 'string', agg: 'string?', start: 'number?', end: 'number?' }, desc: 'Aggregate per-hour across rooms (sum or avg) returning [{ts, y}]' },
      { name: 'compare_field_across_rooms', args: { table: 'string', field: 'string', agg: 'string?', start: 'number?', end: 'number?' }, desc: 'Compute per-room value (avg/sum/peak) for ranking and comparison' },
      { name: 'scope_heatmap', args: { rooms: 'string[]', table: 'string', field: 'string', start: 'number?', end: 'number?', bucket_minutes: 'number?', agg: 'string?' }, desc: 'Build a room-by-time heatmap for the given metric. Returns { rooms, timestamps, data, summary } where data items map to [x=time index, y=room index, value]' },
      { name: 'compare_rooms_on_metric', args: { rooms: 'string[]?', table: 'string', field: 'string', agg: 'string?', start: 'number?', end: 'number?' }, desc: 'Rank rooms by metric aggregate within selection (uses selectionRooms if rooms omitted). Returns [{room, value}] sorted desc.' },
      { name: 'comfort_band_summary', args: { rooms: 'string[]?', table: 'string?', field: 'string?', minComfort: 'number?', maxComfort: 'number?', start: 'number?', end: 'number?', limit: 'number?' }, desc: 'Summarize % of samples within the comfort temperature band per room. Returns sorted room summaries plus overall stats.' },
      { name: 'scope_daily_percentile', args: { rooms: 'string[]?', table: 'string?', value_field: 'string?', occupancy_field: 'string?', percentile: 'number?', days: 'number?', start: 'number?', end: 'number?' }, desc: 'Per-room daily percentile/median stats for a multi-room scope. Returns { series: { \"Room Name\": [{ts,p95,occupied_median}] }, summary: [{room,label,avg_p95,worst_p95,occupied_median}] } for charting rankings and multi-series lines.' },
      { name: 'timeseries_regression_join', args: { metrics: '[{room:string,field:string,table?:string,mode?:"avg"|"sum"|"delta",alias?:string}]', regressions: '[{name?:string,x:string,y:string}]', start: 'number?', end: 'number?', bucket_minutes: 'number?', forward_fill_minutes: 'number?', timeZone: 'string?' }, desc: 'Align/aggregate multiple metrics (e.g., IAQ vs dwell) and compute regression stats plus scatter-ready arrays.' },
      { name: 'occupancy_people_insight', args: { occupancy_room: 'string', people_room: 'string', occupancy_field: 'string?', people_fields: 'string[]?', bucket_minutes: 'number?', start: 'number?', end: 'number?', timeZone: 'string?' }, desc: '15-minute utilisation vs people counter analysis with heatmaps, peak windows, and regression scatter.' },
      { name: 'odor_event_monitor', args: { odor_room: 'string', odor_fields: 'string[]?', people_room: 'string?', people_fields: 'string[]?', window_minutes: 'number?', threshold: 'number?', min_duration_minutes: 'number?', context_minutes: 'number?', start: 'number?', end: 'number?', timeZone: 'string?' }, desc: 'Rolling z-score detection for odor sensors with per-day counts and optional entrance-flow medians.' },
      { name: 'scope_schema_matrix', args: { rooms: 'string[]?', include_tables: 'boolean?' }, desc: 'Enumerate scoped devices with the metrics/tables they expose so you can build schema maps or availability matrices.' },
      { name: 'grid_align_timeseries', args: { series: '[{room:string,table?:string,field:string,alias?:string}]', start: 'number?', end: 'number?', bucket_minutes: 'number?', forward_fill_minutes: 'number?', timeZone: 'string?' }, desc: 'Align multiple metrics on a shared time grid (default 5-minute Europe/London) with forward-fill tolerance and completeness stats for heatmaps.' },
      { name: 'ventilation_effectiveness', args: { rooms: 'string[]?', start: 'number?', end: 'number?', value_field: 'string?', air_field: 'string?', percentile: 'number?' }, desc: 'Joins daily airExchangeRate with CO₂ percentiles per room/day, returning scatter points plus regression (slope/intercept/R²).' },
      { name: 'daypart_boxplot', args: { rooms: 'string[]', field: 'string', occupancy_field: 'string?', table: 'string?', start: 'number?', end: 'number?', timeZone: 'string?' }, desc: 'Build boxplot quartiles for 08-12 / 12-16 / 16-20 windows and companion occupancy medians for dual-axis overlays.' },
      { name: 'energy_iaq_linkage', args: { links: '[{name:string,energyRooms:string[],iaqRoom:string}]', start: 'number?', end: 'number?', bucket: '\"hourly\"|\"daily\"?', iaq_fields: 'string[]?' }, desc: 'Aggregates SmallPower/Lighting meters and IAQ sensors per area, returning aligned hourly/daily datasets for dual-axis panels.' },
      { name: 'device_health_summary', args: { rooms: 'string[]?', lookback_days: 'number?' }, desc: 'Summarise IAQ device health (latest battery/RSSI/voltage, sparklines, missingness alerts) for dashboards.' },
      { name: 'weekday_weekend_pm_profile', args: { rooms: 'string[]', field: 'string?', bucket_minutes: 'number?', start: 'number?', end: 'number?', timeZone: 'string?' }, desc: 'Compare weekday vs weekend diurnal PM profiles (median per 30-min bin) and report uplift percentages.' },
      { name: 'table_sample', args: { room: 'string', table: 'string', fields: 'string[]?', limit: 'number?', order: '"asc" | "desc"?', start: 'number?', end: 'number?' }, desc: 'Return up to N rows from a room table (ts + selected fields) respecting an optional time window. Useful for table extracts.' },
      { name: 'compare_metrics_in_room', args: { room: 'string', table: 'string', fields: 'string[]', agg: 'string?', start: 'number?', end: 'number?' }, desc: 'Compare multiple metrics within one room; returns [{field, value}]' },
      { name: 'common_metrics_in_scope', args: { rooms: 'string[]?' }, desc: 'List metrics common to all scoped rooms (intersection of first-row keys excluding ts)' },
      { name: 'correlation_matrix', args: { room: 'string', table: 'string', fields: 'string[]', start: 'number?', end: 'number?', time_window_ms: 'number?' }, desc: 'Pairwise Pearson correlation among fields within a room/table over the window' }
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
          const t = trace[i];
          if (t.tool !== ref.tool) continue;
          if (ref.room && t.args && t.args.room && String(t.args.room) !== String(ref.room)) continue;
          if (ref.yField && t.args && Array.isArray(t.args.fields) && !t.args.fields.includes(ref.yField)) continue;
          toolResult = t.result;
          break;
        }
        
        if (!toolResult) {
          log('Warning: Could not find tool result for', ref.tool);
          series.data = [];
          continue;
        }
        
        // Extract data based on the reference
        let sourceData = toolResult;
        
        // If compare_series_cross_room returned a map, select series by ref.field or series.name
        if (ref.tool === 'compare_series_cross_room' && sourceData && typeof sourceData === 'object' && !Array.isArray(sourceData)) {
          const keys = Object.keys(sourceData);
          let key = ref.field || series.name || '';
          let match = keys.find(k => k === key) || keys.find(k => k.toLowerCase() === String(key).toLowerCase());
          if (!match && key) match = keys.find(k => k.toLowerCase().includes(String(key).toLowerCase()));
          if (!match) match = keys[0];
          sourceData = sourceData[match] || [];
        }

        if (ref.tool === 'compare_rooms_on_metric' && Array.isArray(toolResult)) {
          const data = toolResult
            .filter((row) => row && row.room && Number.isFinite(Number(row.value)))
            .map((row) => [deviceFriendlyName(row.room), Number(row.value)]);
          series.data = data;
          delete series.dataRef;
          continue;
        }
        
        // If ref specifies a field (e.g., forecast blocks)
        if (ref.field && Array.isArray(toolResult?.[ref.field])) {
          sourceData = toolResult[ref.field];
        }
        
        // Convert to chart data format
        if (Array.isArray(sourceData)) {
          const xField = ref.xField || 'ts';
          const yField = ref.yField;
          const valueField = ref.valueField;
          
          let data = sourceData.map((item) => {
            const x = item[xField];
            if (valueField) {
              const y = yField != null ? item[yField] : item.y;
              const v = item[valueField];
              return [x, y, v];
            }
            const yVal = yField ? item[yField] : item[Object.keys(item).find((k) => k !== xField)];
            return [x, yVal];
          }).filter((tuple) => {
            if (tuple[0] == null || tuple[1] == null) return false;
            if (tuple.length >= 3) {
              const v = tuple[2];
              return v != null && (typeof v !== 'number' || Number.isFinite(v));
            }
            const y = tuple[1];
            return y != null && (typeof y !== 'number' || Number.isFinite(y));
          });
          if (!valueField) {
            data.sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0));
          }

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

  function applyChartTheme(chartObj) {
    if (!chartObj) return chartObj;
    const type = (chartObj.chart && chartObj.chart.type) ? chartObj.chart.type : 'line';
    const chartBase = chartObj.chart || {};
    chartObj.chart = {
      spacing: chartBase.spacing || [16, 16, 24, 16],
      backgroundColor: chartBase.backgroundColor || 'transparent',
      zoomType: chartBase.zoomType || (type === 'scatter' ? 'xy' : 'x'),
      style: chartBase.style || { fontFamily: 'Inter, "Helvetica Neue", Arial, sans-serif' },
      ...(chartBase || {})
    };
    chartObj.colors = chartObj.colors || CHART_COLORS;
    chartObj.credits = { enabled: false };
    chartObj.legend = {
      align: 'center',
      verticalAlign: 'bottom',
      itemStyle: { fontWeight: 500, color: '#1f2933' },
      symbolHeight: 10,
      symbolWidth: 24,
      ...(chartObj.legend || {})
    };
    if (chartObj.title) {
      chartObj.title.style = chartObj.title.style || { color: '#111827', fontWeight: 600, fontSize: '15px' };
    }
    if (chartObj.subtitle) {
      chartObj.subtitle.style = chartObj.subtitle.style || { color: '#64748b', fontWeight: 400, fontSize: '12px' };
    }
    const sharedTooltip = type !== 'scatter' && type !== 'column';
    chartObj.tooltip = {
      shared: sharedTooltip,
      padding: 12,
      valueDecimals: 2,
      ...(chartObj.tooltip || {})
    };
    const baseSeriesOptions = {
      lineWidth: type === 'column' ? undefined : 2,
      marker: {
        enabled: type === 'scatter' || type === 'column',
        radius: type === 'scatter' ? 4 : 3,
        symbol: 'circle'
      },
      shadow: false,
      states: {
        hover: {
          halo: { size: 6 }
        }
      }
    };
    chartObj.plotOptions = {
      series: { ...baseSeriesOptions, ...(chartObj.plotOptions?.series || {}) },
      column: {
        borderRadius: 4,
        pointPadding: 0.08,
        groupPadding: 0.1,
        ...(chartObj.plotOptions?.column || {})
      },
      area: {
        fillOpacity: 0.2,
        ...(chartObj.plotOptions?.area || {})
      },
      spline: chartObj.plotOptions?.spline || {},
      ...(chartObj.plotOptions || {})
    };
    const normalizeAxis = (axis, isX = false) => {
      const base = axis || {};
      return {
        gridLineColor: base.gridLineColor || '#f1f5f9',
        lineColor: base.lineColor || '#dbe3f0',
        labels: {
          style: { color: '#475569', fontSize: '11px' },
          ...(base.labels || {})
        },
        title: base.title ? {
          ...base.title,
          style: { color: '#111827', fontWeight: 600, ...(base.title?.style || {}) }
        } : undefined,
        tickWidth: base.tickWidth ?? 1,
        tickColor: base.tickColor || '#dbe3f0',
        ...(base || {})
      };
    };
    const xAxes = chartObj.xAxis == null ? [{}] : (Array.isArray(chartObj.xAxis) ? chartObj.xAxis : [chartObj.xAxis]);
    const yAxes = chartObj.yAxis == null ? [{}] : (Array.isArray(chartObj.yAxis) ? chartObj.yAxis : [chartObj.yAxis]);
    const themedX = xAxes.map((axis) => normalizeAxis(axis, true));
    const themedY = yAxes.map((axis) => normalizeAxis(axis, false));
    chartObj.xAxis = Array.isArray(chartObj.xAxis) ? themedX : themedX[0];
    chartObj.yAxis = Array.isArray(chartObj.yAxis) ? themedY : themedY[0];
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
    chartObj.series = chartObj.series.filter((s) => Array.isArray(s.data) && s.data.length);
    chartObj.series.forEach((s, idx) => {
      if (!s.color) s.color = (chartObj.colors || CHART_COLORS)[idx % (chartObj.colors || CHART_COLORS).length];
    });
    applyChartTheme(chartObj);
    return chartObj.series.length ? chartObj : null;
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

  function alignSeriesWithinWindow(seriesA, fieldA, seriesB, fieldB, windowMs) {
    if (!seriesA.length || !seriesB.length) return [];
    const sortedA = [...seriesA].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
    const sortedB = [...seriesB].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
    const pairs = [];
    let j = 0;
    for (let i = 0; i < sortedA.length; i += 1) {
      const a = sortedA[i];
      const tsA = a.ts ?? null;
      const v1 = Number(a[fieldA]);
      if (!Number.isFinite(tsA) || !Number.isFinite(v1)) continue;
      while (j < sortedB.length - 1 && (sortedB[j].ts ?? 0) < tsA) {
        if (Math.abs((sortedB[j + 1].ts ?? 0) - tsA) < Math.abs((sortedB[j].ts ?? 0) - tsA)) {
          j += 1;
        } else {
          break;
        }
      }
      const candidates = [];
      for (let k = Math.max(0, j - 1); k <= Math.min(sortedB.length - 1, j + 1); k += 1) {
        const b = sortedB[k];
        const tsB = b.ts ?? null;
        const dt = Math.abs((tsB ?? 0) - tsA);
        if (dt <= windowMs) {
          const v2 = Number(b[fieldB]);
          if (Number.isFinite(v2)) {
            candidates.push({ dt, value: v2, index: k });
          }
        }
      }
      if (candidates.length) {
        candidates.sort((a, b) => a.dt - b.dt);
        const chosen = candidates[0];
        j = chosen.index;
        pairs.push([v1, chosen.value]);
      }
    }
    return pairs;
  }

  function alignSeriesByBucket(seriesA, fieldA, seriesB, fieldB, bucketMs) {
    if (!seriesA.length || !seriesB.length) return [];
    const bucketsA = new Map();
    const bucketsB = new Map();
    const add = (map, ts, value) => {
      const key = Math.floor((ts ?? 0) / bucketMs) * bucketMs;
      const entry = map.get(key) || { sum: 0, n: 0 };
      entry.sum += value;
      entry.n += 1;
      map.set(key, entry);
    };
    for (const a of seriesA) {
      const ts = a.ts ?? null;
      const v = Number(a[fieldA]);
      if (!Number.isFinite(ts) || !Number.isFinite(v)) continue;
      add(bucketsA, ts, v);
    }
    for (const b of seriesB) {
      const ts = b.ts ?? null;
      const v = Number(b[fieldB]);
      if (!Number.isFinite(ts) || !Number.isFinite(v)) continue;
      add(bucketsB, ts, v);
    }
    const pairs = [];
    for (const [key, a] of bucketsA.entries()) {
      if (!bucketsB.has(key)) continue;
      const b = bucketsB.get(key);
      const avgA = a.n ? a.sum / a.n : null;
      const avgB = b.n ? b.sum / b.n : null;
      if (Number.isFinite(avgA) && Number.isFinite(avgB)) {
        pairs.push([avgA, avgB]);
      }
    }
    return pairs;
  }

  function pickChartTypeForField(field, question = '') {
    const key = String(field || '').toLowerCase();
    const q = String(question || '').toLowerCase();
    const wantsComparison = /\b(compare|versus|vs|diff|difference|busiest|rank)\b/.test(q);
    if (/people|occup|count/.test(key) || /occupancy|headcount|people/.test(q)) {
      return wantsComparison ? 'spline' : 'column';
    }
    if (/pm|particle/.test(key)) return 'areaspline';
    if (/humidity/.test(key)) return 'areaspline';
    if (/temperature|temp/.test(key)) return 'spline';
    if (/lux|light/.test(key)) return 'spline';
    if (/co2|co₂/.test(key)) return 'areaspline';
    if (/energy|kwh|power|total/.test(key)) return 'area';
    return 'line';
  }

  function buildFallbackChartFromTrace({
    trace,
    question,
    defaultRoom = null,
    selectionRooms = []
  }) {
    if (!Array.isArray(trace) || !trace.length) return null;
    const qLower = String(question || '').toLowerCase();

    for (let i = trace.length - 1; i >= 0; i--) {
      const entry = trace[i];
      if (!entry || !entry.tool) continue;

      if (entry.tool === 'pair_timeseries' && Array.isArray(entry.result) && entry.result.length) {
        const chart = {
          chart: { type: 'scatter' },
          title: { text: `${humanizeMetricName(entry.args?.field1 || 'Metric A')} vs ${humanizeMetricName(entry.args?.field2 || 'Metric B')}` },
          xAxis: { title: { text: humanizeMetricName(entry.args?.field1 || 'Metric A') } },
          yAxis: { title: { text: humanizeMetricName(entry.args?.field2 || 'Metric B') } },
          series: [{
            name: `${humanizeMetricName(entry.args?.field1 || 'Metric A')} vs ${humanizeMetricName(entry.args?.field2 || 'Metric B')}`,
            dataRef: { tool: 'pair_timeseries', xField: 'x', yField: 'y', field1: entry.args?.field1, field2: entry.args?.field2 }
          }]
        };
        const valid = validateChart(cloneChart(chart), trace);
        if (valid) return chart;
      }

      if ((entry.tool === 'fetch_timeseries' || entry.tool === 'hourly_timeseries' || entry.tool === 'daily_avg') &&
          Array.isArray(entry.result) && entry.result.length) {
        const sample = entry.result.find((row) => row && typeof row === 'object');
        if (!sample) continue;
        const fields = Object.keys(sample).filter((k) => k !== 'ts' && sample[k] != null);
        if (!fields.length) continue;

        const preferred = [];
        for (const f of fields) {
          if (qLower.includes(String(f).toLowerCase())) preferred.push(f);
        }
        const pick = preferred.length ? preferred : fields;
        const seriesFields = pick.slice(0, Math.min(2, pick.length));
        const roomId = entry.args?.room || defaultRoom || selectionRooms[0] || null;
        const friendlyRoom = roomId ? deviceFriendlyName(roomId) : 'Scope';
        const chartType = pickChartTypeForField(seriesFields[0], question);
        const yAxisTitle = humanizeMetricName(seriesFields.length === 1 ? seriesFields[0] : 'Value');

        const chart = {
          chart: { type: chartType },
          title: { text: `${friendlyRoom} — ${seriesFields.map(humanizeMetricName).join(' / ')}` },
          xAxis: { type: 'datetime', title: { text: 'Time' } },
          yAxis: { title: { text: yAxisTitle } },
          tooltip: seriesFields.length > 1 ? { shared: true } : undefined,
          series: seriesFields.map((field) => ({
            name: `${friendlyRoom} ${humanizeMetricName(field)}`,
            dataRef: {
              tool: entry.tool,
              room: entry.args?.room,
              table: entry.args?.table,
              xField: 'ts',
              yField: field
            }
          }))
        };
        const valid = validateChart(cloneChart(chart), trace);
        if (valid) return chart;
      }

      if (entry.tool === 'weather_fetch' && Array.isArray(entry.result) && entry.result.length) {
        const sample = entry.result[0];
        const numericFields = Object.keys(sample || {}).filter((k) => k !== 'ts' && Number.isFinite(Number(sample[k])));
        const seriesFields = numericFields.slice(0, Math.min(2, numericFields.length));
        if (!seriesFields.length) continue;
        const chart = {
          chart: { type: 'spline' },
          title: { text: `Weather — ${seriesFields.map(humanizeMetricName).join(' / ')}` },
          xAxis: { type: 'datetime', title: { text: 'Time' } },
          yAxis: { title: { text: 'Value' } },
          series: seriesFields.map((field) => ({
            name: `Weather ${humanizeMetricName(field)}`,
            dataRef: { tool: 'weather_fetch', xField: 'ts', yField: field }
          }))
        };
        const valid = validateChart(cloneChart(chart), trace);
        if (valid) return chart;
      }

      if (entry.tool === 'histogram' && Array.isArray(entry.result) && entry.result.length) {
        const field = entry.args?.field || 'Metric';
        const roomId = entry.args?.room || defaultRoom || selectionRooms[0] || null;
        const friendlyRoom = roomId ? deviceFriendlyName(roomId) : 'Scope';
        const chart = {
          chart: { type: 'column' },
          title: { text: `Histogram — ${friendlyRoom} ${humanizeMetricName(field)}` },
          xAxis: { title: { text: humanizeMetricName(field) } },
          yAxis: { title: { text: 'Count' } },
          series: [{
            name: `${friendlyRoom} ${humanizeMetricName(field)}`,
            dataRef: { tool: 'histogram', xField: 'binStart', yField: 'count' }
          }]
        };
        const valid = validateChart(cloneChart(chart), trace);
        if (valid) return chart;
      }

      if (entry.tool === 'compare_rooms_on_metric' && Array.isArray(entry.result) && entry.result.length) {
        const metricName = humanizeMetricName(entry.args?.field || entry.args?.metric || 'Value');
        const labelField = entry.result.some((row) => row && row.friendlyName) ? 'friendlyName' : 'room';
        const chart = {
          chart: { type: 'column' },
          title: { text: `${metricName} by Room` },
          xAxis: { type: 'category', title: { text: labelField === 'friendlyName' ? 'Space' : 'Room' } },
          yAxis: { title: { text: metricName } },
          series: [{
            name: metricName,
            dataRef: { tool: 'compare_rooms_on_metric', xField: labelField, yField: 'value' }
          }]
        };
        const valid = validateChart(cloneChart(chart), trace);
        if (valid) return chart;
      }

      if (entry.tool === 'correlation_matrix' && entry.result && Array.isArray(entry.result.data)) {
        const chart = {
          chart: { type: 'heatmap' },
          title: { text: 'Correlation Heatmap' },
          colorAxis: { min: -1, max: 1 },
          series: [{
            name: 'Correlation',
            dataRef: { tool: 'correlation_matrix', format: 'heatmap' }
          }]
        };
        const valid = validateChart(cloneChart(chart), trace);
        if (valid) return chart;
      }
    }

    return null;
  }

  function withinRange(ts, start, end) { 
    return (!start || ts >= start) && (!end || ts <= end); 
  }
  
  function floorHour(ts) { 
    const d = new Date(ts); 
    d.setMinutes(0,0,0); 
    return d.getTime(); 
  }
  function devicesMatchingQuestion(text, scopeDeviceZones = {}, limit = Infinity) {
    const matches = [];
    const ql = String(text || '').toLowerCase();
    if (!ql) return matches;
    const seen = new Set();
    const pushDevice = (id) => {
      if (!id || seen.has(id)) return false;
      seen.add(id);
      matches.push(id);
      return true;
    };
    for (const [deviceId, zoneName] of Object.entries(scopeDeviceZones || {})) {
      if (!zoneName) continue;
      if (ql.includes(String(zoneName).toLowerCase())) {
        if (pushDevice(deviceId) && matches.length >= limit) return matches;
      }
    }
    const sanitized = ql.replace(ZONE_STOPWORD_REGEX, ' ').replace(/\s+/g, ' ').trim();
    if (snapshotIndex?.zoneByName && sanitized) {
      for (const [zoneKey, zoneRecords] of snapshotIndex.zoneByName.entries()) {
        if (!zoneKey || !sanitized.includes(zoneKey)) continue;
        for (const zoneRecord of zoneRecords) {
          const entries = buildDeviceEntriesFromSnapshotZone(zoneRecord);
          for (const entry of entries) {
            if (pushDevice(entry.cloudId || entry.primaryId || entry.id) && matches.length >= limit) {
              return matches;
            }
          }
        }
      }
    }
    return matches;
  }

  function inferRoomFromText(text) {
    const ctx = currentScopeContext || {};
    const scopeMatches = devicesMatchingQuestion(text, ctx.scopeDeviceZones, 1);
    if (scopeMatches.length) return scopeMatches[0];
    try {
      const rooms = listRooms();
      const tl = String(text || '').toLowerCase();
      for (const r of rooms) {
        if (tl.includes(String(r).toLowerCase())) return r;
      }
    } catch {}
    return null;
  }

  function isAllRooms(sel) {
    const s = String(sel || '').toLowerCase();
    return s === 'all' || s === '*';
  }

  
  function norm(s) { 
    return String(s||'').toLowerCase().replace(/[^a-z0-9]/g,''); 
  }
  
  function resolveTable(room, name) {
    const t = loadRoomTables(room);
    const keys = Object.keys(t);
    if (!keys.length) return name || 'telemetry';
    if (!name) {
      if (t.telemetry) return 'telemetry';
      return keys[0];
    }
    if (t[name]) return name;
    const n = norm(name);
    const TABLE_ALIAS = {
      iaq: 'telemetry',
      indoorairquality: 'telemetry',
      airquality: 'telemetry',
      telemetryiaq: 'telemetry',
      sensor: 'telemetry',
      sensors: 'telemetry',
      hvac: 'telemetry',
      people: 'telemetry',
      occupancy: 'telemetry',
      energy: 'telemetry',
      power: 'telemetry',
      env: 'telemetry'
    };
    const aliasTarget = TABLE_ALIAS[n];
    if (aliasTarget && t[aliasTarget]) return aliasTarget;
    const k1 = keys.find(k => norm(k) === n);
    if (k1) return k1;
    const parts = String(name).split('_');
    const core = norm(parts[parts.length-1] || name);
    const k2 = keys.find(k => norm(k) === core) || keys.find(k => norm(k).endsWith(core)) || keys.find(k => norm(k).includes(core));
    if (k2) return k2;
    if (keys.length === 1) return keys[0];
    if (t.telemetry) return 'telemetry';
    return name;
  }

  function findRoomWithTable(tableName, selectionRooms = [], fallbackRoom = null) {
    const tryDevice = (deviceId) => {
      if (!deviceId) return null;
      const normalized = normalizeRoomId(deviceId) || String(deviceId);
      const tables = loadRoomTables(normalized);
      if (!tables || !Object.keys(tables).length) return null;
      const resolved = resolveTable(normalized, tableName || 'iaq');
      return tables[resolved] ? normalized : null;
    };
    if (Array.isArray(selectionRooms)) {
      for (const id of selectionRooms) {
        const match = tryDevice(id);
        if (match) return match;
      }
    }
    if (fallbackRoom) {
      const match = tryDevice(fallbackRoom);
      if (match) return match;
    }
    if (Array.isArray(selectionRooms) && selectionRooms.length) {
      const match = tryDevice(selectionRooms[0]);
      if (match) return match;
    }
    return tryDevice(fallbackRoom) || null;
  }

  function resolveFieldBinding(field, selectionRooms = [], preferredRoom = null) {
    if (!field) return null;
    const target = String(field).trim().toLowerCase();
    if (!target) return null;
    const queue = [];
    const seen = new Set();
    const pushCandidate = (roomId) => {
      if (!roomId) return;
      const key = String(roomId).trim();
      if (!key || key === 'ALL' || key === '*') return;
      if (seen.has(key)) return;
      seen.add(key);
      queue.push(key);
    };
    pushCandidate(preferredRoom);
    (selectionRooms || []).forEach(pushCandidate);
    try {
      if (queue.length < 16) {
        for (const r of listRooms()) pushCandidate(r);
      }
    } catch {}

    const suggestions = [];
    for (const roomId of queue) {
      const tables = loadRoomTables(roomId);
      for (const [table, rows] of Object.entries(tables)) {
        if (!Array.isArray(rows) || !rows.length) continue;
        const first = rows[0] || {};
        for (const key of Object.keys(first)) {
          if (!key || key === 'ts') continue;
          const keyNorm = key.toLowerCase();
          if (keyNorm === target) {
            return { room: roomId, table, fieldName: key };
          }
          if (keyNorm.includes(target) || target.includes(keyNorm)) {
            suggestions.push({ room: roomId, table, fieldName: key });
          }
        }
      }
    }
    return suggestions[0] || null;
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
    const sets = Object.values(availableSets || {});
    // Direct match across any table
    for (const set of sets) {
      for (const f of set) if (norm(f) === target) return f;
    }
    // Synonyms
    let canonicalFallback = null;
    for (const [canon, syns] of Object.entries(FIELD_SYNONYMS)) {
      const cn = norm(canon);
      if (target === cn || syns.some(s => norm(s) === target)) {
        canonicalFallback = canon;
        for (const set of sets) {
          for (const f of set) if (norm(f) === cn) return f;
          for (const s of syns) {
            for (const f of set) if (norm(f) === norm(s)) return f;
          }
        }
      }
    }
    // Fuzzy contains
    for (const set of sets) {
      for (const f of set) if (norm(f).includes(target) || target.includes(norm(f))) return f;
    }
    if (canonicalFallback) return canonicalFallback;
    return target || null;
  }

function parseFieldsFromQuestion(question, availableSets) {
  const q = String(question || '').toLowerCase();
  const fields = [];
  // Recognize air exchange rate synonyms explicitly
  try {
    const airSyns = ['air exchangerate','air exchange rate','airexchangerate','airchangerate','airchange','ach'];
    if (airSyns.some(s => q.includes(s))) {
      const f = inferFieldName('airExchangeRate', availableSets) || inferFieldName('ach', availableSets);
      if (f && !fields.includes(f)) fields.push(f);
    }
  } catch {}
    // 1) explicit "x vs y" or "x against y"
    if (q.includes(' vs ') || q.includes(' against ')) {
      const parts = question.split(/\s+(?:vs|against)\s+/i).map(s => s.trim());
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
    const candidates = ['co2','co₂','voc','lux','light','illum', 'pressure','humidity','humid','temperature','temp','people_count','people','occupancy','pm1','pm25','pm10','nh3','h2s','odor','odour','odor_level','value','total_kwh','energy','kwh','power'];
    for (const c of candidates) {
      if (fields.length >= 2) break;
      if (q.includes(c)) {
        const f = inferFieldName(c, availableSets);
        if (f && !fields.includes(f)) fields.push(f);
      }
    }
    return fields;
  }

  const QUESTION_FIELD_HINTS = [
    { field: 'pm25', keywords: ['pm2.5', 'pm 2.5', 'pm25'] },
    { field: 'pm10', keywords: ['pm10', 'pm 10'] },
    { field: 'pm1', keywords: ['pm1', 'pm 1'] },
    { field: 'voc', keywords: ['voc', 'tvoc'] },
    { field: 'virusRisk', keywords: ['virus risk', 'virusrisk'] },
    { field: 'mold', keywords: ['mold', 'mould'] },
    { field: 'radonShortTermAvg', keywords: ['radon'] },
    { field: 'airExchangeRate', keywords: ['air exchange', 'airchangerate', 'ach'] },
    { field: 'co2', keywords: ['co2', 'co₂', 'carbon dioxide'] },
    { field: 'humidity', keywords: ['humidity', 'humid'] },
    { field: 'temperature', keywords: ['temperature', 'temp'] },
    { field: 'lux', keywords: ['lux', 'light level', 'illuminance'] },
    { field: 'people_count', keywords: ['people', 'occupancy', 'headcount', 'footfall'] }
  ];

  function inferFieldFromQuestionKeywords(question) {
    const q = String(question || '').toLowerCase();
    if (!q) return null;
    for (const entry of QUESTION_FIELD_HINTS) {
      if (entry.keywords.some((kw) => q.includes(kw))) {
        return entry.field;
      }
    }
    return null;
  }

  function extractTimestampFromQuestion(question) {
    if (!question) return null;
    const text = String(question);
    const isoPattern = /(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/;
    const altPattern = /(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ ,T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/;
    const m = text.match(isoPattern) || text.match(altPattern);
    if (!m) return null;
    const parts = m.slice(1).map((val) => (val == null ? null : Number(val)));
    let year, month, day, hour = 0, minute = 0, second = 0;
    if (m === text.match(altPattern)) {
      [month, day, year, hour, minute, second] = parts;
    } else {
      [year, month, day, hour, minute, second] = parts;
    }
    if (!year || !month || !day) return null;
    const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour || 0).padStart(2, '0')}:${String(minute || 0).padStart(2, '0')}:${String(second || 0).padStart(2, '0')}`;
    const ts = Date.parse(iso);
    return Number.isFinite(ts) ? ts : null;
  }

  function resolveRoomForQuestion(question, fallbackRoom, selectionRooms = [], scopeDeviceZones = {}) {
    const matches = devicesMatchingQuestion(question, scopeDeviceZones, 1);
    if (matches.length) return matches[0];
    const inferred = inferRoomFromText(question);
    if (inferred) return inferred;
    if (Array.isArray(selectionRooms) && selectionRooms.length === 1) return selectionRooms[0];
    if (!isAllRooms(fallbackRoom) && fallbackRoom) return fallbackRoom;
    return (selectionRooms && selectionRooms.length) ? selectionRooms[0] : null;
  }

  function describeTimeDelta(baseTs, targetTs) {
    if (!Number.isFinite(baseTs) || !Number.isFinite(targetTs)) return '';
    const delta = baseTs - targetTs;
    if (delta === 0) return 'exact match';
    const abs = Math.abs(delta);
    const minutes = Math.round(abs / 60000);
    if (minutes === 0) return delta > 0 ? 'seconds after' : 'seconds before';
    const hours = minutes >= 60 ? (minutes / 60).toFixed(minutes % 60 === 0 ? 0 : 1) + ' h' : `${minutes} min`;
    return `${hours} ${delta > 0 ? 'after' : 'before'}`;
  }

  function tryAnswerPointQuery({ question, timestamp, room, selectionRooms = [], scopeDeviceZones = {}, range }) {
    if (!timestamp) return null;
    let resolvedRoom = resolveRoomForQuestion(question, room, selectionRooms, scopeDeviceZones);
    if (!resolvedRoom || isAllRooms(resolvedRoom)) {
      resolvedRoom = (selectionRooms && selectionRooms.length) ? selectionRooms[0] : null;
    }
    if (!resolvedRoom) return null;
    const available = availableFieldsByTable(resolvedRoom);
    let fields = parseFieldsFromQuestion(question, available);
    if (!fields.length) {
      const lower = String(question || '').toLowerCase();
      if (lower.includes('humidity') || lower.includes('dew')) fields = ['humidity'];
      else if (lower.includes('co2')) fields = ['co2'];
      else if (lower.includes('temperature') || lower.includes('temp')) fields = ['temperature'];
      else if (lower.includes('lux') || lower.includes('light')) fields = ['lux'];
      else if (lower.includes('nh3')) fields = ['nh3'];
      else if (lower.includes('h2s')) fields = ['h2s'];
      else if (lower.includes('energy') || lower.includes('kwh') || lower.includes('power')) fields = ['total_kwh'];
    }
    if (!fields.length) {
      const tables = loadRoomTables(resolvedRoom);
      const firstTable = Object.values(tables).find((rows) => Array.isArray(rows) && rows.length);
      if (firstTable && firstTable.length) {
        const keys = Object.keys(firstTable[0] || {}).filter((k) => k !== 'ts');
        if (keys.length) fields = [keys[0]];
      }
    }
    if (!fields.length) return null;
    const fieldHint = fields[0];
    const binding = resolveFieldBinding(fieldHint, selectionRooms, resolvedRoom) || resolveFieldBinding(fieldHint, [resolvedRoom], resolvedRoom);
    if (!binding || !binding.fieldName) return null;
    const fieldName = binding.fieldName;
    const tableName = binding.table || resolveTable(binding.room || resolvedRoom, fieldName === 'total_kwh' ? 'energy' : 'iaq');
    const windowMs = 15 * 60 * 1000;
    const fetchArgs = {
      room: binding.room || resolvedRoom,
      table: tableName,
      fields: [fieldName],
      start: timestamp - windowMs,
      end: timestamp + windowMs,
      limit: 20
    };
    const rows = tools.fetch_timeseries(fetchArgs);
    const trace = [{ tool: 'fetch_timeseries', args: fetchArgs, result: rows }];
    if (!Array.isArray(rows) || !rows.length) {
      return {
        message: assistantMessage(`No ${humanizeMetricName(fieldName)} readings near ${formatLocal(timestamp)}.`),
        chart: null,
        trace
      };
    }
    let nearest = null;
    for (const row of rows) {
      const value = row[fieldName];
      if (value == null) continue;
      const dist = Math.abs((row.ts ?? 0) - timestamp);
      if (!nearest || dist < nearest.dist) nearest = { row, dist };
    }
    if (!nearest) {
      return {
        message: assistantMessage(`Samples near ${formatLocal(timestamp)} lacked ${humanizeMetricName(fieldName)} values.`),
        chart: null,
        trace
      };
    }
    const offsetLabel = describeTimeDelta(nearest.row.ts, timestamp);
    const answerText = `${humanizeMetricName(fieldName)} in ${deviceFriendlyName(binding.room || resolvedRoom)} was ${formatNumericValue(Number(nearest.row[fieldName]))} at ${formatLocal(nearest.row.ts)} (${offsetLabel} relative to the requested ${formatLocal(timestamp)}).`;
    const chart = {
      chart: { type: 'line' },
      title: { text: `${humanizeMetricName(fieldName)} near ${formatLocal(timestamp)}` },
      xAxis: { type: 'datetime' },
      yAxis: { title: { text: humanizeMetricName(fieldName) } },
      series: [{
        name: humanizeMetricName(fieldName),
        dataRef: { tool: 'fetch_timeseries', xField: 'ts', yField: fieldName }
      }]
    };
    const validChart = validateChart(cloneChart(chart), trace);
    return {
      message: assistantMessage(answerText),
      chart: validChart ? chart : null,
      trace
    };
  }
  

  // Lightweight intent classifier tolerant to varied phrasing
  function classifyIntent(question) {
    const q = String(question || '').toLowerCase();
    const has = (...words) => words.some(w => q.includes(w));
    const typeRegex = /(boardroom|meeting|lab|laboratory|toilet|restroom|bathroom|wc|cafe|cafeteria|kitchen)/i;
    const metricsRegex = /(temperature|temp|humidity|co2|concentration|occupancy|people|lux|energy|kwh|power|voc|pm|pressure|water|leak|battery|h2s|nh3)/;
    const mentionsTable = /\btable\b|\btabular\b|\brows\b|\breadings\b|\bentries\b|\bextract\b|\bsample\b/.test(q);
    const mentionsData = has('iaq','data','reading','entries','sensor','log','logs');
    const wantsTableSample = mentionsTable && mentionsData;
    const wantsTableMeta = ((/\bfirst\b|\bearliest\b|\boldest\b/.test(q) && /\bdate\b|\btimestamp\b|\breading\b/.test(q)) ||
      (/\blast\b|\blatest\b/.test(q) && /\bdate\b|\btimestamp\b/.test(q)));
    const mentionsRooms = /\brooms?\b/.test(q);
    const mentionsZones = /\bzones?\b/.test(q);
    const mentionsBetween = /\bbetween\b/.test(q);
    const compareAcrossZones = /\bcompare\b/.test(q) && (
      (mentionsBetween && (mentionsRooms || mentionsZones)) ||
      has('across rooms','across zones','between rooms','between zones','rooms on this floor','zones on this floor','zones in this building','rooms in this building')
    );
    const mentionsWeather = /\bweather\b|\boutdoor\b|\boutside\b/.test(q) || has('outside temperature') || has('outside temp') || has('external temperature');
    return {
      selectionTime: has('what selection','what scope and time','what selection and time','what time period are you analys','current range','current window','what scope do you see','selection and time','selection and time frame','selection and time period','what selection and time'),
      metricsEachRoom: (
        has(
          'metrics in each room','metrics in every room','metrics per room',
          'what metrics are in each','what metrics are in the rooms',
          'metrics are measured in these rooms','metrics measured in these rooms',
          'what metrics are measured in these rooms','what metrics are measured in the rooms',
          'metrics in these rooms','metrics for these rooms','metrics across these rooms'
        ) ||
        (
          (has('in scope','in the scope','in selection','in the selection','here','these rooms','the rooms')
            && has('metrics','detectors') && has('room','rooms'))
          || (has('detectors') && has('each','every','rooms'))
        )
      ),
      devicesInRoom: has('what detectors','what devices','what sensors') && !has('each','every'),
      plotAcrossRooms: (has('plot','chart','visualize') && (has('across all rooms','on this floor','on this building'))) || has('compare across rooms','timeseries across rooms') || compareAcrossZones,
      rankRooms: (
        (has('highest','top','most','rank') && (has('avg','average','mean','peak','sum','total') || true) && (has('on this floor') || has('on this building') || has('rooms'))) ||
        /\brank\b.*\brooms\b/.test(q) ||
        compareAcrossZones
      ),
      plotSingle: has('plot','chart','visualize') && !has('across all rooms','on this floor','on this building') && !compareAcrossZones,
      correlation: has('correlation','correlate','matrix'),
      histogram: has('histogram','distribution','frequency','bins','bucket','spread'),
      compareMetricsRoom: (
        has('compare') &&
        metricsRegex.test(q) &&
        !has('across all rooms','across the rooms','on this floor','on this building','between rooms','between zones')
      ),
      tableSample: wantsTableSample,
      tableMeta: wantsTableMeta
      ,
      compareTypes: (q.includes('compare') && /\b(and|vs|versus)\b/i.test(q) && typeRegex.test(q)),
      weatherQuestion: mentionsWeather
    };
  }

  function resolveMetricAndTableFromQuestion(question, availableSets, fallbackField='people_count') {
    const fields = parseFieldsFromQuestion(question, availableSets);
    const field = fields[0] || (question.toLowerCase().includes('occup') ? 'people_count' : (question.toLowerCase().includes('energy') ? 'value' : fallbackField));
    let table = null;
    for (const [t, set] of Object.entries(availableSets)) if (set.has(field)) { table = t; break; }
    if (!table) table = (field === 'value' || field === 'total_kwh') ? 'energy' : 'iaq';
    return { field, table };
  }

  function inferTableNameFromQuestion(question) {
    const q = String(question || '').toLowerCase();
    if (/\benergy\b|\bkwh\b|\bpower\b|\bkw\b/.test(q)) return 'energy';
    if (/\bpeople\b|\boccupancy\b|\bcount\b|\bdwell\b|\bheatmap\b/.test(q)) return 'people';
    if (/\bwater\b|\bleak\b/.test(q)) return 'water';
    if (/\bweather\b/.test(q)) return 'weather';
    return 'iaq';
  }

  function resolveToolName(name) {
    const t = String(name || '').toLowerCase();
    const map = new Map([
      ['list_rooms_in_scope','graph_rooms_by_scope'],
      ['rooms_in_scope','graph_rooms_by_scope'],
      ['scope_rooms','graph_rooms_by_scope'],
      ['graph_rooms_in_scope','graph_rooms_by_scope'],
      ['list_buildings','scope_list_buildings'],
      ['buildings','scope_list_buildings'],
      ['list_floors','scope_list_floors'],
      ['floors','scope_list_floors'],
      ['list_rooms','scope_list_rooms'],
      ['rooms','scope_list_rooms'],
      ['list_detectors','scope_list_detectors'],
      ['detectors_in_room','scope_list_detectors'],
      ['room_detectors','scope_list_detectors'],
      ['sensors_in_room','scope_list_detectors'],
      ['list_sensors','scope_list_detectors'],
      ['devices_in_room','graph_zone_devices'],
      ['list_devices','graph_zone_devices'],
      ['common_metrics','common_metrics_in_scope'],
      ['common_fields','common_metrics_in_scope'],
      ['metrics_in_scope','common_metrics_in_scope'],
      ['rank_rooms','compare_rooms_on_metric'],
      ['top_rooms','compare_rooms_on_metric'],
      ['highest_avg','compare_rooms_on_metric'],
      ['compare_metrics','compare_metrics_in_room'],
      ['compare_fields','compare_metrics_in_room'],
      ['correlate_metrics','correlation_matrix'],
      ['correlationmatrix','correlation_matrix'],
      ['vector_search','vector_search_docs'],
      ['search_docs','vector_search_docs']
      ,
      ['time_for_value','get_time_for_value'],
      ['timestamp_for_value','get_time_for_value'],
      ['find_value_time','get_time_for_value'],
      ['get_timeseries_data','fetch_timeseries'],
      ['get_sensor_data','fetch_timeseries'],
      ['fetch_sensor_data','fetch_timeseries'],
      ['sensor_timeseries','fetch_timeseries'],
      ['pull_timeseries','fetch_timeseries']
    ]);
    return map.get(t) || name;
  }

  function ensureChartData(chartObj, { question, room, selectionRooms = [], range = {}, trace = [], scopeLabels = {} } = {}) {
    if (!chartObj || !Array.isArray(chartObj.series)) return;
    const missingToolCalls = [];
    const rr = range || {};
    const roomsList = Array.isArray(selectionRooms) ? selectionRooms : [];

    for (const series of chartObj.series) {
      if (!series || !series.dataRef) continue;
      const ref = series.dataRef;
      const toolName = ref.tool;
      if (!toolName) continue;

      const alreadyPresent = trace.some((t) => t && t.tool === toolName && (!ref.room || (t.args && String(t.args.room) === String(ref.room))));
      if (alreadyPresent) continue;

      try {
        let args = null;
        if (toolName === 'fetch_timeseries') {
          const primaryDevice = roomsList.find(Boolean);
          const preferredRoom = ref.room || primaryDevice || (isAllRooms(room) ? null : room);
          const binding = resolveFieldBinding(ref.yField || ref.field, selectionRooms, preferredRoom) || null;
          const roomForRef = binding?.room || preferredRoom || (inferRoomFromText(series.name) || inferRoomFromText(question) || room);
          const fieldName = binding?.fieldName || ref.yField || ref.field;
          if (!roomForRef || !fieldName) continue;
          const tableName = binding?.table || resolveTable(roomForRef, 'iaq');
          args = {
            room: roomForRef,
            table: tableName,
            fields: [fieldName],
            start: rr.start ?? undefined,
            end: rr.end ?? undefined
          };
          if (fieldName && ref.yField && fieldName !== ref.yField) ref.yField = fieldName;
          ref.room = roomForRef;
        } else if (toolName === 'pair_timeseries') {
          const primaryDevice = roomsList.find(Boolean) || null;
          const tablesSets = availableFieldsByTable(primaryDevice || room || '');
          let f1 = ref.field1;
          let f2 = ref.field2;
          if ((!f1 || !f2) && series && typeof series.name === 'string') {
            const parts = series.name.split(/\s+vs\s+|\s+and\s+/i).map((s) => s.trim()).filter(Boolean);
            if (parts.length >= 2) {
              f1 = f1 || inferFieldName(parts[0], tablesSets) || parts[0];
              f2 = f2 || inferFieldName(parts[1], tablesSets) || parts[1];
            }
          }
          f1 = f1 || ref.yField || inferFieldName(question, tablesSets) || 'temperature';
          f2 = f2 || inferFieldName(question, tablesSets) || 'humidity';
          const preferredRoom = ref.room || primaryDevice || (isAllRooms(room) ? null : room);
          const binding1 = resolveFieldBinding(f1, selectionRooms, preferredRoom);
          const roomForRef = binding1?.room || preferredRoom || inferRoomFromText(series.name) || inferRoomFromText(question) || room;
          if (!roomForRef) continue;
          const binding2 = resolveFieldBinding(f2, selectionRooms, roomForRef) || resolveFieldBinding(f2, selectionRooms, preferredRoom);
          const table1 = binding1?.table || resolveTable(roomForRef, 'iaq');
          const table2 = (binding2 && binding2.room === roomForRef) ? binding2.table : resolveTable(roomForRef, table1);
          const field1Name = binding1?.fieldName || f1;
          const field2Name = (binding2 && binding2.fieldName) || f2;
          if (!field1Name || !field2Name) continue;
          args = {
            room: roomForRef,
            table1,
            field1: field1Name,
            table2,
            field2: field2Name,
            start: rr.start ?? undefined,
            end: rr.end ?? undefined
          };
          ref.field1 = field1Name;
          ref.field2 = field2Name;
          ref.room = roomForRef;
        } else if (toolName === 'histogram') {
          const primaryDevice = roomsList.find(Boolean) || null;
          const binding = resolveFieldBinding(ref.field, selectionRooms, ref.room || primaryDevice || (isAllRooms(room) ? null : room));
          const roomForRef = binding?.room || ref.room || primaryDevice || (inferRoomFromText(series.name) || inferRoomFromText(question) || room);
          const fieldName = binding?.fieldName || ref.field;
          if (!roomForRef || !fieldName) continue;
          const tableName = binding?.table || resolveTable(roomForRef, 'iaq');
          args = {
            room: roomForRef,
            table: tableName,
            field: fieldName,
            bins: ref.bins || 12,
            start: rr.start ?? undefined,
            end: rr.end ?? undefined
          };
          ref.field = fieldName;
          ref.room = roomForRef;
        } else if (toolName === 'hourly_timeseries' || toolName === 'daily_avg') {
          const primaryDevice = roomsList.find(Boolean) || null;
          const preferredRoom = ref.room || primaryDevice || (isAllRooms(room) ? null : room);
          const fieldHint = ref.field || ref.yField || ref.metric || inferFieldName(series?.name || question, availableFieldsByTable(preferredRoom || room || '')) || 'temperature';
          const binding = resolveFieldBinding(fieldHint, selectionRooms, preferredRoom) || resolveFieldBinding(fieldHint, selectionRooms, null) || resolveFieldBinding('temperature', selectionRooms, preferredRoom);
          if (!binding) continue;
          const roomForRef = binding.room;
          const tableName = binding.table || resolveTable(roomForRef, 'iaq');
          const fieldName = binding.fieldName || fieldHint;
          args = {
            room: roomForRef,
            table: tableName,
            field: fieldName,
            start: rr.start ?? undefined,
            end: rr.end ?? undefined
          };
          ref.field = fieldName;
          ref.room = roomForRef;
        } else if (toolName === 'compare_metrics_in_room') {
          const preferredRoom = ref.room || (isAllRooms(room) ? (roomsList[0] || null) : room) || roomsList[0] || null;
          if (!preferredRoom) continue;
          const axisEntries = [];
          const axes = Array.isArray(chartObj?.xAxis) ? chartObj.xAxis : (chartObj?.xAxis ? [chartObj.xAxis] : []);
          for (const ax of axes) {
            if (Array.isArray(ax?.categories)) axisEntries.push(...ax.categories.map(String));
          }
          const inferredFields = axisEntries.length ? axisEntries : [];
          const manualFields = Array.isArray(ref.fields) ? ref.fields : [];
          let fields = manualFields.length ? manualFields : inferredFields;
          if (!fields.length && typeof series?.name === 'string') {
            fields = series.name.split(/[+,/&]/).map((s) => s.trim()).filter(Boolean);
          }
          if (!fields.length) fields = pickFieldsForRoom(preferredRoom, 4);
          if (!fields.length) continue;
          const binding = resolveFieldBinding(fields[0], selectionRooms, preferredRoom) || resolveFieldBinding(fields[0], [preferredRoom], preferredRoom);
          const tableName = binding?.table || ref.table || resolveTable(preferredRoom, 'iaq');
          const normalizedFields = fields.map((f) => {
            const b = resolveFieldBinding(f, selectionRooms, preferredRoom) || resolveFieldBinding(f, [preferredRoom], preferredRoom);
            return b?.fieldName || f;
          });
          args = {
            room: preferredRoom,
            table: tableName,
            fields: normalizedFields,
            agg: ref.agg || 'avg',
            start: rr.start ?? undefined,
            end: rr.end ?? undefined
          };
          ref.room = preferredRoom;
          ref.fields = normalizedFields;
        } else if (toolName === 'compare_rooms_on_metric') {
          const roomsForCompare = Array.isArray(ref.rooms) && ref.rooms.length
            ? ref.rooms
            : (roomsList.length ? roomsList.slice(0, 12) : (isAllRooms(room) ? listRooms().slice(0, 8) : [room].filter(Boolean)));
          if (!roomsForCompare.length) continue;
          const tablesSets = availableFieldsByTable(roomsForCompare[0]);
          const fieldCandidate = ref.field || ref.metric || inferFieldName(series?.name || question, tablesSets) || 'temperature';
          const binding = resolveFieldBinding(fieldCandidate, roomsForCompare, roomsForCompare[0]) || resolveFieldBinding(fieldCandidate, selectionRooms, roomsForCompare[0]);
          const tableName = binding?.table || ref.table || resolveTable(roomsForCompare[0], fieldCandidate === 'total_kwh' ? 'energy' : 'iaq');
          const fieldName = binding?.fieldName || fieldCandidate;
          args = {
            rooms: roomsForCompare,
            table: tableName,
            field: fieldName,
            agg: ref.agg || 'avg',
            start: rr.start ?? undefined,
            end: rr.end ?? undefined
          };
          ref.field = fieldName;
          ref.rooms = roomsForCompare;
          ref.table = tableName;
        } else if (toolName === 'correlation_matrix') {
          const targetRoom = ref.room || (isAllRooms(room) ? (roomsList[0] || null) : room) || null;
          if (!targetRoom) continue;
          const axes = Array.isArray(chartObj?.xAxis) ? chartObj.xAxis : (chartObj?.xAxis ? [chartObj.xAxis] : []);
          let categories = [];
          for (const ax of axes) {
            if (Array.isArray(ax?.categories) && ax.categories.length) { categories = ax.categories.map(String); break; }
          }
          const fieldList = Array.isArray(ref.fields) && ref.fields.length ? ref.fields : categories;
          const defaultFields = fieldList.length ? fieldList : ['temperature', 'humidity', 'co2'];
          const normalizedFields = defaultFields.map((f) => {
            const binding = resolveFieldBinding(f, selectionRooms, targetRoom) || resolveFieldBinding(f, [targetRoom], targetRoom);
            return binding?.fieldName || f;
          });
          args = {
            room: targetRoom,
            table: ref.table || resolveTable(targetRoom, 'iaq'),
            fields: normalizedFields,
            start: rr.start ?? undefined,
            end: rr.end ?? undefined
          };
          ref.room = targetRoom;
          ref.fields = normalizedFields;
        } else if (toolName === 'hour_of_day_stats') {
          const preferredRoom = ref.room || (isAllRooms(room) ? roomsList[0] || null : room) || roomsList[0] || null;
          if (!preferredRoom) continue;
          const binding = resolveFieldBinding(ref.field || ref.metric || inferFieldName(question, availableFieldsByTable(preferredRoom)), selectionRooms, preferredRoom) ||
                          resolveFieldBinding('occupancy', selectionRooms, preferredRoom) ||
                          resolveFieldBinding('people_count', selectionRooms, preferredRoom) ||
                          resolveFieldBinding('co2', selectionRooms, preferredRoom);
          if (!binding) continue;
          args = {
            room: preferredRoom,
            table: binding.table || resolveTable(preferredRoom, 'iaq'),
            field: binding.fieldName,
            start: rr.start ?? undefined,
            end: rr.end ?? undefined
          };
          ref.room = preferredRoom;
          ref.field = binding.fieldName;
        } else if (toolName === 'scope_heatmap') {
          const roomsForHeatmap = Array.isArray(ref.rooms) && ref.rooms.length
            ? ref.rooms
            : (roomsList.length ? roomsList.slice(0, 20) : selectionRooms.slice(0, 20));
          if (!roomsForHeatmap.length) continue;
          const fieldCandidate = ref.field || ref.metric || (question && /co2|carbon/i.test(question) ? 'co2' : (/temperature|temp/i.test(question) ? 'temperature' : (/humidity/i.test(question) ? 'humidity' : (/occupancy|people/i.test(question) ? 'occupancy' : 'people_count'))));
          const binding = resolveFieldBinding(fieldCandidate, roomsForHeatmap, roomsForHeatmap[0]) || resolveFieldBinding(fieldCandidate, selectionRooms, roomsForHeatmap[0]);
          const tableName = binding?.table || ref.table || resolveTable(roomsForHeatmap[0], fieldCandidate === 'total_kwh' ? 'energy' : (/water/i.test(fieldCandidate) ? 'water' : 'iaq'));
          const fieldName = binding?.fieldName || fieldCandidate;
          args = {
            rooms: roomsForHeatmap,
            table: tableName,
            field: fieldName,
            bucket_minutes: ref.bucket_minutes || 60,
            agg: ref.agg || 'avg',
            start: rr.start ?? undefined,
            end: rr.end ?? undefined
          };
          ref.rooms = roomsForHeatmap;
          ref.field = fieldName;
          ref.table = tableName;
        } else if (toolName && toolName.startsWith('forecast_')) {
          const preferredRoom = ref.room || (isAllRooms(room) ? (roomsList[0] || null) : room) || roomsList[0] || null;
          if (!preferredRoom) continue;
          const tablesSets = availableFieldsByTable(preferredRoom);
          const fieldCandidate = ref.field || inferFieldName(question, tablesSets) || inferFieldName(series?.name, tablesSets) || 'temperature';
          const binding = resolveFieldBinding(fieldCandidate, selectionRooms, preferredRoom) || resolveFieldBinding(fieldCandidate, [preferredRoom], preferredRoom) || resolveFieldBinding('temperature', selectionRooms, preferredRoom);
          if (!binding) continue;
          const tableName = binding.table || resolveTable(preferredRoom, fieldCandidate === 'total_kwh' ? 'energy' : 'iaq');
          const fieldName = binding.fieldName || fieldCandidate;
          args = {
            room: preferredRoom,
            table: tableName,
            field: fieldName,
            start: rr.start ?? undefined,
            end: rr.end ?? undefined
          };
          if (ref.horizon_hours) args.horizon_hours = ref.horizon_hours;
          if (ref.days) args.days = ref.days;
          if (ref.alpha) args.alpha = ref.alpha;
          if (ref.window) args.window = ref.window;
          if (ref.degree) args.degree = ref.degree;
          ref.room = preferredRoom;
          ref.field = fieldName;
          ref.table = tableName;
        } else if (toolName === 'compare_series_cross_room') {
          const roomsForCompare = roomsList.length ? roomsList.slice(0, 8) : (room && !isAllRooms(room) ? [room] : listRooms().slice(0, 4));
          const tablesSetsAny = roomsForCompare.length ? availableFieldsByTable(roomsForCompare[0]) : {};
          let field = ref.yField || ref.field || inferFieldName(series.name, tablesSetsAny) || inferFieldName(question, tablesSetsAny) || 'temperature';
          const seriesArgs = [];
          for (const r of roomsForCompare) {
            const binding = resolveFieldBinding(field, [r], r);
            if (!binding) continue;
            const label = friendlySeriesLocation(binding.room, binding.room);
            seriesArgs.push({
              room: binding.room,
              table: binding.table,
              field: binding.fieldName,
              name: `${label} ${humanizeMetricName(binding.fieldName)}`
            });
          }
          if (!seriesArgs.length) continue;
          args = {
            start: rr.start ?? undefined,
            end: rr.end ?? undefined,
            series: seriesArgs
          };
          ref.field = field;
        } else if (toolName === 'weather_fetch') {
          const fields = Array.isArray(ref.fields) && ref.fields.length ? ref.fields : ['temp', 'humidity'];
          const buildingHint = (scopeLabels && scopeLabels.building) || inferBuildingFromContext();
          args = {
            building: buildingHint || undefined,
            room: (roomsList.length ? roomsList[0] : undefined),
            fields,
            start: rr.start ?? undefined,
            end: rr.end ?? undefined
          };
        }

        if (args) {
          missingToolCalls.push({ tool: toolName, args });
        }
      } catch (err) {
        log('ensureChartData failed to prepare tool', toolName, err?.message || String(err));
      }
    }

    for (const call of missingToolCalls) {
      if (tools[call.tool]) {
        try {
          const result = tools[call.tool](call.args);
          trace.push({ tool: call.tool, args: call.args, result });
          log(`Auto-ran missing tool for chart: ${call.tool}`, call.args);
        } catch (err) {
          log(`ensureChartData tool ${call.tool} failed:`, String(err));
        }
      }
    }
  }

  function chartHasRenderableSeries(chartObj) {
    if (!chartObj) return false;
    const series = Array.isArray(chartObj.series)
      ? chartObj.series
      : Array.isArray(chartObj?.chart?.series)
        ? chartObj.chart.series
        : [];
    if (!series.length) return false;
    return series.some((s) => {
      if (!s) return false;
      if (Array.isArray(s.data) && s.data.length) return true;
      if (s.dataRef && typeof s.dataRef === 'object') return true;
      return false;
    });
  }
  
  const FIELD_SYNONYMS = {
    temperature: ['temp', 'temperaturec', 'temp_c', 'airtemp', 'ambienttemp'],
    people_count: ['people', 'count', 'occupants', 'occupancy', 'personcount'],
    virusrisk: ['virus_risk', 'virusrisk', 'risk'],
    total_kwh: ['totalkwh', 'kwh_total', 'energy_total', 'total_energy'],
    humidity: ['hum', 'rh', 'relativehumidity', 'humid'],
    co2: ['co2ppm', 'carbondioxide', 'co2_level', 'concentration'],
    lux: ['illuminance', 'light', 'lightlevel'],
    pm1: ['pm_1', 'particulate1'],
    pm25: ['pm_2_5', 'pm2.5', 'particulate25'],
    pm10: ['pm_10', 'particulate10'],
    pressure: ['atmpressure', 'barometricpressure'],
    voc: ['volatileorganiccompounds', 'voc_level'],
    nh3: ['ammonia', 'nh_3', 'nh-3'],
    h2s: ['hydrogen_sulfide', 'hydrogensulfide', 'h_2_s', 'h-2-s'],
    odor_level: ['odor','odour','odorlevel','smell','odor_level'],
    airExchangeRate: ['air exchange rate','airexchangerate','airchangerate','airchange','ach','air_exch_rate','air_exch','airexchagerate'],
    battery: ['battery_level', 'batt'],
    rssi: ['signal', 'signalstrength'],
    value: ['reading', 'measurement'],
    unit: ['units'],
    sla: ['servicelevelagreement'],
    time: ['timestamp', 'datetime'],
    date: ['datestamp']
  };

  function normalizeRoomTypeFromId(roomId) {
    const m = String(roomId || '').toLowerCase().match(/^[a-z]_f\d+_([a-z0-9]+)/);
    return m ? m[1] : null;
  }

  function roomsByType(selectionRooms, type) {
    const t = String(type || '').toLowerCase();
    const synonyms = {
      boardroom: ['boardroom','meeting'],
      lab: ['lab','laboratory'],
      toilet: ['toilet','restroom','bathroom','wc'],
      cafe: ['cafe','cafeteria','kitchen']
    };
    const keys = synonyms[t] || [t];
    return (selectionRooms||[]).filter(r => keys.some(k => String(r).toLowerCase().includes(k)));
  }

  function pickFieldsForRoom(room, count = 3) {
    const tablesSets = availableFieldsByTable(room);
    const priority = ['people_count','co2','temperature','humidity','lux','value','total_kwh','voc','pm25','pm10'];
    const out = [];
    for (const p of priority) {
      if (out.length >= count) break;
      for (const set of Object.values(tablesSets)) { if (set.has(p)) { out.push(p); break; } }
    }
    // Fallback: any fields
    if (out.length < count) {
      const any = new Set();
      for (const set of Object.values(tablesSets)) for (const f of set) if (f !== 'ts') any.add(f);
      for (const f of any) { if (out.length >= count) break; if (!out.includes(f)) out.push(f); }
    }
    return out.slice(0, count);
  }
  
  function resolveField(rows, field) {
    const keys = Object.keys(rows?.[0] || {});
    if (!keys.length) return field;
    const target = norm(field);
    let k = keys.find(x => norm(x) === target);
    if (k) return k;
    for (const [canon, syns] of Object.entries(FIELD_SYNONYMS)) {
      if (norm(canon) === target || syns.some(s => norm(s) === target)) {
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

  function ensureFutureForecast(points = [], lastTs = null) {
    if (!Array.isArray(points) || !points.length) return [];
    const cutoff = Number.isFinite(lastTs) ? Number(lastTs) : null;
    return points.filter((p) => {
      if (!p || !Number.isFinite(p.ts)) return false;
      if (cutoff == null) return true;
      return p.ts > cutoff;
    });
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
      // Prefer zones (rooms) from graph snapshot so that "rooms" align with Zones, not device IDs
      try {
        const snap = loadGraphSnapshot();
        if (snap && Array.isArray(snap.nodes)) {
          const rooms = snap.nodes.filter(n => (n.nodeType||n.label)==='Zone').map(n => n.roomId || n.name).filter(Boolean);
          return Array.from(new Set(rooms)).sort();
        }
      } catch {}
      // Fallback to device IDs in S3-only mode
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
    
    scope_summary() {
      return {
        rooms: Array.isArray(currentScopeContext.selectionRooms) ? [...currentScopeContext.selectionRooms] : [],
        zones: Array.isArray(currentScopeContext.selectionZones) ? [...currentScopeContext.selectionZones] : [],
        labels: currentScopeContext.scopeLabels ? { ...currentScopeContext.scopeLabels } : {},
        range: currentScopeContext.range ? { ...currentScopeContext.range } : null
      };
    },

    // Multi-line plotting across a scope (tenant/building/floor/zone)
    // Returns { series: [ { name, zone, building, deviceId, data:[[ts,value],...] } ], meta: { devices, metric } }
    scope_multiline({ tenant = null, building = null, floor = null, zone = null, metric, start = null, end = null, limit_per_series = 500 }) {
      if (!metric) return { series: [], meta: { error: 'metric required' } };
      const out = [];
      try {
        const devResp = (graph && graph.devicesByScope) ? graph.devicesByScope({ tenant, building, floor, zone, type: null }) : { devices: [] };
        const devList = devResp.devices || [];
        for (const d of devList) {
          const devId = String(d.id);
          const tables = loadRoomTables(devId) || {};
          const arr = Array.isArray(tables.telemetry) ? tables.telemetry : [];
          if (!arr.length || !(metric in (arr[0] || {}))) continue;
          let data = [];
          for (const r of arr) {
            if (!withinRange(r.ts, start, end)) continue;
            const v = Number(r[metric]);
            if (Number.isFinite(v)) data.push([r.ts, v]);
          }
          if (limit_per_series && data.length > limit_per_series) data = sampleArray(data, limit_per_series);
          if (data.length) {
            data.sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0));
            out.push({ name: d.name || devId, deviceId: devId, zone: d.zone || null, building: d.building || null, data });
          }
        }
      } catch (e) { log('scope_multiline error:', String(e)); }
      return { series: out, meta: { devices: out.length, metric } };
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
      const tab = resolveTable(room, table);
      const arr = t[tab] || [];

      const coerceValue = (value) => {
        if (value == null) return value;
        if (typeof value === 'number') return value;
        if (typeof value === 'string') {
          const trimmed = value.trim();
          if (trimmed === '') return null;
          const num = Number(trimmed);
          if (Number.isFinite(num)) return num;
        }
        return value;
      };

    const hasExplicitFields = Array.isArray(fields) && fields.length;
    const resolvedFieldCache = new Map();
    const resolveAlias = (alias) => {
      if (!hasExplicitFields) return alias;
      if (!resolvedFieldCache.has(alias)) {
        const resolved = resolveField(arr, alias);
        resolvedFieldCache.set(alias, resolved || alias);
      }
      return resolvedFieldCache.get(alias);
    };

    const selectFields = (row) => {
      const entry = { ts: row.ts };
      if (!hasExplicitFields) {
        for (const [key, value] of Object.entries(row)) {
          if (key === 'ts') continue;
          entry[key] = coerceValue(value);
        }
        return entry;
      }
      for (const alias of fields) {
        if (alias === 'ts') continue;
        const actual = resolveAlias(alias);
        const raw = (actual != null && actual in row) ? row[actual] : row[alias];
        if (raw !== undefined) entry[alias] = coerceValue(raw);
      }
      return entry;
    };

      // If limit is small (like 1) and no specific start, get from the end (most recent)
      const getLatest = limit <= 5 && !start && !after_ts;
      const source = getLatest ? [...arr].reverse() : arr;

      const out = [];
      for (const r of source) {
        if (after_ts != null && r.ts <= after_ts) continue;
        if (!withinRange(r.ts, start, end)) continue;
        out.push(selectFields(r));
        if (limit && out.length >= limit) break;
      }

      if (out.length === 0 && arr.length) {
        const fallbackLimit = limit && limit > 0 ? limit : Math.min(arr.length, 2000);
        if (fallbackLimit <= 5) {
          const target = start != null ? start : (end != null ? end : arr[arr.length - 1].ts);
          const sorted = [...arr].sort((a, b) => {
            const da = Math.abs((a.ts ?? 0) - target);
            const db = Math.abs((b.ts ?? 0) - target);
            return da - db;
          });
          const slice = sorted.slice(0, fallbackLimit).sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
          for (const row of slice) out.push(selectFields(row));
        } else {
          const slice = arr.slice(-fallbackLimit);
          for (const row of slice) out.push(selectFields(row));
        }
      }

      return getLatest ? out.reverse() : out;
    },
    
    stats({ room, table, field, start = null, end = null, queries = null }) {
      const compute = ({ targetRoom, targetTable, targetField, qStart, qEnd }) => {
        const resolvedRoom = targetRoom || room;
        if (!resolvedRoom) return { error: 'room required' };
        const t = loadRoomTables(resolvedRoom);
        const tab = resolveTable(resolvedRoom, targetTable);
        const arr = t[tab] || [];
        const resolvedField = targetField || field;
        if (!resolvedField) return { error: 'field required', room: resolvedRoom };
        let count = 0, min = Infinity, max = -Infinity, sum = 0;
        let minTs = null, maxTs = null;
        for (const r of arr) {
          if (!withinRange(r.ts, qStart ?? start, qEnd ?? end)) continue;
          const v = Number(r[resolvedField]);
          if (!Number.isFinite(v)) continue;
          count += 1;
          sum += v;
          if (v < min) { min = v; minTs = r.ts ?? null; }
          if (v > max) { max = v; maxTs = r.ts ?? null; }
        }
        const avg = count ? sum / count : NaN;
        return {
          room: resolvedRoom,
          table: tab,
          field: resolvedField,
          count,
          min: Number.isFinite(min) ? min : null,
          max: Number.isFinite(max) ? max : null,
          avg: Number.isFinite(avg) ? avg : null,
          sum,
          minTs: minTs ?? null,
          maxTs: maxTs ?? null
        };
      };
      if (Array.isArray(queries) && queries.length) {
        return queries.map((query) => compute({
          targetRoom: query.room || query.room_name || room,
          targetTable: query.table || table,
          targetField: query.field || query.metric_name || field,
          qStart: query.start ?? start,
          qEnd: query.end ?? end
        }));
      }
      return compute({ targetRoom: room, targetTable: table, targetField: field, qStart: start, qEnd: end });
    },
    
    get_time_for_value({
      room,
      table = null,
      field = null,
      metric = null,
      value = null,
      mode = null,
      agg = null,
      start = null,
      end = null
    }) {
      let targetRoom = room;
      if (!targetRoom || isAllRooms(targetRoom)) {
        targetRoom = Array.isArray(currentScopeContext.selectionRooms) && currentScopeContext.selectionRooms.length
          ? currentScopeContext.selectionRooms[0]
          : targetRoom;
      }
      if (!targetRoom) return { error: 'room required', field, value, mode: mode || agg || null, ts: null };
      const resolvedField = field || metric || 'temperature';
      const tab = resolveTable(targetRoom, table || (resolvedField === 'people_count' ? 'people' : 'iaq'));
      const rows = (loadRoomTables(targetRoom)[tab] || []).filter((r) => withinRange(r.ts, start, end));
      if (!rows.length) return { error: 'no_data', field: resolvedField, value: null, ts: null };
      const modeKey = String(mode || agg || (value == null ? 'max' : 'value')).toLowerCase();
      let bestRow = null;
      let bestDiff = Infinity;
      if (value == null && (modeKey === 'max' || modeKey === 'min')) {
        const comparator = modeKey === 'max'
          ? (curr, candidate) => candidate > curr
          : (curr, candidate) => candidate < curr;
        let extreme = modeKey === 'max' ? -Infinity : Infinity;
        for (const row of rows) {
          const v = Number(row[resolvedField]);
          if (!Number.isFinite(v)) continue;
          if (comparator(extreme, v)) {
            extreme = v;
            bestRow = row;
          }
        }
        if (bestRow) {
          return {
            mode: modeKey,
            field: resolvedField,
            value: Number(bestRow[resolvedField]),
            ts: bestRow.ts ?? null
          };
        }
      } else {
        const target = Number(value);
        if (!Number.isFinite(target)) return { error: 'value required', field: resolvedField, value: null, ts: null };
        for (const row of rows) {
          const v = Number(row[resolvedField]);
          if (!Number.isFinite(v)) continue;
          const diff = Math.abs(v - target);
          if (diff < bestDiff) {
            bestDiff = diff;
            bestRow = row;
          }
          if (diff === 0) break;
        }
        if (bestRow) {
          return {
            mode: modeKey || 'value',
            field: resolvedField,
            value: Number(bestRow[resolvedField]),
            ts: bestRow.ts ?? null
          };
        }
      }
      return { error: 'value_not_found', field: resolvedField, value, ts: null };
    },
    
    correlate({ room, table1, field1, table2, field2, start = null, end = null, time_window_ms = 30 * 60 * 1000 }) {
      const resolvedRoom = normalizeRoomId(room) || room;
      const t = loadRoomTables(resolvedRoom);
      const tab1 = resolveTable(resolvedRoom, table1);
      const a = t[tab1] || [];
      let tab2 = null;
      let b = [];
      if (table2 === 'weather') {
        b = loadWeatherScoped(resolvedRoom);
        if (field2 === 'temperature') field2 = 'temp';
      } else {
        tab2 = resolveTable(resolvedRoom, table2);
        b = t[tab2] || [];
      }
      
      const aFiltered = a.filter(r => withinRange(r.ts, start, end));
      const bFiltered = b.filter(r => withinRange(r.ts, start, end));
      
      if (!aFiltered.length || !bFiltered.length) {
        return { n: 0, corr: null, error: 'No data in selected range for one or both tables' };
      }

      let pairs = alignSeriesWithinWindow(aFiltered, field1, bFiltered, field2, time_window_ms);
      if (!pairs.length) {
        const bucketMs = Math.max(time_window_ms * 2, 60 * 60 * 1000);
        pairs = alignSeriesByBucket(aFiltered, field1, bFiltered, field2, bucketMs);
      }
      
      const corr = pearson(pairs.map(p => p[0]), pairs.map(p => p[1]));
      return {
        n: pairs.length,
        corr,
        time_window_ms,
        table1_samples: aFiltered.length,
        table2_samples: bFiltered.length,
        table1_resolved: tab1,
        table2_resolved: tab2 || table2,
        room: resolvedRoom,
        pairs
      };
    },
    
    correlate_cross_room({ room1, table1, field1, room2, table2, field2, start = null, end = null, time_window_ms = 30 * 60 * 1000 }) {
      const resolvedRoom1 = normalizeRoomId(room1) || room1;
      const resolvedRoom2 = normalizeRoomId(room2) || room2;
      const t1 = loadRoomTables(resolvedRoom1);
      const t2 = loadRoomTables(resolvedRoom2);
      const tab1 = resolveTable(resolvedRoom1, table1);
      const tab2 = resolveTable(resolvedRoom2, table2);
      const a = t1[tab1] || [];
      const b = t2[tab2] || [];
      
      const aFiltered = a.filter(r => withinRange(r.ts, start, end));
      const bFiltered = b.filter(r => withinRange(r.ts, start, end));
      
      if (!aFiltered.length || !bFiltered.length) {
        return { n: 0, corr: null, error: 'No data in selected range for one or both rooms' };
      }
      
      let pairs = alignSeriesWithinWindow(aFiltered, field1, bFiltered, field2, time_window_ms);
      if (!pairs.length) {
        const bucketMs = Math.max(time_window_ms * 2, 60 * 60 * 1000);
        pairs = alignSeriesByBucket(aFiltered, field1, bFiltered, field2, bucketMs);
      }

      const corr = pearson(pairs.map(p => p[0]), pairs.map(p => p[1]));
      return {
        n: pairs.length,
        corr,
        room1: resolvedRoom1,
        room2: resolvedRoom2,
        table1_resolved: tab1,
        table2_resolved: tab2,
        table1_samples: aFiltered.length,
        table2_samples: bFiltered.length,
        time_window_ms,
        pairs
      };
    },
    
    correlate_weather_room({ room, table, field_room, field_weather, start = null, end = null, time_window_ms = 60 * 60 * 1000 }) {
      const resolvedRoom = normalizeRoomId(room) || room;
      const t = loadRoomTables(resolvedRoom);
      const roomData = t[table] || [];
      const weatherData = loadWeatherScoped(resolvedRoom);
      
      // Handle weather field aliases
      let weatherField = field_weather;
      if (field_weather === 'temperature') weatherField = 'temp';
      
      let roomFiltered = roomData.filter(r => withinRange(r.ts, start, end));
      let weatherFiltered = weatherData.filter(r => withinRange(r.ts, start, end));
      
      if (!roomFiltered.length || !weatherFiltered.length) {
        return { n: 0, corr: null, error: 'No data in selected range for room or weather' };
      }

      let pairs = alignSeriesWithinWindow(roomFiltered, field_room, weatherFiltered, weatherField, time_window_ms);
      if (!pairs.length) {
        const bucketMs = Math.max(time_window_ms * 2, 60 * 60 * 1000);
        pairs = alignSeriesByBucket(roomFiltered, field_room, weatherFiltered, weatherField, bucketMs);
      }
      
      const corr = pearson(pairs.map(p => p[0]), pairs.map(p => p[1]));
      return { 
        n: pairs.length, 
        corr,
        field_room,
        field_weather: weatherField,
        time_window_ms,
        pairs
      };
    },
    
    weather_correlate({ field1, field2, start = null, end = null, room = null, building = null }) {
      const weather = loadWeatherFor(room, building) || [];
      const filtered = weather.filter((r) => withinRange(r.ts, start, end));
      if (!filtered.length) {
        return { n: 0, corr: null, error: 'No weather data available for the requested window', field1, field2, building, room };
      }
      const pairs = filtered
        .map((r) => [Number(r[field1]), Number(r[field2])])
        .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
      const corr = pearson(pairs.map(p => p[0]), pairs.map(p => p[1]));
      return { n: pairs.length, corr, field1, field2, building, room, pairs };
    },
    
    building_temp_weather_corr({ rooms = null, building = null, field = 'temperature', weather_field = 'temp', start = null, end = null, bucket_minutes = 60 }) {
      const bucketMinutes = Number.isFinite(bucket_minutes) && bucket_minutes > 0 ? bucket_minutes : 60;
      const candidateRooms = Array.isArray(rooms) && rooms.length
        ? rooms.filter(Boolean)
        : (currentScopeContext.selectionRooms && currentScopeContext.selectionRooms.length
            ? currentScopeContext.selectionRooms.slice(0, 24)
            : listRooms().slice(0, 24));
      const uniqueRooms = Array.from(new Set(candidateRooms.filter(Boolean)));
      if (!uniqueRooms.length) {
        return { error: 'No rooms available to compute internal temperature.', n: 0, corr: null, scatter: [] };
      }

      const aggregated = new Map();
      const usedRooms = [];

      for (const roomId of uniqueRooms) {
        const tables = loadRoomTables(roomId);
        if (!tables || !Object.keys(tables).length) continue;
        const tableOrder = [
          'iaq',
          'telemetry',
          ...(Object.keys(tables))
        ];
        const seenTables = new Set();
        let contributed = false;
        for (const candidate of tableOrder) {
          const resolvedTable = resolveTable(roomId, candidate);
          if (!resolvedTable || seenTables.has(resolvedTable)) continue;
          seenTables.add(resolvedTable);
          const hourly = getHourlySeries(roomId, resolvedTable, field, start, end);
          let anyPoint = false;
          for (const p of hourly) {
            if (!Number.isFinite(p.avg)) continue;
            const key = Number.isFinite(p.ts) ? p.ts : floorHour(p.ts);
            const bucket = aggregated.get(key) || { sum: 0, n: 0 };
            bucket.sum += p.avg;
            bucket.n += 1;
            aggregated.set(key, bucket);
            anyPoint = true;
          }
          if (anyPoint) {
            contributed = true;
            break;
          }
        }
        if (contributed) usedRooms.push(roomId);
      }

      if (!aggregated.size) {
        return { error: 'Internal temperature data unavailable for the selected scope.', n: 0, corr: null, scatter: [], rooms: [], bucket_minutes: bucketMinutes };
      }

      const insideSeries = Array.from(aggregated.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([ts, bucket]) => ({
          ts,
          inside: bucket.n ? bucket.sum / bucket.n : null
        }))
        .filter((p) => Number.isFinite(p.inside));

      const referenceRoom = usedRooms[0] || uniqueRooms[0];
      const weatherRows = loadWeatherFor(referenceRoom, building);
      if (!Array.isArray(weatherRows) || !weatherRows.length) {
        return {
          error: 'Weather data unavailable for the selected building scope.',
          n: 0,
          corr: null,
          scatter: [],
          inside_series: insideSeries,
          outside_series: [],
          rooms: usedRooms,
          bucket_minutes: bucketMinutes
        };
      }

      const weatherBuckets = new Map();
      for (const row of weatherRows) {
        if (!withinRange(row.ts, start, end)) continue;
        const val = Number(row[weather_field]);
        if (!Number.isFinite(val)) continue;
        const key = floorHour(row.ts);
        const bucket = weatherBuckets.get(key) || { sum: 0, n: 0 };
        bucket.sum += val;
        bucket.n += 1;
        weatherBuckets.set(key, bucket);
      }

      if (!weatherBuckets.size) {
        return {
          error: 'No overlapping weather data for the requested window.',
          n: 0,
          corr: null,
          scatter: [],
          inside_series: insideSeries,
          outside_series: [],
          rooms: usedRooms,
          bucket_minutes: bucketMinutes
        };
      }

      const outsideSeries = Array.from(weatherBuckets.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([ts, bucket]) => ({
          ts,
          outside: bucket.n ? bucket.sum / bucket.n : null
        }))
        .filter((p) => Number.isFinite(p.outside));

      const insideMap = new Map(insideSeries.map((p) => [p.ts, p.inside]));
      const scatter = [];
      for (const point of outsideSeries) {
        const inside = insideMap.get(point.ts);
        if (!Number.isFinite(inside) || !Number.isFinite(point.outside)) continue;
        scatter.push({
          ts: point.ts,
          inside,
          outside: point.outside,
          x: point.outside,
          y: inside
        });
      }

      const corr = scatter.length >= 3 ? pearson(scatter.map((p) => p.outside), scatter.map((p) => p.inside)) : null;
      const corrSafe = Number.isFinite(corr) ? corr : null;
      const buildingName = building || inferBuildingFromContext(referenceRoom);

      return {
        n: scatter.length,
        corr: corrSafe,
        rooms: usedRooms,
        building: buildingName || null,
        field,
        weather_field,
        bucket_minutes: bucketMinutes,
        inside_series: insideSeries,
        outside_series: outsideSeries,
        scatter
      };
    },

    building_temp_weather_scatter(options = {}) {
      const result = this.building_temp_weather_corr(options);
      if (!result || result.error) return result;
      return {
        ...result,
        scatter_series: result.scatter
      };
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

    scope_heatmap({ rooms = [], table = 'people', field = 'people_count', start = null, end = null, bucket_minutes = 60, agg = 'avg' }) {
      const bucketMinutes = Number.isFinite(bucket_minutes) && bucket_minutes > 0 ? bucket_minutes : 60;
      if (!Array.isArray(rooms) || rooms.length === 0) {
        const err = new Error('scope_heatmap requires at least one room in scope.');
        err.code = 'HEATMAP_NO_ROOMS';
        throw err;
      }
      const resolvedRooms = rooms.map((room) => normalizeRoomId(room) || room);
      const bucketMs = bucketMinutes * 60 * 1000;
      let computedStart = Number.isFinite(start) ? Number(start) : Infinity;
      let computedEnd = Number.isFinite(end) ? Number(end) : -Infinity;
      const roomEntries = [];

      resolvedRooms.forEach((roomId, idx) => {
        const tables = loadRoomTables(roomId);
        const tab = resolveTable(roomId, table);
        const rows = (tables[tab] || []).filter((row) => withinRange(row.ts, start, end));
        if (!rows.length) {
          roomEntries.push({ roomId, index: idx, rows: [], label: friendlySeriesLocation(roomId, deviceFriendlyName(roomId)), buckets: new Map() });
          return;
        }
        for (const r of rows) {
          if (!Number.isFinite(computedStart)) computedStart = r.ts;
          else if (r.ts < computedStart) computedStart = r.ts;
          if (!Number.isFinite(computedEnd)) computedEnd = r.ts;
          else if (r.ts > computedEnd) computedEnd = r.ts;
        }
        roomEntries.push({ roomId, index: idx, rows, label: friendlySeriesLocation(roomId, deviceFriendlyName(roomId)), buckets: new Map() });
      });

      if (!Number.isFinite(computedStart) || !Number.isFinite(computedEnd)) {
        return { rooms: [], timestamps: [], data: [], summary: 'No telemetry available for the requested range.', bucket_minutes: bucketMinutes, agg };
      }

      const rangeStart = Number.isFinite(start) ? Number(start) : computedStart;
      const rangeEnd = Number.isFinite(end) ? Number(end) : computedEnd;
      if (rangeEnd <= rangeStart) {
        return { rooms: [], timestamps: [], data: [], summary: 'Invalid time window for heatmap.', bucket_minutes: bucketMinutes, agg };
      }
      const bucketStart = Math.floor(rangeStart / bucketMs) * bucketMs;
      const bucketEnd = Math.ceil(rangeEnd / bucketMs) * bucketMs;
      const bucketCount = Math.max(1, Math.round((bucketEnd - bucketStart) / bucketMs));

      const timestamps = Array.from({ length: bucketCount }, (_, i) => bucketStart + i * bucketMs);
      const timeLabels = timestamps.map((ts) => formatLocal(ts));

      let globalMin = Infinity;
      let globalMax = -Infinity;
      const heatmapData = [];
      const summaryLines = [];

      for (const entry of roomEntries) {
        const { rows, buckets, index, label } = entry;
        let sumAll = 0;
        let countAll = 0;
        let peakValue = -Infinity;
        let peakTs = null;
        for (const row of rows) {
          const raw = row[field];
          const value = Number(raw);
          if (!Number.isFinite(value)) continue;
          const bucketIndex = Math.floor((row.ts - bucketStart) / bucketMs);
          if (bucketIndex < 0 || bucketIndex >= bucketCount) continue;
          if (!buckets.has(bucketIndex)) buckets.set(bucketIndex, { sum: 0, count: 0, max: -Infinity, maxTs: null, values: [] });
          const bucket = buckets.get(bucketIndex);
          bucket.sum += value;
          bucket.count += 1;
          if (value > bucket.max) {
            bucket.max = value;
            bucket.maxTs = row.ts;
          }
          if (agg === 'sum') bucket.values.push(value);
          sumAll += value;
          countAll += 1;
          if (value > peakValue) {
            peakValue = value;
            peakTs = row.ts;
          }
        }
        for (const [bucketIndex, bucket] of buckets.entries()) {
          let value = null;
          if (bucket.count > 0) {
            if (agg === 'sum') value = bucket.values.reduce((acc, val) => acc + val, 0);
            else if (agg === 'max') value = bucket.max;
            else value = bucket.sum / bucket.count;
          }
          if (value == null) continue;
          const numericValue = Number(value);
          heatmapData.push({ x: bucketIndex, y: index, value: numericValue, ts: timestamps[bucketIndex], room: entry.roomId });
          if (numericValue < globalMin) globalMin = numericValue;
          if (numericValue > globalMax) globalMax = numericValue;
        }
        if (countAll > 0) {
          const avg = sumAll / countAll;
          const summary = `${label}: avg ${formatNumericValue(avg)}${Number.isFinite(peakValue) ? `, peak ${formatNumericValue(peakValue)} at ${formatLocal(peakTs)}` : ''}`;
          summaryLines.push(summary);
        } else {
          summaryLines.push(`${label}: no data in range`);
        }
      }

      const roomsMeta = roomEntries.map(({ roomId, label }) => ({ id: roomId, label }));
      if (!heatmapData.length) {
        return {
          rooms: roomsMeta,
          timestamps,
          timeLabels,
          data: [],
          min: null,
          max: null,
          summary: summaryLines.join(' | ') || 'No telemetry available for the requested rooms.',
          bucket_minutes: bucketMinutes,
          agg
        };
      }

      return {
        rooms: roomsMeta,
        timestamps,
        timeLabels,
        data: heatmapData,
        min: Number.isFinite(globalMin) ? globalMin : null,
        max: Number.isFinite(globalMax) ? globalMax : null,
        summary: summaryLines.join(' | '),
        bucket_minutes: bucketMinutes,
        agg
      };
    },

    compare_series_cross_room({ series = [], start = null, end = null }) {
      const out = {};
      if (!Array.isArray(series)) return out;
      for (const s of series) {
        if (!s || !s.room || !s.table || !s.field) continue;
        const resolvedRoom = normalizeRoomId(s.room) || String(s.room);
        const t = loadRoomTables(resolvedRoom);
        const tab = resolveTable(resolvedRoom, s.table);
        const arr = (t[tab] || []).filter(r => withinRange(r.ts, start, end));
        const name = s.name || `${resolvedRoom} ${s.field}`;
        const points = [];
        for (const r of arr) {
          const y = Number(r[s.field]);
          if (!Number.isFinite(y)) continue;
          points.push({ ts: r.ts, y });
        }
        out[name] = points;
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

    aggregate_stats_across_rooms({ table, field, agg = 'sum', start = null, end = null, rooms = null }) {
      const targets = scopedRoomIds(rooms, { limit: 80 });
      let values = [];
      for (const roomId of targets) {
        const t = loadRoomTables(roomId);
        const tab = resolveTable(roomId, table);
        const rows = (t[tab] || []).filter(row => withinRange(row.ts, start, end));
        if (!rows.length) continue;
        const resolvedField = resolveField(rows, field);
        for (const row of rows) {
          const v = Number(row[resolvedField]);
          if (Number.isFinite(v)) values.push(v);
        }
      }
      if (!values.length) return { agg, value: null, count: 0 };
      const sum = values.reduce((a,b)=>a+b,0);
      const avg = sum / values.length;
      const min = Math.min(...values);
      const max = Math.max(...values);
      const map = { sum, avg, min, max };
      const value = map[agg] != null ? map[agg] : sum;
      return { agg, value, count: values.length, sum, avg, min, max };
    },

    aggregate_hourly_across_rooms({ table, field, agg = 'sum', start = null, end = null }) {
      const buckets = new Map();
      for (const r of listRooms()) {
        const hourly = getHourlySeries(r, table, field, start, end);
        for (const p of hourly) {
          if (!Number.isFinite(p.avg)) continue;
          const b = buckets.get(p.ts) || { sum: 0, n: 0 };
          b.sum += p.avg;
          b.n += 1;
          buckets.set(p.ts, b);
        }
      }
      const out = [];
      for (const [ts, b] of Array.from(buckets.entries()).sort((a,b)=>a[0]-b[0])) {
        const y = agg === 'avg' ? (b.n ? b.sum / b.n : null) : b.sum;
        out.push({ ts, y });
      }
      return out;
    },

    compare_rooms_on_metric({ rooms = null, table, field, agg = 'avg', start = null, end = null }) {
      const targetRooms = scopedRoomIds(rooms, { limit: 32 });
      const out = [];
      for (const roomId of targetRooms) {
        const t = loadRoomTables(roomId);
        const tab = resolveTable(roomId, table);
        const rows = (t[tab] || []).filter(row => withinRange(row.ts, start, end));
        if (!rows.length) {
          out.push({ room: roomId, friendlyName: deviceFriendlyName(roomId), value: null });
          continue;
        }
        const resolvedField = resolveField(rows, field);
        const vals = rows.map(row => Number(row[resolvedField])).filter(Number.isFinite);
        if (!vals.length) {
          out.push({ room: roomId, friendlyName: deviceFriendlyName(roomId), value: null });
          continue;
        }
        const sum = vals.reduce((a,b)=>a+b,0);
        const avg = sum / vals.length;
        const peak = Math.max(...vals);
        const map = { sum, avg, peak };
        out.push({
          room: roomId,
          friendlyName: deviceFriendlyName(roomId),
          value: map[agg] != null ? map[agg] : avg
        });
      }
      out.sort((a,b)=> (b.value ?? -Infinity) - (a.value ?? -Infinity));
      return out;
    },

    comfort_band_summary({
      rooms = [],
      table = 'iaq',
      field = 'temperature',
      minComfort = Number(process.env.COMFORT_MIN_TEMP) || 20,
      maxComfort = Number(process.env.COMFORT_MAX_TEMP) || 24,
      start = null,
      end = null,
      limit = 12
    }) {
      const resolvedRooms = [];
      const seen = new Set();
      const pushRoom = (roomId) => {
        if (!roomId) return;
        const normalized = normalizeRoomId(roomId) || roomId;
        if (!normalized) return;
        if (seen.has(normalized)) return;
        seen.add(normalized);
        resolvedRooms.push(normalized);
      };
      if (Array.isArray(rooms) && rooms.length) {
        rooms.forEach(pushRoom);
      }
      if (!resolvedRooms.length && Array.isArray(currentScopeContext.selectionRooms)) {
        currentScopeContext.selectionRooms.forEach(pushRoom);
      }
      if (!resolvedRooms.length && currentScopeContext.scopeDeviceZones) {
        Object.keys(currentScopeContext.scopeDeviceZones).forEach(pushRoom);
      }
      const summaries = [];
      let totalSamples = 0;
      let totalInBand = 0;
      const clampMin = Number(minComfort);
      const clampMax = Number(maxComfort);
      for (const roomId of resolvedRooms.slice(0, limit || 12)) {
        const tables = loadRoomTables(roomId);
        if (!tables) continue;
        const tab = resolveTable(roomId, table || 'iaq');
        const rows = (tables[tab] || []).filter((row) => withinRange(row.ts, start, end));
        if (!rows.length) continue;
        const resolvedField = resolveField(rows, field || 'temperature');
        const values = [];
        for (const row of rows) {
          const val = Number(row[resolvedField]);
          if (Number.isFinite(val)) values.push(val);
        }
        if (!values.length) continue;
        const samples = values.length;
        const inBand = values.filter((val) => Number.isFinite(clampMin) && Number.isFinite(clampMax)
          ? (val >= clampMin && val <= clampMax)
          : true
        ).length;
        const pct = samples ? (inBand / samples) * 100 : 0;
        const avg = values.reduce((a, b) => a + b, 0) / samples;
        const minVal = Math.min(...values);
        const maxVal = Math.max(...values);
        summaries.push({
          room: roomId,
          friendlyName: deviceFriendlyName(roomId),
          samples,
          inBand,
          pctInBand: pct,
          avgValue: avg,
          minValue: minVal,
          maxValue: maxVal,
          field: resolvedField
        });
        totalSamples += samples;
        totalInBand += inBand;
      }
      summaries.sort((a, b) => (a.pctInBand ?? 0) - (b.pctInBand ?? 0));
      const overall = {
        roomsAnalyzed: summaries.length,
        avgPctInBand: totalSamples ? (totalInBand / totalSamples) * 100 : null,
        minPctInBand: summaries[0]?.pctInBand ?? null,
        maxPctInBand: summaries[summaries.length - 1]?.pctInBand ?? null,
        totalSamples,
        minComfort: clampMin,
        maxComfort: clampMax
      };
      return logToolResult('comfort_band_summary', {
        rooms,
        table,
        field,
        minComfort: clampMin,
        maxComfort: clampMax,
        start,
        end,
        limit
      }, { rooms: summaries, overall });
    },
    
    scope_daily_percentile({
      rooms = null,
      table = 'telemetry',
      value_field = 'co2',
      occupancy_field = 'occupants',
      percentile = 0.95,
      days = 14,
      start = null,
      end = null
    }) {
      const targetRooms = Array.isArray(rooms) && rooms.length
        ? rooms
        : (Array.isArray(currentScopeContext.selectionRooms) ? currentScopeContext.selectionRooms : []);
      if (!targetRooms.length) {
        throw new Error('scope_daily_percentile requires at least one room.');
      }
      const pct = Number.isFinite(percentile) && percentile > 0 && percentile < 1 ? Number(percentile) : 0.95;
      const dayWindow = Number.isFinite(days) && days > 0 ? Number(days) : 14;
      let windowEnd = Number.isFinite(end) ? Number(end) : (currentScopeContext.range?.end ?? Date.now());
      if (!Number.isFinite(windowEnd)) windowEnd = Date.now();
      let windowStart = Number.isFinite(start) ? Number(start) : (currentScopeContext.range?.start ?? (windowEnd - dayWindow * DAY_MS));
      const minStart = windowEnd - dayWindow * DAY_MS;
      if (!Number.isFinite(windowStart)) windowStart = minStart;
      if (!Number.isFinite(start)) windowStart = Math.max(windowStart, minStart);

      const seriesStore = {};
      const summary = [];
      const usedLabels = new Set();
      const labelForRoom = (roomId) => {
        const base = friendlySeriesLocation(roomId, roomId) || String(roomId);
        let candidate = base;
        let suffix = 2;
        while (usedLabels.has(candidate)) {
          candidate = `${base} (${suffix++})`;
        }
        usedLabels.add(candidate);
        return candidate;
      };

      for (const roomId of targetRooms) {
        const normalizedRoom = normalizeRoomId(roomId) || String(roomId);
        const tables = loadRoomTables(normalizedRoom);
        const tab = resolveTable(normalizedRoom, table);
        const rows = (tables[tab] || []).filter((row) => withinRange(row.ts, windowStart, windowEnd));
        const label = labelForRoom(normalizedRoom);
        if (!rows.length) {
          summary.push({
            room: normalizedRoom,
            label,
            avg_p95: null,
            worst_p95: null,
            occupied_median: null,
            days: 0,
            samples: 0
          });
          continue;
        }
        const resolvedValueField = resolveField(rows, value_field);
        const resolvedOccField = occupancy_field ? resolveField(rows, occupancy_field) : null;
        const buckets = new Map();
        let samples = 0;
        for (const row of rows) {
          if (!Number.isFinite(row.ts)) continue;
          const val = Number(row[resolvedValueField]);
          if (!Number.isFinite(val)) continue;
          samples += 1;
          const dayKey = startOfDayLocal(row.ts);
          if (dayKey == null) continue;
          if (!buckets.has(dayKey)) buckets.set(dayKey, { values: [], occupiedValues: [] });
          const bucket = buckets.get(dayKey);
          bucket.values.push(val);
          if (resolvedOccField) {
            const occVal = Number(row[resolvedOccField]);
            if (Number.isFinite(occVal) && occVal > 0) bucket.occupiedValues.push(val);
          }
        }
        const dailySeries = [];
        for (const [dayKey, bucket] of Array.from(buckets.entries()).sort((a, b) => a[0] - b[0])) {
          if (!bucket.values.length) continue;
          const p95 = percentileValue(bucket.values, pct);
          if (p95 == null) continue;
          const occMedian = bucket.occupiedValues.length ? medianValue(bucket.occupiedValues) : null;
          dailySeries.push({ ts: dayKey, p95, occupied_median: occMedian });
        }
        if (dailySeries.length) {
          seriesStore[label] = dailySeries;
        }
        const p95Values = dailySeries.map((p) => p.p95).filter((v) => Number.isFinite(v));
        const occupiedMedians = dailySeries.map((p) => p.occupied_median).filter((v) => Number.isFinite(v));
        const avgP95 = p95Values.length ? p95Values.reduce((a, b) => a + b, 0) / p95Values.length : null;
        const worstP95 = p95Values.length ? Math.max(...p95Values) : null;
        const occupiedMedianOverall = occupiedMedians.length ? medianValue(occupiedMedians) : null;
        summary.push({
          room: normalizedRoom,
          label,
          avg_p95: avgP95,
          worst_p95: worstP95,
          occupied_median: occupiedMedianOverall,
          days: dailySeries.length,
          samples
        });
      }

      summary.sort((a, b) => (b.worst_p95 ?? -Infinity) - (a.worst_p95 ?? -Infinity));

      return {
        series: seriesStore,
        summary,
        percentile: pct,
        value_field,
        occupancy_field,
        start: windowStart,
        end: windowEnd
      };
    },

    timeseries_regression_join({
      metrics = [],
      regressions = [],
      bucket_minutes = 60,
      start = null,
      end = null,
      timeZone = DEFAULT_TIME_ZONE,
      forward_fill_minutes = 60
    }) {
      if (!Array.isArray(metrics) || !metrics.length) {
        throw new Error('timeseries_regression_join requires at least one metric definition.');
      }
      const bucketMs = Math.max(1, bucket_minutes || 60) * 60 * 1000;
      const ffMs = Math.max(0, forward_fill_minutes || bucket_minutes || 60) * 60 * 1000;
      const contextRange = currentScopeContext.range || {};
      let windowStart = Number.isFinite(start) ? Number(start) : contextRange.start;
      let windowEnd = Number.isFinite(end) ? Number(end) : contextRange.end;
      if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd)) {
        let minTs = Infinity;
        let maxTs = -Infinity;
        for (const metric of metrics) {
          const normalizedRoom = normalizeRoomId(metric.room) || metric.room;
          if (!normalizedRoom) continue;
          const tables = loadRoomTables(normalizedRoom);
          const tableName = resolveTable(normalizedRoom, metric.table || 'telemetry');
          const rows = (tables[tableName] || []).filter((row) => Number.isFinite(row.ts));
          if (!rows.length) continue;
          minTs = Math.min(minTs, rows[0].ts);
          maxTs = Math.max(maxTs, rows[rows.length - 1].ts);
        }
        if (!Number.isFinite(windowStart)) windowStart = minTs;
        if (!Number.isFinite(windowEnd)) windowEnd = maxTs;
      }
      if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd)) {
        throw new Error('Unable to determine time window for timeseries_regression_join.');
      }
      const alignedStart = alignTimestampToBucket(windowStart, bucket_minutes, timeZone);
      const alignedEnd = alignTimestampToBucket(windowEnd + bucketMs - 1, bucket_minutes, timeZone);
      const bucketCount = Math.max(1, Math.floor((alignedEnd - alignedStart) / bucketMs) + 1);
      const buckets = [];
      for (let idx = 0; idx < bucketCount; idx++) buckets.push(alignedStart + idx * bucketMs);

      const aliasMeta = {};
      const valueSeries = {};

      const assignAlias = (metric, idx) => {
        const base =
          metric.alias ||
          friendlySeriesLocation(metric.room, metric.room) + (metric.field ? ` ${metric.field}` : '') ||
          `series_${idx + 1}`;
        let alias = base;
        let suffix = 2;
        while (aliasMeta[alias]) {
          alias = `${base} (${suffix++})`;
        }
        return alias;
      };

      metrics.forEach((metric, idx) => {
        const normalizedRoom = normalizeRoomId(metric.room) || metric.room;
        if (!normalizedRoom) return;
        const alias = assignAlias(metric, idx);
        const tables = loadRoomTables(normalizedRoom);
        const tableName = resolveTable(normalizedRoom, metric.table || 'telemetry');
        const rows = (tables[tableName] || []).filter((row) =>
          withinRange(row.ts, alignedStart - ffMs, alignedEnd + bucketMs + ffMs)
        );
        if (!rows.length) {
          valueSeries[alias] = buckets.map((ts) => ({ ts, value: null }));
          aliasMeta[alias] = { room: normalizedRoom, field: metric.field, table: tableName };
          return;
        }
        rows.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
        const mode = metric.mode || 'avg';
        const resolvedField = metric.fields || metric.field || PEOPLE_FALLBACK_FIELDS;
        const acc = new Map();
        let prevValue = null;
        let prevTs = null;
        for (const row of rows) {
          const ts = row.ts;
          if (!Number.isFinite(ts)) continue;
          const raw = extractFieldValue(row, resolvedField);
          if (!Number.isFinite(raw)) continue;
          let val = raw;
          if (mode === 'delta') {
            if (prevValue == null) {
              prevValue = raw;
              prevTs = ts;
              continue;
            }
            const delta = raw - prevValue;
            prevValue = raw;
            prevTs = ts;
            if (delta < 0) continue;
            val = delta;
          }
          const bucketTs = alignTimestampToBucket(ts, bucket_minutes, timeZone);
          if (bucketTs < alignedStart || bucketTs > alignedEnd) continue;
          const entry = acc.get(bucketTs) || { sum: 0, count: 0 };
          entry.sum += val;
          entry.count += 1;
          acc.set(bucketTs, entry);
        }
        const aliasSeries = buckets.map((ts) => {
          const entry = acc.get(ts);
          if (!entry || !entry.count) return { ts, value: null };
          const value = mode === 'sum' || mode === 'delta' ? entry.sum : entry.sum / entry.count;
          return { ts, value };
        });
        valueSeries[alias] = aliasSeries;
        aliasMeta[alias] = { room: normalizedRoom, field: metric.field || resolvedField, table: tableName };
      });

      const regressionResults = [];
      const scatterSeries = {};
      for (const reg of regressions || []) {
        const name = reg.name || `${reg.y || 'y'} vs ${reg.x || 'x'}`;
        const xSeries = valueSeries[reg.x] || [];
        const ySeries = valueSeries[reg.y] || [];
        const seriesPoints = [];
        const map = new Map();
        xSeries.forEach((entry) => {
          if (Number.isFinite(entry.value)) map.set(entry.ts, { ts: entry.ts, x: entry.value });
        });
        ySeries.forEach((entry) => {
          if (!Number.isFinite(entry.value)) return;
          const existing = map.get(entry.ts);
          if (!existing || !Number.isFinite(existing.x)) return;
          existing.y = entry.value;
          seriesPoints.push(existing);
        });
        const regression = linearRegression(
          seriesPoints.map((p) => p.x),
          seriesPoints.map((p) => p.y)
        );
        regressionResults.push({
          name,
          xAlias: reg.x,
          yAlias: reg.y,
          slope: regression.slope,
          intercept: regression.intercept,
          r2: regression.r2,
          n: regression.n,
          points: seriesPoints
        });
        scatterSeries[name] = seriesPoints.map((p) => [p.x, p.y]);
      }

      return {
        start: alignedStart,
        end: alignedEnd,
        bucket_minutes,
        timeZone,
        series: valueSeries,
        regressions: regressionResults,
        scatter: scatterSeries,
        aliases: aliasMeta
      };
    },

    occupancy_people_insight({
      occupancy_room,
      occupancy_field = 'is_used',
      people_room,
      people_fields = PEOPLE_FALLBACK_FIELDS,
      bucket_minutes = 15,
      start = null,
      end = null,
      timeZone = DEFAULT_TIME_ZONE,
      peak_windows = [
        { label: '08-10', startHour: 8, endHour: 10 },
        { label: '12-14', startHour: 12, endHour: 14 },
        { label: '16-18', startHour: 16, endHour: 18 }
      ]
    }) {
      if (!occupancy_room || !people_room) {
        throw new Error('occupancy_people_insight requires both occupancy_room and people_room.');
      }
      const bucketMs = Math.max(1, bucket_minutes || 15) * 60 * 1000;
      const contextRange = currentScopeContext.range || {};
      const windowStart = Number.isFinite(start) ? Number(start) : contextRange.start;
      const windowEnd = Number.isFinite(end) ? Number(end) : contextRange.end;
      const normalizedOcc = normalizeRoomId(occupancy_room) || occupancy_room;
      const normalizedPeople = normalizeRoomId(people_room) || people_room;
      const occupancyTables = loadRoomTables(normalizedOcc);
      const peopleTables = loadRoomTables(normalizedPeople);
      const occRows = (occupancyTables.telemetry || occupancyTables.occupancy || occupancyTables.people || [])
        .filter((row) => withinRange(row.ts, windowStart, windowEnd));
      const peopleRows = (peopleTables.people || peopleTables.telemetry || [])
        .filter((row) => withinRange(row.ts, windowStart, windowEnd));
      const occupancyBuckets = new Map();
      for (const row of occRows) {
        if (!Number.isFinite(row.ts)) continue;
        const bucketTs = alignTimestampToBucket(row.ts, bucket_minutes, timeZone);
        const entry = occupancyBuckets.get(bucketTs) || { sum: 0, count: 0 };
        entry.sum += coerceBooleanUsage(row[occupancy_field]);
        entry.count += 1;
        occupancyBuckets.set(bucketTs, entry);
      }
      const peopleBuckets = new Map();
      for (const row of peopleRows) {
        if (!Number.isFinite(row.ts)) continue;
        const bucketTs = alignTimestampToBucket(row.ts, bucket_minutes, timeZone);
        const val = extractFieldValue(row, people_fields);
        if (!Number.isFinite(val)) continue;
        const entry = peopleBuckets.get(bucketTs) || { sum: 0, count: 0 };
        entry.sum += val;
        entry.count += 1;
        peopleBuckets.set(bucketTs, entry);
      }
      const allBucketKeys = Array.from(new Set([...occupancyBuckets.keys(), ...peopleBuckets.keys()])).sort((a, b) => a - b);
      const combinedBuckets = allBucketKeys.map((ts) => {
        const occ = occupancyBuckets.get(ts);
        const ppl = peopleBuckets.get(ts);
        return {
          ts,
          utilisation: occ && occ.count ? occ.sum / occ.count : null,
          people: ppl && ppl.count ? ppl.sum / ppl.count : null
        };
      });

      const heatmapData = [];
      const dayHourMap = new Map();
      combinedBuckets.forEach(({ ts, utilisation }) => {
        if (!Number.isFinite(ts) || utilisation == null) return;
        const parts = getTimeZoneParts(ts, timeZone);
        const day = new Date(ts + parts.offset).getUTCDay();
        const hour = parts.hour;
        const key = `${day}:${hour}`;
        const entry = dayHourMap.get(key) || { sum: 0, count: 0 };
        entry.sum += utilisation;
        entry.count += 1;
        dayHourMap.set(key, entry);
      });
      for (const [key, entry] of dayHourMap.entries()) {
        const [dayStr, hourStr] = key.split(':');
        heatmapData.push({
          day: Number(dayStr),
          hour: Number(hourStr),
          value: entry.count ? entry.sum / entry.count : null
        });
      }

      const peakSummaries = peak_windows.map((window) => {
        const stats = { label: window.label || `${window.startHour}-${window.endHour}`, sum: 0, count: 0 };
        combinedBuckets.forEach(({ ts, people }) => {
          if (people == null) return;
          const parts = getTimeZoneParts(ts, timeZone);
          if (parts.hour >= window.startHour && parts.hour < window.endHour) {
            stats.sum += people;
            stats.count += 1;
          }
        });
        stats.avg = stats.count ? stats.sum / stats.count : null;
        return stats;
      });

      const scatter = combinedBuckets
        .filter((row) => row.people != null && row.utilisation != null)
        .map((row) => ({ ts: row.ts, x: row.people, y: row.utilisation }));
      const regression = linearRegression(
        scatter.map((p) => p.x),
        scatter.map((p) => p.y)
      );

      return {
        buckets: combinedBuckets,
        heatmap: {
          data: heatmapData,
          days: [0, 1, 2, 3, 4, 5, 6],
          hours: Array.from({ length: 24 }, (_, i) => i),
          timeZone
        },
        peaks: peakSummaries,
        scatter,
        regression
      };
    },

    odor_event_monitor({
      odor_room,
      odor_fields = ['h2s', 'nh3'],
      people_room,
      people_fields = PEOPLE_FALLBACK_FIELDS,
      window_minutes = 60,
      threshold = 3,
      min_duration_minutes = 10,
      context_minutes = 30,
      start = null,
      end = null,
      timeZone = DEFAULT_TIME_ZONE
    }) {
      if (!odor_room) throw new Error('odor_event_monitor requires odor_room.');
      const normalizedOdor = normalizeRoomId(odor_room) || odor_room;
      const normalizedPeople = people_room ? (normalizeRoomId(people_room) || people_room) : null;
      const tables = loadRoomTables(normalizedOdor);
      const rows = (tables.telemetry || [])
        .filter((row) => withinRange(row.ts, start ?? currentScopeContext.range?.start, end ?? currentScopeContext.range?.end))
        .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
      const windowMs = Math.max(1, window_minutes || 60) * 60 * 1000;
      const minDurationMs = Math.max(1, min_duration_minutes || 10) * 60 * 1000;
      const statsByField = new Map();
      const ensureFieldStats = (field) => {
        if (!statsByField.has(field)) {
          statsByField.set(field, { values: [], sum: 0, sumSq: 0 });
        }
        return statsByField.get(field);
      };
      const pushValue = (field, sample) => {
        const stats = ensureFieldStats(field);
        stats.values.push(sample);
        stats.sum += sample.value;
        stats.sumSq += sample.value * sample.value;
      };
      const pruneValues = (field, currentTs) => {
        const stats = ensureFieldStats(field);
        while (stats.values.length && currentTs - stats.values[0].ts > windowMs) {
          const removed = stats.values.shift();
          stats.sum -= removed.value;
          stats.sumSq -= removed.value * removed.value;
        }
      };
      const zScore = (field, currentValue, currentTs) => {
        const stats = ensureFieldStats(field);
        pruneValues(field, currentTs);
        if (stats.values.length < 2) return 0;
        const mean = stats.sum / stats.values.length;
        const variance = stats.sumSq / stats.values.length - mean * mean;
        const sd = variance > 0 ? Math.sqrt(variance) : 0;
        if (!sd) return 0;
        return (currentValue - mean) / sd;
      };

      const timeSeries = [];
      let eventState = null;
      const events = [];
      const dailyCounts = new Map();
      for (const row of rows) {
        if (!Number.isFinite(row.ts)) continue;
        const entry = { ts: row.ts, values: {}, z: {} };
        let maxZ = -Infinity;
        let peakField = null;
        for (const field of odor_fields) {
          const val = coerceNumber(row[field]);
          if (!Number.isFinite(val)) continue;
          pushValue(field, { ts: row.ts, value: val });
          const z = zScore(field, val, row.ts);
          entry.values[field] = val;
          entry.z[field] = z;
          if (z > maxZ) {
            maxZ = z;
            peakField = field;
          }
        }
        timeSeries.push(entry);
        const active = maxZ >= threshold;
        if (active && !eventState) {
          eventState = { start: row.ts, end: row.ts, maxZ, field: peakField };
        } else if (active && eventState) {
          eventState.end = row.ts;
          if (maxZ > eventState.maxZ) {
            eventState.maxZ = maxZ;
            eventState.field = peakField;
          }
        } else if (!active && eventState) {
          const duration = eventState.end - eventState.start;
          if (duration >= minDurationMs) {
            events.push({ ...eventState });
            const dayKey = startOfDayLocal(eventState.start, timeZone);
            dailyCounts.set(dayKey, (dailyCounts.get(dayKey) || 0) + 1);
          }
          eventState = null;
        }
      }
      if (eventState) {
        const duration = eventState.end - eventState.start;
        if (duration >= minDurationMs) {
          events.push({ ...eventState });
          const dayKey = startOfDayLocal(eventState.start, timeZone);
          dailyCounts.set(dayKey, (dailyCounts.get(dayKey) || 0) + 1);
        }
      }

      const flowSummaries = [];
      if (normalizedPeople) {
        const flowTables = loadRoomTables(normalizedPeople);
        const flowRows = (flowTables.people || flowTables.telemetry || [])
          .filter((row) => Number.isFinite(row.ts))
          .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
        const ctxMs = Math.max(5, context_minutes || 30) * 60 * 1000;
        for (const event of events) {
          const startWindow = event.start - ctxMs;
          const endWindow = event.end + ctxMs;
          const values = [];
          for (const row of flowRows) {
            if (row.ts < startWindow) continue;
            if (row.ts > endWindow) break;
            const val = extractFieldValue(row, people_fields);
            if (Number.isFinite(val)) values.push(val);
          }
          values.sort((a, b) => a - b);
          const median = values.length
            ? values.length % 2
              ? values[(values.length - 1) / 2]
              : (values[values.length / 2 - 1] + values[values.length / 2]) / 2
            : null;
          flowSummaries.push({
            start: event.start,
            end: event.end,
            medianFlow: median,
            samples: values.length
          });
        }
      }

      return {
        events,
        daily_counts: Array.from(dailyCounts.entries()).map(([ts, count]) => ({ ts, count })),
        series: timeSeries,
        flowDuringEvents: flowSummaries,
        parameters: { threshold, window_minutes, min_duration_minutes }
      };
    },

    scope_schema_matrix({ rooms = null, include_tables = false }) {
      const targetRooms = Array.isArray(rooms) && rooms.length
        ? rooms
        : (Array.isArray(currentScopeContext.selectionRooms) && currentScopeContext.selectionRooms.length
            ? currentScopeContext.selectionRooms
            : listRooms());
      if (!targetRooms.length) throw new Error('scope_schema_matrix requires at least one room.');
      const metricsSet = new Set(['co2', 'pm25', 'pm10', 'airExchangeRate', 'virusRisk', 'voc', 'mold', 'radonShortTermAvg', 'temperature', 'humidity', 'lux', 'battery', 'rssi', 'occupants', 'occupantsLower', 'occupantsUpper']);
      const rows = [];
      for (const roomId of targetRooms) {
        const normalizedRoom = normalizeRoomId(roomId) || String(roomId);
        const tables = loadRoomTables(normalizedRoom);
        const fieldMap = {};
        const tableDetails = {};
        for (const [tableName, entries] of Object.entries(tables || {})) {
          if (!Array.isArray(entries) || !entries.length) continue;
          const sampleSize = Math.min(entries.length, 3000);
          const sampleRows = entries.slice(-sampleSize);
          const fieldsSet = new Set();
          for (const row of sampleRows) {
            if (!row || typeof row !== 'object') continue;
            for (const key of Object.keys(row)) {
              if (key && key !== 'ts') fieldsSet.add(key);
            }
          }
          if (!fieldsSet.size) continue;
          const fields = Array.from(fieldsSet);
          tableDetails[tableName] = fields;
          for (const field of fields) {
            const key = field.trim();
            if (!key) continue;
            metricsSet.add(key);
            fieldMap[key] = { table: tableName, present: true };
          }
        }
        const hier = lookupDeviceHierarchy(normalizedRoom) || {};
        const label = friendlySeriesLocation(normalizedRoom, hier.name || normalizedRoom);
        const deviceEntry = {
          room: normalizedRoom,
          label,
          deviceName: hier.name || normalizedRoom,
          building: hier.buildingName || currentScopeContext.scopeLabels?.building || null,
          floor: hier.floorName || currentScopeContext.scopeLabels?.floor || null,
          zone: hier.zoneName || currentScopeContext.scopeLabels?.room || null,
          metrics: fieldMap,
          missingMetrics: [],
          tables: include_tables ? tableDetails : undefined
        };
        rows.push(deviceEntry);
      }
      const orderedMetrics = Array.from(metricsSet).filter(Boolean).sort();
      for (const row of rows) {
        const missing = [];
        for (const metric of orderedMetrics) {
          if (!row.metrics[metric]) missing.push(metric);
        }
        row.missingMetrics = missing;
      }
      return { metrics: orderedMetrics, devices: rows };
    },

    grid_align_timeseries({
      series = [],
      start = null,
      end = null,
      bucket_minutes = 5,
      forward_fill_minutes = 15,
      timeZone = DEFAULT_TIME_ZONE
    }) {
      if (!Array.isArray(series) || !series.length) {
        throw new Error('grid_align_timeseries requires at least one series definition.');
      }
      const bucketMs = Math.max(1, bucket_minutes || 5) * 60 * 1000;
      const forwardFillMs = Math.max(0, forward_fill_minutes || 0) * 60 * 1000;
      const contextRange = currentScopeContext.range || {};
      let windowStart = Number.isFinite(start) ? Number(start) : contextRange.start;
      let windowEnd = Number.isFinite(end) ? Number(end) : contextRange.end;
      if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd)) {
        // derive from available data if range missing
        let minTs = Infinity;
        let maxTs = -Infinity;
        for (const entry of series) {
          const room = entry?.room;
          if (!room) continue;
          const normalizedRoom = normalizeRoomId(room) || room;
          const tables = loadRoomTables(normalizedRoom);
          const tableName = resolveTable(normalizedRoom, entry.table || 'telemetry');
          const rows = (tables[tableName] || []).filter((row) => Number.isFinite(row.ts));
          if (!rows.length) continue;
          minTs = Math.min(minTs, rows[0].ts);
          maxTs = Math.max(maxTs, rows[rows.length - 1].ts);
        }
        if (Number.isFinite(minTs) && !Number.isFinite(windowStart)) windowStart = minTs;
        if (Number.isFinite(maxTs) && !Number.isFinite(windowEnd)) windowEnd = maxTs;
      }
      if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd)) {
        throw new Error('Unable to infer start/end for grid_align_timeseries.');
      }
      const alignedStart = alignTimestampToBucket(windowStart, bucket_minutes, timeZone);
      const alignedEnd = alignTimestampToBucket(windowEnd + bucketMs - 1, bucket_minutes, timeZone);
      const bucketCount = Math.max(1, Math.floor((alignedEnd - alignedStart) / bucketMs) + 1);
      const buckets = [];
      for (let i = 0; i < bucketCount; i++) buckets.push(alignedStart + i * bucketMs);

      const aliasMeta = {};
      const completeness = {};
      const rows = buckets.map((ts) => ({ ts }));

      const assignAlias = (entry, index) => {
        if (entry.alias) return entry.alias;
        const base = `${friendlySeriesLocation(entry.room, entry.room)} ${entry.field || ''}`.trim() || `series_${index + 1}`;
        let name = base;
        let suffix = 2;
        while (aliasMeta[name]) {
          name = `${base} (${suffix++})`;
        }
        return name;
      };

      series.forEach((entry, idx) => {
        const room = entry?.room;
        const field = entry?.field;
        if (!room || !field) return;
        const normalizedRoom = normalizeRoomId(room) || room;
        const table = resolveTable(normalizedRoom, entry.table || 'telemetry');
        const alias = assignAlias(entry, idx);
        aliasMeta[alias] = { room: normalizedRoom, table, field };
        const tables = loadRoomTables(normalizedRoom);
        const rowsRaw = (tables[table] || []).filter((row) => withinRange(row.ts, alignedStart, alignedEnd + bucketMs));
        if (!rowsRaw.length) {
          completeness[alias] = { samples: 0, expected: bucketCount, completeness: 0 };
          return;
        }
        const resolvedField = resolveField(rowsRaw, field);
        let pointer = 0;
        let lastValue = null;
        let lastTs = null;
        let filled = 0;
        for (const bucketTs of buckets) {
          const bucketIndex = Math.round((bucketTs - alignedStart) / bucketMs);
          const targetRow = rows[bucketIndex];
          while (pointer < rowsRaw.length && rowsRaw[pointer].ts <= bucketTs) {
            const candidate = Number(rowsRaw[pointer][resolvedField]);
            if (Number.isFinite(candidate)) {
              lastValue = candidate;
              lastTs = rowsRaw[pointer].ts;
            }
            pointer += 1;
          }
          const withinTolerance = Number.isFinite(lastTs) && bucketTs - lastTs <= forwardFillMs;
          if (withinTolerance && Number.isFinite(lastValue)) {
            targetRow[alias] = lastValue;
            filled += 1;
          } else {
            targetRow[alias] = null;
          }
        }
        completeness[alias] = {
          samples: filled,
          expected: bucketCount,
          completeness: bucketCount ? filled / bucketCount : 0
        };
      });

      const aliasList = Object.keys(aliasMeta);
      const heatmapData = [];
      rows.forEach((row, xIdx) => {
        aliasList.forEach((alias, yIdx) => {
          const val = row[alias];
          heatmapData.push({
            x: xIdx,
            y: yIdx,
            ts: row.ts,
            alias,
            value: Number.isFinite(val) ? 1 : 0
          });
        });
      });

      return {
        start: alignedStart,
        end: alignedEnd,
        bucket_minutes,
        timeZone,
        rows,
        completeness,
        aliases: aliasMeta,
        heatmap: {
          aliases: aliasList,
          timestamps: rows.map((row) => row.ts),
          data: heatmapData
        }
      };
    },

    ventilation_effectiveness({
      rooms = null,
      start = null,
      end = null,
      value_field = 'co2',
      air_field = 'airExchangeRate',
      percentile = 0.95
    }) {
      const targetRooms = Array.isArray(rooms) && rooms.length
        ? rooms
        : (Array.isArray(currentScopeContext.selectionRooms) && currentScopeContext.selectionRooms.length
            ? currentScopeContext.selectionRooms
            : listRooms());
      if (!targetRooms.length) throw new Error('ventilation_effectiveness requires at least one room.');
      const percentileResult = tools.scope_daily_percentile({
        rooms: targetRooms,
        start,
        end,
        value_field,
        percentile
      });
      const airByRoom = new Map();
      for (const roomId of targetRooms) {
        const normalizedRoom = normalizeRoomId(roomId) || roomId;
        const tables = loadRoomTables(normalizedRoom);
        const table = resolveTable(normalizedRoom, 'telemetry');
        const rowsRaw = (tables[table] || []).filter((row) => withinRange(row.ts, percentileResult.start, percentileResult.end));
        if (!rowsRaw.length) continue;
        const resolvedField = resolveField(rowsRaw, air_field);
        const daily = new Map();
        for (const row of rowsRaw) {
          const value = Number(row[resolvedField]);
          if (!Number.isFinite(value)) continue;
          const dayKey = startOfDayLocal(row.ts);
          if (!daily.has(dayKey)) daily.set(dayKey, { sum: 0, n: 0 });
          const bucket = daily.get(dayKey);
          bucket.sum += value;
          bucket.n += 1;
        }
        airByRoom.set(
          normalizedRoom,
          new Map(Array.from(daily.entries()).map(([k, v]) => [k, v.n ? v.sum / v.n : null]))
        );
      }
      const roomsOut = [];
      for (const summaryRow of percentileResult.summary) {
        const roomKey = summaryRow.room;
        const label = summaryRow.label || friendlySeriesLocation(roomKey, roomKey);
        const daySeries = percentileResult.series[label] || percentileResult.series[roomKey] || [];
        const airSeries = airByRoom.get(roomKey) || new Map();
        const points = [];
        for (const entry of daySeries) {
          const airValue = airSeries.get(entry.ts);
          if (!Number.isFinite(airValue) || !Number.isFinite(entry.p95)) continue;
          points.push({ ts: entry.ts, x: airValue, y: entry.p95 });
        }
        const regression = linearRegression(points);
        roomsOut.push({
          room: roomKey,
          label,
          points,
          regression
        });
      }
      roomsOut.sort((a, b) => {
        const aR2 = Number.isFinite(a.regression.r2) ? a.regression.r2 : -Infinity;
        const bR2 = Number.isFinite(b.regression.r2) ? b.regression.r2 : -Infinity;
        return bR2 - aR2;
      });
      const scatterSeries = roomsOut.map((entry) => ({
        name: entry.label,
        data: entry.points.map((p) => [p.x, p.y]),
        regression: entry.regression,
        room: entry.room
      }));
      return {
        rooms: roomsOut,
        series: scatterSeries,
        percentile: percentileResult.percentile,
        start: percentileResult.start,
        end: percentileResult.end,
        value_field,
        air_field
      };
    },

    daypart_boxplot({
      rooms,
      field,
      occupancy_field = 'occupants',
      table = 'telemetry',
      start = null,
      end = null,
      timeZone = DEFAULT_TIME_ZONE
    }) {
      if (!Array.isArray(rooms) || !rooms.length) {
        throw new Error('daypart_boxplot requires an explicit list of rooms.');
      }
      if (!field) throw new Error('daypart_boxplot requires a metric field.');
      const contextRange = currentScopeContext.range || {};
      const windowStart = Number.isFinite(start) ? Number(start) : contextRange.start;
      const windowEnd = Number.isFinite(end) ? Number(end) : contextRange.end;
      const results = [];
      for (const roomId of rooms) {
        const normalizedRoom = normalizeRoomId(roomId) || roomId;
        const tables = loadRoomTables(normalizedRoom);
        const tableName = resolveTable(normalizedRoom, table || 'telemetry');
        const rowsRaw = (tables[tableName] || []).filter((row) => withinRange(row.ts, windowStart, windowEnd));
        if (!rowsRaw.length) {
          results.push({
            room: normalizedRoom,
            label: friendlySeriesLocation(normalizedRoom, normalizedRoom),
            boxplots: {},
            occupancy: {}
          });
          continue;
        }
        const valueField = resolveField(rowsRaw, field);
        const occField = occupancy_field ? resolveField(rowsRaw, occupancy_field) : null;
        const buckets = new Map();
        const occBuckets = new Map();
        for (const row of rowsRaw) {
          const bucket = resolveDaypart(row.ts, timeZone, DAYPART_WINDOWS);
          if (!bucket) continue;
          const val = Number(row[valueField]);
          if (Number.isFinite(val)) {
            if (!buckets.has(bucket)) buckets.set(bucket, []);
            buckets.get(bucket).push(val);
          }
          if (occField) {
            const occVal = Number(row[occField]);
            if (Number.isFinite(occVal)) {
              if (!occBuckets.has(bucket)) occBuckets.set(bucket, []);
              occBuckets.get(bucket).push(occVal);
            }
          }
        }
        const boxplots = {};
        DAYPART_WINDOWS.forEach((windowDef) => {
          const id = windowDef.id;
          boxplots[id] = computeBoxplot(buckets.get(id) || []);
        });
        const occupancySummary = {};
        DAYPART_WINDOWS.forEach((windowDef) => {
          const id = windowDef.id;
          const vals = occBuckets.get(id) || [];
          occupancySummary[id] = {
            median: vals.length ? medianValue(vals) : null,
            avg: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null,
            count: vals.length
          };
        });
        const boxplotSeries = DAYPART_WINDOWS.map((windowDef, idx) => {
          const stats = boxplots[windowDef.id] || {};
          return [
            idx,
            Number.isFinite(stats.min) ? stats.min : null,
            Number.isFinite(stats.q1) ? stats.q1 : null,
            Number.isFinite(stats.median) ? stats.median : null,
            Number.isFinite(stats.q3) ? stats.q3 : null,
            Number.isFinite(stats.max) ? stats.max : null
          ];
        });
        const occupancyPoints = DAYPART_WINDOWS.map((windowDef, idx) => ({
          idx,
          daypart: windowDef.id,
          median: Number.isFinite(occupancySummary[windowDef.id]?.median) ? occupancySummary[windowDef.id].median : null
        }));
        results.push({
          room: normalizedRoom,
          label: friendlySeriesLocation(normalizedRoom, normalizedRoom),
          boxplots,
          occupancy: occupancySummary,
          series: {
            boxplot: boxplotSeries,
            occupancy: occupancyPoints
          }
        });
      }
      return {
        rooms: results,
        dayparts: DAYPART_WINDOWS.map((w) => w.id),
        field,
        occupancy_field,
        timeZone,
        start: windowStart ?? null,
        end: windowEnd ?? null
      };
    },

    energy_iaq_linkage({
      links = [],
      start = null,
      end = null,
      bucket = 'daily',
      iaq_fields = ['co2', 'virusRisk'],
      timeZone = DEFAULT_TIME_ZONE,
      detrend = false
    }) {
      if (!Array.isArray(links) || !links.length) {
        throw new Error('energy_iaq_linkage requires at least one link definition.');
      }
      const bucketMinutes = bucket === 'hourly' ? 60 : 24 * 60;
      const bucketMs = bucketMinutes * 60 * 1000;
      const bucketFn = bucket === 'hourly'
        ? (ts) => alignTimestampToBucket(ts, bucketMinutes, timeZone)
        : (ts) => startOfDayLocal(ts, timeZone);
      const contextRange = currentScopeContext.range || {};
      const windowStart = Number.isFinite(start) ? Number(start) : contextRange.start;
      const windowEnd = Number.isFinite(end) ? Number(end) : contextRange.end;

      const aggregateEnergy = (room) => {
        const normalizedRoom = normalizeRoomId(room) || room;
        const tables = loadRoomTables(normalizedRoom);
        const tableName = resolveTable(normalizedRoom, 'energy');
        const rowsRaw = (tables[tableName] || []).filter((row) => withinRange(row.ts, windowStart, windowEnd));
        if (!rowsRaw.length) return [];
        const sorted = [...rowsRaw].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
        let prevTotal = null;
        const deltas = [];
        for (const row of sorted) {
          const ts = row.ts;
          if (!Number.isFinite(ts)) continue;
          let delta = null;
          if (Number.isFinite(row.value)) {
            delta = row.value;
          } else if (Number.isFinite(row.total_kwh)) {
            const current = Number(row.total_kwh);
            if (prevTotal != null) {
              const diff = current - prevTotal;
              if (diff >= 0) delta = diff;
            }
            prevTotal = current;
          }
          if (Number.isFinite(delta)) deltas.push({ ts, value: delta });
        }
        return deltas;
      };

      const aggregateIaq = (room) => {
        const normalizedRoom = normalizeRoomId(room) || room;
        const tables = loadRoomTables(normalizedRoom);
        const tableName = resolveTable(normalizedRoom, 'telemetry');
        const rowsRaw = (tables[tableName] || []).filter((row) => withinRange(row.ts, windowStart, windowEnd));
        if (!rowsRaw.length) return [];
        return rowsRaw;
      };

      const linkResults = [];
      for (const link of links) {
        const energyRooms = Array.isArray(link.energyRooms) ? link.energyRooms : [];
        const iaqRoom = link.iaqRoom;
        if (!energyRooms.length || !iaqRoom) continue;
        const bucketTotals = new Map();
        for (const room of energyRooms) {
          const deltas = aggregateEnergy(room);
          for (const { ts, value } of deltas) {
            const key = bucketFn(ts);
            if (!bucketTotals.has(key)) bucketTotals.set(key, 0);
            bucketTotals.set(key, bucketTotals.get(key) + value);
          }
        }
        const iaqRows = aggregateIaq(iaqRoom);
        const iaqByBucket = new Map();
        for (const row of iaqRows) {
          const key = bucketFn(row.ts);
          if (!iaqByBucket.has(key)) iaqByBucket.set(key, {});
          const bucketMetrics = iaqByBucket.get(key);
          for (const metric of iaq_fields || []) {
            const resolved = resolveField([row], metric);
            const val = Number(row[resolved]);
            if (!Number.isFinite(val)) continue;
            if (!bucketMetrics[metric]) bucketMetrics[metric] = { sum: 0, n: 0 };
            bucketMetrics[metric].sum += val;
            bucketMetrics[metric].n += 1;
          }
        }
        const mergedBuckets = Array.from(new Set([...bucketTotals.keys(), ...iaqByBucket.keys()])).sort((a, b) => a - b);
        const rowsAligned = mergedBuckets.map((ts) => {
          const iaqEntry = {};
          for (const metric of iaq_fields || []) {
            const aggregate = iaqByBucket.get(ts)?.[metric];
            iaqEntry[metric] = aggregate && aggregate.n ? aggregate.sum / aggregate.n : null;
          }
          return {
            ts,
            energy_kwh: bucketTotals.get(ts) || 0,
            iaq: iaqEntry
          };
        });
        const energySeries = rowsAligned.map((row) => [row.ts, row.energy_kwh]);
        const iaqSeries = {};
        for (const metric of iaq_fields || []) {
          iaqSeries[metric] = rowsAligned.map((row) => [row.ts, row.iaq?.[metric] ?? null]);
        }
        let detrendedRows = rowsAligned;
        if (detrend) {
          const baselineEnergy = new Map();
          const baselineIaq = new Map();
          const getKey = (ts) => {
            const parts = getTimeZoneParts(ts, timeZone);
            if (bucket === 'hourly') return `${parts.day}:${parts.hour}`;
            return `${parts.year}-${parts.month}-${parts.day}`;
          };
          for (const row of rowsAligned) {
            const key = getKey(row.ts);
            const baseline = baselineEnergy.get(key) || { sum: 0, count: 0 };
            baseline.sum += row.energy_kwh;
            baseline.count += 1;
            baselineEnergy.set(key, baseline);
            for (const metric of iaq_fields || []) {
              const mapKey = `${metric}:${key}`;
              const base = baselineIaq.get(mapKey) || { sum: 0, count: 0 };
              const val = row.iaq?.[metric];
              if (Number.isFinite(val)) {
                base.sum += val;
                base.count += 1;
                baselineIaq.set(mapKey, base);
              }
            }
          }
          detrendedRows = rowsAligned.map((row) => {
            const key = getKey(row.ts);
            const energyBaseline = baselineEnergy.get(key);
            const energyMean = energyBaseline && energyBaseline.count ? energyBaseline.sum / energyBaseline.count : 0;
            const iaqEntry = {};
            for (const metric of iaq_fields || []) {
              const mapKey = `${metric}:${key}`;
              const base = baselineIaq.get(mapKey);
              const mean = base && base.count ? base.sum / base.count : 0;
              const val = row.iaq?.[metric];
              iaqEntry[metric] = Number.isFinite(val) ? val - mean : null;
            }
            return {
              ts: row.ts,
              energy_kwh: row.energy_kwh - energyMean,
              iaq: iaqEntry
            };
          });
        }
        const correlations = {};
        const scatterMatrix = [];
        for (const row of rowsAligned) {
          const entry = { ts: row.ts, energy_kwh: row.energy_kwh };
          for (const metric of iaq_fields || []) {
            entry[metric] = row.iaq?.[metric] ?? null;
          }
          scatterMatrix.push(entry);
        }
        for (const metric of iaq_fields || []) {
          const seriesRows = (detrend ? detrendedRows : rowsAligned).filter(
            (row) => Number.isFinite(row.energy_kwh) && Number.isFinite(row.iaq?.[metric])
          );
          const energyVals = seriesRows.map((row) => row.energy_kwh);
          const iaqVals = seriesRows.map((row) => row.iaq?.[metric]);
          const { corr, n } = pearson(energyVals, iaqVals);
          correlations[metric] = { corr, n };
        }
        linkResults.push({
          name: link.name || friendlySeriesLocation(iaqRoom, iaqRoom),
          energyRooms,
          iaqRoom,
          rows: rowsAligned,
          rows_detrended: detrendedRows,
          series: {
            energy: energySeries,
            iaq: iaqSeries
          },
          correlations,
          scatterMatrix
        });
      }
      return {
        bucket,
        bucket_minutes,
        timeZone,
        start: windowStart ?? null,
        end: windowEnd ?? null,
        iaq_fields,
        detrended: detrend,
        links: linkResults
      };
    },

    device_health_summary({
      rooms = null,
      lookback_days = 7,
      timeZone = DEFAULT_TIME_ZONE
    }) {
      const targetRooms = Array.isArray(rooms) && rooms.length
        ? rooms
        : (Array.isArray(currentScopeContext.selectionRooms) && currentScopeContext.selectionRooms.length
            ? currentScopeContext.selectionRooms
            : listRooms());
      if (!targetRooms.length) throw new Error('device_health_summary requires at least one room.');
      const lookbackMs = Math.max(1, lookback_days || 7) * DAY_MS;
      const cutoff = Date.now() - lookbackMs;
      const summaries = [];
      for (const roomId of targetRooms) {
        const normalizedRoom = normalizeRoomId(roomId) || roomId;
        const tables = loadRoomTables(normalizedRoom);
        const tableName = resolveTable(normalizedRoom, 'telemetry');
        const rows = (tables[tableName] || []).filter((row) => Number.isFinite(row.ts));
        if (!rows.length) continue;
        const sorted = [...rows].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
        const latest = sorted[sorted.length - 1];
        const batteryField = resolveField(sorted, 'battery');
        const rssiField = resolveField(sorted, 'rssi');
        const voltageField = resolveField(sorted, 'supplyVoltage') || resolveField(sorted, 'supply_voltage');
        const batteryLatest = Number(latest[batteryField]);
        const rssiLatest = Number(latest[rssiField]);
        const voltageLatest = Number(latest[voltageField]);
        const sparklineBattery = [];
        const sparklineRssi = [];
        const step = Math.max(1, Math.floor(sorted.length / 120));
        const missingFields = ['co2', 'pm25', 'pm10', 'temperature', 'humidity', 'voc', 'h2s', 'nh3'];
        const missingResolvers = {};
        missingFields.forEach((field) => {
          const resolved = resolveField(sorted, field);
          if (resolved) missingResolvers[field] = resolved;
        });
        const missingByField = new Map();
        const addMissing = (field, dayKey, isMissing) => {
          const map = missingByField.get(field) || new Map();
          const stats = map.get(dayKey) || { total: 0, missing: 0 };
          stats.total += 1;
          if (isMissing) stats.missing += 1;
          map.set(dayKey, stats);
          missingByField.set(field, map);
        };
        for (const row of sorted) {
          const dayKey = startOfDayLocal(row.ts, timeZone);
          for (const [field, resolved] of Object.entries(missingResolvers)) {
            addMissing(field, dayKey, row[resolved] == null || row[resolved] === '');
          }
        }
        for (let i = Math.max(0, sorted.length - 1); i >= 0; i -= step) {
          const row = sorted[i];
          if (row.ts < cutoff) break;
          const bVal = Number(row[batteryField]);
          const rVal = Number(row[rssiField]);
          if (Number.isFinite(bVal)) sparklineBattery.push({ ts: row.ts, value: bVal });
          if (Number.isFinite(rVal)) sparklineRssi.push({ ts: row.ts, value: rVal });
        }
        sparklineBattery.reverse();
        sparklineRssi.reverse();
        const label = friendlySeriesLocation(normalizedRoom, normalizedRoom);
        const missingness = {};
        const missingAlerts = [];
        for (const [field, dayMap] of missingByField.entries()) {
          const series = Array.from(dayMap.entries())
            .map(([ts, stats]) => ({
              ts,
              missing_pct: stats.total ? stats.missing / stats.total : 0
            }))
            .sort((a, b) => a.ts - b.ts);
          missingness[field] = series;
          if (series.some((entry) => entry.missing_pct > 0.1)) {
            missingAlerts.push(`${field} missingness >10%`);
          }
        }
        const deviceAlerts = [];
        if (Number.isFinite(batteryLatest) && batteryLatest < 20) deviceAlerts.push('battery_low');
        if (Number.isFinite(rssiLatest) && rssiLatest < -80) deviceAlerts.push('rssi_weak');
        if (Number.isFinite(voltageLatest) && voltageLatest < 3.0) deviceAlerts.push('voltage_low');
        deviceAlerts.push(...missingAlerts);
        summaries.push({
          room: normalizedRoom,
          label,
          latestTs: latest.ts,
          battery: {
            value: Number.isFinite(batteryLatest) ? batteryLatest : null,
            sparkline: sparklineBattery,
            needsService: Number.isFinite(batteryLatest) ? batteryLatest < 20 : false
          },
          rssi: {
            value: Number.isFinite(rssiLatest) ? rssiLatest : null,
            sparkline: sparklineRssi,
            weakSignal: Number.isFinite(rssiLatest) ? rssiLatest < -80 : false
          },
          supplyVoltage: {
            value: Number.isFinite(voltageLatest) ? voltageLatest : null,
            low: Number.isFinite(voltageLatest) ? voltageLatest < 3.0 : false
          },
          missingness,
          alerts: deviceAlerts
        });
      }
      const alerts = summaries
        .filter((device) => device.alerts.length)
        .map((device) => ({ room: device.room, label: device.label, issues: device.alerts }));
      return {
        lookback_days,
        battery_threshold: 20,
        rssi_threshold: -80,
        devices: summaries,
        alerts
      };
    },

    weekday_weekend_pm_profile({
      rooms = [],
      field = 'pm25',
      bucket_minutes = 30,
      start = null,
      end = null,
      timeZone = DEFAULT_TIME_ZONE
    }) {
      if (!Array.isArray(rooms) || !rooms.length) {
        throw new Error('weekday_weekend_pm_profile requires at least one room.');
      }
      const profiles = [];
      for (const roomId of rooms) {
        const normalizedRoom = normalizeRoomId(roomId) || roomId;
        const tables = loadRoomTables(normalizedRoom);
        const tableName = resolveTable(normalizedRoom, 'telemetry');
        const rows = (tables[tableName] || [])
          .filter((row) => withinRange(row.ts, start ?? currentScopeContext.range?.start, end ?? currentScopeContext.range?.end))
          .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
        if (!rows.length) continue;
        const weekdayBuckets = new Map();
        const weekendBuckets = new Map();
        for (const row of rows) {
          if (!Number.isFinite(row.ts)) continue;
          const val = coerceNumber(row[field]);
          if (!Number.isFinite(val)) continue;
          const parts = getTimeZoneParts(row.ts, timeZone);
          const minutes = parts.hour * 60 + parts.minute;
          const key = Math.floor(minutes / bucket_minutes) * bucket_minutes;
          const target = (parts.day === 0 || parts.day === 6) ? weekendBuckets : weekdayBuckets;
          if (!target.has(key)) target.set(key, []);
          target.get(key).push(val);
        }
        const toSeries = (map) => Array.from(map.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([minutes, values]) => ({
            minutes,
            median: medianValue(values)
          }));
        const weekdaySeries = toSeries(weekdayBuckets);
        const weekendSeries = toSeries(weekendBuckets);
        const weekdayMap = new Map(weekdaySeries.map((entry) => [entry.minutes, entry.median]));
        const uplift = weekendSeries
          .map(({ minutes, median }) => {
            const base = weekdayMap.get(minutes);
            if (!Number.isFinite(base) || !Number.isFinite(median) || base === 0) {
              return { minutes, uplift: null };
            }
            return { minutes, uplift: (median - base) / Math.abs(base) };
          })
          .filter((entry) => entry.uplift != null);
        profiles.push({
          room: normalizedRoom,
          label: friendlySeriesLocation(normalizedRoom, normalizedRoom),
          weekday: weekdaySeries,
          weekend: weekendSeries,
          uplift
        });
      }
      return {
        bucket_minutes,
        profiles
      };
    },

    compare_metrics_in_room({ room, table, fields = [], agg = 'avg', start = null, end = null }) {
      const t = loadRoomTables(room);
      const tab = resolveTable(room, table);
      const arr = (t[tab] || []).filter(row => withinRange(row.ts, start, end));
      const out = [];
      for (const f of fields) {
        const vals = arr.map(r => Number(r[f])).filter(Number.isFinite);
        if (!vals.length) { out.push({ field: f, value: null }); continue; }
        const sum = vals.reduce((a,b)=>a+b,0);
        const avg = sum / vals.length;
        const peak = Math.max(...vals);
        const map = { sum, avg, peak };
        out.push({ field: f, value: map[agg] != null ? map[agg] : avg });
      }
      out.sort((a,b)=> (b.value ?? -Infinity) - (a.value ?? -Infinity));
      return out;
    },

    table_sample({ room, table = 'iaq', fields = null, limit = 15, order = 'desc', start = null, end = null }) {
      if (!room) return [];
      const candidates = gatherCandidateDevices(room);
      const preferredFields = Array.isArray(fields) ? fields : [];
      const targetRoom = candidates.length ? resolveDeviceForFields(room, preferredFields, candidates) : (normalizeRoomId(room) || String(room));
      const t = loadRoomTables(targetRoom);
      const tab = resolveTable(targetRoom, table);
      const arr = (t[tab] || []).filter(row => withinRange(row.ts, start, end));
      if (!arr.length) return [];
      const sorted = [...arr].sort((a, b) => {
        const tsA = a.ts ?? 0;
        const tsB = b.ts ?? 0;
        return order === 'asc' ? tsA - tsB : tsB - tsA;
      });
      const cap = Math.max(1, Math.min(100, limit || 15));
      const slice = sorted.slice(0, cap);
      const resolvedFields = [];
      if (Array.isArray(fields) && fields.length) {
        for (const field of fields) {
          if (!field) continue;
          const resolved = resolveField(slice, field);
          if (resolved && resolved !== 'ts' && !resolvedFields.includes(resolved)) {
            resolvedFields.push(resolved);
          }
        }
      }
      if (!resolvedFields.length) {
        const sampleRow = slice.find((row) => row && typeof row === 'object') || {};
        for (const key of Object.keys(sampleRow)) {
          if (key === 'ts') continue;
          resolvedFields.push(key);
          if (resolvedFields.length >= 6) break;
        }
      }
      const columns = ['ts', ...resolvedFields.filter((f) => f && f !== 'ts')];
      return slice.map((row) => {
        const entry = { ts: row.ts ?? null };
        for (const col of columns.slice(1)) entry[col] = row[col] ?? null;
        return entry;
      });
    },

    common_metrics_in_scope({ rooms = null }) {
      const rs = Array.isArray(rooms) && rooms.length ? rooms : listRooms();
      let common = null;
      for (const r of rs) {
        const t = loadRoomTables(r);
        const set = new Set();
        for (const [name, rows] of Object.entries(t)) {
          const first = rows?.[0] || {};
          for (const k of Object.keys(first)) if (k !== 'ts') set.add(k);
        }
        if (common == null) common = set; else common = new Set([...common].filter(x => set.has(x)));
      }
      return Array.from(common || []);
    },

    correlation_matrix({ room, table, fields = [], start = null, end = null, time_window_ms = 30 * 60 * 1000 }) {
      const t = loadRoomTables(room);
      const tab = resolveTable(room, table);
      const arr = (t[tab] || []).filter(r => withinRange(r.ts, start, end));
      // Build per-field time aligned vectors by ts
      const byTs = new Map();
      for (const r of arr) {
        const o = byTs.get(r.ts) || {}; byTs.set(r.ts, o);
        for (const f of fields) { if (r[f] != null) o[f] = Number(r[f]); }
      }
      const xs = Array.from(byTs.values());
      const n = fields.length;
      const matrix = Array.from({ length: n }, () => Array(n).fill(null));
      function corr(a, b) {
        let sx=0, sy=0, sxx=0, syy=0, sxy=0, k=0;
        for (const row of xs) {
          const x = row[a]; const y = row[b];
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
          sx += x; sy += y; sxx += x*x; syy += y*y; sxy += x*y; k++;
        }
        if (k < 3) return null;
        const cov = (sxy - (sx*sy)/k) / k;
        const vx = (sxx - (sx*sx)/k) / k; const vy = (syy - (sy*sy)/k) / k;
        const denom = Math.sqrt(vx*vy);
        return denom>0 ? cov/denom : null;
      }
      for (let i=0;i<n;i++) for (let j=i;j<n;j++) {
        const c = i===j ? 1 : corr(fields[i], fields[j]);
        matrix[i][j] = c; matrix[j][i] = c;
      }
      return { fields, matrix };
    },

    compare_field_across_rooms({ table, field, agg = 'avg', start = null, end = null }) {
      const perRoom = {};
      for (const r of listRooms()) {
        const t = loadRoomTables(r);
        const tab = resolveTable(r, table);
        const arr = (t[tab] || []).filter(row => withinRange(row.ts, start, end));
        const vals = arr.map(row => Number(row[field])).filter(Number.isFinite);
        if (!vals.length) { perRoom[r] = null; continue; }
        const sum = vals.reduce((a,b)=>a+b,0);
        const avg = sum / vals.length;
        const peak = Math.max(...vals);
        const map = { sum, avg, peak };
        perRoom[r] = map[agg] != null ? map[agg] : avg;
      }
      return perRoom;
    },
    
    weather_fetch({ room = null, building = null, fields = [], start = null, end = null, limit = 2000 }) {
      const arr = loadWeatherFor(room, building);
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

    // Graph adapters (Neo4j) — return synchronous placeholders if adapter is async in this context
    graph_rooms_by_tenant({ tenant }) {
      try {
        if (!graph || !graph.roomsByTenant) return { rooms: [], error: 'graph_not_configured' };
        const res = graph.roomsByTenant(tenant);
        return res && typeof res.then === 'function' ? { rooms: [], pending: true } : res;
      } catch (e) { return { rooms: [], error: String(e) }; }
    },

    graph_devices_by_scope({ tenant = null, building = null, floor = null, zone = null, type = null }) {
      try {
        if (!graph || !graph.devicesByScope) return { devices: [], error: 'graph_not_configured' };
        const args = { tenant, building, floor, zone, type };
        const res = graph.devicesByScope(args);
        return res && typeof res.then === 'function' ? { devices: [], pending: true } : res;
      } catch (e) { return { devices: [], error: String(e) }; }
    },

    graph_rooms_by_scope({ building = null, floor = null }) {
      const dedupe = new Set();
      if (snapshotIndex?.zoneById?.size) {
        const rooms = [];
        snapshotIndex.zoneById.forEach((zone) => {
          if (!zone) return;
          if (building && !buildingMatchesSelection(building, { name: zone.buildingName, id: zone.buildingId })) {
            return;
          }
          if (floor && !floorMatchesSelection(floor, { name: zone.floorName, id: zone.floorId })) {
            return;
          }
          const roomId = zone.roomId || zone.id || zone.name;
          if (!roomId) return;
          if (dedupe.has(roomId)) return;
          dedupe.add(roomId);
          rooms.push(String(roomId));
        });
        return { rooms };
      }
      // Fallback: load snapshot file or infer from room naming
      try {
        const snap = loadGraphSnapshot();
        if (snap && Array.isArray(snap.nodes)) {
          const rooms = [];
          for (const zone of snap.nodes) {
            if ((zone.nodeType || zone.label) !== 'Zone') continue;
            const buildingCandidate = { name: zone.buildingName || null, id: zone.buildingId || null };
            if (building && !buildingMatchesSelection(building, buildingCandidate)) continue;
            const floorCandidate = { name: zone.floorName || null, id: zone.floorId || null };
            if (floor && !floorMatchesSelection(floor, floorCandidate)) continue;
            if (zone.roomId && !dedupe.has(zone.roomId)) {
              dedupe.add(zone.roomId);
              rooms.push(zone.roomId);
            }
          }
          if (rooms.length) return { rooms };
        }
      } catch {}
      const rooms = listRooms();
      const out = rooms.filter((r) => {
        const lower = String(r || '').toLowerCase();
        const buildingOk = building ? lower.includes(normalizeName(building)) : true;
        const floorOk = floor ? lower.includes(normalizeName(floor)) : true;
        return buildingOk && floorOk;
      });
      return { rooms: out };
    },

    scope_list_buildings() {
      if (snapshotIndex?.buildingById?.size) {
        const names = new Set();
        snapshotIndex.buildingById.forEach((building) => {
          if (building?.name) names.add(building.name);
        });
        return Array.from(names).sort();
      }
      const snap = loadGraphSnapshot();
      if (snap && Array.isArray(snap.nodes)) {
        const bs = snap.nodes.filter(n => (n.nodeType||n.label)==='Building').map(n => n.name).filter(Boolean);
        if (bs.length) return Array.from(new Set(bs)).sort();
      }
      const rooms = listRooms();
      const set = new Set();
      for (const r of rooms) { const m = String(r).match(/^([A-Za-z])_/); if (m) set.add(`Building ${m[1].toUpperCase()}`); }
      return Array.from(set).sort();
    },

    scope_list_floors({ building }) {
      if (snapshotIndex?.floorById?.size) {
        const names = new Set();
        snapshotIndex.floorById.forEach((floor) => {
          if (!floor) return;
          if (building && !buildingMatchesSelection(building, { name: floor.buildingName, id: floor.buildingId })) {
            return;
          }
          if (floor.name) names.add(floor.name);
        });
        return Array.from(names).sort((a,b)=> Number(a.replace(/\D+/g,'')) - Number(b.replace(/\D+/g,'')));
      }
      const snap = loadGraphSnapshot();
      if (snap && Array.isArray(snap.nodes) && Array.isArray(snap.links)) {
        const floorNames = new Set();
        for (const n of snap.nodes) {
          if ((n.nodeType||n.label) !== 'Floor') continue;
          const fid = n.id;
          const bLink = snap.links.find(l => l.source===fid && l.rel==='LOCATED_IN_BUILDING');
          const bid = bLink ? bLink.target : null;
          const bNode = bid ? snap.nodes.find(nn => nn.id===bid) : null;
          if (building && (!bNode || !buildingMatchesSelection(building, bNode))) continue;
          floorNames.add(n.name);
        }
        if (floorNames.size) {
          return Array.from(floorNames).sort((a,b)=> Number(a.replace(/\D+/g,'')) - Number(b.replace(/\D+/g,'')));
        }
      }
      // Fallback to inference
      const rooms = listRooms();
      const set = new Set();
      const b = (String(building||'').match(/([A-Za-z])$/) || [,''])[1].toUpperCase();
      for (const r of rooms) { const m = String(r).match(/^([A-Za-z])_(F\d+)_/); if (m && (!b || m[1].toUpperCase()===b)) set.add(`Floor ${m[2].slice(1)}`); }
      return Array.from(set).sort((a,b)=> Number(a.split(' ').at(-1)) - Number(b.split(' ').at(-1)));
    },

    scope_list_rooms({ building = null, floor = null }) {
      return (this.graph_rooms_by_scope({ building, floor })?.rooms) || [];
    },

    scope_list_detectors({ room }) {
      const t = loadRoomTables(room);
      const detectors = [];
      if (t.iaq && t.iaq.length) detectors.push('IAQ_Sensor');
      if (t.energy && t.energy.length) detectors.push('Energy_Meter');
      if (t.people && t.people.length) detectors.push('People_Counter');
      if (t.water && t.water.length) detectors.push('Water_Meter');
      return detectors;
    },

    graph_zone_devices({ room }) {
      const scopeLabels = currentScopeContext.scopeLabels || {};
      const dedupe = new Set();
      const devicesOut = [];
      const pushDevice = (entry) => {
        const deviceId = entry.cloudId || entry.primaryId || entry.id;
        if (!deviceId || dedupe.has(deviceId)) return;
        dedupe.add(deviceId);
        const meta = lookupDeviceHierarchy(deviceId) || {};
        devicesOut.push({
          id: deviceId,
          name: meta.name || entry.name || deviceId,
          type: meta.type || entry.type || entry.deviceType || null,
          zone: meta.zoneName || entry.zone || entry.zoneName || null,
          floor: meta.floorName || entry.floor || entry.floorName || null,
          building: meta.buildingName || entry.building || entry.buildingName || null,
          metrics: metricsPreviewForDevice(deviceId),
          hasTelemetry: deviceTablesAvailable(deviceId)
        });
      };

      const resolveZoneLabel = (value) => {
        if (!value) return null;
        return String(value).replace(ZONE_STOPWORD_REGEX, ' ').trim() || value;
      };

      let targetZone = resolveZoneEntry(resolveZoneLabel(room), scopeLabels);
      if (!targetZone && typeof room === 'string') {
        const meta = lookupDeviceHierarchy(room);
        if (meta?.zoneName) {
          targetZone = resolveZoneEntry(meta.zoneName, scopeLabels);
        }
      }
      if (!targetZone && snapshotIndex && typeof room === 'string') {
        const deviceMeta = snapshotIndex.deviceMeta?.get(room) || snapshotIndex.deviceMetaCanonical?.get(room.toLowerCase());
        if (deviceMeta?.zoneName) {
          targetZone = resolveZoneEntry(deviceMeta.zoneName, scopeLabels);
        }
      }

      const zoneLabel = targetZone?.name || targetZone?.zone || resolveZoneLabel(room);
      if (zoneLabel) {
        const zoneDevices = collectDevicesForZone(zoneLabel, scopeLabels);
        zoneDevices.forEach(pushDevice);
      }
      if (!devicesOut.length && typeof room === 'string') {
        // direct device lookup fallback
        const meta = lookupDeviceHierarchy(room);
        if (meta?.cloudId) {
          pushDevice({ cloudId: meta.cloudId, name: meta.name, type: meta.type, zoneName: meta.zoneName, floorName: meta.floorName, buildingName: meta.buildingName });
        }
      }
      return { devices: devicesOut };
    },

    // Vector search — fallback stub (the system already has TF‑IDF rag)
    vector_search_docs({ query, k = 6 }) {
      try {
        if (!vector || !vector.searchDocs) return { hits: [], error: 'vector_not_configured' };
        const res = vector.searchDocs({ query, k });
        return res && typeof res.then === 'function' ? { hits: [], pending: true } : (res || { hits: [] });
      } catch (e) { return { hits: [], error: String(e) }; }
    },

    compare_series_cross_room({ series = [], start = null, end = null }) {
      const out = {};
      if (!Array.isArray(series)) return out;
      for (const s of series) {
        if (!s || !s.room || !s.table || !s.field) continue;
        const t = loadRoomTables(String(s.room));
        const arr = (t[String(s.table)] || []).filter(r => withinRange(r.ts, start, end));
        const name = s.name || `${s.room} ${s.field}`;
        const points = [];
        for (const r of arr) {
          const y = Number(r[s.field]);
          if (!Number.isFinite(y)) continue;
          points.push({ ts: r.ts, y });
        }
        out[name] = points;
      }
      return out;
    },

    latest_value({ room, table, field, start = null, end = null }) {
      const t = loadRoomTables(room);
      const tab = resolveTable(room, table);
      const arr = (t[tab] || []).filter(r => withinRange(r.ts, start, end));
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
        const tab = resolveTable(r, table);
        const arr = (t[tab] || []).filter(x => withinRange(x.ts, start, end));
        let val = null, ts = null;
        for (let i = arr.length - 1; i >= 0; i--) {
          const v = arr[i][field];
          if (v != null && Number.isFinite(Number(v))) { val = Number(v); ts = arr[i].ts; break; }
        }
        out.push({ room: r, ts, value: val });
      }
      return out;
    },

    compare_series_cross_room({ series = [], start = null, end = null }) {
      const out = {};
      if (!Array.isArray(series)) return out;
      for (const s of series) {
        if (!s || !s.room || !s.table || !s.field) continue;
        const t = loadRoomTables(String(s.room));
        const arr = (t[String(s.table)] || []).filter(r => withinRange(r.ts, start, end));
        const name = s.name || `${s.room} ${s.field}`;
        const points = [];
        for (const r of arr) {
          const y = Number(r[s.field]);
          if (!Number.isFinite(y)) continue;
          points.push({ ts: r.ts, y });
        }
        out[name] = points;
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

    compare_series_cross_room({ series = [], start = null, end = null }) {
      const out = {};
      if (!Array.isArray(series)) return out;
      for (const s of series) {
        if (!s || !s.room || !s.table || !s.field) continue;
        const t = loadRoomTables(String(s.room));
        const arr = (t[String(s.table)] || []).filter(r => withinRange(r.ts, start, end));
        const name = s.name || `${s.room} ${s.field}`;
        const points = [];
        for (const r of arr) {
          const y = Number(r[s.field]);
          if (!Number.isFinite(y)) continue;
          points.push({ ts: r.ts, y });
        }
        out[name] = points;
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

    compare_series_cross_room({ series = [], start = null, end = null }) {
      const out = {};
      if (!Array.isArray(series)) return out;
      for (const s of series) {
        if (!s || !s.room || !s.table || !s.field) continue;
        const t = loadRoomTables(String(s.room));
        const arr = (t[String(s.table)] || []).filter(r => withinRange(r.ts, start, end));
        const name = s.name || `${s.room} ${s.field}`;
        const points = [];
        for (const r of arr) {
          const y = Number(r[s.field]);
          if (!Number.isFinite(y)) continue;
          points.push({ ts: r.ts, y });
        }
        out[name] = points;
      }
      return out;
    },
    busiest_day_of_week({ room, table, field, start = null, end = null, agg = 'avg' }) {
      const t = loadRoomTables(room);
      const tab = resolveTable(room, table);
      const arr = (t[tab] || []).filter(r => withinRange(r.ts, start, end));
      const buckets = Array.from({ length: 7 }, () => ({ sum: 0, n: 0 }));
      for (const r of arr) { const v = Number(r[field]); if (!Number.isFinite(v)) continue; const d = new Date(r.ts).getDay(); buckets[d].sum += v; buckets[d].n += 1; }
      const stats = buckets.map((b,i)=>({ day:i, avg: b.n? b.sum/b.n : 0, sum: b.sum, n:b.n }));
      const key = agg==='sum'?'sum':'avg';
      const best = stats.reduce((a,b)=> b[key]>(a?.[key]??-Infinity)?b:a, null);
      return { best, stats };
    },
    weekday_weekend_comparison({ room, table, field, start = null, end = null }) {
      const t = loadRoomTables(room);
      const tab = resolveTable(room, table);
      const arr = (t[tab] || []).filter(r => withinRange(r.ts, start, end));
      let wSum=0,wN=0, weSum=0,weN=0;
      for (const r of arr) { const v=Number(r[field]); if(!Number.isFinite(v)) continue; const d=new Date(r.ts).getDay(); if(d===0||d===6){ weSum+=v; weN++; } else { wSum+=v; wN++; } }
      return { weekday_avg: wN? wSum/wN: null, weekend_avg: weN? weSum/weN: null, weekday_n:wN, weekend_n:weN };
    },
    energy_delta_kwh({ room, table = null, field = null, start = null, end = null }) {
      const t = loadRoomTables(room);
      const tables = [];
      if (table) {
        const resolved = resolveTable(room, table);
        if (resolved && t[resolved]) tables.push(resolved);
      }
      if (!tables.length) tables.push(...Object.keys(t));

      const candidates = [];
      if (field) candidates.push(field);
      candidates.push('total_kwh');
      const seen = new Set();
      const fieldCandidates = candidates.filter((c) => {
        const key = String(c || '').toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      let fallback = null;
      for (const tabName of tables) {
        const allRows = t[tabName] || [];
        if (!allRows.length) continue;
        const windowed = allRows.filter(r => withinRange(r.ts, start, end));
        if (!windowed.length) continue;
        for (const candidate of fieldCandidates) {
          const resolvedFieldName = resolveField(windowed, candidate);
          if (!resolvedFieldName || resolvedFieldName === 'ts') continue;
          const series = windowed
            .map(r => ({ ts: r.ts, value: Number(r[resolvedFieldName]) }))
            .filter(p => Number.isFinite(p.value))
            .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
          if (!series.length) continue;
          if (!fallback || series.length > fallback.points) {
            fallback = { series, points: series.length, table: tabName, field: resolvedFieldName };
          }
          if (series.length >= 2) {
            const first = series[0];
            const last = series[series.length - 1];
            return {
              delta_kwh: last.value - first.value,
              points: series.length,
              table: tabName,
              field: resolvedFieldName,
              start_value: first.value,
              end_value: last.value
            };
          }
        }
      }

      if (fallback) {
        const { series, table: tabName, field: resolvedFieldName } = fallback;
        const first = series[0];
        const last = series[series.length - 1];
        const delta = series.length >= 2 ? last.value - first.value : null;
        return {
          delta_kwh: delta,
          points: fallback.points,
          table: tabName,
          field: resolvedFieldName,
          start_value: first?.value ?? null,
          end_value: last?.value ?? null
        };
      }

      return { delta_kwh: null, points: 0 };
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

    compare_series_cross_room({ series = [], start = null, end = null }) {
      const out = {};
      if (!Array.isArray(series)) return out;
      for (const s of series) {
        if (!s || !s.room || !s.table || !s.field) continue;
        const t = loadRoomTables(String(s.room));
        const arr = (t[String(s.table)] || []).filter(r => withinRange(r.ts, start, end));
        const name = s.name || `${s.room} ${s.field}`;
        const points = [];
        for (const r of arr) {
          const y = Number(r[s.field]);
          if (!Number.isFinite(y)) continue;
          points.push({ ts: r.ts, y });
        }
        out[name] = points;
      }
      return out;
    },
    detect_spikes({ room, table, field, z = 3, start = null, end = null }) {
      const t = loadRoomTables(room);
      const tab = resolveTable(room, table);
      const arr = (t[tab] || []).filter(r => withinRange(r.ts, start, end)).map(r => Number(r[field])).filter(Number.isFinite);
      if (arr.length < 5) return [];
      const mean = arr.reduce((a,b)=>a+b,0)/arr.length;
      const sd = Math.sqrt(arr.reduce((a,b)=>a+(b-mean)*(b-mean),0)/arr.length) || 1;
      const rows = (t[tab] || []).filter(r => withinRange(r.ts, start, end));
      const out = [];
      for (const r of rows) { const v=Number(r[field]); if(!Number.isFinite(v)) continue; const zz=(v-mean)/sd; if (Math.abs(zz) >= z) out.push({ ts:r.ts, value:v, z:zz }); }
      return out;
    },

    compare_series_cross_room({ series = [], start = null, end = null }) {
      const out = {};
      if (!Array.isArray(series)) return out;
      for (const s of series) {
        if (!s || !s.room || !s.table || !s.field) continue;
        const t = loadRoomTables(String(s.room));
        const arr = (t[String(s.table)] || []).filter(r => withinRange(r.ts, start, end));
        const name = s.name || `${s.room} ${s.field}`;
        const points = [];
        for (const r of arr) {
          const y = Number(r[s.field]);
          if (!Number.isFinite(y)) continue;
          points.push({ ts: r.ts, y });
        }
        out[name] = points;
      }
      return out;
    },
    histogram({ room, table, field, bins = 10, start = null, end = null }) {
      const t = loadRoomTables(room);
      const tab = resolveTable(room, table);
      const vals = (t[tab] || [])
        .filter(r => withinRange(r.ts, start, end))
        .map(r => Number(r[field]))
        .filter(Number.isFinite);
      if (!vals.length) {
        return logToolResult('histogram', { room, table: tab, field, bins, start, end }, []);
      }
      const min = Math.min(...vals);
      const max = Math.max(...vals);
      if (min === max) {
        const single = [{ binStart: min, binEnd: min, count: vals.length }];
        return logToolResult('histogram', { room, table: tab, field, bins, start, end }, single);
      }
      const safeBins = Math.max(1, Number(bins) || 10);
      const width = max - min;
      const step = width / safeBins;
      const out = Array.from({ length: safeBins }, (_, i) => ({
        binStart: min + i * step,
        binEnd: i === safeBins - 1 ? max : min + (i + 1) * step,
        count: 0
      }));
      for (const v of vals) {
        let idx = Math.floor((v - min) / step);
        if (idx >= safeBins) idx = safeBins - 1;
        if (idx < 0) idx = 0;
        out[idx].count += 1;
      }
      return logToolResult('histogram', { room, table: tab, field, bins: safeBins, start, end }, out);
    },

    compare_series_cross_room({ series = [], start = null, end = null }) {
      const out = {};
      if (!Array.isArray(series)) return out;
      for (const s of series) {
        if (!s || !s.room || !s.table || !s.field) continue;
        const t = loadRoomTables(String(s.room));
        const arr = (t[String(s.table)] || []).filter(r => withinRange(r.ts, start, end));
        const name = s.name || `${s.room} ${s.field}`;
        const points = [];
        for (const r of arr) {
          const y = Number(r[s.field]);
          if (!Number.isFinite(y)) continue;
          points.push({ ts: r.ts, y });
        }
        out[name] = points;
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

    compare_series_cross_room({ series = [], start = null, end = null }) {
      const out = {};
      if (!Array.isArray(series)) return out;
      for (const s of series) {
        if (!s || !s.room || !s.table || !s.field) continue;
        const t = loadRoomTables(String(s.room));
        const arr = (t[String(s.table)] || []).filter(r => withinRange(r.ts, start, end));
        const name = s.name || `${s.room} ${s.field}`;
        const points = [];
        for (const r of arr) {
          const y = Number(r[s.field]);
          if (!Number.isFinite(y)) continue;
          points.push({ ts: r.ts, y });
        }
        out[name] = points;
      }
      return out;
    },
    distinct_values({ room, table, field, limit = 50 }) {
      const t = loadRoomTables(room);
      const tab = resolveTable(room, table);
      const set = new Set();
      for (const r of (t[tab]||[])) { const v=r[field]; if (v!=null) { set.add(String(v)); if (set.size>=limit) break; } }
      return Array.from(set);
    }
,

    fetch_table_meta({ room, table }) {
      const t = loadRoomTables(room);
      const tab = resolveTable(room, table);
      const arr = t[tab] || [];
      const n = arr.length;
      const fields = Object.keys(arr[0] || {});
      const tsMin = n ? arr[0].ts : null;
      const tsMax = n ? arr[n - 1].ts : null;
      return { count: n, fields, tsMin, tsMax, table: tab };
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

    compare_series_cross_room({ series = [], start = null, end = null }) {
      const out = {};
      if (!Array.isArray(series)) return out;
      for (const s of series) {
        if (!s || !s.room || !s.table || !s.field) continue;
        const t = loadRoomTables(String(s.room));
        const arr = (t[String(s.table)] || []).filter(r => withinRange(r.ts, start, end));
        const name = s.name || `${s.room} ${s.field}`;
        const points = [];
        for (const r of arr) {
          const y = Number(r[s.field]);
          if (!Number.isFinite(y)) continue;
          points.push({ ts: r.ts, y });
        }
        out[name] = points;
      }
      return out;
    },
    
    hour_of_day_stats({ room, table, field, start = null, end = null }) {
      const t = loadRoomTables(room);
      const tab = resolveTable(room, table);
      const arr = t[tab] || [];
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
      const predictions = ensureFutureForecast(naiveForecast(last.ts, last.avg, step, horizon_hours), last.ts);
      return { historical: hourly, forecast: predictions };
    },
    
    forecast_hourly_linear({ room, table, field, start = null, end = null, horizon_hours = 168 }) {
      const hourly = getHourlySeries(room, table, field, start, end);
      if (hourly.length < 2) return { historical: hourly, forecast: [] };
      const lastTs = hourly[hourly.length - 1]?.ts;
      const predictions = ensureFutureForecast(lrForecast(hourly, horizon_hours), lastTs);
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
      
      return { historical: hourly, forecast: ensureFutureForecast(predictions, lastTs), profile };
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
      return { historical: smoothed, forecast: ensureFutureForecast(predictions, lastTs) };
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
      return { historical: ma, forecast: ensureFutureForecast(predictions, lastTs) };
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
      return { historical: hourly, forecast: ensureFutureForecast(predictions, lastTs) };
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
      return { historical: hourly, forecast: ensureFutureForecast(predictions, lastTs), coeffs };
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

      if (!out.length) {
        // Fallback: align by exact timestamp when both series share the same cadence
        const mapB = new Map();
        for (const row of bf) {
          const ts = Number(row.ts);
          const val = Number(row[field2]);
          if (Number.isFinite(ts) && Number.isFinite(val)) mapB.set(ts, val);
        }
        for (const ra of af) {
          const ts = Number(ra.ts);
          const xa = Number(ra[field1]);
          if (!Number.isFinite(ts) || !Number.isFinite(xa)) continue;
          if (!mapB.has(ts)) continue;
          const yb = mapB.get(ts);
          out.push({ x: xa, y: yb, ts1: ts, ts2: ts, dt: 0 });
        }
      }

      return out;
    },

    compare_series_cross_room({ series = [], start = null, end = null }) {
      const out = {};
      if (!Array.isArray(series)) return out;
      for (const s of series) {
        if (!s || !s.room || !s.table || !s.field) continue;
        const t = loadRoomTables(String(s.room));
        const arr = (t[String(s.table)] || []).filter(r => withinRange(r.ts, start, end));
        const name = s.name || `${s.room} ${s.field}`;
        const points = [];
        for (const r of arr) {
          const y = Number(r[s.field]);
          if (!Number.isFinite(y)) continue;
          points.push({ ts: r.ts, y });
        }
        out[name] = points;
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

  async function buildContextSnippet(question, room, range, selectionRooms = [], options = {}) {
    const {
      selectionZones = [],
      selectionFloors = [],
      scopeDeviceZones = {},
      scopeLabels = {},
      retrievalHints = {}
    } = options || {};
    const ragState = ragManager.ensure();
    const scopeContext = {
      room,
      rooms: selectionRooms,
      zones: selectionZones,
      tenant: retrievalHints.scope?.tenant || null,
      building: retrievalHints.scope?.building || null,
      floor: retrievalHints.scope?.floor || null,
      metrics: retrievalHints.metrics || [],
      timeHints: retrievalHints.timeHints || {}
    };
    const retrieved = await hybridRetrieve({
      query: question,
      ragIndex: ragState.index,
      vectorClient: vector,
      k: retrievalHints.k || 6,
      preferCategories: retrievalHints.preferCategories || [],
      scope: scopeContext
    }).catch(() => []);
    const structuredHits = (retrieved || []).map((h, idx) => ({
      id: h.id,
      source: h.source,
      score: Number(h.final ?? h.rrf ?? h.scoreRaw ?? 0),
      category: h.meta?.category || h.meta?.type || null,
      meta: h.meta || null,
      snippet: h.text && h.text.length > 420 ? `${h.text.slice(0, 420)}…` : h.text,
      rank: idx + 1
    }));
    const head = structuredHits
      .slice(0, 3)
      .map((hit) => `#${hit.rank} [${hit.category || hit.source}] score=${hit.score.toFixed(3)} :: ${hit.snippet}`)
      .join('\n---\n');
    
    let schema = {};
    if (room && room !== 'ALL') {
      schema = Object.fromEntries(
        Object.entries(loadRoomTables(room)).map(([k, v]) => [k, Object.keys(v?.[0] || {})])
      );
    } else if (Array.isArray(selectionRooms) && selectionRooms.length) {
      const perRoom = {};
      for (const r of selectionRooms.slice(0, 20)) {
        perRoom[r] = Object.fromEntries(
          Object.entries(loadRoomTables(r)).map(([k, v]) => [k, Object.keys(v?.[0] || {})])
        );
      }
      schema = { _multiRoom: true, rooms: perRoom };
    }
    
    const meta = {};
    if (room && room !== 'ALL') {
      const tables = loadRoomTables(room);
      for (const [t, rows] of Object.entries(tables)) {
        const n = rows.length;
        const tsMin = n ? rows[0].ts : null;
        const tsMax = n ? rows[n-1].ts : null;
        meta[t] = { count: n, tsMin, tsMax };
      }
    } else if (Array.isArray(selectionRooms) && selectionRooms.length) {
      const agg = {};
      for (const r of selectionRooms.slice(0, 20)) {
        const tables = loadRoomTables(r);
        for (const [t, rows] of Object.entries(tables)) {
          const n = rows.length;
          const tsMin = n ? rows[0].ts : null;
          const tsMax = n ? rows[n-1].ts : null;
          const cur = agg[t] || { count: 0, tsMin: null, tsMax: null };
          cur.count += n;
          cur.tsMin = (cur.tsMin == null || (tsMin != null && tsMin < cur.tsMin)) ? tsMin : cur.tsMin;
          cur.tsMax = (cur.tsMax == null || (tsMax != null && tsMax > cur.tsMax)) ? tsMax : cur.tsMax;
          agg[t] = cur;
        }
      }
      Object.assign(meta, agg);
    }
    const scopeSnapshotSummary = buildScopeSnapshotContextSummary({
      selectionRooms,
      selectionZones,
      selectionFloors,
      scopeDeviceZones,
      scopeLabels
    });
    const ctx = {
      retrieved: head,
      retrievedDocs: structuredHits,
      schema,
      meta,
      range,
      room,
      selectionRooms,
      selectionZones,
      _retrievedDocs: retrieved
    };
    if (scopeSnapshotSummary) ctx.scopeSnapshot = scopeSnapshotSummary;
    ctx.scopeHeaderLine = formatScopeHeaderLine(scopeLabels, selectionFloors, selectionZones);
    return ctx;
  }
	
  function zoneLabelFromEntry(entry) {
    if (!entry) return null;
    const snapZone = entry.__snapshot || (snapshotIndex ? findSnapshotZone(entry.name || entry.zone || entry.id || null) : null);
    const zoneName = entry.name || entry.zone || snapZone?.name || entry.id || null;
    const floorName = entry.floorName
      || snapZone?.floorName
      || (entry.floorId && graphHierarchy?.floorById?.get(entry.floorId)?.name)
      || null;
    const buildingName = entry.buildingName
      || snapZone?.buildingName
      || (entry.buildingId && graphHierarchy?.buildingById?.get(entry.buildingId)?.name)
      || null;
    if (!zoneName) return null;
    const ctx = [];
    if (floorName) ctx.push(floorName);
    if (buildingName) ctx.push(buildingName);
    return ctx.length ? `${zoneName} (${ctx.join(', ')})` : zoneName;
  }
	
  function resolveZoneLabelDisplay(zoneKey, { building, floor } = {}) {
    if (!zoneKey) return null;
    const raw = String(zoneKey).trim();
    let entry = null;
    try { entry = resolveZoneEntry(raw, { building, floor }); } catch {}
    if (entry) return zoneLabelFromEntry(entry) || raw;
    if (snapshotIndex) {
      const snapZone = findSnapshotZone(raw, { building, floor });
      if (snapZone) {
        return zoneLabelFromEntry({ name: snapZone.name, floorName: snapZone.floorName, buildingName: snapZone.buildingName, __snapshot: snapZone }) || raw;
      }
    }
    if (graphHierarchy) {
      const candidate = graphHierarchy.zoneById.get(raw) || null;
      if (candidate) return zoneLabelFromEntry(candidate) || raw;
    }
    return raw;
  }
	
	  function getDeviceZoneCandidate(deviceId, scopeDeviceZones = {}) {
	    if (!deviceId) return null;
	    const keyVariants = [
	      String(deviceId).trim(),
	      normalizeDeviceKey(deviceId, false),
	      normalizeDeviceKey(deviceId, true)
	    ];
	    for (const key of keyVariants) {
	      if (key && scopeDeviceZones[key] != null) return scopeDeviceZones[key];
	    }
	    const info = lookupDeviceHierarchy(deviceId);
	    if (info) return info.zoneName || info.zoneId || null;
	    return null;
	  }
	
  function summarizeZones(selectionRooms = [], selectionZones = [], scopeDeviceZones = {}, context = {}) {
    const zoneDisplaySet = new Map();
    const addZone = (zoneKey, deviceId = null) => {
      const label = resolveZoneLabelDisplay(zoneKey, context);
	      if (!label) return;
	      if (!zoneDisplaySet.has(label)) zoneDisplaySet.set(label, new Set());
	      if (deviceId) zoneDisplaySet.get(label).add(deviceId);
	    };
	
	    for (const deviceId of selectionRooms || []) {
	      const zoneCandidate = getDeviceZoneCandidate(deviceId, scopeDeviceZones);
	      if (zoneCandidate) addZone(zoneCandidate, deviceId);
	    }
	
	    for (const zone of selectionZones || []) addZone(zone);
	
    return Array.from(zoneDisplaySet.entries()).map(([label, devices]) => {
      if (!devices || devices.size === 0) return label;
      const listed = Array.from(devices).slice(0, 3).map((id) => deviceFriendlyName(id));
      const suffix = devices.size > 3 ? `, …${devices.size - 3} more` : '';
      return `${label} — devices: ${listed.join(', ')}${suffix}`;
    });
  }

  function selectionRoomsMatchingQuestion(question, selectionRooms = [], scopeDeviceZones = {}) {
    const normalizedQuestion = normalizeName(question);
    if (!normalizedQuestion) return [];
    const matches = [];
    for (const deviceId of selectionRooms || []) {
      const zoneCandidate = getDeviceZoneCandidate(deviceId, scopeDeviceZones);
      if (!zoneCandidate) continue;
      const zoneNorm = normalizeName(zoneCandidate);
      if (zoneNorm && normalizedQuestion.includes(zoneNorm)) {
        matches.push(deviceId);
      }
    }
    return matches;
  }
	
  async function run(messages, {
    room,
    range,
    selectionRooms = [],
    selectionZones = [],
	    tenant = null,
	    building = null,
	    floor = null,
	    zone = null,
    scopeLabels = null,
    scopeFloors = [],
    scopeDeviceZones = {},
    attempt = 0,
    conversationSummary = ''
  }) {
    const question = messages[messages.length - 1]?.content || '';
    const questionLower = String(question || '').toLowerCase();
    let scopeHeaderLine = '';
    const applyScopeHeader = (text) => applyScopeHeaderText(text, scopeHeaderLine);

    try {

    // --- ROUTING & HYBRID RETRIEVAL ---
    const routing = classifyQuery(question);
    const questionNamedRooms = extractQuestionRooms(question);
    routing.namedRooms = questionNamedRooms;
    const filters = suggestRetrievalFilters(routing.level, routing);
    const preferCategories = filters?.preferCategories || [];
    const routerDirectives = buildAnalysisDirectives(routing);
    const selectionFloors = Array.isArray(scopeFloors) ? [...scopeFloors] : [];

    const retrievalScope = {
      tenant,
      building,
      floor,
      room,
      rooms: selectionRooms,
      zones: selectionZones,
      metrics: routing.metrics,
      timeHints: routing.timeHints
    };

    const ctx = await buildContextSnippet(
      question,
      room && room !== 'ALL' ? room : null,
      range,
      selectionRooms,
      {
        selectionZones,
        selectionFloors,
        scopeDeviceZones,
        scopeLabels,
        retrievalHints: {
          preferCategories,
          metrics: routing.metrics,
          timeHints: routing.timeHints,
          scope: retrievalScope,
          k: routing?.pipeline?.retrieval?.k || 6
        }
      }
    );

    scopeHeaderLine = ctx?.scopeHeaderLine || scopeHeaderLine;

    const hybridHits = (ctx && ctx._retrievedDocs && ctx._retrievedDocs.length)
      ? ctx._retrievedDocs
      : await hybridRetrieve({
          query: question,
          ragIndex: ragManager.ensure().index,
          vectorClient: vector,
          k: routing?.pipeline?.retrieval?.k || 6,
          preferCategories,
          scope: retrievalScope
        }).catch(() => []);

    // --- QUERY ENRICHMENT: Knowledge Pack ---
    let knowledgeSnippets = hybridHits
      .filter(h => h.meta?.type === 'knowledge')
      .map(h => `From ${h.meta.file}: ${h.text}`)
      .join('\n---\n');
    if (knowledgeSnippets && knowledgeSnippets.length > 1500) {
      knowledgeSnippets = knowledgeSnippets.slice(0, 1500) + '\n…';
    }
    // --------------------------------------------

    const attemptIndex = Number.isFinite(Number(attempt)) ? Number(attempt) : 0;

    const roomFieldCache = new Map();
    function fieldsForRoom(roomId) {
      if (!roomId) return new Set();
      if (roomFieldCache.has(roomId)) return roomFieldCache.get(roomId);
      const tablesSets = availableFieldsByTable(roomId);
      const set = new Set();
      for (const val of Object.values(tablesSets || {})) {
        if (val && typeof val.forEach === 'function') {
          val.forEach((f) => { if (f && f !== 'ts') set.add(f); });
        }
      }
      roomFieldCache.set(roomId, set);
      return set;
    }

    function findSharedField(roomIds = [], preferred = [], exclude = null) {
      const candidates = [...preferred];
      const firstRoom = roomIds.find(Boolean);
      if (firstRoom) {
        fieldsForRoom(firstRoom).forEach((f) => { if (!candidates.includes(f)) candidates.push(f); });
      }
      for (const field of candidates) {
        if (!field || (exclude && String(field) === String(exclude))) continue;
        const ok = roomIds.every((rid) => !rid || fieldsForRoom(rid).has(field));
        if (ok) return field;
      }
      return null;
    }

    log('Question:', '<redacted>');
    if (DEBUG) log('Context snippet schema keys:', Object.keys(ctx.schema));

    let rr = (range && typeof range === 'object') ? { ...range } : {};
    const telemetryAlignment = alignRangeToTelemetry(rr, {
      selectionRooms,
      selectionZones,
      scopeLabels: scopeLabels || {},
      fallbackRoom: room
    });
    rr = telemetryAlignment.range;
    setScopeContext({ selectionRooms, selectionZones, selectionFloors, scopeDeviceZones, scopeLabels, range: rr });
    const adaptationNotes = [];
    if (telemetryAlignment.changed) {
      adaptationNotes.push(`Adjusted time window to available telemetry (${describeRangeWindow(rr)}).`);
    }
    // Inject knowledge enrichment into system prompt
    const startDate = rr.start ? new Date(rr.start) : null;
    const endDate = rr.end ? new Date(rr.end) : null;
	    const startFmt = startDate ? `${startDate.toLocaleString()} (UTC: ${startDate.toISOString().replace('T', ' ').slice(0, 16)})` : 'none';
	    const endFmt = endDate ? `${endDate.toLocaleString()} (UTC: ${endDate.toISOString().replace('T', ' ').slice(0, 16)})` : 'none';
	
    const zoneSummaries = summarizeZones(selectionRooms, selectionZones, scopeDeviceZones, { building, floor });
    const zonesLine = zoneSummaries.length ? zoneSummaries.join('; ') : '(none)';
    const devicesLine = Array.isArray(selectionRooms) && selectionRooms.length ? selectionRooms.join(', ') : '(none)';
    const namedRoomDevices = questionNamedRooms.map((label) => ({
      label,
      devices: collectDevicesForZone(label, { building, floor })
    }));
    const namedRoomDeviceHints = namedRoomDevices
      .map(({ label, devices }) => {
        if (!Array.isArray(devices) || !devices.length) return `${label}: no matching scope devices`;
        const preview = devices
          .slice(0, 3)
          .map((entry) => {
            const id = entry.cloudId || entry.primaryId || entry.id || '';
            const nm = entry.name && entry.name !== id ? ` (${entry.name})` : '';
            return id ? `${id}${nm}` : entry.name || '';
          })
          .filter(Boolean)
          .join(', ');
        return `${label}: ${preview}`;
      })
      .filter(Boolean);

    const unavailableMetricResponse = detectUnavailableMetricResponse(question, selectionRooms, room);
    if (unavailableMetricResponse) return unavailableMetricResponse;

    const intent = classifyIntent(question);
    const histogramRequested = (routing?.intents?.histogram === true)
      || questionLower.includes('histogram')
      || questionLower.includes('distribution')
      || questionLower.includes('frequency')
      || questionLower.includes('bins')
      || questionLower.includes('bucket');
    const heatmapRequested = (routing?.intents?.heatmap === true)
      || questionLower.includes('heatmap')
      || questionLower.includes('matrix');
    const requireRoomRanking = questionRequiresRoomRanking(question) && Array.isArray(selectionZones) && selectionZones.length > 1;
    const rankingRoomsList = requireRoomRanking
      ? (selectionZones.length ? selectionZones.join(', ') : (selectionRooms && selectionRooms.length ? selectionRooms.join(', ') : '(current scope)'))
      : '';
    const rankingInstruction = requireRoomRanking
      ? `ROOM COMPARISON TASK: The user is asking which room/zone is busiest or unused. Compare every room currently in scope (${rankingRoomsList}). Use compare_rooms_on_metric (preferred), scope_daily_percentile (for percentile/occupied-median requests), or compare_series_cross_room on people_count/occupancy to rank them, cite the values, and explicitly name which room is busiest. Mention any rooms that lack occupancy data.`
      : '';
    const needsRoomComparison = questionRequiresRoomComparison(question);
    const comparisonRoomsList = questionNamedRooms.length
      ? questionNamedRooms.join(', ')
      : (selectionZones && selectionZones.length ? selectionZones.join(', ') : (selectionRooms && selectionRooms.length ? selectionRooms.join(', ') : '(current scope)'));
    const comparisonInstruction = needsRoomComparison
      ? `ROOM METRIC COMPARISON TASK: The user asked to compare metrics between ${comparisonRoomsList}. You MUST call compare_series_cross_room or compare_rooms_on_metric (or both) on the relevant metric(s), discuss differences for each room, and highlight which room leads or lags.`
      : '';

    const scopeSnapshotNote = ctx.scopeSnapshot ? `Scope snapshot notes:\n${ctx.scopeSnapshot}\n` : '';
    const connectorNote = summarizeConnectorStatus(ctx.connectors);
    const sys = `You are a senior data analyst agent for building operations.
${conversationSummary ? `=== CONVERSATION MEMORY ===\n${conversationSummary}\n` : ''}
${connectorNote ? `${connectorNote}\n` : ''}
Selected room: ${room || '(none)'}.
Zones in scope: ${zonesLine}
Devices in scope: ${devicesLine}
${namedRoomDeviceHints.length ? `User-named rooms resolved to devices: ${namedRoomDeviceHints.join(' | ')}` : ''}
${room === 'ALL' && selectionRooms && selectionRooms.length ? `IMPORTANT: Cross-room analysis MUST be limited to ONLY these devices and their parent zones. Do NOT introduce other scopes.` : ''}
${scopeSnapshotNote}
Selected time window: 
- Local: ${startFmt} to ${endFmt}
- Epoch ms: start=${rr.start ?? 'none'} end=${rr.end ?? 'none'}

MANDATORY: Always use this time window for all analysis and answers. Do NOT invent or assume any other period. If the user asks "what time period are you analysing", repeat this exact window.

FREEDOM TO ANALYZE: You are encouraged to analyze the data, derive insights, compare across rooms within scope, and synthesize conclusions. Use tools as needed; if tools are insufficient, explain and proceed with reasoned analysis using available data.

DOMAIN NOTE: "Zone" and "Room" are synonyms in this system. When the user mentions a zone, treat it exactly as a room, and vice versa. Use graph relationships (Building → Floor → Zone) to understand placement.

${routerDirectives}

${rankingInstruction ? `${rankingInstruction}\n` : ''}${comparisonInstruction ? `${comparisonInstruction}\n` : ''}=== KNOWLEDGE PACK ENRICHMENT (REPHRASE ONLY) ===
${knowledgeSnippets || 'No extra knowledge found for this query.'}

RULE: Do NOT dump or quote long passages from knowledge. If you use it, REPHRASE concisely in your own words and keep it brief.
CONSISTENCY RULE: Build every conclusion from the tools you run—do NOT fall back to placeholder text.
AGGREGATION RULE: When comparing metrics, compute stats (count/min/max/avg) or aggregates (compare_rooms_on_metric, stats) and cite those numbers.

${intent.weatherQuestion ? 'WEATHER TASK: Questions mentioning weather or outside conditions REQUIRE you to call weather_fetch (or building_temp_weather_corr) for the current building so you can compare indoor vs outdoor signals.' : ''}

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

CHART STYLE: Pick a chart type that fits the metric (e.g., column for occupancy counts, line for smooth trends, area for cumulative energy, scatter for correlations, histogram for distributions). Always explain in prose what the chart shows and why it matters.

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

=== ANALYSIS WORKFLOW (MANDATORY) ===
1. Before calling any tool, respond with {"action":"plan","steps":[{"id":"S1","goal":"Review CO2 trend","tool":"fetch_timeseries","inputs":["co2"]}, ...]} listing 2‑4 concrete steps. Every step MUST be a JSON object (not a string) with:
   - id: S1, S2, S3… (unique per step)
   - goal: what you will do
   - tool: the exact tool name you intend to call
   - inputs/metrics (array) describing the metric(s) you’ll request
   Do NOT call tools until the structured plan is acknowledged.
2. After the plan is acknowledged, every {"action":"tool_call"} (and each entry inside {"action":"tool_calls"}) MUST include "planStep":"S#" pointing to the step it satisfies. Execute the plan in order and only advance after completing each step’s tool call.
3. When tools finish, respond with {"action":"final", ... , "plan_status":[{"id":"S1","status":"done","finding":"CO₂ trend captured"}, ...]} that (a) begins with "Overview:" summarizing the conclusions for ${startFmt} to ${endFmt} in 2 sentences, (b) adds a "Details:" section referencing each plan step and the tool outputs, (c) explicitly comments on any chart you provide, and (d) lists plan_status for every step with its outcome.
4. If you cannot complete a plan step (missing data, tool limitation, etc.), explain why in the final answer, mark that step in plan_status with status:"blocked" (or similar), and describe the gap.

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
- Prefer dataRef in chart series; only embed small aggregate arrays when they contain a handful of points.
- The backend resolves dataRef automatically from tool results
- Avoid embedding large datasets – use dataRef for timeseries and long arrays

Tools: ${buildToolSpec()}.
Notes: 
- In weather data, temperature field is 'temp'.
- Use 'hour_of_day_stats' for "best time" by CO2 or occupancy.
- Use 'busiest_day_of_week' for questions about "busiest day", "which weekday", "most crowded day", "highest occupancy day", etc.
- Use 'histogram' when the user asks for a distribution or histogram.
- Use 'compare_metrics_in_room' for comparing multiple metrics within one room, and 'compare_rooms_on_metric' to rank rooms by an aggregate.
- Use 'scope_daily_percentile' when users request multi-room percentile/occupied-period summaries (e.g., “daily 95th percentile CO₂ with occupied median”).
For IAQ table: common fields are temperature, humidity, co2, pm25, pm10, lux, airexchangerate
When user asks to COMPARE between rooms or metrics, prefer these tools:
- compare_series_cross_room (timeseries across rooms)
- compare_rooms_on_metric (rank rooms by agg over window)
- compare_metrics_in_room (compare multiple fields within one room)
- correlation_matrix (pairwise correlations among metrics)
Context: ${JSON.stringify(ctx).slice(0, 5000)}`;

    const convo = [
      { role: 'user', content: sys },
      ...messages
    ];

    const qlLower = (question || '').toLowerCase();
    const mentionsScopeSummary =
      /\bscope\b/.test(qlLower) &&
      (qlLower.includes('visible') ||
        qlLower.includes('highlight') ||
        qlLower.includes('devices') ||
        qlLower.includes('zones') ||
        qlLower.includes('floors') ||
        qlLower.includes('sensors') ||
        qlLower.includes('selected') ||
        qlLower.includes('gaps') ||
        qlLower.includes('current scope') ||
        /\bcurrent(ly)?\b/.test(qlLower));
    const scopeOnlyQuestion =
      (mentionsScopeSummary || /\bwhat\s+scope\b/.test(qlLower)) &&
      !/\b(sensor|sensors|metric|metrics|telemetry|gap|gaps|chart|trend|compare|list|plot|graph)\b/.test(qlLower);
    const wantsScopeSummary =
      intent.selectionTime ||
      /what\s+scope\s+do\s+you\s+see/.test(qlLower) ||
      /what\s+selection\s+do\s+you\s+see/.test(qlLower) ||
      /selection\s+and\s+time/.test(qlLower) ||
      /current\s+(range|window)\??/.test(qlLower) ||
      /what\s+(time|period|window)\s+are\s+you\s+analys/.test(qlLower) ||
      /what\s+time\s+period/.test(qlLower) ||
      scopeOnlyQuestion;
    if (wantsScopeSummary) {
      const summary = buildScopeSummary({
        selectionRooms,
        selectionZones,
        selectionFloors: scopeFloors || [],
        scopeDeviceZones: scopeDeviceZones || {},
        selectionLabels: scopeLabels || { tenant, building, floor, room: zone },
        range: rr
      });
      return { message: assistantMessage(summary), chart: null, trace: [] };
    }

    const explicitTimestamp = extractTimestampFromQuestion(question);
    const looksLikeRangeQuery = (() => {
      const q = String(question || '').toLowerCase();
      if (q.includes('between')) return true;
      if (q.includes('range')) return true;
      if (q.includes('over the') || q.includes('throughout')) return true;
      if (q.includes('from') && q.includes('to')) return true;
      if ((q.match(/\d{4}/g) || []).length >= 2) return true;
      return false;
    })();
    if (explicitTimestamp && !looksLikeRangeQuery) {
      const pointAnswer = tryAnswerPointQuery({
        question,
        timestamp: explicitTimestamp,
        room,
        selectionRooms,
        scopeDeviceZones,
        range: rr
      });
      if (pointAnswer) return pointAnswer;
    }


    const trace = [];
    let lastToolSig = '';
    let repeatCount = 0;
    let totalToolCalls = 0;
    let scatterRetryCount = 0;
    let chartRetryCount = 0;
    let planConfirmed = false;
    let planSteps = [];
    let planStatus = [];
    let planStepMap = new Map();
    let consecutivePlanReplies = 0;
    let planLoopWarnings = 0;
    let lastPlanSignature = null;
    let consecutiveJsonFailures = 0;
    let incompletePlanWarnings = 0;
    const MAX_INCOMPLETE_PLAN_WARNINGS = Math.max(1, Number(process.env.AGENT_INCOMPLETE_PLAN_MAX || 3));

    const canonicalPlanStepId = (raw, idx = null) => {
      let id = raw == null ? '' : String(raw).trim();
      if (!id && idx != null) id = `S${idx + 1}`;
      if (!id) return null;
      id = id.replace(/\s+/g, '');
      if (/^step\d+$/i.test(id)) id = `S${id.replace(/^step/i, '')}`;
      if (/^\d+$/i.test(id)) id = `S${id}`;
      if (!/^S/i.test(id)) id = `S${id}`;
      return id.toUpperCase();
    };

    const registerPlanSteps = (steps = []) => {
      planStepMap = new Map();
      steps.forEach((step, idx) => {
        if (!step || !step.id) return;
        const aliases = new Set([
          step.id,
          step.id.toLowerCase(),
          `S${step.index || idx + 1}`,
          `STEP${step.index || idx + 1}`,
          String(step.index || idx + 1)
        ]);
        aliases.forEach((key) => planStepMap.set(String(key).toUpperCase(), step));
      });
    };

    const findPlanStep = (ref) => {
      if (!ref) return null;
      const key = canonicalPlanStepId(ref);
      if (!key) return null;
      return planStepMap.get(key.toUpperCase()) || null;
    };

    const planStatusSnapshot = () => planStatus.map((step) => ({
      id: step.id,
      index: step.index,
      text: step.text,
      tool: step.tool,
      done: !!step.done,
      note: step.note || null
    }));

    const findTraceEntryForPlanStep = (stepRef) => {
      if (!stepRef) return null;
      const key = canonicalPlanStepId(stepRef);
      if (!key) return null;
      for (let i = trace.length - 1; i >= 0; i -= 1) {
        const entry = trace[i];
        if (!entry || !entry.planStepId) continue;
        const entryKey = canonicalPlanStepId(entry.planStepId);
        if (entryKey && entryKey === key) return entry;
      }
      return null;
    };

    const chartFromSupportingData = (items = []) => {
      if (!Array.isArray(items) || !items.length) return null;
      const series = [];
      let chartType = null;
      let chartTitle = null;
      let axisType = null;
      let yLabel = null;
      for (const item of items) {
        if (!item) continue;
        chartType = chartType || item.chartType || 'line';
        chartTitle = chartTitle || item.title || item.name || 'Supporting Data';
        const mappings = item.mappings || {};
        if (!axisType) axisType = mappings.x ? (mappings.x === 'ts' ? 'datetime' : 'linear') : 'datetime';
        if (!yLabel && mappings.yLabel) yLabel = mappings.yLabel;
        let dataRef = null;
        if (item.dataRef && typeof item.dataRef === 'object') {
          dataRef = { ...item.dataRef };
        } else {
          const refKey = item.dataRef || item.planStep || item.plan_step || item.step;
          if (refKey) {
            const entry = findTraceEntryForPlanStep(refKey);
            if (entry) {
              const args = entry.args || {};
              const inferredY = mappings.y || args.field || (Array.isArray(args.fields) ? args.fields[0] : null);
              dataRef = {
                tool: entry.tool,
                room: args.room || null,
                table: args.table || args.table1 || args.table2 || null,
                fields: args.fields,
                xField: mappings.x || 'ts',
                yField: inferredY || 'value'
              };
            }
          }
        }
        if (!dataRef && typeof item.tool === 'string') {
          dataRef = {
            tool: resolveToolName(item.tool),
            xField: mappings.x || 'ts',
            yField: mappings.y || 'value'
          };
        }
        if (!dataRef || !dataRef.tool) continue;
        if (!dataRef.xField) dataRef.xField = 'ts';
        if (!dataRef.yField) dataRef.yField = 'value';
        const name = item.name || item.title || `Series ${series.length + 1}`;
        series.push({ name, dataRef });
      }
      if (!series.length) return null;
      const chart = {
        chart: { type: chartType || 'line' },
        title: { text: chartTitle || 'Supporting Data' },
        series
      };
      if (axisType) chart.xAxis = { type: axisType };
      if (yLabel) chart.yAxis = { title: { text: yLabel } };
      return chart;
    };

    const normalizePlanSteps = (rawSteps = []) => {
      const normalized = [];
      const errors = [];
      rawSteps.forEach((raw, idx) => {
        if (!raw || typeof raw !== 'object') {
          errors.push(`Step ${idx + 1} must be an object with id/tool/goal.`);
          return;
        }
        const text = String(raw.goal ?? raw.text ?? raw.description ?? raw.summary ?? '').trim();
        if (!text) {
          errors.push(`Step ${idx + 1} is missing a goal/description.`);
          return;
        }
        const id = canonicalPlanStepId(raw.id ?? raw.stepId ?? raw.step_id ?? raw.step ?? raw.index ?? raw.name ?? raw.label ?? '', idx);
        if (!id) {
          errors.push(`Step ${idx + 1} is missing an id (use S1, S2, ...).`);
          return;
        }
        const rawToolName = raw.tool ?? raw.tool_name ?? raw.toolName ?? raw.action ?? raw.intent ?? '';
        const resolvedTool = resolveToolName(rawToolName);
        if (!resolvedTool || !tools[resolvedTool]) {
          errors.push(`Step ${id} must specify a valid tool (got "${rawToolName || 'none'}").`);
          return;
        }
        const inputs = [];
        const pushInput = (val) => {
          const str = String(val ?? '').trim();
          if (str) inputs.push(str);
        };
        if (Array.isArray(raw.inputs)) raw.inputs.forEach(pushInput);
        if (Array.isArray(raw.fields)) raw.fields.forEach(pushInput);
        if (Array.isArray(raw.metrics)) raw.metrics.forEach(pushInput);
        if (raw.metric) pushInput(raw.metric);
        if (raw.field) pushInput(raw.field);
        normalized.push({
          id,
          index: idx + 1,
          text,
          tool: resolvedTool,
          rawTool: rawToolName || resolvedTool,
          inputs,
          target: raw.room || raw.zone || raw.target || raw.scope || null,
          done: false,
          note: null
        });
      });
      return { steps: normalized, errors };
    };

    const planStatusPayload = () => planStatusSnapshot().map((step) => ({
      id: step.id,
      status: step.done ? 'done' : 'pending',
      finding: step.note || step.text || ''
    }));

    const attachPlanStatus = (obj = {}) => {
      if (!planConfirmed || !planStatus.length || !obj || typeof obj !== 'object') return obj;
      const payload = extractPlanStatusPayload(obj);
      if (!Array.isArray(payload) || !payload.length) {
        obj.plan_status = planStatusPayload();
      }
      return obj;
    };
    let comparisonSatisfied = !needsRoomComparison;
    let rankingSatisfied = !requireRoomRanking;
    const summarizePlanStatusLines = () => planStatus
      .map((step) => {
        if (!step) return null;
        const marker = step.done ? 'x' : ' ';
        const label = step.text || step.description || step.goal || '';
        const toolLabel = step.tool ? ` [${step.tool}]` : '';
        return `[${marker}] ${step.id || step.index}: ${label}${toolLabel}`;
      })
      .filter(Boolean)
      .join('\n');

    const pushPlanProgress = (note) => {
      if (!planStatus.length) return;
      const summaryLines = summarizePlanStatusLines();
      const next = planStatus.find((step) => !step.done);
      const defaultNote = next
        ? `Next: ${next.id}: ${next.text}. Execute it via {"action":"tool_call","planStep":"${next.id}","tool":"${next.tool}","args":{...}}.`
        : 'All planned steps are complete. Provide {"action":"final","plan_status":[...]} summarizing each step.';
      convo.push({
        role: 'user',
        content: `PLAN STATUS:\n${summaryLines}\n${note || defaultNote}\nRemember: every tool call must include "planStep":"S#".`
      });
    };

    const markPlanStepComplete = (stepRef = null, note = null) => {
      if (!planConfirmed || !planStatus.length) return;
      const target = stepRef ? findPlanStep(stepRef) : planStatus.find((s) => !s.done);
      if (!target) return;
      if (!target.done) {
        target.done = true;
        if (note) target.note = note;
        pushPlanProgress(`Completed ${target.id}: ${target.text}.`);
        incompletePlanWarnings = 0;
      } else if (note) {
        target.note = note;
      }
    };

    const extractPlanStatusPayload = (obj = {}) => {
      if (Array.isArray(obj.plan_status)) return obj.plan_status;
      if (Array.isArray(obj.planStatus)) return obj.planStatus;
      if (obj.plan && Array.isArray(obj.plan.status)) return obj.plan.status;
      return null;
    };

    const ensureFinalReferencesPlan = (obj = {}) => {
      if (!planConfirmed || !planStatus.length) return true;
      const payload = extractPlanStatusPayload(obj);
      if (!Array.isArray(payload) || !payload.length) {
        convo.push({
          role: 'user',
          content: 'Include "plan_status":[{"id":"S1","status":"done","finding":"..."}] summarizing each plan step before finalizing.'
        });
        return false;
      }
      const provided = new Set();
      for (const entry of payload) {
        const norm = canonicalPlanStepId(entry?.id ?? entry?.step ?? entry?.stepId ?? entry?.planStep ?? '');
        if (norm) provided.add(norm);
      }
      const missing = planStatus.filter((step) => !provided.has(step.id));
      if (missing.length) {
        convo.push({
          role: 'user',
          content: `Plan status missing for ${missing.map((s) => s.id).join(', ')}. Include each step with its outcome and resend the final response.`
        });
        return false;
      }
      return true;
    };
    
    STEP_LOOP: for (let step = 0; step < 12; step++) {
      const t0 = Date.now();
      const reply = await callGeminiChat(convo, {});
      const dt = Date.now() - t0;
      log(`LLM step ${step} took ${dt}ms`);
      
      if (!reply) {
        const emergency = runEmergencyAnalysis({ question, selectionRooms, room, range: rr });
        if (emergency) {
          const mergedTrace = Array.isArray(emergency.trace) ? [...trace, ...emergency.trace] : trace;
          return { ...emergency, trace: mergedTrace };
        }
        break;
      }
      if (DEBUG) log('LLM raw reply:', reply.slice(0, 600));

      const assistantTurn = String(reply || '').trim();
      if (assistantTurn) {
        convo.push({ role: 'assistant', content: assistantTurn });
      }
      
      // Force finalization if we've made enough tool calls
      if (totalToolCalls >= 8 && step >= 5) {
        const recentlyPaired = trace.some(t => t.tool === 'pair_timeseries');
        if (recentlyPaired && step < 5) {
          // Allow one extra iteration to let the model produce a chart using the paired dataRef
          log('Skipping forced finalization to allow scatter pairing (step', step, ')');
        } else {
          log('Strongly encouraging finalization after', totalToolCalls, 'tool calls at step', step);
        
        // CRITICAL: After 2 tools and step 2+, FORCE finalization with very explicit instructions
        if (step >= 4) {
          const ql = question.toLowerCase();
          const isCorrelationPlot = ql.includes('correlation') && (ql.includes('plot') || ql.includes('show'));
          const isScatterPlot = ql.includes('scatter') || ql.includes('scatterplot') || ql.includes(' vs ') || ql.includes(' against ');
          const isCompare = ql.includes('compare') || ql.includes('vs') || ql.includes('versus');
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
          
          convo.push({ role: 'user', content: hint });
          continue STEP_LOOP; // Force another iteration with this guidance
        }
      }
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

      if (obj) {
        consecutiveJsonFailures = 0;
        attachPlanStatus(obj);
      } else {
        consecutiveJsonFailures += 1;
        if (consecutiveJsonFailures >= 3 && totalToolCalls > 0) {
          log('Synthesizing final JSON after repeated parse errors');
          const syntheticChart = buildFallbackChartFromTrace({
            trace,
            question,
            defaultRoom: room,
            selectionRooms
          });
          const syntheticAnswer = buildDefaultAnswer({
            question,
            trace,
            chart: syntheticChart,
            range: rr
          });
          obj = {
            action: 'final',
            answer: syntheticAnswer,
            chart: syntheticChart,
            plan_status: planStatusSnapshot()
          };
        }
      }

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
            role: 'user',
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
          continue STEP_LOOP;
        }
        
        // Check if the reply contains embedded data arrays (another detection method)
        if (trimmed.includes('"data":[[') || trimmed.match(/"data":\s*\[\[/)) {
          log('Detected embedded data array in response');
          convo.push({
            role: 'user',
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
          continue STEP_LOOP;
        }
        
        // CRITICAL: Reject plain text responses - force JSON format
        const plain = String(reply || '').trim();
        if (plain.length > 20 && /[a-zA-Z]/.test(plain) && !plain.startsWith('{')) {
          if (totalToolCalls > 0 && (step >= 4 || attempt >= 1)) {
            log('Auto-wrapping plain text response after tooling');
            return {
              message: assistantMessage(plain),
              chart: null,
              trace
            };
          }
          
          log('Rejecting plain text response, enforcing JSON format');
          convo.push({
            role: 'user',
            content: `CRITICAL ERROR: You provided a plain text response instead of JSON. This is NOT acceptable.

Your response started with:
"${plain.slice(0, 200)}..."

You MUST respond with a valid JSON object using this EXACT format:

{"action":"final","answer":"${plain.slice(0, 100).replace(/"/g, '\\"')}...","chart":null}

Copy the above format and fill in your complete answer. Use proper JSON syntax.`
          });
          continue STEP_LOOP;
        }
        
        convo.push({
          role: 'user',
          content: `CRITICAL ERROR: Response could not be parsed as valid JSON. You must respond with a JSON object using the documented schema (action/tool_calls/final/chart). Resend your answer in the required JSON format.`
        });
        continue STEP_LOOP;
        
        // After step 2, if reply is not valid JSON with "action", force a JSON answer
        if (step >= 2 && (!obj || !obj.action)) {
          convo.push({
            role: 'user',
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
          continue STEP_LOOP;
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
          role: 'user', 
          content: `{"tool_results": ${JSON.stringify(results).slice(0, 15000)} }` 
        });
        continue STEP_LOOP;
      }
      
      if (obj && obj.action === 'plan') {
        consecutivePlanReplies += 1;
        const rawSteps = Array.isArray(obj.steps) ? obj.steps : [];
        const { steps: structuredSteps, errors } = normalizePlanSteps(rawSteps);
        const signature = JSON.stringify(structuredSteps.map((step) => ({
          id: step.id,
          tool: step.tool,
          goal: step.text
        })));
        if (planConfirmed && planStatus.length && signature && signature === lastPlanSignature) {
          planLoopWarnings += 1;
          const next = planStatus.find((s) => !s.done);
          const reminder = next
            ? `Plan already locked. Execute ${next.id}: ${next.text} via {"action":"tool_call","planStep":"${next.id}","tool":"${next.tool}","args":{...}} instead of rewriting the plan.`
            : 'Plan locked and all steps complete. Respond with {"action":"final","plan_status":[...]} referencing each step.';
          convo.push({ role: 'user', content: reminder });
          if (planLoopWarnings >= 2) pushPlanProgress('Stop resending the plan—advance to the pending step.');
          continue STEP_LOOP;
        }
        if (errors.length) {
          convo.push({
            role: 'user',
            content: `Plan error: ${errors[0]}. Provide {"action":"plan","steps":[{"id":"S1","goal":"Review CO2 trend","tool":"fetch_timeseries","inputs":["co2"]}, {"id":"S2","goal":"Compare rooms on CO2","tool":"compare_rooms_on_metric","inputs":["co2"]}]}`
          });
          continue STEP_LOOP;
        }
        if (structuredSteps.length < 2) {
          convo.push({
            role: 'user',
            content: 'Plan must include at least two structured steps with ids/tools. Respond again with {"action":"plan","steps":[...]}'
          });
        } else {
          const planWasActive = planConfirmed && planStatus.length;
          planConfirmed = true;
          planSteps = structuredSteps.map((step) => ({ ...step }));
          planStatus = planSteps;
          registerPlanSteps(planStatus);
          incompletePlanWarnings = 0;
          lastPlanSignature = signature;
          trace.push({ tool: 'plan', args: { steps: planStatusSnapshot() }, result: null });
          const initialStep = planStatus.find((s) => !s.done);
          const prefix = planWasActive ? 'Plan updated.' : 'Plan locked.';
          const note = initialStep
            ? `${prefix} Begin ${initialStep.id}: ${initialStep.text} using {"action":"tool_call","planStep":"${initialStep.id}","tool":"${initialStep.tool}","args":{...}}.`
            : `${prefix} Execute the outlined steps with the required tools.`;
          pushPlanProgress(note);
        }
        planLoopWarnings = 0;
        consecutivePlanReplies = 0;
        continue STEP_LOOP;
      }

      consecutivePlanReplies = 0;

      if (!planConfirmed) {
        convo.push({
          role: 'user',
          content: 'MANDATORY: Provide {"action":"plan","steps":[...]} before calling tools or finalizing. Outline 2-4 analytical steps that reference the data or tools you will use.'
        });
        continue STEP_LOOP;
      }
      
      // Handle single tool call
      // Handle multiple parallel tool calls
      if (obj.action === 'tool_calls' && Array.isArray(obj.tools)) {
        planLoopWarnings = 0;
        const resolvedCalls = [];
        for (const tc of obj.tools) {
          const planRefRaw = tc.planStep ?? tc.plan_step ?? tc.plan ?? tc.step ?? tc.stepId ?? tc.id ?? null;
          let planEntry = planConfirmed ? findPlanStep(planRefRaw) : null;
          if (!planEntry && planConfirmed) {
            planEntry = autoAssignPlanStep(tc.tool);
          }
          resolvedCalls.push({
            raw: tc,
            toolName: resolveToolName(tc.tool),
            planEntry,
            planStepId: planEntry?.id || (planRefRaw ? canonicalPlanStepId(planRefRaw) : null)
          });
        }
        const results = [];
        for (const tc of resolvedCalls) {
          const tool = tc.toolName;
          const args = { ...((tc.raw?.args) || {}) };
          if (!tools[tool]) {
            results.push({ planStep: tc.planStepId, tool, args, result: { error: `Tool ${tool} not found` } });
            continue;
          }
          if (args.room == null && room) args.room = room;
          if (args.start == null && rr.start != null) args.start = rr.start;
          if (args.end == null && rr.end != null) args.end = rr.end;
          // Steer tool args toward intended metric/table inferred from the question
          const want = (String(question||'').toLowerCase().includes('humidity') ? 'humidity' :
                       String(question||'').toLowerCase().includes('temperature') || String(question||'').toLowerCase().includes('temp') ? 'temperature' :
                       String(question||'').toLowerCase().includes('co2') ? 'co2' :
                       String(question||'').toLowerCase().includes('lux') || String(question||'').toLowerCase().includes('light') ? 'lux' : null);
          if (want) {
            if (tool === 'fetch_timeseries') {
              if (!args.fields || !args.fields.length || !args.fields.includes(want)) args.fields = [want];
              if (!args.table) { const t = inferDefaultTableForMetric(want); if (t) args.table = t; }
            } else if (tool === 'hourly_timeseries' || tool === 'daily_avg' || tool === 'stats' || tool === 'hour_of_day_stats' || tool === 'histogram') {
              if (!args.field) args.field = want;
              if (!args.table) { const t = inferDefaultTableForMetric(want); if (t) args.table = t; }
            }
          }
          prepareToolArgs(tool, args);
          let result = null;
          try { result = tools[tool](args); } catch (e) { result = { error: String(e) }; }
          results.push({ planStep: tc.planStepId, tool, args, result });
          trace.push({ planStepId: tc.planStepId, tool, args, result });
          totalToolCalls += 1;
          if (needsRoomComparison && (tool === 'compare_series_cross_room' || tool === 'compare_rooms_on_metric' || tool === 'compare_metrics_in_room' || tool === 'scope_daily_percentile')) {
            comparisonSatisfied = true;
          }
          if (requireRoomRanking && (tool === 'compare_series_cross_room' || tool === 'compare_rooms_on_metric' || tool === 'compare_metrics_in_room' || tool === 'scope_daily_percentile')) {
            rankingSatisfied = true;
          }
          markPlanStepComplete(tc.planStepId, `Executed ${tool}`);
        }
        convo.push({ role: 'user', content: `{"tool_results": ${JSON.stringify(results).slice(0, 15000)} }` });
        continue STEP_LOOP;
      }
      if (obj.action === 'tool_calls' && !Array.isArray(obj.tools)) {
        convo.push({
          role: 'user',
          content: 'ERROR: Received tool_calls without a tools array. Respond with a proper JSON final answer.'
        });
        continue STEP_LOOP;
      }

      if (obj.action === 'tool_call') {
        planLoopWarnings = 0;
        const planRefRaw = obj.planStep ?? obj.plan_step ?? obj.plan ?? obj.step ?? obj.stepId ?? null;
        let planEntry = planConfirmed ? findPlanStep(planRefRaw) : null;
        if (!planEntry && planConfirmed) {
          planEntry = autoAssignPlanStep(obj.tool);
        }
        const planStepId = planEntry?.id || (planRefRaw ? canonicalPlanStepId(planRefRaw) : null);
        let { tool, args } = obj;
        tool = resolveToolName(tool);
        log('Tool call:', tool, 'args:', args);
        totalToolCalls += 1;
        
        if (!tools[tool]) {
          convo.push({ 
            role: 'user', 
            content: `Tool ${tool} not found.` 
          });
          break;
        }
        
        // Auto-fill missing room/start/end from selected context
        const filledArgs = { ...(args || {}) };
        if (filledArgs.room == null && room) filledArgs.room = room;
        if (filledArgs.start == null && rr.start != null) filledArgs.start = rr.start;
        if (filledArgs.end == null && rr.end != null) filledArgs.end = rr.end;
        // Steer tool args toward intended metric/table inferred from the question
        const want = (String(question||'').toLowerCase().includes('humidity') ? 'humidity' :
                     String(question||'').toLowerCase().includes('temperature') || String(question||'').toLowerCase().includes('temp') ? 'temperature' :
                     String(question||'').toLowerCase().includes('co2') ? 'co2' :
                     String(question||'').toLowerCase().includes('lux') || String(question||'').toLowerCase().includes('light') ? 'lux' : null);
        if (want) {
          if (tool === 'fetch_timeseries') {
            if (!filledArgs.fields || !filledArgs.fields.length || !filledArgs.fields.includes(want)) filledArgs.fields = [want];
            if (!filledArgs.table) { const t = inferDefaultTableForMetric(want); if (t) filledArgs.table = t; }
          } else if (tool === 'hourly_timeseries' || tool === 'daily_avg' || tool === 'stats' || tool === 'hour_of_day_stats' || tool === 'histogram') {
            if (!filledArgs.field) filledArgs.field = want;
            if (!filledArgs.table) { const t = inferDefaultTableForMetric(want); if (t) filledArgs.table = t; }
          }
        }
        prepareToolArgs(tool, filledArgs);
        
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
        trace.push({ planStepId, tool, args: filledArgs, result });
        if (needsRoomComparison && (tool === 'compare_series_cross_room' || tool === 'compare_rooms_on_metric' || tool === 'compare_metrics_in_room' || tool === 'scope_daily_percentile')) {
          comparisonSatisfied = true;
        }
        if (requireRoomRanking && (tool === 'compare_series_cross_room' || tool === 'compare_rooms_on_metric' || tool === 'compare_metrics_in_room' || tool === 'scope_daily_percentile')) {
          rankingSatisfied = true;
        }
        markPlanStepComplete(planStepId, `Executed ${tool}`);
        
        // If compare tool returned series, finalize immediately with a ready-to-plot chart
        if (tool === 'compare_series_cross_room' && result && typeof result === 'object' && !Array.isArray(result)) {
          try {
            let entries = Object.entries(result);
            const qlc = String(question||'').toLowerCase();
            let chart = null;
            const requested = (args && Array.isArray(args.series)) ? args.series : [];
            let adaptedRange = null;
            const metaSummaries = [];
            const allEmpty = entries.every(([, pts]) => !Array.isArray(pts) || pts.length === 0);
            if (allEmpty && requested.length) {
              let maxStart = -Infinity;
              let minEnd = Infinity;
              let overlapPossible = true;
              for (const s of requested) {
                const tableReq = s.table || 'iaq';
                const meta = tools.fetch_table_meta({ room: s.room, table: tableReq });
                trace.push({ tool: 'fetch_table_meta', args: { room: s.room, table: tableReq }, result: meta });
                const label = s.name || deviceFriendlyName(s.room);
                metaSummaries.push({ label, meta });
                if (!meta || !Number(meta.count)) {
                  overlapPossible = false;
                  continue;
                }
                if (meta.tsMin != null) maxStart = Math.max(maxStart, meta.tsMin);
                if (meta.tsMax != null) minEnd = Math.min(minEnd, meta.tsMax);
              }
              if (overlapPossible && Number.isFinite(maxStart) && Number.isFinite(minEnd) && maxStart < minEnd) {
                const adaptedArgs = { ...args, start: maxStart, end: minEnd };
                const adaptedResult = tools.compare_series_cross_room(adaptedArgs);
                trace.push({ tool: 'compare_series_cross_room', args: { ...adaptedArgs, _adapted: true }, result: adaptedResult });
                const adaptedEntries = Object.entries(adaptedResult || {});
                const hasData = adaptedEntries.some(([, pts]) => Array.isArray(pts) && pts.length);
                if (hasData) {
                  result = adaptedResult;
                  entries = adaptedEntries;
                  adaptedRange = { start: maxStart, end: minEnd };
                }
              }
              if (adaptedRange) {
                adaptationNotes.push(`No overlapping data in the requested window; showing overlap from ${formatLocal(adaptedRange.start)} to ${formatLocal(adaptedRange.end)}.`);
              } else if (metaSummaries.length) {
                const summaryText = metaSummaries.map(({ label, meta }) => {
                  if (!meta || !Number(meta.count)) return `${label}: no stored data`;
                  const latest = meta.tsMax != null ? formatLocal(meta.tsMax) : 'n/a';
                  return `${label}: last data ${latest}`;
                }).join('; ');
                adaptationNotes.push(`No data in the requested window. ${summaryText}.`);
              }
            }
            if (/(histogram|distribution)\b/.test(qlc)) {
              // Build histograms per series (per room/field)
              const colSeries = [];
              const requested = (args && Array.isArray(args.series)) ? args.series : [];
              for (const s of requested) {
                const roomReq = s.room;
                const fieldReq = s.field;
                const tableReq = s.table || 'iaq';
                try {
                  const hist = tools.histogram({ room: roomReq, table: tableReq, field: fieldReq, bins: 20, start: args.start || undefined, end: args.end || undefined });
                  trace.push({ tool: 'histogram', args: { room: roomReq, table: tableReq, field: fieldReq }, result: hist });
                  const data = Array.isArray(hist) ? hist.map(h => [Number(h.binStart), Number(h.count)]) : [];
                  colSeries.push({ name: `${roomReq} ${fieldReq}`, data });
                } catch (e) { /* ignore */ }
              }
              const any = colSeries.some(s => s.data && s.data.length);
              chart = any ? { chart: { type: 'column' }, title: { text: 'Histogram Comparison' }, xAxis: { title: { text: 'Value' } }, yAxis: { title: { text: 'Count' } }, series: colSeries } : null;
            } else {
              const lineSeries = entries.map(([name, pts]) => ({
                name,
                data: Array.isArray(pts) ? pts.filter(p => p && p.ts != null && Number.isFinite(Number(p.y))).map(p => [Number(p.ts), Number(p.y)]) : []
              }));
              const any = lineSeries.some(s => s.data && s.data.length);
              chart = any ? {
                chart: { type: 'line' },
                title: { text: 'Comparison' },
                xAxis: { type: 'datetime' },
                yAxis: { title: { text: '' } },
                series: lineSeries
              } : null;
            }
            const baseAnswer = entries.length ? 'Compared series across rooms.' : 'No data available to compare in the selected period.';
            let answerText = buildDefaultAnswer({
              question,
              chart,
              trace,
              fallbackText: baseAnswer,
              notes: adaptationNotes,
              range
            });
            if (!answerText || normalizeText(answerText) === normalizeText(question)) {
              const chartSummary = summarizeChart(chart);
              answerText = chartSummary || baseAnswer || 'Compared the requested metrics using available data.';
              if (Array.isArray(adaptationNotes) && adaptationNotes.length) {
                answerText += ' ' + adaptationNotes.join(' ');
              }
            }
            const evalMetrics = evaluateQA({ question, answer: answerText, retrievedDocs: ctx._retrievedDocs || [] });
            const extraEval = { message: assistantMessage(`Eval grounding=${(evalMetrics.grounding*100).toFixed(0)}% uncertainty=${(evalMetrics.uncertainty*100).toFixed(0)}%`), chart: null };
            return {
              message: assistantMessage(answerText),
              chart,
              extras: [extraEval],
              trace
            };
          } catch (e) {
            log('compare_series_cross_room finalize failed:', String(e));
          }
        }

        // Feed back a structured tool result frame when not finalizing
        convo.push({ role: 'user', content: `{"tool_result": { "tool": ${JSON.stringify(tool)}, "args": ${JSON.stringify(filledArgs)}, "result": ${JSON.stringify(result).slice(0, 10000)} }}` });
        
        // If the selected window produced no data, fetch meta to inform the model (but do not auto-expand the window)
        if ((tool === 'fetch_timeseries' && Array.isArray(result) && result.length === 0) ||
            (tool === 'stats' && (!result || !Number(result.count)))) {
          try {
            const meta = tools.fetch_table_meta({
              room: filledArgs.room,
              table: filledArgs.table || filledArgs.table1 || filledArgs.table2
            });
            convo.push({
              role: 'user',
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
            let answer = `Available data for room ${r}: ` + 
              Object.entries(summary)
                .map(([t, cols]) => `${t} [${cols.join(', ')}]`)
                .join('; ');
            answer = applyScopeHeader(answer);
            const evalMetrics = evaluateQA({ question, answer, retrievedDocs: ctx._retrievedDocs || [] });
            return { 
              message: assistantMessage(answer), 
              chart: null, 
              extras: [{ message: assistantMessage(`Query ${routing.level}; grounding ${(evalMetrics.grounding*100).toFixed(0)}%; uncertainty ${(evalMetrics.uncertainty*100).toFixed(0)}%`), chart: null }],
              trace 
            };
          }
        }
        continue STEP_LOOP;
        
      } else if (obj.action === 'final' || obj.action === 'finish' || obj.action === 'finalize') {
        planLoopWarnings = 0;
        log('Finalizing answer. Chart provided?', !!obj.chart);

        const executedToolCount = countTraceToolExecutions(trace);
        if (planConfirmed && executedToolCount === 0) {
          pushPlanProgress('Plan recorded but no tools have been executed. Execute Step 1 with the required tool before finalizing.');
          continue STEP_LOOP;
        }
        if (planConfirmed) {
          const incompleteSteps = planStatus.filter((step) => !step.done);
          if (incompleteSteps.length) {
            incompletePlanWarnings += 1;
            if (incompletePlanWarnings >= MAX_INCOMPLETE_PLAN_WARNINGS) {
              log('Auto-finalizing after repeated incomplete plan warnings');
              const autoChart = buildFallbackChartFromTrace({
                trace,
                question,
                defaultRoom: room,
                selectionRooms
              });
              if (autoChart) {
                ensureChartData(autoChart, { question, room, selectionRooms, range: rr, trace, scopeLabels });
              }
              const fallbackAnswer = buildDefaultAnswer({
                question,
                chart: autoChart,
                trace,
                notes: [`Plan steps ${incompleteSteps.map((s) => s.id).join(', ')} were not executed; summarizing available telemetry instead.`],
                range: rr
              });
              let overviewAnswer = enforceOverviewDetails(fallbackAnswer, { range: rr, trace, planStatus });
              overviewAnswer = applyScopeHeader(overviewAnswer);
              return {
                message: assistantMessage(overviewAnswer),
                chart: autoChart,
                trace
              };
            }
            const nextStep = incompleteSteps[0];
            convo.push({
              role: 'user',
              content: `REMINDER: Plan steps ${incompleteSteps.map((s) => s.id).join(', ')} still need their tool calls. Execute {"action":"tool_call","planStep":"${nextStep.id}","tool":"${nextStep.tool}","args":{...}} before finalizing.`
            });
            continue STEP_LOOP;
          }
        }

        // If model returned embedded arrays or no dataRef, retrofit to dataRef
        if (obj.chart && obj.chart.series && Array.isArray(obj.chart.series)) {
          try {
            const tablesSets = availableFieldsByTable(room);
            const ql2 = (question || '').toLowerCase();
    const isVsQuery = /\bvs\b/.test(ql2) || /\bagainst\b/.test(ql2) || ql2.includes('scatter');

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
                  const normField = (value) => String(value || '').trim().toLowerCase();
                  const candidateTools = new Set(['hourly_timeseries', 'daily_avg', 'fetch_timeseries']);
                  const match = (() => {
                    for (let i = trace.length - 1; i >= 0; i--) {
                      const entry = trace[i];
                      if (!entry || !candidateTools.has(entry.tool)) continue;
                      const args = entry.args || {};
                      const entryField = args.field || (Array.isArray(args.fields) ? args.fields[0] : null);
                      if (field && entryField && normField(entryField) !== normField(field)) continue;
                      return entry;
                    }
                    return null;
                  })();
                  if (match) {
                    const refObj = {
                      tool: match.tool,
                      room: match.args?.room,
                      table: match.args?.table || match.args?.table1 || match.args?.table2
                    };
                    if (match.tool === 'hourly_timeseries' || match.tool === 'daily_avg') {
                      refObj.field = match.args?.field || field;
                      refObj.xField = 'ts';
                      refObj.yField = 'avg';
                    } else if (match.tool === 'fetch_timeseries') {
                      refObj.fields = match.args?.fields || (field ? [field] : undefined);
                      refObj.xField = 'ts';
                      refObj.yField = field;
                    }
                    if (!refObj.yField) refObj.yField = 'value';
                    s.dataRef = refObj;
                    scrubDataArrays(s);
                  } else if (field) {
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

        ensureChartData(obj.chart, { question, room, selectionRooms, range: rr, trace, scopeLabels });

        // Now resolve chart as usual
        const chartRequested = !!(obj.chart && Array.isArray(obj.chart.series) && obj.chart.series.length);
        let chartForAnswer = chartRequested ? cloneChart(obj.chart) : null;
        let validChart = chartRequested ? validateChart(cloneChart(obj.chart), trace) : null;
        if (obj.chart && !validChart) {
          log('Chart validation failed - attempting fallback synthesis');
        }

        // Optionally execute background tools and return as extras
        let extras = [];
        try {
          if (Array.isArray(obj.background_tools)) {
            for (const bt of obj.background_tools) {
              const tool = bt && bt.tool;
              const args = { ...((bt && bt.args) || {}) };
              if (!tool || !tools[tool]) continue;
              if (args.room == null && room) args.room = room;
              if (args.start == null && rr.start != null) args.start = rr.start;
              if (args.end == null && rr.end != null) args.end = rr.end;
              let result = null;
              try { result = tools[tool](args); } catch (e) { result = { error: String(e) }; }
              trace.push({ tool, args, result });
              // Build a friendly extra message
              let extraMsg = `Fetched with ${tool}.`;
              if (Array.isArray(result)) extraMsg = `${tool}: ${result.length} rows.`;
              else if (result && typeof result === 'object' && typeof result.count === 'number') extraMsg = `${tool}: count=${result.count}.`;
              extras.push({ message: assistantMessage(extraMsg), chart: null });
            }
          }
        } catch (e) { log('background_tools execution failed:', String(e)); }

        // Inject routing info and evaluation into extras
        if (questionRequiresScatter(question)) {
          const chartType = chartForAnswer?.chart?.type || null;
          const scatterSeries = Array.isArray(chartForAnswer?.series) ? chartForAnswer.series : [];
          const isScatter = (chartType === 'scatter') || scatterSeries.some((s) => s && s.type === 'scatter');
          const hasDataRef = scatterSeries.length > 0 && scatterSeries.every((s) => s && s.dataRef && s.dataRef.tool);
          let scatterHasData = hasDataRef;
          if (scatterHasData) {
            const traceLookup = Array.isArray(trace) ? trace.slice().reverse() : [];
            scatterHasData = scatterSeries.every((series) => {
              const ref = series.dataRef || {};
              const toolName = ref.tool;
              if (!toolName) return false;
              const entry = traceLookup.find((t) => t.tool === toolName);
              if (!entry || !entry.result) return false;
              const result = entry.result;
              if (Array.isArray(result)) return result.length > 0;
              if (ref.field && Array.isArray(result[ref.field])) return result[ref.field].length > 0;
              if (toolName === 'pair_timeseries') {
                const pairs = Array.isArray(result) ? result : Array.isArray(result.pairs) ? result.pairs : [];
                return pairs.length > 0;
              }
              if (toolName === 'building_temp_weather_corr' || toolName === 'building_temp_weather_scatter') {
                const scatter = Array.isArray(result.scatter) ? result.scatter : Array.isArray(result.scatter_series) ? result.scatter_series : [];
                return scatter.length > 0;
              }
              return false;
            });
          }
          if ((!validChart || !chartForAnswer || !isScatter || !hasDataRef || !scatterHasData) && scatterRetryCount < 2) {
            scatterRetryCount++;
            convo.push({
              role: 'user',
              content: 'REMINDER: You must return a scatter chart with a valid dataRef referencing the tool results before finalizing. Call pair_timeseries or building_temp_weather_corr/building_temp_weather_scatter to generate data for the scatter and include it in your final chart.'
            });
            continue STEP_LOOP;
          }
        }
        if (needsRoomComparison && !comparisonSatisfied) {
          convo.push({
            role: 'user',
            content: `REMINDER: You still need to compare ${comparisonRoomsList || 'the selected rooms'} using compare_rooms_on_metric or compare_series_cross_room before finalizing. Call the comparison tool and summarize the differences.`
          });
          continue STEP_LOOP;
        }
        if (requireRoomRanking && !rankingSatisfied) {
          convo.push({
            role: 'user',
            content: `REMINDER: You still need to rank ${rankingRoomsList || 'the selected rooms'} by their occupancy metrics. Call compare_rooms_on_metric (preferred) or compare_series_cross_room on people_count/occupancy to produce the ranking and identify underused rooms before finalizing.`
          });
          continue STEP_LOOP;
        }

        let chartForResponse = validChart ? validChart : null;
        const baseChartRequested = questionRequiresChart(question);
        const needsChart = baseChartRequested || needsRoomComparison || requireRoomRanking;
        if (needsChart && !chartHasRenderableSeries(chartForResponse)) {
          const allowNoChart = adaptationNotes.some(note => /no (chart|data)/i.test(String(note)));
          if (!allowNoChart && chartRetryCount < 2) {
            chartRetryCount++;
            convo.push({
              role: 'user',
              content: 'REMINDER: You must include a chart with valid dataRef references before finalizing. Call the appropriate tool (e.g., fetch_timeseries, compare_series_cross_room, scope_heatmap) and structure the chart with dataRef pointing to that tool result.'
            });
            continue STEP_LOOP;
          }
        }
        const chartHasSeries = chartHasRenderableSeries(chartForResponse);
        const histogramHasData = traceHasHistogramData(trace);
        if (histogramRequested) {
          const type = (chartForResponse?.chart?.type || chartForResponse?.type || '').toLowerCase();
          const acceptableType = type === 'column' || type === 'bar' || type === 'histogram';
          const histogramSeriesValid = chartForResponse
            && Array.isArray(chartForResponse.series)
            && chartForResponse.series.length > 0
            && chartForResponse.series.every((series) => series?.dataRef && (series.dataRef.tool === 'histogram' || series.dataRef.tool === 'field_histogram'));
          if (histogramHasData) {
            if (!chartForResponse || !acceptableType || !histogramSeriesValid) {
              chartRetryCount++;
              convo.push({
                role: 'user',
                content: 'REMINDER: A histogram/distribution was requested. Call histogram or field_histogram for the requested metric(s) and provide a column-style chart that references those tool results via dataRef before finalizing.'
              });
              continue STEP_LOOP;
            }
          } else {
            adaptationNotes.push('Histogram requested but no usable bins were available in the selected window.');
          }
        }
        if (heatmapRequested) {
          const type = (chartForResponse?.chart?.type || chartForResponse?.type || '').toLowerCase();
          const acceptableType = type === 'heatmap';
          const heatmapTools = new Set(['scope_heatmap', 'correlation_matrix', 'hour_of_day_stats', 'weekday_weekend_comparison', 'busiest_day_of_week']);
          const hasHeatmapData = acceptableType
            && Array.isArray(chartForResponse?.series)
            && chartForResponse.series.every((series) => {
              const toolName = series?.dataRef?.tool;
              if (!toolName) return false;
              if (heatmapTools.has(toolName)) return true;
              if (series?.dataRef?.format === 'heatmap') return true;
              return false;
            });
          if (!acceptableType || !hasHeatmapData) {
            chartRetryCount++;
            convo.push({
              role: 'user',
              content: 'REMINDER: A heatmap was requested. Call scope_heatmap or correlation_matrix to build heatmap data, then return a heatmap chart referencing that tool via dataRef before finalizing.'
            });
            continue STEP_LOOP;
          }
        }
        if (!ensureFinalReferencesPlan(obj)) {
          continue STEP_LOOP;
        }

        const dataPresent = traceHasData(trace);
        if (!obj.chart && Array.isArray(obj.supportingData) && obj.supportingData.length) {
          const supportChart = chartFromSupportingData(obj.supportingData);
          if (supportChart) obj.chart = supportChart;
        }

        const baseAnswer = typeof obj.answer === 'string' ? obj.answer.trim() : '';
        const summaryAnswer = typeof obj.summary === 'string' ? obj.summary.trim() : '';
        const llmAnswer = baseAnswer || summaryAnswer;
        let finalAnswer = llmAnswer && !isPlaceholderAnswer(llmAnswer)
          ? llmAnswer
          : buildDefaultAnswer({
              question,
              chart: validChart,
              trace,
              fallbackText: llmAnswer || reply || '',
              notes: adaptationNotes,
              range
            });
        if (!llmAnswer && planStatus.length) {
          const summary = planStatus.map((step, idx) => {
            const label = step && step.text ? step.text : '';
            const marker = step?.done ? 'done' : 'pending';
            return `Step ${step?.id ?? step?.index ?? idx + 1} (${marker}): ${label}`;
          }).join(' | ');
          finalAnswer = `${finalAnswer}\nPlan executed: ${summary}`;
        }
        if (requireRoomRanking) {
          const type = (chartForResponse?.chart?.type || chartForResponse?.type || '').toLowerCase();
          const acceptableType = type === 'column' || type === 'bar';
          const rankingTools = new Set(['compare_rooms_on_metric', 'compare_series_cross_room', 'compare_metrics_in_room', 'scope_daily_percentile']);
          const rankingSeriesValid = chartForResponse
            && Array.isArray(chartForResponse.series)
            && chartForResponse.series.some((series) => {
              const toolName = series?.dataRef?.tool;
              return toolName && rankingTools.has(toolName);
            });
          if (!chartForResponse || !acceptableType || !rankingSeriesValid) {
            chartRetryCount++;
            convo.push({
              role: 'user',
              content: 'REMINDER: A room ranking was requested. Include a column or bar chart that references compare_rooms_on_metric (or another comparison tool) via dataRef so the busiest and underused rooms are visualized before finalizing.'
            });
            continue STEP_LOOP;
          }
        }
        if (!finalAnswer || normalizeText(finalAnswer) === normalizeText(question)) {
          const fallbackChartSummary = summarizeChart(validChart);
          const insight = traceInsight(trace);
          finalAnswer = fallbackChartSummary || insight || 'I analyzed the available data for the selected scope and time window.';
          if (Array.isArray(adaptationNotes) && adaptationNotes.length) {
            finalAnswer += ' ' + adaptationNotes.join(' ');
          }
        }
        if (!dataPresent) {
          finalAnswer = 'No telemetry data was available for the selected scope and time window; adjust the range or choose a different scope.';
          chartForResponse = null;
        }
        if ((!chartForResponse || !chartHasRenderableSeries(chartForResponse)) && needsChart) {
          const fallbackChart = buildFallbackChartFromTrace({
            trace,
            question,
            defaultRoom: room,
            selectionRooms
          });
          if (fallbackChart) {
            ensureChartData(fallbackChart, { question, room, selectionRooms, range: rr, trace, scopeLabels });
            chartForResponse = fallbackChart;
          }
        }
        if (chartForResponse) {
          const chartSummary = summarizeChart(chartForResponse);
          if (chartSummary && !normalizeText(finalAnswer).includes(normalizeText(chartSummary))) {
            finalAnswer += finalAnswer.endsWith('.') ? ' ' : '\n';
            finalAnswer += `Chart insight: ${chartSummary}`;
          }
        }
        finalAnswer = enforceOverviewDetails(finalAnswer, { range: rr, trace, planStatus });
        finalAnswer = applyScopeHeader(finalAnswer);

        try {
          const evalMetrics = evaluateQA({ question, answer: finalAnswer, retrievedDocs: ctx._retrievedDocs || [] });
          extras = extras || [];
          extras.unshift({ message: assistantMessage(`Query ${routing.level}; grounding ${(evalMetrics.grounding*100).toFixed(0)}%; uncertainty ${(evalMetrics.uncertainty*100).toFixed(0)}%`), chart: null });
        } catch {}

        return {
          message: assistantMessage(finalAnswer),
          chart: chartForResponse,
          extras,
          trace
        };
        
      } else if (obj.action === 'final_text') {
        log('Finalizing plain text answer.');
        const executedToolCount = countTraceToolExecutions(trace);
        if (planConfirmed && executedToolCount === 0) {
          pushPlanProgress('Plan recorded but no tools have been executed. Execute Step 1 before finalizing.');
          continue STEP_LOOP;
        }
        if (needsRoomComparison && !comparisonSatisfied) {
          convo.push({
            role: 'user',
            content: `REMINDER: You must compare ${comparisonRoomsList || 'the selected rooms'} using compare_rooms_on_metric or compare_series_cross_room before providing the final answer.`
          });
          continue STEP_LOOP;
        }
        if (requireRoomRanking && !rankingSatisfied) {
          convo.push({
            role: 'user',
            content: `REMINDER: You must rank ${rankingRoomsList || 'the selected rooms'} using compare_rooms_on_metric (or compare_series_cross_room) before providing the final answer. Report the busiest and underused rooms.`
          });
          continue STEP_LOOP;
        }
        if (histogramRequested || heatmapRequested || requireRoomRanking) {
          const histogramNeedsChart = histogramRequested && traceHasHistogramData(trace);
          if (histogramNeedsChart || heatmapRequested || requireRoomRanking) {
            convo.push({
              role: 'user',
              content: 'REMINDER: You must include the requested visualization (histogram/heatmap/ranking chart) before finalizing in plain text. Return {"action":"final","chart":{...}} with the correct chart type referencing the appropriate tool output.'
            });
            continue STEP_LOOP;
          }
        }
        if (histogramRequested && !traceHasHistogramData(trace)) {
          const note = 'Histogram requested but no usable bins were available in the selected window.';
          if (!adaptationNotes.includes(note)) adaptationNotes.push(note);
        }
        if (!ensureFinalReferencesPlan(obj)) {
          continue STEP_LOOP;
        }
        const llmAnswer = typeof obj.answer === 'string' ? obj.answer.trim() : '';
        let finalAnswer = llmAnswer && !isPlaceholderAnswer(llmAnswer)
          ? llmAnswer
          : buildDefaultAnswer({
              question,
              chart: null,
              trace,
              fallbackText: llmAnswer || reply || '',
              notes: adaptationNotes,
              range
            });
        if (!llmAnswer && planStatus.length) {
          const summary = planStatus.map((step, idx) => {
            const label = step && step.text ? step.text : '';
            const marker = step?.done ? 'done' : 'pending';
            return `Step ${step?.id ?? step?.index ?? idx + 1} (${marker}): ${label}`;
          }).join(' | ');
          finalAnswer = `${finalAnswer}\nPlan executed: ${summary}`;
        }
        if (!finalAnswer || normalizeText(finalAnswer) === normalizeText(question)) {
          const insight = traceInsight(trace);
          finalAnswer = insight || 'I analyzed the available data for the selected scope and time window.';
          if (Array.isArray(adaptationNotes) && adaptationNotes.length) {
            finalAnswer += ' ' + adaptationNotes.join(' ');
          }
        }
      if (!traceHasData(trace)) {
        finalAnswer = 'No telemetry data was available for the selected scope and time window; adjust the range or choose a different scope.';
      }
      finalAnswer = enforceOverviewDetails(finalAnswer, { range: rr, trace, planStatus });
      finalAnswer = applyScopeHeader(finalAnswer);
        let finalChart = null;
        const baseChartRequested = questionRequiresChart(question);
        const chartNeeded = baseChartRequested || needsRoomComparison || requireRoomRanking || histogramRequested || heatmapRequested;
        if (chartNeeded) {
          finalChart = buildFallbackChartFromTrace({
            trace,
            question,
            defaultRoom: room,
            selectionRooms
          });
          if (finalChart) {
            ensureChartData(finalChart, { question, room, selectionRooms, range: rr, trace, scopeLabels });
          }
        }
      return {
        message: assistantMessage(finalAnswer),
        chart: finalChart,
        trace
      };
      } else {
        // Unknown → continue
        log('Unknown action from LLM:', obj.action);
        convo.push({ 
          role: 'user', 
          content: 'ERROR: Invalid action. Use "tool_call", "tool_calls", or "final".' 
        });
      }
    }
    
    // If model emitted non-JSON but informative text, return it
    let autoChart = null;
    if (convo.length && typeof convo[convo.length - 1]?.content === 'string') {
      const last = convo[convo.length - 1].content;
      // NEVER return tool_results JSON as the final answer
      if (last.includes('"tool_results"') || last.includes('"tool_result"') || last.includes('"tool_hint"')) {
        log('Prevented tool results JSON from being returned as final answer');
        
        // If detectors/metrics per room were fetched, summarize them explicitly
        try {
          const recentDet = trace.filter(t => t && (t.tool === 'scope_list_detectors'));
          if (recentDet.length) {
            const lines = [];
            for (const t of recentDet) {
              const r = t.args && t.args.room;
              if (!r) continue;
              const dets = Array.isArray(t.result) ? t.result : [];
              const tables = loadRoomTables(r);
              const fieldSet = new Set();
              for (const rows of Object.values(tables)) { const first=(rows||[])[0]||{}; for (const k of Object.keys(first)) if (k!=='ts') fieldSet.add(k); }
              const label = deviceFriendlyName(r);
              lines.push(`- ${label}: detectors=[${dets.join(', ')||'—'}], metrics=[${Array.from(fieldSet).sort().join(', ')||'—'}]`);
            }
            if (lines.length) {
              return { message: assistantMessage(`Metrics by room in current scope:\n${lines.join('\n')}`), chart: null, trace };
            }
          }
        } catch (e) { log('detectors summary in tool_results fallback failed:', String(e)); }

        // Try to construct a useful answer from the trace otherwise
        const fallbackChart = buildFallbackChartFromTrace({
          trace,
          question,
          defaultRoom: room,
          selectionRooms
        });
        const answer = buildDefaultAnswer({
          question,
          chart: fallbackChart,
          trace,
          notes: adaptationNotes,
          range
        });
        let overviewAnswer = enforceOverviewDetails(answer, { range: rr, trace, planStatus });
        overviewAnswer = applyScopeHeader(overviewAnswer);
        return {
          message: assistantMessage(overviewAnswer),
          chart: fallbackChart,
          trace
        };
      }
      const trimmedLast = last.trim();
      const planPromptLeak = /Include\s+"plan_status"/i.test(trimmedLast);
      const isSystemReminder =
        /^REMINDER:/i.test(trimmedLast) ||
        /^MANDATORY:/i.test(trimmedLast) ||
        /^CRITICAL ERROR:/i.test(trimmedLast) ||
        /^ERROR:/i.test(trimmedLast) ||
        /^PLAN STATUS:/i.test(trimmedLast) ||
        planPromptLeak ||
        /^You must include the requested visualization/i.test(trimmedLast);
      if (!isSystemReminder &&
          last && last.length > 40 && !last.includes('respond with a JSON') && !last.includes('ERROR:')) {
        autoChart = buildFallbackChartFromTrace({
          trace,
          question,
          defaultRoom: room,
          selectionRooms
        });
        if (autoChart) {
          ensureChartData(autoChart, { question, room, selectionRooms, range: rr, trace, scopeLabels });
        }
        let safeAnswer = buildDefaultAnswer({
          question,
          chart: autoChart,
          trace,
          fallbackText: last,
          notes: adaptationNotes,
          range
        });
        if (!safeAnswer || normalizeText(safeAnswer) === normalizeText(question)) {
          const chartSummary = summarizeChart(autoChart);
          const insight = traceInsight(trace);
          safeAnswer = chartSummary || insight || 'I analyzed the available data for the selected scope and time window.';
          if (Array.isArray(adaptationNotes) && adaptationNotes.length) {
            safeAnswer += ' ' + adaptationNotes.join(' ');
          }
        }
        safeAnswer = enforceOverviewDetails(safeAnswer, { range: rr, trace, planStatus });
        safeAnswer = applyScopeHeader(safeAnswer);
        return { message: assistantMessage(safeAnswer), chart: autoChart, trace };
      }
    }
    
    // Fallback: construct answer from trace
    log('Constructing fallback answer from trace');
    if (!autoChart) {
      autoChart = buildFallbackChartFromTrace({
        trace,
        question,
        defaultRoom: room,
        selectionRooms
      });
    }
    if (autoChart) {
      ensureChartData(autoChart, { question, room, selectionRooms, range: rr, trace, scopeLabels });
    }
    const traceSummary = traceInsight(trace);
    const fallbackAnswer = buildDefaultAnswer({
      question,
      chart: autoChart,
      trace,
      fallbackText: traceSummary,
      knowledgeSnippets,
      includeKnowledge: !traceSummary,
      notes: adaptationNotes,
      range
    });

    let finalFallback = fallbackAnswer;
    if (!finalFallback || normalizeText(finalFallback) === normalizeText(question)) {
      const chartSummary = summarizeChart(autoChart);
      const insight = traceSummary || traceInsight(trace);
      finalFallback = chartSummary || insight || 'I analyzed the available data for the selected scope and time window.';
      if (Array.isArray(adaptationNotes) && adaptationNotes.length) {
        finalFallback += ' ' + adaptationNotes.join(' ');
      }
      if (knowledgeSnippets && knowledgeSnippets.trim()) {
        const hint = shortenKnowledgeSnippet(knowledgeSnippets);
        if (hint) {
          finalFallback += `\nHint: ${hint}`;
        }
      }
    }

    finalFallback = enforceOverviewDetails(finalFallback, { range: rr, trace, planStatus });
    finalFallback = applyScopeHeader(finalFallback);

    return { 
      message: assistantMessage(finalFallback), 
      chart: null, 
      trace 
    };
    } finally {
      setScopeContext();
    }
  }

  return { run };
}
    const autoAssignPlanStep = (toolName) => {
      if (!planConfirmed || !planStatus.length) return null;
      const normalizedTool = toolName ? resolveToolName(toolName) : null;
      const open = planStatus.filter((step) => !step.done);
      if (!open.length) return planStatus[planStatus.length - 1] || planStatus[0] || null;
      if (normalizedTool) {
        const match = open.find((step) => resolveToolName(step.tool) === normalizedTool);
        if (match) return match;
      }
      return open[0];
    };
