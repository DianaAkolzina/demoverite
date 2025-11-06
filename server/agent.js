import { buildDocsFromData, buildRagIndex } from './rag.js';
import { classifyQuery, suggestRetrievalFilters } from './router.js';
import { hybridRetrieve } from './retrieval.js';
import { evaluateQA } from './eval.js';
import fs from 'fs';
import path from 'path';

export function createAgent({ dataDir, listRooms, loadRoomTables: loadRoomTablesRaw, loadWeather, callGeminiChat, graph = null, vector = null }) {
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

  const normalizeId = (val) => String(val ?? '').trim();
  const normalizeName = (val) => String(val ?? '').trim().toLowerCase();
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

  const graphHierarchy = loadGraphFormHierarchy();
  const snapshotIndex = buildSnapshotIndex();
  let currentScopeContext = {
    selectionRooms: [],
    selectionZones: [],
    scopeDeviceZones: {},
    scopeLabels: {}
  };

  function setScopeContext(ctx = {}) {
    currentScopeContext = {
      selectionRooms: Array.isArray(ctx.selectionRooms) ? [...ctx.selectionRooms] : [],
      selectionZones: Array.isArray(ctx.selectionZones) ? [...ctx.selectionZones] : [],
      scopeDeviceZones: ctx.scopeDeviceZones && typeof ctx.scopeDeviceZones === 'object' ? { ...ctx.scopeDeviceZones } : {},
      scopeLabels: ctx.scopeLabels && typeof ctx.scopeLabels === 'object' ? { ...ctx.scopeLabels } : {}
    };
  }

  function loadFriendlyToCloudMap() {
    const map = new Map();
    const knownDeviceIds = new Set();
    const csvDir = path.join(repoRoot, 'CSVex_s3');

    try {
      const csvPath = path.join(repoRoot, 'data', 'graph_form', 'devices.csv');
      if (fs.existsSync(csvPath)) {
        const text = fs.readFileSync(csvPath, 'utf8');
        const lines = text.split(/\r?\n/).filter((line) => line.trim().length);
        if (lines.length) {
          const headers = lines[0].split(',').map((h) => h.trim());
          for (let i = 1; i < lines.length; i++) {
            const parts = lines[i].split(',');
            const row = {};
            headers.forEach((h, idx) => {
              row[h] = (parts[idx] || '').trim();
            });

            const cloudId = row.cloud_id || row.cloudId || row.cloudID || '';
            if (!cloudId) continue;

            const addAlias = (alias) => {
              if (!alias) return;
              const trimmed = String(alias).trim();
              if (!trimmed) return;
              if (!map.has(trimmed)) map.set(trimmed, cloudId);
            };

            addAlias(row.name);
            addAlias(row.label);
            addAlias(row.id);
            addAlias(row.deviceId);
            addAlias(row.device_id);
            addAlias(row.deviceProfileID);
            addAlias(row.deviceProfileId);
            addAlias(row.numericId);
            addAlias(row.numeric_id);
            addAlias(row.cloud_id);

            [cloudId, row.deviceId, row.device_id, row.numericId, row.numeric_id].forEach((id) => {
              const key = String(id || '').trim();
              if (key) knownDeviceIds.add(key);
            });
          }
        }
      }
    } catch (err) {
      if (DEBUG) log('failed to build friendly→cloud map:', String(err));
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
            if (!knownDeviceIds.has(primary) && !fs.existsSync(path.join(csvDir, `${primary}.csv`))) continue;

            const aliasVariants = new Set([String(alias).trim(), String(alias).toLowerCase().trim()]);
            for (const variant of aliasVariants) {
              if (!variant) continue;
              if (!map.has(variant)) map.set(variant, primary);
            }
            for (const extra of list) {
              if (!extra) continue;
              const key = String(extra).trim();
              if (!key) continue;
              if (!knownDeviceIds.has(key) && !fs.existsSync(path.join(csvDir, `${key}.csv`))) continue;
              if (!map.has(key)) map.set(key, primary);
              const lowerKey = key.toLowerCase();
              if (!map.has(lowerKey)) map.set(lowerKey, primary);
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
            if (!knownDeviceIds.has(deviceId) && !fs.existsSync(path.join(csvDir, `${deviceId}.csv`))) continue;
            const aliases = new Set([zoneLabel, deviceId]);
            if (currentFloor) aliases.add(`${zoneLabel} (${currentFloor})`);
            if (buildingName) aliases.add(`${zoneLabel} (${buildingName})`);
            if (currentFloor && buildingName) aliases.add(`${zoneLabel} (${currentFloor}, ${buildingName})`);
            for (const alias of aliases) {
              const key = String(alias || '').trim();
              if (!key) continue;
              if (!map.has(key)) map.set(key, deviceId);
              const lowerKey = key.toLowerCase();
              if (!map.has(lowerKey)) map.set(lowerKey, deviceId);
              const slugKey = lowerKey.replace(/[^a-z0-9]/g, '');
              if (!map.has(slugKey)) map.set(slugKey, deviceId);
            }
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
  const { stats: CSV_DEVICE_STATS, metrics: CSV_DEVICE_METRICS } = buildCsvMetadata();
  const CSV_STATS_CACHE = CSV_DEVICE_STATS;
  const friendlyLookup = (label) => {
    if (!label) return null;
    const raw = String(label).trim();
    if (!raw) return null;
    const lower = raw.toLowerCase();
    const slug = lower.replace(/[^a-z0-9]/g, '');
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

  function loadWeatherScoped(room = null) {
    const buildingName = inferBuildingFromContext(room);
    return loadWeather(buildingName);
  }

  function loadWeatherFor(room = null, building = null) {
    if (building && String(building).trim()) {
      return loadWeather(String(building).trim());
    }
    return loadWeatherScoped(room);
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
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return 'n/a';
    return d.toLocaleString();
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
          return `Average value ${stats.avg.toFixed(2)} with range ${min}–${max} across ${stats.count || 0} samples.`;
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
      }
    }
    return '';
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
    if (q.includes('plot') || q.includes('chart') || q.includes('graph') || q.includes('visualize') || q.includes('heatmap') || q.includes('scatter')) return true;
    if (/(line|bar|column|area)\s+chart/.test(q)) return true;
    if (/show\s+(me\s+)?(the\s+)?(trend|timeseries|time series)/.test(q)) return true;
    return false;
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

    const sortByName = (arr) => arr.sort((a, b) => String(a).localeCompare(String(b)));

    const buildingNames = sortByName(Array.from(grouped.keys()));
    const lines = [];
    lines.push('Scope and time window:');
    if (tenantLabel) lines.push(`Tenant: ${tenantLabel}`);
    if (buildingLabel && !buildingNames.includes(buildingLabel)) lines.push(`Building (selected): ${buildingLabel}`);
    if (floorLabel) lines.push(`Floor (selected): ${floorLabel}`);
    if (zoneLabel) lines.push(`Zone (selected): ${zoneLabel}`);

    for (const buildingName of buildingNames) {
      lines.push(`- ${buildingName}`);
      const floorMap = grouped.get(buildingName);
      const floorNames = sortByName(Array.from(floorMap.keys()));
      for (const floorName of floorNames) {
        lines.push(`  - ${floorName}`);
        const zoneMap = floorMap.get(floorName);
        const zoneNames = sortByName(Array.from(zoneMap.keys()));
        for (const zoneName of zoneNames) {
          lines.push(`    - ${zoneName}`);
          const devices = zoneMap.get(zoneName).slice(0, 8);
          for (const device of devices) {
            const typeSuffix = device.type ? ` [${device.type}]` : '';
            const metricsText = device.metrics.length ? ` metrics: ${device.metrics.slice(0, 8).join(', ')}` : '';
            lines.push(`      - ${device.name}${typeSuffix} (${device.shortId})${metricsText}`);
          }
          if (zoneMap.get(zoneName).length > devices.length) {
            lines.push(`      - … ${zoneMap.get(zoneName).length - devices.length} more devices`);
          }
        }
      }
    }

    if (!deviceMap.size) {
      lines.push('- No devices resolved for the current scope (CSV data missing or mapping incomplete).');
    }

    lines.push('');
    lines.push('Time window:');
    if (rr.start != null && rr.end != null) {
      lines.push(`- Local: ${formatLocal(rr.start)} → ${formatLocal(rr.end)}`);
      lines.push(`- UTC: ${formatUtc(rr.start)} → ${formatUtc(rr.end)}`);
    } else if (rr.start != null) {
      lines.push(`- Local start: ${formatLocal(rr.start)}`);
      lines.push(`- UTC start: ${formatUtc(rr.start)}`);
    } else if (rr.end != null) {
      lines.push(`- Local end: ${formatLocal(rr.end)}`);
      lines.push(`- UTC end: ${formatUtc(rr.end)}`);
    } else {
      lines.push('- Local: not set');
    }
    lines.push(`- Epoch (ms): start=${rr.start ?? 'none'}, end=${rr.end ?? 'none'}`);

    return lines.join('\n');
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
    try {
      const rootDir = path.join(path.dirname(dataDir));
      const baseDir = path.join(rootDir, 'data', 'graph_form');
      if (!fs.existsSync(baseDir)) return null;

      const readCsv = (file) => {
        const full = path.join(baseDir, file);
        if (!fs.existsSync(full)) return [];
        const text = fs.readFileSync(full, 'utf8');
        const lines = text.split(/\r?\n/).filter((line) => line.trim().length);
        if (!lines.length) return [];
        const headers = lines[0].split(',').map((h) => h.trim());
        const rows = [];
        for (let i = 1; i < lines.length; i++) {
          const rawLine = lines[i];
          if (!rawLine) continue;
          const parts = rawLine.split(',');
          const rec = {};
          headers.forEach((h, idx) => {
            const val = parts[idx] != null ? parts[idx].trim() : '';
            rec[h] = val;
          });
          rows.push(rec);
        }
        return rows;
      };

      const canon = (val) => normalizeName(val).replace(/[^a-z0-9]/g, '');

      const buildingRows = readCsv('buildings.csv');
      const floorRows = readCsv('floors.csv');
      const zoneRows = readCsv('zones.csv');
      const deviceRows = readCsv('devices.csv');

      const buildingById = new Map();
      const buildingIndexById = new Map();
      const buildingIndexByTenant = new Map();
      for (const b of buildingRows) {
        const id = normalizeId(b.id || b.ID || b.buildingID);
        if (!id) continue;
        const tenantId = normalizeId(b.tenantID);
        const entry = {
          id,
          name: b.name || `Building ${id}`,
          tenantId,
          raw: b
        };
        if (!buildingById.has(id)) buildingById.set(id, entry);
        if (!buildingIndexById.has(id)) buildingIndexById.set(id, []);
        buildingIndexById.get(id).push(entry);
        buildingIndexByTenant.set(`${tenantId}::${id}`, entry);
      }

      const findBuilding = (buildingId, tenantId) => {
        const id = normalizeId(buildingId);
        if (!id) return null;
        const tenantKey = `${normalizeId(tenantId)}::${id}`;
        if (buildingIndexByTenant.has(tenantKey)) return buildingIndexByTenant.get(tenantKey);
        const candidates = buildingIndexById.get(id) || [];
        return candidates[0] || null;
      };

      const floorById = new Map();
      const floorIndexById = new Map();
      const floorIndexByTenant = new Map();
      const floorNameIndex = new Map();
      for (const f of floorRows) {
        const id = normalizeId(f.id || f.ID || f.floorID);
        if (!id) continue;
        const buildingId = normalizeId(f.buildingID);
        const tenantId = normalizeId(f.tenantID);
        const building = findBuilding(buildingId, tenantId);
        const entry = {
          id,
          name: f.name || `Floor ${id}`,
          buildingId,
          buildingName: building?.name || null,
          tenantId,
          raw: f
        };
        if (!floorById.has(id)) floorById.set(id, entry);
        if (!floorIndexById.has(id)) floorIndexById.set(id, []);
        floorIndexById.get(id).push(entry);
        floorIndexByTenant.set(`${tenantId}::${id}`, entry);

        const keys = new Set();
        keys.add(`${buildingId}::${normalizeName(entry.name)}`);
        if (entry.buildingName) keys.add(`${normalizeName(entry.buildingName)}::${normalizeName(entry.name)}`);
        for (const key of keys) {
          if (!floorNameIndex.has(key)) floorNameIndex.set(key, []);
          floorNameIndex.get(key).push(entry);
        }
      }

      const findFloor = (floorId, tenantId, buildingId) => {
        const id = normalizeId(floorId);
        if (!id) return null;
        const tenantKey = `${normalizeId(tenantId)}::${id}`;
        if (floorIndexByTenant.has(tenantKey)) return floorIndexByTenant.get(tenantKey);
        const candidates = floorIndexById.get(id) || [];
        if (candidates.length === 1) return candidates[0];
        const byBuilding = candidates.filter((c) => normalizeId(c.buildingId) === normalizeId(buildingId));
        if (byBuilding.length) return byBuilding[0];
        return candidates[0] || null;
      };

      const zoneById = new Map();
      const zoneIndexById = new Map();
      const zoneNameIndex = new Map();
      for (const z of zoneRows) {
        const id = normalizeId(z.id || z.ID || z.zoneID);
        if (!id) continue;
        const floorId = normalizeId(z.floorID);
        const buildingId = normalizeId(z.buildingID);
        const tenantId = normalizeId(z.tenantID);
        const building = findBuilding(buildingId, tenantId);
        const floor = findFloor(floorId, tenantId, buildingId);
        const entry = {
          id,
          name: z.name || `Zone ${id}`,
          floorId,
          floorName: floor?.name || null,
          buildingId,
          buildingName: building?.name || null,
          tenantId,
          zoneKey: zoneCompositeKey(id, buildingId, floorId, tenantId),
          raw: z
        };
        if (!zoneById.has(id)) zoneById.set(id, entry);
        if (!zoneIndexById.has(id)) zoneIndexById.set(id, []);
        zoneIndexById.get(id).push(entry);

        const zoneName = normalizeName(entry.name);
        const keys = new Set();
        keys.add(`${buildingId}::${floorId}::${zoneName}`);
        keys.add(`${buildingId}::${zoneName}`);
        if (entry.buildingName && entry.floorName) keys.add(`${normalizeName(entry.buildingName)}::${normalizeName(entry.floorName)}::${zoneName}`);
        if (entry.buildingName) keys.add(`${normalizeName(entry.buildingName)}::${zoneName}`);
        keys.add(zoneName);
        for (const key of keys) {
          if (!zoneNameIndex.has(key)) zoneNameIndex.set(key, []);
          zoneNameIndex.get(key).push(entry);
        }
      }

      const deviceByKey = new Map();
      const zoneDevices = new Map();

      const addDeviceKey = (key, entry) => {
        if (!key) return;
        deviceByKey.set(canon(key), entry);
        deviceByKey.set(normalizeName(key), entry);
      };

      for (const d of deviceRows) {
        const cloudId = normalizeId(d.cloud_id || d.cloudId || d.cloudID);
        if (!cloudId) continue;
        const deviceId = normalizeId(d.deviceId || d.deviceID);
        const numericId = normalizeId(d.id || d.ID);
        const tenantId = normalizeId(d.tenantID);
        let zoneId = normalizeId(d.zoneID || d.zoneId);
        let floorId = normalizeId(d.floorID || d.floorId);
        let buildingId = normalizeId(d.buildingID || d.buildingId);

        const zoneCandidates = zoneId ? (zoneIndexById.get(zoneId) || []) : [];
        const zoneMatch = zoneCandidates.find((z) => (!tenantId || z.tenantId === tenantId) && (!buildingId || z.buildingId === buildingId)) || zoneCandidates[0] || null;

        if (!floorId && zoneMatch) floorId = zoneMatch.floorId || floorId;
        if (!buildingId && zoneMatch) buildingId = zoneMatch.buildingId || buildingId;

        const floor = findFloor(floorId, tenantId || zoneMatch?.tenantId, buildingId || zoneMatch?.buildingId);
        const building = findBuilding(buildingId, tenantId || zoneMatch?.tenantId);

        const entry = {
          primaryId: cloudId || deviceId || numericId,
          cloudId: cloudId || null,
          deviceId: deviceId || null,
          numericId: numericId || null,
          name: d.name || d.label || d.deviceName || d.cloud_id || cloudId || deviceId || numericId,
          type: d.type || d.deviceType || d.label || null,
          zoneId: zoneMatch?.id || zoneId || null,
          zoneName: zoneMatch?.name || null,
          floorId: floor?.id || zoneMatch?.floorId || floorId || null,
          floorName: floor?.name || zoneMatch?.floorName || null,
          buildingId: building?.id || zoneMatch?.buildingId || buildingId || null,
          buildingName: building?.name || zoneMatch?.buildingName || null,
          tenantId: tenantId || zoneMatch?.tenantId || floor?.tenantId || building?.tenantId || null,
          zoneKey: zoneMatch?.zoneKey || zoneCompositeKey(zoneId, buildingId, floorId, tenantId),
          raw: d
        };

        addDeviceKey(entry.primaryId, entry);
        addDeviceKey(entry.cloudId, entry);
        addDeviceKey(entry.deviceId, entry);
        addDeviceKey(entry.numericId, entry);

        const fullKey = entry.zoneKey;
        if (fullKey) {
          if (!zoneDevices.has(fullKey)) zoneDevices.set(fullKey, []);
          zoneDevices.get(fullKey).push(entry);
        }
        if (entry.zoneId) {
          if (!zoneDevices.has(entry.zoneId)) zoneDevices.set(entry.zoneId, []);
          zoneDevices.get(entry.zoneId).push(entry);
        }
      }

      return {
        buildingById,
        floorById,
        zoneById,
        zoneNameIndex,
        floorNameIndex,
        deviceByKey,
        zoneDevices,
        zoneIndexById
      };
    } catch (err) {
      if (DEBUG) log('graph_form hierarchy load failed:', String(err));
      return null;
    }
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
    if (/people|occup|count/.test(key) || /occupancy|headcount|people/.test(q)) return 'column';
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
  function inferRoomFromText(text) {
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
    if (t[name]) return name;
    const keys = Object.keys(t);
    if (!keys.length) return name;
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
    const parts = name.split('_');
    const core = norm(parts[parts.length-1] || name);
    const k2 = keys.find(k => norm(k) === core) || keys.find(k => norm(k).endsWith(core)) || keys.find(k => norm(k).includes(core));
    if (k2) return k2;
    return keys.length === 1 ? keys[0] : name;
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
    // Direct match across any table
    for (const set of Object.values(availableSets)) {
      for (const f of set) if (norm(f) === target) return f;
    }
    // Synonyms
    for (const [canon, syns] of Object.entries(FIELD_SYNONYMS)) {
      const cn = norm(canon);
      if (target === cn || syns.some(s => norm(s) === target)) {
        for (const set of Object.values(availableSets)) {
          for (const f of set) if (norm(f) === cn) return f;
          for (const s of syns) {
            for (const f of set) if (norm(f) === norm(s)) return f;
          }
        }
      }
    }
    // Fuzzy contains
    for (const set of Object.values(availableSets)) {
      for (const f of set) if (norm(f).includes(target) || target.includes(norm(f))) return f;
    }
    return null;
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
    // 1) explicit "x vs y"
    if (q.includes(' vs ')) {
      const parts = question.split(/\s+vs\s+/i).map(s => s.trim());
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

  // Lightweight intent classifier tolerant to varied phrasing
  function classifyIntent(question) {
    const q = String(question || '').toLowerCase();
    const has = (...words) => words.some(w => q.includes(w));
    const typeRegex = /(boardroom|meeting|lab|laboratory|toilet|restroom|bathroom|wc|cafe|cafeteria|kitchen)/i;
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
      plotAcrossRooms: (has('plot','chart','visualize') && (has('across all rooms','on this floor','on this building'))) || has('compare across rooms','timeseries across rooms'),
      rankRooms: (has('highest','top','most') && (has('avg','average','mean','peak') || true) && (has('on this floor') || has('on this building'))),
      plotSingle: has('plot','chart','visualize') && !has('across all rooms','on this floor','on this building'),
      correlation: has('correlation','correlate','matrix')
      ,
      compareTypes: (q.includes('compare') && /\b(and|vs|versus)\b/i.test(q) && typeRegex.test(q))
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
    ]);
    return map.get(t) || name;
  }

  function wantsChart(question) {
    const q = String(question || '').toLowerCase();
    return (
      q.includes('plot') || q.includes('chart') || q.includes('visual') || q.includes('trend') ||
      q.includes('over time') || q.includes('history') || q.includes('vs') || q.includes('correlation')
    );
  }
  
  const FIELD_SYNONYMS = {
    temperature: ['temp', 'temperaturec', 'temp_c', 'airtemp', 'ambienttemp'],
    people_count: ['people', 'count', 'occupants', 'occupancy', 'personcount'],
    virusrisk: ['virus_risk', 'virusrisk', 'risk'],
    total_kwh: ['totalkwh', 'kwh_total', 'energy_total', 'total_energy'],
    humidity: ['hum', 'rh', 'relativehumidity', 'humid'],
    co2: ['co2ppm', 'carbondioxide', 'co2_level'],
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
    
    stats({ room, table, field, start = null, end = null }) {
      const t = loadRoomTables(room);
      const tab = resolveTable(room, table);
      const arr = t[tab] || [];
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

    aggregate_stats_across_rooms({ table, field, agg = 'sum', start = null, end = null }) {
      let values = [];
      for (const r of listRooms()) {
        const t = loadRoomTables(r);
        const tab = resolveTable(r, table);
        const arr = (t[tab] || []).filter(row => withinRange(row.ts, start, end));
        for (const row of arr) {
          const v = Number(row[field]);
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
      const targetRooms = Array.isArray(rooms) && rooms.length ? rooms : listRooms();
      const out = [];
      for (const r of targetRooms) {
        const t = loadRoomTables(r);
        const tab = resolveTable(r, table);
        const arr = (t[tab] || []).filter(row => withinRange(row.ts, start, end));
        const vals = arr.map(row => Number(row[field])).filter(Number.isFinite);
        if (!vals.length) { out.push({ room: r, value: null }); continue; }
        const sum = vals.reduce((a,b)=>a+b,0);
        const avg = sum / vals.length;
        const peak = Math.max(...vals);
        const map = { sum, avg, peak };
        out.push({ room: r, value: map[agg] != null ? map[agg] : avg });
      }
      out.sort((a,b)=> (b.value ?? -Infinity) - (a.value ?? -Infinity));
      return out;
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
      // Prefer graph snapshot or adapter; otherwise infer from room IDs locally
      try {
        const snap = loadGraphSnapshot();
        if (snap && Array.isArray(snap.nodes) && Array.isArray(snap.links)) {
          const buildingName = building && /Building\s+/i.test(building) ? building : (building ? `Building ${building}` : null);
          const floors = new Map();
          const nodesById = new Map(snap.nodes.map(n => [n.id, n]));
          const hasRel = (from, to, rel) => snap.links.some(l => l.source===from && l.target===to && (!rel || l.rel===rel));
          const rooms = [];
          // Iterate zones and backtrack to floor/building
          for (const n of snap.nodes) {
            if ((n.nodeType||n.label) !== 'Zone') continue;
            const zid = n.id;
            // find floor
            const floorLink = snap.links.find(l => l.source===zid && l.rel==='BELONGS_TO_FLOOR');
            const fid = floorLink ? floorLink.target : null;
            const fNode = fid ? nodesById.get(fid) : null;
            // find building
            let bNode = null;
            if (fid) {
              const bLink = snap.links.find(l => l.source===fid && l.rel==='LOCATED_IN_BUILDING');
              const bid = bLink ? bLink.target : null;
              bNode = bid ? nodesById.get(bid) : null;
            }
            const bOk = buildingName ? (bNode && bNode.name === buildingName) : true;
            const fOk = floor ? (fNode && (fNode.name === floor || fNode.name.endsWith(` ${String(floor).replace(/^F/, '')}`))) : true;
            if (bOk && fOk) {
              if (n.roomId) rooms.push(n.roomId);
            }
          }
          return { rooms: Array.from(new Set(rooms)) };
        }
      } catch {}
      const rooms = listRooms();
      function normBuilding(b) { if (!b) return null; const m = String(b).match(/([A-Za-z])$/); return m ? m[1].toUpperCase() : String(b).toUpperCase(); }
      function normFloor(f) { if (!f) return null; const m = String(f).match(/(\d+)/); return m ? `F${m[1]}` : String(f); }
      const b = normBuilding(building);
      const f = normFloor(floor);
      const out = rooms.filter(r => {
        const m = String(r).match(/^([A-Za-z])_(F\d+)_.+$/);
        if (!m) return false;
        const rb = m[1].toUpperCase();
        const rf = m[2];
        if (b && rb !== b) return false;
        if (f && rf !== f) return false;
        return true;
      });
      return { rooms: out };
    },

    scope_list_buildings() {
      const snap = loadGraphSnapshot();
      if (snap && Array.isArray(snap.nodes)) {
        const bs = snap.nodes.filter(n => (n.nodeType||n.label)==='Building').map(n => n.name).filter(Boolean);
        return Array.from(new Set(bs)).sort();
      }
      const rooms = listRooms();
      const set = new Set();
      for (const r of rooms) { const m = String(r).match(/^([A-Za-z])_/); if (m) set.add(`Building ${m[1].toUpperCase()}`); }
      return Array.from(set).sort();
    },

    scope_list_floors({ building }) {
      const snap = loadGraphSnapshot();
      if (snap && Array.isArray(snap.nodes) && Array.isArray(snap.links)) {
        const targetB = building && /Building\s+/i.test(building) ? building : (building ? `Building ${building}` : null);
        const floorNames = new Set();
        for (const n of snap.nodes) {
          if ((n.nodeType||n.label) !== 'Floor') continue;
          const fid = n.id;
          const bLink = snap.links.find(l => l.source===fid && l.rel==='LOCATED_IN_BUILDING');
          const bid = bLink ? bLink.target : null;
          const bNode = bid ? snap.nodes.find(nn => nn.id===bid) : null;
          if (targetB && (!bNode || bNode.name !== targetB)) continue;
          floorNames.add(n.name);
        }
        return Array.from(floorNames).sort((a,b)=> Number(a.replace(/\D+/g,'')) - Number(b.replace(/\D+/g,'')));
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
      const snap = loadGraphSnapshot();
      if (!snap || !Array.isArray(snap.nodes) || !Array.isArray(snap.links)) return { devices: [] };
      const nodesById = new Map(snap.nodes.map(n => [n.id, n]));
      // Find zone node by roomId
      const z = snap.nodes.find(n => (n.nodeType||n.label)==='Zone' && n.roomId === room);
      if (!z) return { devices: [] };
      const devs = [];
      for (const l of snap.links) {
        if (l.target === z.id && l.rel === 'LOCATED_IN_ZONE') {
          const d = nodesById.get(l.source);
          if (d && (d.nodeType||d.label)==='Device') devs.push({ id: d.id, name: d.name, type: d.deviceType || d.type || 'Device' });
        }
      }
      // Attach metric types measured
      const withMetrics = devs.map(d => {
        const mids = snap.links.filter(l => l.target===d.id && l.rel==='MEASURES').map(l => l.source);
        const metrics = mids.map(mid => (nodesById.get(mid)?.name)).filter(Boolean);
        return { ...d, metrics };
      });
      return { devices: withMetrics };
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

  async function buildContextSnippet(question, room, range, selectionRooms = []) {
    const retrieved = await hybridRetrieve({ query: question, ragIndex: rag, vectorClient: vector, k: 6 }).catch(() => []);
    const head = (retrieved || []).map(h => 
      `Score:${(h.final ?? h.rrf ?? h.scoreRaw ?? 0).toFixed(3)} Meta:${JSON.stringify(h.meta)}\n${h.text}`
    ).join('\n---\n');
    
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
	    return { retrieved: head, schema, meta, range, room, selectionRooms, _retrievedDocs: retrieved };
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
	    attempt = 0
	  }) {
    const question = messages[messages.length - 1]?.content || '';
    setScopeContext({ selectionRooms, selectionZones, scopeDeviceZones, scopeLabels });

    try {

    // --- ROUTING & HYBRID RETRIEVAL ---
    const routing = classifyQuery(question);
    const filters = suggestRetrievalFilters(routing.level);
    const hybridHits = await hybridRetrieve({ query: question, ragIndex: rag, vectorClient: vector, k: routing?.pipeline?.retrieval?.k || 6 }).catch(()=>[]);

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
    const aggressiveCharts = attemptIndex > 0;

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

    const ctx = await buildContextSnippet(question, room && room !== 'ALL' ? room : null, range, selectionRooms);
    log('Question:', '<redacted>');
    if (DEBUG) log('Context snippet schema keys:', Object.keys(ctx.schema));

    const rr = range || {};
    const adaptationNotes = [];
    // Inject knowledge enrichment into system prompt
    const startDate = rr.start ? new Date(rr.start) : null;
    const endDate = rr.end ? new Date(rr.end) : null;
	    const startFmt = startDate ? `${startDate.toLocaleString()} (UTC: ${startDate.toISOString().replace('T', ' ').slice(0, 16)})` : 'none';
	    const endFmt = endDate ? `${endDate.toLocaleString()} (UTC: ${endDate.toISOString().replace('T', ' ').slice(0, 16)})` : 'none';
	
	    const zoneSummaries = summarizeZones(selectionRooms, selectionZones, scopeDeviceZones, { building, floor });
	    const zonesLine = zoneSummaries.length ? zoneSummaries.join('; ') : '(none)';
	    const devicesLine = Array.isArray(selectionRooms) && selectionRooms.length ? selectionRooms.join(', ') : '(none)';
	
	    const sys = `You are a senior data analyst agent for building operations.
Selected room: ${room || '(none)'}.
Zones in scope: ${zonesLine}
Devices in scope: ${devicesLine}
${room === 'ALL' && selectionRooms && selectionRooms.length ? `IMPORTANT: Cross-room analysis MUST be limited to ONLY these devices and their parent zones. Do NOT introduce other scopes.` : ''}
Selected time window: 
- Local: ${startFmt} to ${endFmt}
- Epoch ms: start=${rr.start ?? 'none'} end=${rr.end ?? 'none'}

MANDATORY: Always use this time window for all analysis and answers. Do NOT invent or assume any other period. If the user asks "what time period are you analysing", repeat this exact window.

FREEDOM TO ANALYZE: You are encouraged to analyze the data, derive insights, compare across rooms within scope, and synthesize conclusions. Use tools as needed; if tools are insufficient, explain and proceed with reasoned analysis using available data.

DOMAIN NOTE: "Zone" and "Room" are synonyms in this system. When the user mentions a zone, treat it exactly as a room, and vice versa. Use graph relationships (Building → Floor → Zone) to understand placement.

=== KNOWLEDGE PACK ENRICHMENT (REPHRASE ONLY) ===
${knowledgeSnippets || 'No extra knowledge found for this query.'}

RULE: Do NOT dump or quote long passages from knowledge. If you use it, REPHRASE concisely in your own words and keep it brief.

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
- Use dataRef in all chart series - NEVER embed data arrays
- The backend resolves dataRef automatically from tool results
- Embedding data causes truncation - always use references

Tools: ${buildToolSpec()}.
Notes: 
- In weather data, temperature field is 'temp'.
- Use 'hour_of_day_stats' for "best time" by CO2 or occupancy.
- Use 'busiest_day_of_week' for questions about "busiest day", "which weekday", "most crowded day", "highest occupancy day", etc.
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
    const intent = classifyIntent(question);
    const wantsScopeSummary =
      intent.selectionTime ||
      /what\s+scope\s+do\s+you\s+see/.test(qlLower) ||
      /what\s+selection\s+do\s+you\s+see/.test(qlLower) ||
      /selection\s+and\s+time/.test(qlLower) ||
      /current\s+(range|window)/.test(qlLower) ||
      /what\s+(time|period|window)\s+are\s+you\s+analys/.test(qlLower) ||
      /what\s+time\s+period/.test(qlLower);
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

    // EARLY PLOTTING: floor/building scope cross-room plots
    const ql = (question || '').toLowerCase();
    const floorAll = isAllRooms(room) && Array.isArray(selectionRooms) && selectionRooms.length;
    const multiScope = Array.isArray(selectionRooms) && selectionRooms.length >= 2;
    const wantsAcrossRooms = /across\s+all\s+rooms|on\s+this\s+floor|on\s+this\s+building/.test(ql);
    if ((floorAll || multiScope) && (intent.plotAcrossRooms || ((ql.includes('plot') || ql.includes('chart')) && wantsAcrossRooms))) {
      try {
        const tablesSets = availableFieldsByTable(selectionRooms[0]);
        const { field: f } = resolveMetricAndTableFromQuestion(question, tablesSets, (ql.includes('occupancy')||ql.includes('people')) ? 'people_count' : 'temperature');
        let fieldUsed = f;
        let compareArgs = { start: rr.start || undefined, end: rr.end || undefined, series: [] };
        for (const r of selectionRooms.slice(0, 8)) {
          const t = loadRoomTables(r);
          let tableMatch = null;
          for (const [tname, rows] of Object.entries(t)) { if (rows.length && Object.keys(rows[0] || {}).includes(f)) { tableMatch = tname; break; } }
          compareArgs.series.push({ room: r, table: tableMatch || 'iaq', field: f, name: `${r} ${f}` });
        }
        let result = tools.compare_series_cross_room(compareArgs);
        let hasData = Object.values(result || {}).some(arr => Array.isArray(arr) && arr.length);
        if (!hasData && aggressiveCharts) {
          const preferred = pickFieldsForRoom(selectionRooms[0], 5);
          const altField = findSharedField(selectionRooms.slice(0, 8), preferred, f);
          if (altField && altField !== f) {
            const retryArgs = { start: compareArgs.start, end: compareArgs.end, series: [] };
            for (const r of selectionRooms.slice(0, 8)) {
              const tables = loadRoomTables(r);
              let tableMatch = null;
              for (const [tname, rows] of Object.entries(tables)) { if (rows.length && Object.keys(rows[0] || {}).includes(altField)) { tableMatch = tname; break; } }
              retryArgs.series.push({ room: r, table: tableMatch || 'iaq', field: altField, name: `${r} ${altField}` });
            }
            const altResult = tools.compare_series_cross_room(retryArgs);
            const altHasData = Object.values(altResult || {}).some(arr => Array.isArray(arr) && arr.length);
            if (altHasData) {
              compareArgs = retryArgs;
              result = altResult;
              fieldUsed = altField;
              hasData = true;
            }
          }
        }
        if (!hasData) {
          const msg = `No ${humanizeMetricName(fieldUsed)} readings available for the selected rooms during ${describeRange(rr)}.`;
          return { message: assistantMessage(msg), chart: null, trace: [{ tool: 'compare_series_cross_room', args: compareArgs, result }] };
        }
        const seriesKeys = Object.keys(result || {}).slice(0, 8);
        const metricLabel = humanizeMetricName(fieldUsed);
        const chartType = /people|occupancy|count/i.test(fieldUsed) ? 'column' : 'line';
        const chart = seriesKeys.length ? {
          chart: { type: chartType },
          title: { text: `${metricLabel} across rooms` },
          xAxis: { type: 'datetime' },
          yAxis: { title: { text: metricLabel } },
          series: seriesKeys.map(k => ({ name: k, dataRef: { tool: 'compare_series_cross_room', field: k, xField: 'ts', yField: 'y' } }))
        } : null;
        const trace = [{ tool: 'compare_series_cross_room', args: compareArgs, result }];
        const valid = validateChart(cloneChart(chart), trace);
        if (valid) {
          const fallbackText = `Plotted ${humanizeMetricName(fieldUsed)} across ${seriesKeys.length} room(s) in scope.`;
          const answerText = buildDefaultAnswer({
            question,
            chart: valid,
            trace,
            fallbackText,
            notes: adaptationNotes,
            range: rr
          });
          return { message: assistantMessage(answerText), chart, trace };
        }
      } catch (e) { log('early plot across rooms failed:', String(e)); }
    }

    // EARLY COMPARE between two room types (e.g., "compare humidity in the cafe and boardroom")
    if ((floorAll || multiScope) && intent.compareTypes) {
      try {
        // Extract two room-type keywords
        const types = [];
        const tokens = ql.split(/[^a-z0-9_]+/).filter(Boolean);
        const typeWords = ['boardroom','meeting','lab','laboratory','toilet','restroom','bathroom','wc','cafe','cafeteria','kitchen'];
        for (const tk of tokens) {
          if (typeWords.includes(tk) && !types.includes(tk)) types.push(tk);
          if (types.length >= 2) break;
        }
        const norm = (t) => (t==='meeting'?'boardroom': t==='laboratory'?'lab': (t==='restroom'||t==='bathroom'||t==='wc')?'toilet': (t==='cafeteria'||t==='kitchen')?'cafe': t);
        const t1 = types[0] ? norm(types[0]) : null;
        const t2 = types[1] ? norm(types[1]) : null;
        const tablesSets = availableFieldsByTable(selectionRooms[0]);
        const { field: f } = resolveMetricAndTableFromQuestion(question, tablesSets, 'humidity');
        const r1 = t1 ? roomsByType(selectionRooms, t1)[0] : null;
        const r2 = t2 ? roomsByType(selectionRooms, t2)[0] : null;
        const compareArgs = { start: rr.start || undefined, end: rr.end || undefined, series: [] };
        if (r1) {
          let tableMatch = null; for (const [tname, rows] of Object.entries(loadRoomTables(r1))) { if (rows.length && Object.keys(rows[0]||{}).includes(f)) { tableMatch = tname; break; } }
          compareArgs.series.push({ room: r1, table: tableMatch || 'iaq', field: f, name: `${r1} ${f}` });
        }
        if (r2) {
          let tableMatch = null; for (const [tname, rows] of Object.entries(loadRoomTables(r2))) { if (rows.length && Object.keys(rows[0]||{}).includes(f)) { tableMatch = tname; break; } }
          compareArgs.series.push({ room: r2, table: tableMatch || 'iaq', field: f, name: `${r2} ${f}` });
        }
        if (compareArgs.series.length >= 2) {
          const result = tools.compare_series_cross_room(compareArgs);
          const entries = Object.values(result || {});
          const hasData = entries.some(arr => Array.isArray(arr) && arr.length);
          if (!hasData) {
            const msg = `No ${humanizeMetricName(f)} data available for the requested room types in ${describeRange(rr)}.`;
            return { message: assistantMessage(msg), chart: null, trace: [{ tool: 'compare_series_cross_room', args: compareArgs, result }] };
          }
          const keys = Object.keys(result || {}).slice(0, 8);
          const chart = keys.length ? {
            chart: { type: 'line' }, title: { text: `${f} comparison` }, xAxis: { type: 'datetime' }, yAxis: { title: { text: f } },
            series: keys.map(k => ({ name: k, dataRef: { tool: 'compare_series_cross_room', field: k, xField: 'ts', yField: 'y' } }))
          } : null;
          const trace = [{ tool: 'compare_series_cross_room', args: compareArgs, result }];
          const valid = validateChart(cloneChart(chart), trace);
          if (valid) {
            const fallbackText = `Compared ${humanizeMetricName(f)} between ${deviceFriendlyName(r1)} and ${deviceFriendlyName(r2)}.`;
            const answerText = buildDefaultAnswer({
              question,
              chart: valid,
              trace,
              fallbackText,
              notes: adaptationNotes,
              range: rr
            });
            const extras = [{ message: assistantMessage(`Query ${routing.level}`), chart: null }];
            return { message: assistantMessage(answerText), chart, trace, extras };
          }
        }
      } catch (e) { log('early compareTypes failed:', String(e)); }
    }

    // EARLY METRICS SUMMARY: "what metrics are in each room" at floor/building scope
    if ((floorAll || multiScope) && (intent.metricsEachRoom || /(what|which)\s+(metrics|detectors)[^?]*\b(each|every)\b[^?]*\brooms?/i.test(ql))) {
      try {
        const lines = [];
        for (const r of selectionRooms.slice(0, 20)) {
          const t = loadRoomTables(r);
          const detectors = [];
          if (t.iaq && t.iaq.length) detectors.push('IAQ_Sensor');
          if (t.energy && t.energy.length) detectors.push('Energy_Meter');
          if (t.people && t.people.length) detectors.push('People_Counter');
          if (t.water && t.water.length) detectors.push('Water_Meter');
          const fields = new Set();
          for (const rows of Object.values(t)) {
            const first = (rows||[])[0] || {};
            for (const k of Object.keys(first)) if (k !== 'ts') fields.add(k);
          }
          const label = deviceFriendlyName(r);
          lines.push(`- ${label}: detectors=[${detectors.join(', ')||'—'}], metrics=[${Array.from(fields).sort().join(', ')||'—'}]`);
        }
        const msg = `Metrics by room in current scope:\n${lines.join('\n')}`;
        const extras = [{ message: assistantMessage(`Query ${routing.level}`), chart: null }];
        return { message: assistantMessage(msg), chart: null, trace: [], extras };
      } catch (e) { log('early metrics summary failed:', String(e)); }
    }

    // EARLY: compare metric between exactly two rooms in scope (e.g., "compare temperature between the two rooms in the scope")
    if (multiScope && selectionRooms.length === 2 && /\bcompare\b/i.test(question)) {
      try {
        const rA = selectionRooms[0];
        const rB = selectionRooms[1];
        const tablesSetsA = availableFieldsByTable(rA);
        const { field: f } = resolveMetricAndTableFromQuestion(question, tablesSetsA, 'temperature');
        const compareArgs = { start: rr.start || undefined, end: rr.end || undefined, series: [] };
        // room A
        let tabA = null; for (const [tname, rows] of Object.entries(loadRoomTables(rA))) { if (rows.length && Object.keys(rows[0]||{}).includes(f)) { tabA = tname; break; } }
        compareArgs.series.push({ room: rA, table: tabA || 'iaq', field: f, name: `${rA} ${f}` });
        // room B
        let tabB = null; for (const [tname, rows] of Object.entries(loadRoomTables(rB))) { if (rows.length && Object.keys(rows[0]||{}).includes(f)) { tabB = tname; break; } }
        compareArgs.series.push({ room: rB, table: tabB || 'iaq', field: f, name: `${rB} ${f}` });
        let fieldUsed = f;
        let result = tools.compare_series_cross_room(compareArgs);
        let hasData = Object.values(result || {}).some(arr => Array.isArray(arr) && arr.length);
        if (!hasData && aggressiveCharts) {
          const preferred = pickFieldsForRoom(rA || rB, 5);
          const altField = findSharedField([rA, rB], preferred, f);
          if (altField && altField !== f) {
            const retryArgs = { start: compareArgs.start, end: compareArgs.end, series: [] };
            const roomsToCompare = [rA, rB].filter(Boolean);
            for (const roomId of roomsToCompare) {
              let altTable = null;
              for (const [tname, rows] of Object.entries(loadRoomTables(roomId))) {
                if (rows.length && Object.keys(rows[0] || {}).includes(altField)) { altTable = tname; break; }
              }
              retryArgs.series.push({ room: roomId, table: altTable || 'iaq', field: altField, name: `${roomId} ${altField}` });
            }
            const altResult = tools.compare_series_cross_room(retryArgs);
            const altHasData = Object.values(altResult || {}).some(arr => Array.isArray(arr) && arr.length);
            if (altHasData) {
              result = altResult;
              compareArgs = retryArgs;
              fieldUsed = altField;
              hasData = true;
            }
          }
        }
        if (!hasData) {
          const msg = `No ${humanizeMetricName(f)} readings available for ${deviceFriendlyName(rA)} or ${deviceFriendlyName(rB)} in ${describeRange(rr)}.`;
          return { message: assistantMessage(msg), chart: null, trace: [{ tool: 'compare_series_cross_room', args: compareArgs, result }] };
        }
        const keys = Object.keys(result || {});
        const metricLabel = humanizeMetricName(fieldUsed);
        const chartType = /people|occupancy|count/i.test(fieldUsed) ? 'column' : 'line';
        const chart = keys.length ? {
          chart: { type: chartType },
          title: { text: `${metricLabel} comparison` },
          xAxis: { type: 'datetime' },
          yAxis: { title: { text: metricLabel } },
          series: keys.map(k => ({ name: k, dataRef: { tool: 'compare_series_cross_room', field: k, xField: 'ts', yField: 'y' } }))
        } : null;
        const trace = [{ tool: 'compare_series_cross_room', args: compareArgs, result }];
        const valid = validateChart(cloneChart(chart), trace);
        if (valid) {
          const fallbackText = `Compared ${humanizeMetricName(fieldUsed)} between ${deviceFriendlyName(rA)} and ${deviceFriendlyName(rB)}.`;
          const answerText = buildDefaultAnswer({
            question,
            chart: valid,
            trace,
            fallbackText,
            notes: adaptationNotes,
            range: rr
          });
          return { message: assistantMessage(answerText), chart, trace };
        }
      } catch (e) { log('early compare two rooms failed:', String(e)); }
    }

    // Devices/Detectors for a specific room (broad phrasing)
    if (intent.devicesInRoom) {
      let r = inferRoomFromText(question) || (selectionRooms && selectionRooms.length===1 ? selectionRooms[0] : null);
      if (!r && floorAll) {
        // Try by room type keyword in question
        const types = ['boardroom','lab','toilet','cafe'];
        for (const tp of types) {
          if (ql.includes(tp) || (tp==='boardroom' && ql.includes('meeting'))) {
            const matches = roomsByType(selectionRooms, tp);
            if (matches.length) { r = matches[0]; break; }
          }
        }
      }
      if (r) {
        try {
          const dets = tools.scope_list_detectors({ room: r });
          const tables = loadRoomTables(r);
          const fieldSet = new Set();
          for (const rows of Object.values(tables)) { const first=(rows||[])[0]||{}; for (const k of Object.keys(first)) if (k!=='ts') fieldSet.add(k); }
          const label = deviceFriendlyName(r);
          const msg = `${label}: detectors=[${(Array.isArray(dets)?dets:[]).join(', ')||'—'}], metrics=[${Array.from(fieldSet).sort().join(', ')||'—'}]`;
          const extras = [{ message: assistantMessage(`Query ${routing.level}`), chart: null }];
          return { message: assistantMessage(msg), chart: null, trace: [], extras };
        } catch (e) { log('early devices summary failed:', String(e)); }
      }
    }

    // Plot metrics in the boardroom/lab/toilet/cafe with N random (or available) series
    if (floorAll && intent.plotSingle && /(boardroom|meeting|lab|laboratory|toilet|restroom|bathroom|wc|cafe|cafeteria|kitchen)/i.test(question)) {
      try {
        let roomForPlot = inferRoomFromText(question);
        if (!roomForPlot) {
          const types = ['boardroom','lab','toilet','cafe'];
          for (const tp of types) { if (ql.includes(tp) || (tp==='boardroom' && ql.includes('meeting'))) { const matches = roomsByType(selectionRooms, tp); if (matches.length) { roomForPlot = matches[0]; break; } } }
        }
        if (roomForPlot) {
          const nMatch = question.match(/(\d+)\s*(random|metrics|series)?/i);
          const n = nMatch ? Math.max(1, Math.min(5, parseInt(nMatch[1], 10))) : 3;
          const fields = pickFieldsForRoom(roomForPlot, n);
          const tablesSets = availableFieldsByTable(roomForPlot);
          const series = fields.map(f => {
            let table = null; for (const [t, set] of Object.entries(tablesSets)) if (set.has(f)) { table = t; break; }
            return { name: `${roomForPlot} ${f}`, dataRef: { tool: 'fetch_timeseries', room: roomForPlot, xField: 'ts', yField: f } };
          });
          const chart = { chart: { type: 'line' }, title: { text: `${roomForPlot} — ${fields.join(', ')}` }, xAxis: { type: 'datetime' }, yAxis: { title: { text: 'Value' } }, series };
          // Ensure tool results are present
          const trace = [];
          for (const f of fields) {
            // Decide table for this field
            let tab = null; for (const [t, set] of Object.entries(tablesSets)) if (set.has(f)) { tab = t; break; }
            const args = { room: roomForPlot, table: tab || 'iaq', fields: [f], start: rr.start || undefined, end: rr.end || undefined };
            const res = tools.fetch_timeseries(args);
            trace.push({ tool: 'fetch_timeseries', args, result: res });
          }
          const valid = validateChart(cloneChart(chart), trace);
          if (valid) {
            const fallbackText = `Plotted ${fields.length} metric(s) for ${deviceFriendlyName(roomForPlot)}.`;
            const answerText = buildDefaultAnswer({
              question,
              chart: valid,
              trace,
              fallbackText,
              notes: adaptationNotes,
              range: rr
            });
            return { message: assistantMessage(answerText), chart, trace };
          }
        }
      } catch (e) { log('plot room-type random metrics failed:', String(e)); }
    }

    // EARLY RANKING: highest average co2 (or similar) on this floor/building
    if (floorAll && /(highest|top|most)\s+(avg|average|mean)?\s*(co2|temperature|humidity|lux|pm25|pm10|value)/i.test(question)) {
      try {
        const m = question.match(/(co2|temperature|humidity|lux|pm25|pm10|value)/i);
        const field = (m && m[1]) ? m[1].toLowerCase() : 'co2';
        const tableGuess = field==='value' ? 'energy' : 'iaq';
        const ranking = tools.compare_rooms_on_metric({ rooms: selectionRooms, table: tableGuess, field, agg: 'avg', start: rr.start || undefined, end: rr.end || undefined });
        const top = ranking.filter(r => r.value!=null).slice(0, 5).map(r => `${r.room}: ${Number(r.value).toFixed(2)}`).join('\n');
        const chart = ranking.length ? {
          chart: { type: 'bar' },
          title: { text: `Average ${field} by room` },
          xAxis: { categories: ranking.map(r => r.room) },
          yAxis: { title: { text: field } },
          series: [{ name: `avg(${field})`, data: ranking.map(r => (r.value!=null ? Number(r.value) : null)) }]
        } : null;
        return { message: assistantMessage(`Top rooms by average ${field} in the selected window:\n${top || 'No data'}`), chart, trace: [] };
      } catch (e) { log('early ranking failed:', String(e)); }
    }

    // Auto-handle plotting intents by directly building charts without LLM
    {
      const qlc = String(question||'').toLowerCase();
      const isPlotIntent = /(plot|chart|graph|scatter|histogram|heatmap)\b/.test(qlc);
      if (isPlotIntent) {
        try {
          const deviceCandidate = inferDeviceFromQuestion(question);
          if (deviceCandidate) {
            const deviceId = normalizeRoomId(deviceCandidate) || deviceCandidate;
            const tables = loadRoomTables(deviceId);
            if (tables && Object.keys(tables).length) {
              const rr = range || {};
              const fieldsMapDevice = availableFieldsByTable(deviceId);
              const { field: resolvedField, table: resolvedTable } = resolveMetricAndTableFromQuestion(question, fieldsMapDevice, 'lux');
              const luxField = inferFieldName(resolvedField, fieldsMapDevice) || inferFieldName('lux', fieldsMapDevice) || inferFieldName('light', fieldsMapDevice) || resolvedField || 'lux';
              const tableGuess = resolvedTable || (() => {
                for (const [tableName, set] of Object.entries(fieldsMapDevice)) {
                  if (set.has(luxField)) return tableName;
                }
                return 'iaq';
              })();
              const fetchArgs = {
                room: deviceId,
                table: tableGuess,
                fields: [luxField],
                start: rr.start || undefined,
                end: rr.end || undefined
              };
              const res = tools.fetch_timeseries(fetchArgs);
              const traceAuto = [{ tool: 'fetch_timeseries', args: fetchArgs, result: res }];
              if (Array.isArray(res) && res.length) {
                const chart = {
                  chart: { type: 'line' },
                  title: { text: `${deviceFriendlyName(deviceId)} — ${humanizeMetricName(luxField)}` },
                  xAxis: { type: 'datetime' },
                  yAxis: { title: { text: humanizeMetricName(luxField) } },
                  series: [{
                    name: `${deviceFriendlyName(deviceId)} ${humanizeMetricName(luxField)}`,
                    dataRef: { tool: 'fetch_timeseries', room: deviceId, xField: 'ts', yField: luxField }
                  }]
                };
                const valid = validateChart(cloneChart(chart), traceAuto);
                if (valid) {
                  const fallbackText = `Plotted ${humanizeMetricName(luxField)} for ${deviceFriendlyName(deviceId)}.`;
                  const answerText = buildDefaultAnswer({
                    question,
                    chart: valid,
                    trace: traceAuto,
                    fallbackText,
                    notes: adaptationNotes,
                    range: rr
                  });
                  return { message: assistantMessage(answerText), chart, trace: traceAuto };
                }
              } else {
                const msg = `No ${humanizeMetricName('lux')} readings available for ${deviceFriendlyName(deviceId)} in the selected window.`;
                return { message: assistantMessage(msg), chart: null, trace: traceAuto };
              }
            }
          }
        } catch (e) {
          log('device-specific autoplot failed:', String(e));
        }
      }
      if (isPlotIntent && /\bcorrelat/.test(qlc) && qlc.includes('outside') && qlc.includes('temperat')) {
        try {
          const rr = range || {};
          const candidateRooms = Array.isArray(selectionRooms) && selectionRooms.length
            ? selectionRooms.slice(0, 24)
            : listRooms().slice(0, 24);
          const corrArgs = {
            rooms: candidateRooms,
            building: (scopeLabels && scopeLabels.building) || null,
            field: 'temperature',
            weather_field: 'temp',
            start: rr.start || undefined,
            end: rr.end || undefined,
            bucket_minutes: qlc.includes('daily') ? 1440 : 60
          };
          const res = tools.building_temp_weather_corr(corrArgs);
          const traceAuto = [{ tool: 'building_temp_weather_corr', args: corrArgs, result: res }];
          if (Array.isArray(res?.scatter) && res.scatter.length) {
            const chart = {
              chart: { type: 'scatter' },
              title: { text: 'Internal vs Outside Temperature' },
              xAxis: { title: { text: 'Outside Temperature (°C)' } },
              yAxis: { title: { text: 'Average Internal Temperature (°C)' } },
              series: [{
                name: 'Internal vs Outside Temp',
                dataRef: { tool: 'building_temp_weather_corr', field: 'scatter', xField: 'x', yField: 'y' }
              }]
            };
            const valid = validateChart(cloneChart(chart), traceAuto);
            if (valid) {
              const parts = [];
              if (Number.isFinite(res.corr)) {
                parts.push(`Correlation between averaged internal temperature and outside temperature is ${res.corr.toFixed(2)} (n=${res.n}).`);
              } else {
                parts.push(`Plotted averaged internal vs outside temperature for ${res.n} hourly points.`);
              }
              if (Array.isArray(res.rooms) && res.rooms.length) {
                const roomLabels = res.rooms.slice(0, 4).map((id) => deviceFriendlyName(id)).filter(Boolean);
                const suffix = res.rooms.length > 4 ? '…' : '';
                if (roomLabels.length) parts.push(`Rooms included: ${roomLabels.join(', ')}${suffix}`);
              }
              const fallbackText = parts.join(' ');
              const answerText = buildDefaultAnswer({
                question,
                chart: valid,
                trace: traceAuto,
                fallbackText,
                notes: adaptationNotes,
                range: rr
              });
              return { message: assistantMessage(answerText), chart, trace: traceAuto };
            }
          }
          if (res?.error) {
            return { message: assistantMessage(res.error), chart: null, trace: traceAuto };
          }
        } catch (e) {
          log('building_temp_weather_corr autoplot failed:', String(e));
        }
      }
      if (isPlotIntent && (room === 'ALL' || multiScope || floorAll)) {
        if (qlc.includes('heatmap')) {
          try {
            const rr = range || {};
            const candidateRooms = selectRoomsForHeatmap(question, selectionRooms, 8);
            if (candidateRooms.length === 0) {
              log('Heatmap autoplot skipped: no candidate rooms resolved');
            } else {
              const fieldsMap = availableFieldsByTable(candidateRooms[0] || candidateRooms);
              const defaults = resolveMetricAndTableFromQuestion(question, fieldsMap, qlc.includes('occup') ? 'people_count' : 'co2');
              const bucketMinutes = qlc.includes('daily') ? 1440 : 60;
              const heatmapArgs = {
                rooms: candidateRooms,
                table: defaults.table,
                field: defaults.field,
                start: rr.start || undefined,
                end: rr.end || undefined,
                bucket_minutes: bucketMinutes,
                agg: 'avg'
              };
              let res;
              try {
                res = tools.scope_heatmap(heatmapArgs);
              } catch (err) {
                const message = err && err.message ? err.message : 'Heatmap generation failed due to missing rooms.';
                return { message: assistantMessage(message), chart: null, trace: [{ tool: 'scope_heatmap', args: heatmapArgs, result: { error: message } }] };
              }
              const traceAuto = [{ tool: 'scope_heatmap', args: heatmapArgs, result: res }];
              if (res && res.error) {
                const message = typeof res.error === 'string' ? res.error : 'Heatmap generation failed.';
                return { message: assistantMessage(message), chart: null, trace: traceAuto };
              }
              if (!res.data || res.data.length === 0) {
                const message = res.summary || `No ${humanizeMetricName(defaults.field)} readings found for the requested rooms during the selected window.`;
                return { message: assistantMessage(message), chart: null, trace: traceAuto };
              }
              const roomLabels = res.rooms.map((r) => r.label);
              const timeLabels = res.timeLabels && res.timeLabels.length ? res.timeLabels : res.timestamps.map((ts) => formatLocal(ts));
              const metricLabel = humanizeMetricName(defaults.field);
              const colorAxis = {};
              if (Number.isFinite(res.min)) colorAxis.min = res.min;
              if (Number.isFinite(res.max)) colorAxis.max = res.max;
              const chart = {
                chart: { type: 'heatmap' },
                title: { text: `${metricLabel} heatmap` },
                xAxis: { categories: timeLabels, title: { text: `Time (${res.bucket_minutes || bucketMinutes}-min buckets)` } },
                yAxis: { categories: roomLabels, title: { text: 'Room' } },
                colorAxis,
                series: [{
                  name: metricLabel,
                  dataRef: { tool: 'scope_heatmap', field: 'data', xField: 'x', yField: 'y', valueField: 'value' }
                }]
              };
              if (!Object.keys(colorAxis).length) delete chart.colorAxis;
              const valid = validateChart(cloneChart(chart), traceAuto);
              if (valid) {
                if (res.summary) adaptationNotes.push(res.summary);
                const roomList = roomLabels.slice(0, 4).join(', ') + (roomLabels.length > 4 ? ', …' : '');
                const fallbackText = res.summary
                  ? `${metricLabel} heatmap across ${roomList}. ${res.summary}`
                  : `${metricLabel} heatmap across ${roomList}.`;
                const answerText = buildDefaultAnswer({
                  question,
                  chart: valid,
                  trace: traceAuto,
                  fallbackText,
                  notes: adaptationNotes,
                  range: rr
                });
                return { message: assistantMessage(answerText), chart, trace: traceAuto };
              }
            }
          } catch (e) {
            log('scope_heatmap autoplot failed:', String(e));
          }
        }
      } else if (isPlotIntent && room && room !== 'ALL') {
        function pickMetric(q) {
          const s = String(q||'').toLowerCase();
          if (s.includes('humidity')) return 'humidity';
          if (s.includes('co2')) return 'co2';
          if (s.includes('temperature') || s.includes('temp')) return 'temperature';
          if (s.includes('lux') || s.includes('light')) return 'lux';
          if (s.includes('energy') || s.includes('kwh')) return 'total_kwh';
          if (s.includes('people') || s.includes('occupancy')) return 'people_count';
          return 'co2';
        }
        const metric = pickMetric(question);
        let granularity = 'raw';
        if (qlc.includes('daily')) granularity = 'daily';
        else if (qlc.includes('hourly')) granularity = 'hourly';
        else if (qlc.includes('scatter') || qlc.includes(' vs ')) granularity = 'scatter';
        else if (qlc.includes('histogram') || qlc.includes('distribution')) granularity = 'histogram';
        else if (qlc.includes('heatmap') || qlc.includes('correlation')) granularity = 'heatmap';
        try {
          const rr = range || {};
          const traceAuto = [];
          if (granularity === 'histogram') {
            const res = tools.histogram({ room, table: 'iaq', field: metric, bins: 20, start: rr.start || undefined, end: rr.end || undefined });
            traceAuto.push({ tool: 'histogram', args: { room, table: 'iaq', field: metric }, result: res });
            const chart = { chart: { type: 'column' }, title: { text: `Histogram of ${metric}` }, xAxis: { title: { text: metric } }, yAxis: { title: { text: 'Count' } }, series: [{ name: `${room} ${metric}`, dataRef: { tool: 'histogram', xField: 'binStart', yField: 'count' } }] };
            const valid = validateChart(cloneChart(chart), traceAuto);
            if (valid) {
              const fallbackText = `Histogram of ${humanizeMetricName(metric)} for ${deviceFriendlyName(room)}.`;
              const answerText = buildDefaultAnswer({
                question,
                chart: valid,
                trace: traceAuto,
                fallbackText,
                notes: adaptationNotes,
                range: rr
              });
              return { message: assistantMessage(answerText), chart, trace: traceAuto };
            }
          } else if (granularity === 'heatmap') {
            const wantsCorrelation = /\b(correlation|correlate|matrix)\b/.test(qlc);
            if (wantsCorrelation) {
              const fields = ['temperature','humidity','co2','lux'];
              const res = tools.correlation_matrix({ room, table: 'iaq', fields, start: rr.start || undefined, end: rr.end || undefined });
              traceAuto.push({ tool: 'correlation_matrix', args: { room, table: 'iaq', fields }, result: res });
              const chart = { chart: { type: 'heatmap' }, title: { text: 'Correlation Heatmap' }, colorAxis: { min: -1, max: 1 }, series: [{ name: 'Correlation', dataRef: { tool: 'correlation_matrix', format: 'heatmap' } }] };
              const valid = validateChart(cloneChart(chart), traceAuto);
              if (valid) {
                const fallbackText = `Correlation heatmap for ${deviceFriendlyName(room)}.`;
                const answerText = buildDefaultAnswer({
                  question,
                  chart: valid,
                  trace: traceAuto,
                  fallbackText,
                  notes: adaptationNotes,
                  range: rr
                });
                return { message: assistantMessage(answerText), chart, trace: traceAuto };
              }
            } else {
              const tableGuess = metric === 'people_count' ? 'people' : (metric === 'total_kwh' || metric === 'value') ? 'energy' : 'iaq';
              const heatmapArgs = {
                rooms: [room],
                table: tableGuess,
                field: metric,
                start: rr.start || undefined,
                end: rr.end || undefined,
                bucket_minutes: qlc.includes('daily') ? 1440 : 60,
                agg: 'avg'
              };
              let res;
              try {
                res = tools.scope_heatmap(heatmapArgs);
              } catch (err) {
                const message = err && err.message ? err.message : 'Heatmap generation failed due to missing rooms.';
                traceAuto.push({ tool: 'scope_heatmap', args: heatmapArgs, result: { error: message } });
                return { message: assistantMessage(message), chart: null, trace: traceAuto };
              }
              traceAuto.push({ tool: 'scope_heatmap', args: heatmapArgs, result: res });
              if (res && res.error) {
                const msg = typeof res.error === 'string' ? res.error : 'Heatmap generation failed.';
                return { message: assistantMessage(msg), chart: null, trace: traceAuto };
              }
              if (!res.data || res.data.length === 0) {
                const msg = res.summary || `No ${humanizeMetricName(metric)} readings available for ${room} in the selected window.`;
                return { message: assistantMessage(msg), chart: null, trace: traceAuto };
              }
              const labels = res.rooms.map((r) => r.label);
              const timeLabels = res.timeLabels && res.timeLabels.length ? res.timeLabels : res.timestamps.map((ts) => formatLocal(ts));
              const colorAxis = {};
              if (Number.isFinite(res.min)) colorAxis.min = res.min;
              if (Number.isFinite(res.max)) colorAxis.max = res.max;
              const chart = {
                chart: { type: 'heatmap' },
                title: { text: `${humanizeMetricName(metric)} heatmap` },
                xAxis: { categories: timeLabels, title: { text: `Time (${res.bucket_minutes || heatmapArgs.bucket_minutes}-min buckets)` } },
                yAxis: { categories: labels, title: { text: 'Room' } },
                colorAxis,
                series: [{
                  name: humanizeMetricName(metric),
                  dataRef: { tool: 'scope_heatmap', field: 'data', xField: 'x', yField: 'y', valueField: 'value' }
                }]
              };
              if (!Object.keys(colorAxis).length) delete chart.colorAxis;
              const valid = validateChart(cloneChart(chart), traceAuto);
              if (valid) {
                if (res.summary) adaptationNotes.push(res.summary);
                const fallbackText = res.summary || `Heatmap of ${humanizeMetricName(metric)} for ${deviceFriendlyName(room)}.`;
                const answerText = buildDefaultAnswer({
                  question,
                  chart: valid,
                  trace: traceAuto,
                  fallbackText,
                  notes: adaptationNotes,
                  range: rr
                });
                return { message: assistantMessage(answerText), chart, trace: traceAuto };
              }
            }
          } else if (granularity === 'scatter') {
            const res = tools.pair_timeseries({ room, table1: 'iaq', field1: metric, table2: 'weather', field2: 'temp', start: rr.start || undefined, end: rr.end || undefined, time_window_ms: 60*60*1000 });
            traceAuto.push({ tool: 'pair_timeseries', args: { room, table1: 'iaq', field1: metric, table2: 'weather', field2: 'temp' }, result: res });
            const chart = { chart: { type: 'scatter' }, title: { text: `${metric} vs outside temp` }, series: [{ name: `${metric} vs temp`, dataRef: { tool: 'pair_timeseries', xField: 'x', yField: 'y' } }] };
            const valid = validateChart(cloneChart(chart), traceAuto);
            if (valid) {
              const fallbackText = `Scatter plot of ${humanizeMetricName(metric)} vs outside temperature for ${deviceFriendlyName(room)}.`;
              const answerText = buildDefaultAnswer({
                question,
                chart: valid,
                trace: traceAuto,
                fallbackText,
                notes: adaptationNotes,
                range: rr
              });
              return { message: assistantMessage(answerText), chart, trace: traceAuto };
            }
          } else {
            // time series
            let res = null, yField = metric, toolName = 'fetch_timeseries';
            if (granularity === 'hourly') { res = tools.hourly_timeseries({ room, table: 'iaq', field: metric, start: rr.start || undefined, end: rr.end || undefined }); toolName = 'hourly_timeseries'; yField = 'avg'; }
            else if (granularity === 'daily') { res = tools.daily_avg({ room, table: 'iaq', field: metric, start: rr.start || undefined, end: rr.end || undefined }); toolName = 'daily_avg'; yField = 'avg'; }
            else { res = tools.fetch_timeseries({ room, table: 'iaq', fields: [metric], start: rr.start || undefined, end: rr.end || undefined }); }
            traceAuto.push({ tool: toolName, args: { room, table: 'iaq', field: metric, fields: [metric], start: rr.start || undefined, end: rr.end || undefined }, result: res });
            const chart = { chart: { type: 'line' }, title: { text: `${room} — ${metric} (${granularity})` }, xAxis: { type: 'datetime' }, yAxis: [{ title: { text: metric } }], series: [{ name: `${room} ${metric}`, dataRef: { tool: toolName, xField: 'ts', yField } }] };
            const valid = validateChart(cloneChart(chart), traceAuto);
            if (valid) {
              const fallbackText = `Plotted ${humanizeMetricName(metric)} for ${deviceFriendlyName(room)} (${granularity}).`;
              const answerText = buildDefaultAnswer({
                question,
                chart: valid,
                trace: traceAuto,
                fallbackText,
                notes: adaptationNotes,
                range: rr
              });
              return { message: assistantMessage(answerText), chart, trace: traceAuto };
            }
          }
        } catch (e) { log('auto-plot failed:', String(e)); }
      }
    }

    const trace = [];
    let lastToolSig = '';
   let repeatCount = 0;
   let totalToolCalls = 0;
    let scatterRetryCount = 0;
    let chartRetryCount = 0;
    
    STEP_LOOP: for (let step = 0; step < 10; step++) {
      const t0 = Date.now();
    // Enforce chart_query for plotting intents
    const qlc = String(question||'').toLowerCase();
    if (/(plot|chart|graph|scatter|histogram|heatmap)\b/.test(qlc)) {
      convo.push({ role: 'model', content: 'Reminder: For plotting questions, first call chart_query to produce a plan and chart with dataRef, then execute the plan and finalize with the chart.' });
    }
    const reply = await callGeminiChat(convo, {});
      const dt = Date.now() - t0;
      log(`LLM step ${step} took ${dt}ms`);
      
      if (!reply) break;
      if (DEBUG) log('LLM raw reply:', reply.slice(0, 600));
      
      // Force finalization if we've made enough tool calls
      if (totalToolCalls >= 6 && step >= 4) {
        const recentlyPaired = trace.some(t => t.tool === 'pair_timeseries');
        if (recentlyPaired && step < 4) {
          // Allow one extra iteration to let the model produce a chart using the paired dataRef
          log('Skipping forced finalization to allow scatter pairing (step', step, ')');
        } else {
          log('Strongly encouraging finalization after', totalToolCalls, 'tool calls at step', step);
        
        // CRITICAL: After 2 tools and step 2+, FORCE finalization with very explicit instructions
        if (step >= 3) {
          const ql = question.toLowerCase();
          const isCorrelationPlot = ql.includes('correlation') && (ql.includes('plot') || ql.includes('show'));
          const isScatterPlot = ql.includes('scatter') || ql.includes('scatterplot');
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
          
          convo.push({ role: 'model', content: hint });
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
            role: 'model',
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
            role: 'model',
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
          // After step 5, auto-wrap plain text in JSON as last resort
          if (step >= 5 && totalToolCalls >= 2) {
            log('Auto-wrapping plain text response in JSON (step', step, ')');
            return {
              message: assistantMessage(plain),
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
          continue STEP_LOOP;
        }
        
        convo.push({
          role: 'model',
          content: `CRITICAL ERROR: Response could not be parsed as valid JSON. You must respond with a JSON object using the documented schema (action/tool_calls/final/chart). Resend your answer in the required JSON format.`
        });
        continue STEP_LOOP;
        
        // After step 2, if reply is not valid JSON with "action", force a JSON answer
        if (step >= 2 && (!obj || !obj.action)) {
          convo.push({
            role: 'model',
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
          role: 'model', 
          content: `{"tool_results": ${JSON.stringify(results).slice(0, 15000)} }` 
        });
        continue STEP_LOOP;
      }
      
      // Handle single tool call
      // Handle multiple parallel tool calls
      if (obj.action === 'tool_calls' && Array.isArray(obj.tools)) {
        const results = [];
        for (const tc of obj.tools) {
          const tool = resolveToolName(tc.tool);
          const args = { ...(tc.args || {}) };
          if (!tools[tool]) {
            results.push({ tool, args, result: { error: `Tool ${tool} not found` } });
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
          function inferTbl(m) { if (!m) return null; if (['co2','temperature','humidity','lux'].includes(m)) return 'iaq'; if (m==='people_count') return 'people'; if (m==='total_kwh') return 'energy'; return null; }
          if (want) {
            if (tool === 'fetch_timeseries') {
              if (!args.fields || !args.fields.length || !args.fields.includes(want)) args.fields = [want];
              if (!args.table) { const t = inferTbl(want); if (t) args.table = t; }
            } else if (tool === 'hourly_timeseries' || tool === 'daily_avg' || tool === 'stats' || tool === 'hour_of_day_stats' || tool === 'histogram') {
              if (!args.field) args.field = want;
              if (!args.table) { const t = inferTbl(want); if (t) args.table = t; }
            }
          }
          let result = null;
          try { result = tools[tool](args); } catch (e) { result = { error: String(e) }; }
          results.push({ tool, args, result });
          trace.push({ tool, args, result });
          totalToolCalls += 1;
        }
        convo.push({ role: 'model', content: `{"tool_results": ${JSON.stringify(results).slice(0, 15000)} }` });
        continue STEP_LOOP;
      }
      if (obj.action === 'tool_calls' && !Array.isArray(obj.tools)) {
        convo.push({
          role: 'model',
          content: 'ERROR: Received tool_calls without a tools array. Respond with a proper JSON final answer.'
        });
        continue STEP_LOOP;
      }

      if (obj.action === 'tool_call') {
        let { tool, args } = obj;
        tool = resolveToolName(tool);
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
        // Steer tool args toward intended metric/table inferred from the question
        const want = (String(question||'').toLowerCase().includes('humidity') ? 'humidity' :
                     String(question||'').toLowerCase().includes('temperature') || String(question||'').toLowerCase().includes('temp') ? 'temperature' :
                     String(question||'').toLowerCase().includes('co2') ? 'co2' :
                     String(question||'').toLowerCase().includes('lux') || String(question||'').toLowerCase().includes('light') ? 'lux' : null);
        function inferTbl(m) { if (!m) return null; if (['co2','temperature','humidity','lux'].includes(m)) return 'iaq'; if (m==='people_count') return 'people'; if (m==='total_kwh') return 'energy'; return null; }
        if (want) {
          if (tool === 'fetch_timeseries') {
            if (!filledArgs.fields || !filledArgs.fields.length || !filledArgs.fields.includes(want)) filledArgs.fields = [want];
            if (!filledArgs.table) { const t = inferTbl(want); if (t) filledArgs.table = t; }
          } else if (tool === 'hourly_timeseries' || tool === 'daily_avg' || tool === 'stats' || tool === 'hour_of_day_stats' || tool === 'histogram') {
            if (!filledArgs.field) filledArgs.field = want;
            if (!filledArgs.table) { const t = inferTbl(want); if (t) filledArgs.table = t; }
          }
        }
        
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
        convo.push({ role: 'model', content: `{"tool_result": { "tool": ${JSON.stringify(tool)}, "args": ${JSON.stringify(filledArgs)}, "result": ${JSON.stringify(result).slice(0, 10000)} }}` });
        
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
                  adaptationNotes.push(`Selected window returned no rows; showing latest available data up to ${formatLocal(meta.tsMax)}.`);
                  continue STEP_LOOP;
                }
              } catch {}
            } else if (meta && meta.count > 0 && meta.tsMin != null && meta.tsMax != null) {
              const adaptedArgs = { ...filledArgs, start: meta.tsMin, end: meta.tsMax };
              try {
                const adaptedResult = tools[tool](adaptedArgs);
                if ((Array.isArray(adaptedResult) && adaptedResult.length > 0) || 
                    (adaptedResult && typeof adaptedResult === 'object' && adaptedResult.count > 0)) {
                  log('Auto-adapting to full available range', adaptedArgs);
                  result = adaptedResult;
                  convo.push({
                    role: 'model',
                    content: `{"tool_result_adapted": { "tool": ${JSON.stringify(tool)}, "args": ${JSON.stringify(adaptedArgs)}, "result": ${JSON.stringify(result).slice(0, 10000)}, "note": "Selected window had no rows. Showing available data from ${new Date(meta.tsMin).toISOString()} to ${new Date(meta.tsMax).toISOString()}." }}`
                  });
                  adaptationNotes.push(`Selected window returned no rows; showing available data from ${formatLocal(meta.tsMin)} to ${formatLocal(meta.tsMax)} instead.`);
                  continue STEP_LOOP;
                }
              } catch (e) {
                log('Full-range adaptation failed:', String(e));
              }
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
        
      } else if (obj.action === 'final') {
        log('Finalizing answer. Chart provided?', !!obj.chart);

        // If model returned embedded arrays or no dataRef, retrofit to dataRef
        if (obj.chart && obj.chart.series && Array.isArray(obj.chart.series)) {
          try {
            const tablesSets = availableFieldsByTable(room);
            const ql2 = (question || '').toLowerCase();
            const isVsQuery = /\bvs\b/.test(ql2) || ql2.includes('scatter');

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
                  if (field) {
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

        // If no chart provided, infer a useful one from the question
        if (!obj.chart || !obj.chart.series || !obj.chart.series.length) {
          try {
            const tablesSets = availableFieldsByTable(room);
            const ql = (question||'').toLowerCase();
            const isHist = ql.includes('histogram') || ql.includes('distribution');
            if (isHist) {
              const fields = parseFieldsFromQuestion(question, tablesSets);
              const f = fields[0] || 'odor_level';
              obj.chart = {
                chart: { type: 'column' },
                title: { text: `${f} distribution` },
                xAxis: { title: { text: f } },
                yAxis: { title: { text: 'Count' } },
                series: [{ name: `${f} histogram`, dataRef: { tool: 'histogram', field: f, xField: 'binStart', yField: 'count' } }]
              };
            } else {
              const fields = parseFieldsFromQuestion(question, tablesSets);
              const floorAll = isAllRooms(room) && Array.isArray(selectionRooms) && selectionRooms.length;
              if (fields.length >= 2) {
                obj.chart = {
                  chart: { type: 'scatter' },
                  title: { text: `${fields[0]} vs ${fields[1]}` },
                  xAxis: { title: { text: fields[0] } },
                  yAxis: { title: { text: fields[1] } },
                  series: [{ name: `${fields[0]} vs ${fields[1]}`, dataRef: { tool: 'pair_timeseries', xField: 'x', yField: 'y', field1: fields[0], field2: fields[1] } }]
                };
              } else if ((fields.length === 1 && !floorAll) || (wantsChart(question) && !floorAll)) {
                const f = fields[0] || 'temperature';
                obj.chart = {
                  chart: { type: 'line' },
                  title: { text: `${f} over time` },
                  xAxis: { type: 'datetime' },
                  yAxis: { title: { text: f } },
                  series: [{ name: f, dataRef: { tool: 'fetch_timeseries', xField: 'ts', yField: f } }]
                };
              } else if (floorAll && fields.length >= 1) {
                // Build cross-room comparison line chart for selected rooms
                const f = fields[0];
                obj.chart = {
                  chart: { type: 'line' },
                  title: { text: `${f} across rooms` },
                  xAxis: { type: 'datetime' },
                  yAxis: { title: { text: f } },
                  series: selectionRooms.slice(0, 8).map(r => ({ name: `${r} ${f}`, dataRef: { tool: 'compare_series_cross_room', field: `${r} ${f}`, xField: 'ts', yField: 'y' } }))
                };
                // Ensure compare tool result is present in trace
                try {
                  const compareArgs = { start: rr.start || undefined, end: rr.end || undefined, series: [] };
                  for (const r of selectionRooms.slice(0, 8)) {
                    const t = loadRoomTables(r);
                    let tableMatch = null;
                    for (const [tname, rows] of Object.entries(t)) {
                      if (rows.length && Object.keys(rows[0] || {}).includes(f)) { tableMatch = tname; break; }
                    }
                    compareArgs.series.push({ room: r, table: tableMatch || 'iaq', field: f, name: `${r} ${f}` });
                  }
                  const compareResult = tools.compare_series_cross_room(compareArgs);
                  trace.push({ tool: 'compare_series_cross_room', args: compareArgs, result: compareResult });
                } catch (e) { log('auto-compare build failed:', String(e)); }
              }
            }
          } catch (e) {
            log('Auto-chart inference failed:', String(e));
          }
        }

        // Find all dataRefs in the chart
        const missingToolCalls = [];
        if (obj.chart && obj.chart.series) {
          for (const series of obj.chart.series) {
            if (series.dataRef) {
              const ref = series.dataRef;
              // Check if tool result is in trace
              const found = trace.some(t => t.tool === ref.tool && (!ref.room || (t.args && String(t.args.room) === String(ref.room))));
              if (!found) {
                // Prepare tool call args
                let args = {};
                if (ref.tool === 'fetch_timeseries') {
                  const preferredRoom = ref.room || (isAllRooms(room) ? null : room);
                  const binding = resolveFieldBinding(ref.yField || ref.field, selectionRooms, preferredRoom) || null;
                  const roomForRef = binding?.room || preferredRoom || (selectionRooms && selectionRooms[0]) || inferRoomFromText(series.name) || inferRoomFromText(question) || room;
                  const fieldName = binding?.fieldName || ref.yField || ref.field;
                  if (!roomForRef || !fieldName) continue;
                  const tableName = binding?.table || resolveTable(roomForRef, 'iaq');
                  args = {
                    room: roomForRef,
                    table: tableName,
                    fields: [fieldName],
                    start: (range && range.start) || undefined,
                    end: (range && range.end) || undefined
                  };
                  if (fieldName && ref.yField && fieldName !== ref.yField) ref.yField = fieldName;
                } else if (ref.tool === 'pair_timeseries') {
                  const tablesSets = availableFieldsByTable(selectionRooms && selectionRooms[0] ? selectionRooms[0] : room || '');
                  let f1 = ref.field1;
                  let f2 = ref.field2;
                  if ((!f1 || !f2) && series && typeof series.name === 'string') {
                    const parts = series.name.split(/\s+vs\s+|\s+and\s+/i).map(s => s.trim()).filter(Boolean);
                    if (parts.length >= 2) {
                      f1 = f1 || inferFieldName(parts[0], tablesSets) || parts[0];
                      f2 = f2 || inferFieldName(parts[1], tablesSets) || parts[1];
                    }
                  }
                  f1 = f1 || ref.yField || inferFieldName(question, tablesSets) || 'temperature';
                  f2 = f2 || inferFieldName(question, tablesSets) || 'humidity';
                  const preferredRoom = ref.room || (selectionRooms && selectionRooms[0]) || (isAllRooms(room) ? null : room);
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
                    start: (range && range.start) || undefined,
                    end: (range && range.end) || undefined
                  };
                  ref.field1 = field1Name;
                  ref.field2 = field2Name;
                } else if (ref.tool === 'histogram') {
                  const binding = resolveFieldBinding(ref.field, selectionRooms, ref.room || (isAllRooms(room) ? null : room));
                  const roomForRef = binding?.room || ref.room || (selectionRooms && selectionRooms[0]) || inferRoomFromText(series.name) || inferRoomFromText(question) || room;
                  const fieldName = binding?.fieldName || ref.field;
                  if (!roomForRef || !fieldName) continue;
                  const tableName = binding?.table || resolveTable(roomForRef, 'iaq');
                  args = { room: roomForRef, table: tableName, field: fieldName, bins: ref.bins || 12, start: (range && range.start) || undefined, end: (range && range.end) || undefined };
                } else if (ref.tool === 'compare_series_cross_room') {
                  const roomsList = Array.isArray(selectionRooms) && selectionRooms.length ? selectionRooms.slice(0, 8) : (room && !isAllRooms(room) ? [room] : listRooms().slice(0, 4));
                  const tablesSetsAny = roomsList.length ? availableFieldsByTable(roomsList[0]) : {};
                  let field = ref.yField || ref.field || inferFieldName(series.name, tablesSetsAny) || inferFieldName(question, tablesSetsAny) || 'temperature';
                  const seriesArgs = [];
                  for (const r of roomsList) {
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
                  if (seriesArgs.length) {
                    args = { start: (range && range.start) || undefined, end: (range && range.end) || undefined, series: seriesArgs };
                  } else {
                    continue;
                  }
                } else if (ref.tool === 'weather_fetch') {
                  const fields = Array.isArray(ref.fields) && ref.fields.length ? ref.fields : ['temp', 'humidity'];
                  const buildingHint = (scopeLabels && scopeLabels.building) || inferBuildingFromContext();
                  args = {
                    building: buildingHint || undefined,
                    room: (selectionRooms && selectionRooms[0]) || undefined,
                    fields,
                    start: (range && range.start) || undefined,
                    end: (range && range.end) || undefined
                  };
                }
                // Add other tool types as needed
                if (args) {
                  missingToolCalls.push({ tool: ref.tool, args });
                }
              }
            }
          }
        }

        // If missing tool calls, run them and add to trace
        for (const call of missingToolCalls) {
          if (tools[call.tool]) {
            const result = tools[call.tool](call.args);
            trace.push({ tool: call.tool, args: call.args, result });
            log(`Auto-ran missing tool: ${call.tool}`, call.args);
          }
        }

        // Now resolve chart as usual
        const chartRequested = !!(obj.chart && Array.isArray(obj.chart.series) && obj.chart.series.length);
        let chartForAnswer = chartRequested ? cloneChart(obj.chart) : null;
        let validChart = chartRequested ? validateChart(cloneChart(obj.chart), trace) : null;
        if (obj.chart && !validChart) {
          log('Chart validation failed - attempting fallback synthesis');
        }

        // Fallback: if no valid chart, synthesize from latest compare_series_cross_room
        if (!validChart) {
          if (chartRequested) {
            adaptationNotes.push('No chartable data returned for the requested scope; providing narrative summary instead.');
          }
          try {
            let lastCompare = null;
            for (let i = trace.length - 1; i >= 0; i--) {
              const t = trace[i];
              if (t && t.tool === 'compare_series_cross_room' && t.result && typeof t.result === 'object') { lastCompare = t; break; }
            }
            if (lastCompare) {
              const keys = Object.keys(lastCompare.result || {}).slice(0, 8);
              if (keys.length) {
                const series = keys.map((k) => ({ name: String(k), dataRef: { tool: 'compare_series_cross_room', field: k, xField: 'ts', yField: 'y' } }));
                const fallbackChart = { chart: { type: 'line' }, title: { text: 'Cross-Room Comparison' }, xAxis: { type: 'datetime', title: { text: 'Time' } }, yAxis: { title: { text: 'Value' } }, series };
                const vc = validateChart(cloneChart(fallbackChart), trace);
                if (vc) {
                  validChart = vc;
                  chartForAnswer = fallbackChart;
                  log('Synthesized fallback chart from compare_series_cross_room');
                }
              }
            }
          } catch (e) { log('Fallback chart synthesis failed:', String(e)); }
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
              role: 'model',
              content: 'You must return a scatter chart with a valid dataRef referencing the tool results before finalizing. Call pair_timeseries or building_temp_weather_corr/building_temp_weather_scatter to generate data for the scatter and include it in your final chart.'
            });
            continue STEP_LOOP;
          }
        }

        const chartForResponse = validChart ? chartForAnswer : null;
        const needsChart = questionRequiresChart(question);
        const chartHasSeries = chartForResponse && Array.isArray(chartForResponse.series) && chartForResponse.series.length;
        if (needsChart && !chartHasSeries) {
          const allowNoChart = adaptationNotes.some(note => /no (chart|data)/i.test(String(note)));
          if (!allowNoChart && chartRetryCount < 2) {
            chartRetryCount++;
            convo.push({
              role: 'model',
              content: 'You must include a chart with valid dataRef references before finalizing. Call the appropriate tool (e.g., fetch_timeseries, compare_series_cross_room, scope_heatmap) and structure the chart with dataRef pointing to that tool result.'
            });
            continue STEP_LOOP;
          }
        }
        const answerText = buildDefaultAnswer({
          question,
          chart: validChart,
          trace,
          fallbackText: obj.answer || reply || '',
          notes: adaptationNotes,
          range
        });
        let finalAnswer = answerText;
        if (!finalAnswer || normalizeText(finalAnswer) === normalizeText(question)) {
          const chartSummary = summarizeChart(validChart);
          const insight = traceInsight(trace);
          finalAnswer = chartSummary || insight || 'I analyzed the available data for the selected scope and time window.';
          if (Array.isArray(adaptationNotes) && adaptationNotes.length) {
            finalAnswer += ' ' + adaptationNotes.join(' ');
          }
        }
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
        const answerText = buildDefaultAnswer({
          question,
          chart: null,
          trace,
          fallbackText: obj.answer || reply || '',
          notes: adaptationNotes,
          range
        });
        let finalAnswer = answerText;
        if (!finalAnswer || normalizeText(finalAnswer) === normalizeText(question)) {
          const insight = traceInsight(trace);
          finalAnswer = insight || 'I analyzed the available data for the selected scope and time window.';
          if (Array.isArray(adaptationNotes) && adaptationNotes.length) {
            finalAnswer += ' ' + adaptationNotes.join(' ');
          }
        }
        return {
          message: assistantMessage(finalAnswer),
          chart: null,
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
        return {
          message: assistantMessage(answer),
          chart: fallbackChart,
          trace
        };
      }
      const trimmedLast = last.trim();
      if (!/^Reminder:/i.test(trimmedLast) && !/^MANDATORY:/i.test(trimmedLast) && !/^CRITICAL ERROR:/i.test(trimmedLast) && !/^ERROR:/i.test(trimmedLast) &&
          last && last.length > 40 && !last.includes('respond with a JSON') && !last.includes('ERROR:')) {
        // Try to infer a helpful chart for plain text responses
        autoChart = null;
        try {
          const tablesSets = availableFieldsByTable(room);
          const fields = parseFieldsFromQuestion(question, tablesSets);
          const floorAll = isAllRooms(room) && Array.isArray(selectionRooms) && selectionRooms.length;
          if (fields.length >= 2) {
            autoChart = {
              chart: { type: 'scatter' },
              title: { text: `${fields[0]} vs ${fields[1]}` },
              xAxis: { title: { text: fields[0] } },
              yAxis: { title: { text: fields[1] } },
              series: [{ name: `${fields[0]} vs ${fields[1]}`, dataRef: { tool: 'pair_timeseries', xField: 'x', yField: 'y', field1: fields[0], field2: fields[1] } }]
            };
          } else if ((fields.length === 1 && !floorAll) || (wantsChart(question) && !floorAll)) {
            const f = fields[0] || 'temperature';
            autoChart = {
              chart: { type: 'line' },
              title: { text: `${f} over time` },
              xAxis: { type: 'datetime' },
              yAxis: { title: { text: f } },
              series: [{ name: f, dataRef: { tool: 'fetch_timeseries', xField: 'ts', yField: f } }]
            };
          } else if (floorAll) {
            // Build a cross-room comparison from last compare_series_cross_room or run one now
            let compare = null;
            for (let i = trace.length - 1; i >= 0; i--) {
              if (trace[i].tool === 'compare_series_cross_room' && trace[i].result && typeof trace[i].result === 'object') { compare = trace[i]; break; }
            }
            const f = fields[0] || 'people_count';
            if (!compare) {
              // Execute compare now for scoped rooms
              const compareArgs = { start: rr.start || undefined, end: rr.end || undefined, series: [] };
              for (const r of selectionRooms.slice(0, 8)) {
                const t = loadRoomTables(r);
                let tableMatch = null;
                for (const [tname, rows] of Object.entries(t)) { if (rows.length && Object.keys(rows[0] || {}).includes(f)) { tableMatch = tname; break; } }
                compareArgs.series.push({ room: r, table: tableMatch || 'iaq', field: f, name: `${r} ${f}` });
              }
              const result = tools.compare_series_cross_room(compareArgs);
              trace.push({ tool: 'compare_series_cross_room', args: compareArgs, result });
              compare = { result };
            }
            const keys = Object.keys(compare.result || {}).slice(0, 8);
            if (keys.length) {
              autoChart = {
                chart: { type: 'line' },
                title: { text: `${f} across rooms` },
                xAxis: { type: 'datetime' },
                yAxis: { title: { text: f } },
                series: keys.map(k => ({ name: k, dataRef: { tool: 'compare_series_cross_room', field: k, xField: 'ts', yField: 'y' } }))
              };
            }
          }
        } catch {}
        // If recent trace includes scope_list_detectors calls, summarize detectors/metrics per room
        try {
          const recent = trace.filter(t => t.tool === 'scope_list_detectors' && t.args && t.args.room);
          if (recent.length) {
            const lines = [];
            for (const t of recent) {
              const r = t.args.room;
              const dets = Array.isArray(t.result) ? t.result : [];
              const tables = loadRoomTables(r);
              const fieldSet = new Set();
              for (const rows of Object.values(tables)) { const first = (rows||[])[0]||{}; for (const k of Object.keys(first)) if (k!=='ts') fieldSet.add(k); }
              const label = deviceFriendlyName(r);
              lines.push(`- ${label}: detectors=[${dets.join(', ')||'—'}], metrics=[${Array.from(fieldSet).sort().join(', ')||'—'}]`);
            }
            const msg = `Metrics by room in current scope:\n${lines.join('\n')}`;
            return { message: assistantMessage(msg), chart: autoChart, trace };
          }
        } catch {}
        if (!autoChart) {
          const fallbackChart = buildFallbackChartFromTrace({
            trace,
            question,
            defaultRoom: room,
            selectionRooms
          });
          if (fallbackChart) autoChart = fallbackChart;
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
