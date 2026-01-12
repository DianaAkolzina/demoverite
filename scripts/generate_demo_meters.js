#!/usr/bin/env node
// Adds utility meters to buildings missing them and generates local telemetry CSVs for demo use.

import fs from 'fs';
import path from 'path';
import url from 'url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, 'data');
const telemetryDir = path.join(root, 'data', 'local_telemetry');
const aliasPath = path.join(dataDir, 'device_aliases.json');

const slug = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function listSnapshots() {
  if (!fs.existsSync(dataDir)) return [];
  // For demo generation, focus on the primary snapshot to keep runtime reasonable.
  return [path.join(dataDir, 'graph_snapshot.json')].filter((p) => fs.existsSync(p));
}

function inferDeviceBuilding(nodes, links, devNode) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const typeOf = (n) => (n?.nodeType || n?.label);
  const devId = devNode?.id;
  if (!devId) return { building: null, floor: null, zone: null };
  let building = null; let floor = null; let zone = null;
  for (const l of links) {
    if (l.source !== devId && l.target !== devId) continue;
    const otherId = l.source === devId ? l.target : l.source;
    const on = byId.get(otherId);
    const t = typeOf(on);
    if (t === 'Zone' && !zone) zone = on.name || on.id;
    if (t === 'Floor' && !floor) floor = on.name || on.id;
    if (t === 'Building' && !building) building = on.name || on.id;
  }
  if (!floor && zone) {
    const z = byId.get(zone) || nodes.find((n) => n.name === zone);
    const rel = z ? links.find((lk) => lk.source === z.id && ['BELONGS_TO_FLOOR', 'LOCATED_ON_FLOOR', 'PART_OF_FLOOR'].includes(lk.rel)) : null;
    const f = rel ? byId.get(rel.target) : null;
    floor = f?.name || floor;
  }
  if (!building && floor) {
    const f = byId.get(floor) || nodes.find((n) => n.name === floor);
    const rel = f ? links.find((lk) => lk.source === f.id && ['LOCATED_IN_BUILDING', 'PART_OF_BUILDING', 'BELONGS_TO_BUILDING'].includes(lk.rel)) : null;
    const b = rel ? byId.get(rel.target) : null;
    building = b?.name || building;
  }
  if (!building && zone) {
    const z = byId.get(zone) || nodes.find((n) => n.name === zone);
    const rel = z ? links.find((lk) => lk.source === z.id && ['LOCATED_IN_BUILDING', 'PART_OF_BUILDING', 'BELONGS_TO_BUILDING'].includes(lk.rel)) : null;
    const b = rel ? byId.get(rel.target) : null;
    building = b?.name || building;
  }
  return { building, floor, zone };
}

function isMeterDevice(dev) {
  const name = (dev?.name || dev?.properties?.label || '').toLowerCase();
  return name.includes('meter');
}

function ensureMeterDevice(buildingNode, nodes, links) {
  const typeOf = (n) => (n?.nodeType || n?.label);
  const meters = nodes.filter((n) => typeOf(n) === 'Device' && isMeterDevice(n))
    .filter((dev) => {
      const meta = inferDeviceBuilding(nodes, links, dev);
      return meta.building === (buildingNode.name || buildingNode.id);
    });
  if (meters.length) return meters.map((m) => ({ node: m, created: false }));

  const cloudId = `meter-${slug(buildingNode.name || buildingNode.id)}`;
  const devId = `Device:meter:${slug(buildingNode.name || buildingNode.id)}`;
  const deviceNode = {
    id: devId,
    label: 'Device',
    name: `Utility Meter - ${buildingNode.name || buildingNode.id}`,
    nodeType: 'Device',
    type: 'Meter',
    hasData: true,
    properties: {
      name: `Utility Meter - ${buildingNode.name || buildingNode.id}`,
      label: 'Utility Meter',
      id: devId,
      isActive: true,
      cloudId
    },
    cloudId
  };
  nodes.push(deviceNode);
  links.push({ source: devId, target: buildingNode.id, rel: 'IN_BUILDING' });

  // Attach to an existing zone/floor if available, otherwise create a synthetic utility zone.
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const normalizeMeter = (m) => {
    const desiredCloud = `meter-${slug(buildingNode.name || buildingNode.id)}`;
    const desiredId = `Device:meter:${slug(buildingNode.name || buildingNode.id)}`;
    const desiredName = `Utility Meter - ${buildingNode.name || buildingNode.id}`;
    if (m.id !== desiredId) {
      for (const l of links) {
        if (l.source === m.id) l.source = desiredId;
        if (l.target === m.id) l.target = desiredId;
      }
      m.id = desiredId;
    }
    m.name = desiredName;
    if (!m.properties) m.properties = {};
    m.properties.name = desiredName;
    m.properties.label = 'Utility Meter';
    m.properties.cloudId = desiredCloud;
    m.cloudId = desiredCloud;
    byId.set(m.id, m);
    return m.id;
  };

  const ensurePlacement = (devId) => {
    const floors = nodes.filter((n) => typeOf(n) === 'Floor' && links.some((l) => l.source === n.id && l.rel === 'LOCATED_IN_BUILDING' && l.target === buildingNode.id));
    const zones = nodes.filter((n) => typeOf(n) === 'Zone' && links.some((l) => l.source === n.id && ['LOCATED_IN_BUILDING', 'PART_OF_BUILDING', 'BELONGS_TO_BUILDING'].includes(l.rel) && l.target === buildingNode.id));
    let pickedZone = zones[0];
    let pickedFloor = floors[0];
    if (!pickedZone && pickedFloor) {
      const z = nodes.find((n) => typeOf(n) === 'Zone' && links.some((l) => l.source === n.id && l.rel === 'BELONGS_TO_FLOOR' && l.target === pickedFloor.id));
      if (z) pickedZone = z;
    }
    if (!pickedZone) {
      const zoneId = `Zone:utility:${slug(buildingNode.name || buildingNode.id)}`;
      pickedZone = byId.get(zoneId);
      if (!pickedZone) {
        pickedZone = {
          id: zoneId,
          label: 'Zone',
          name: `${buildingNode.name || 'Building'} Utility`,
          nodeType: 'Zone',
          roomId: `utility-${slug(buildingNode.name || buildingNode.id)}`,
          properties: { name: `${buildingNode.name || 'Building'} Utility`, isActive: true }
        };
        nodes.push(pickedZone);
        byId.set(zoneId, pickedZone);
        links.push({ source: zoneId, target: buildingNode.id, rel: 'LOCATED_IN_BUILDING' });
      }
    }
    if (!links.some((l) => l.source === devId && l.rel === 'LOCATED_IN_ZONE')) {
      links.push({ source: devId, target: pickedZone.id, rel: 'LOCATED_IN_ZONE' });
    }
    if (pickedFloor && !links.some((l) => l.source === devId && l.rel === 'LOCATED_ON_FLOOR')) {
      links.push({ source: devId, target: pickedFloor.id, rel: 'LOCATED_ON_FLOOR' });
    }
  };

  // Ensure placement for existing meters
  meters.forEach((m) => {
    const nid = normalizeMeter(m);
    ensurePlacement(nid);
  });
  // Ensure placement for new meter
  ensurePlacement(normalizeMeter(deviceNode));

  return [{ node: deviceNode, created: true }];
}

function attachDeviceToHierarchy(hb, zoneNode, deviceNode) {
  if (!hb || !Array.isArray(hb.floors)) return false;
  for (const f of hb.floors) {
    if (!Array.isArray(f.zones)) continue;
    for (const z of f.zones) {
      if (z.id === zoneNode.id || z.name === zoneNode.name) {
        if (!Array.isArray(z.devices)) z.devices = [];
        z.devices.push({
          id: deviceNode.id,
          name: deviceNode.name,
          label: deviceNode.label,
          properties: deviceNode.properties,
          type: deviceNode.type,
          cloudId: deviceNode.cloudId
        });
        return true;
      }
    }
  }
  return false;
}

function ensureMeterForZone(zoneNode, nodes, links, buildingName, floorName) {
  const typeOf = (n) => (n?.nodeType || n?.label);
  const existing = nodes.filter((n) => typeOf(n) === 'Device' && isMeterDevice(n))
    .filter((dev) => {
      const meta = inferDeviceBuilding(nodes, links, dev);
      return meta.zone === (zoneNode.name || zoneNode.id);
    });
  if (existing.length) return existing.map((n) => ({ node: n, created: false }));

  const baseSlug = `${slug(buildingName || 'building')}-${slug(zoneNode.name || zoneNode.id || 'zone')}`;
  const cloudId = `meter-zone-${baseSlug}`;
  const devId = `Device:meter:zone:${baseSlug}`;
  const name = `${zoneNode.name || 'Zone'} Meter - ${buildingName || 'Building'}`;
  const deviceNode = {
    id: devId,
    label: 'Device',
    name,
    nodeType: 'Device',
    type: 'Meter',
    hasData: true,
    properties: {
      name,
      label: 'Utility Meter',
      id: devId,
      isActive: true,
      cloudId
    },
    cloudId
  };
  nodes.push(deviceNode);
  links.push({ source: devId, target: zoneNode.id, rel: 'LOCATED_IN_ZONE' });
  if (floorName) {
    const floorNode = nodes.find((n) => typeOf(n) === 'Floor' && (n.name === floorName || n.id === floorName));
    if (floorNode) links.push({ source: devId, target: floorNode.id, rel: 'LOCATED_ON_FLOOR' });
  }
  if (buildingName) {
    const buildingNode = nodes.find((n) => typeOf(n) === 'Building' && (n.name === buildingName || n.id === buildingName));
    if (buildingNode) links.push({ source: devId, target: buildingNode.id, rel: 'IN_BUILDING' });
  }
  return [{ node: deviceNode, created: true }];
}

function inferZoneContext(nodes, links, zoneNode) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = { building: null, floor: null, zone: zoneNode?.name || zoneNode?.id || null };
  if (!zoneNode) return out;
  // floor
  const lf = links.find((l) => l.source === zoneNode.id && ['BELONGS_TO_FLOOR', 'LOCATED_ON_FLOOR', 'PART_OF_FLOOR'].includes(l.rel));
  const f = lf ? byId.get(lf.target) : null;
  if (f) out.floor = f.name || f.id;
  // building
  const lb = links.find((l) => l.source === zoneNode.id && ['LOCATED_IN_BUILDING', 'PART_OF_BUILDING', 'BELONGS_TO_BUILDING'].includes(l.rel));
  const b = lb ? byId.get(lb.target) : null;
  if (b) out.building = b.name || b.id;
  // Derive via floor->building
  if (!out.building && f) {
    const lfb = links.find((l) => l.source === f.id && ['LOCATED_IN_BUILDING', 'PART_OF_BUILDING', 'BELONGS_TO_BUILDING'].includes(l.rel));
    const fb = lfb ? byId.get(lfb.target) : null;
    if (fb) out.building = fb.name || fb.id;
  }
  return out;
}

function ensureSensorForZone(zoneNode, nodes, links, sensorIdx) {
  const typeOf = (n) => (n?.nodeType || n?.label);
  const ctx = inferZoneContext(nodes, links, zoneNode);
  const slugged = slug(zoneNode.name || zoneNode.id || `zone-${sensorIdx}`);
  const cloudId = `sensor-${slugged}`;
  const devId = `Device:sensor:${slugged}`;
  const exists = nodes.find((n) => n.cloudId === cloudId || n.id === devId);
  if (exists) return { created: false, node: exists, context: ctx };
  const name = `${zoneNode.name || 'Zone'} Sensor`;
  const deviceNode = {
    id: devId,
    label: 'Device',
    name,
    nodeType: 'Device',
    type: 'Sensor',
    hasData: true,
    properties: {
      name,
      label: 'Environmental Sensor',
      id: devId,
      isActive: true,
      cloudId,
      deviceType: 'Sensor'
    },
    cloudId
  };
  nodes.push(deviceNode);
  links.push({ source: devId, target: zoneNode.id, rel: 'LOCATED_IN_ZONE' });
  if (ctx.floor) {
    const floorNode = nodes.find((n) => typeOf(n) === 'Floor' && (n.name === ctx.floor || n.id === ctx.floor));
    if (floorNode) links.push({ source: devId, target: floorNode.id, rel: 'LOCATED_ON_FLOOR' });
  }
  if (ctx.building) {
    const buildingNode = nodes.find((n) => typeOf(n) === 'Building' && (n.name === ctx.building || n.id === ctx.building));
    if (buildingNode) links.push({ source: devId, target: buildingNode.id, rel: 'IN_BUILDING' });
  }
  return { created: true, node: deviceNode, context: ctx };
}

function generateTelemetryRows(seed = 10, hours = 24 * 7) {
  const start = Date.parse('2024-09-01T00:00:00Z');
  const rows = [];
  let cumulative = 0;
  for (let i = 0; i < hours; i++) {
    const ts = start + i * 60 * 60 * 1000;
    const dailyPhase = Math.sin((i % 24) / 24 * Math.PI * 2);
    const energy = Math.max(5, seed + dailyPhase * 2 + (Math.random() * 1.5 - 0.5));
    cumulative += energy;
    rows.push({
      ts,
      energy_kwh: Number(energy.toFixed(2)),
      power_kw: Number((energy / 1).toFixed(2)),
      total_kwh: Number(cumulative.toFixed(2))
    });
  }
  return rows;
}

function writeTelemetryCsv(deviceId, rows) {
  const header = ['ts', 'energy_kwh', 'power_kw', 'total_kwh'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([r.ts, r.energy_kwh, r.power_kw, r.total_kwh].join(','));
  }
  fs.mkdirSync(telemetryDir, { recursive: true });
  const file = path.join(telemetryDir, `${deviceId}.csv`);
  fs.writeFileSync(file, lines.join('\n'));
  return file;
}

function generateSensorRows(seed = 50, hours = 24 * 7) {
  const start = Date.parse('2024-09-01T00:00:00Z');
  const rows = [];
  let cumulative = 0;
  for (let i = 0; i < hours; i++) {
    const ts = start + i * 60 * 60 * 1000;
    const wave = Math.sin((i % 24) / 24 * Math.PI * 2);
    const pressure = Math.max(95, seed + wave * 3 + (Math.random() * 2 - 1)); // kPa
    const flow = Math.max(5, seed / 5 + wave * 1 + (Math.random() * 1 - 0.5)); // L/min
    const vibration = Math.max(0.1, 0.2 + wave * 0.05 + Math.random() * 0.05);
    cumulative += flow;
    rows.push({
      ts,
      pressure_kpa: Number(pressure.toFixed(2)),
      flow_lpm: Number(flow.toFixed(2)),
      vibration_mm_s: Number(vibration.toFixed(3)),
      total_flow_l: Number(cumulative.toFixed(2))
    });
  }
  return rows;
}

function writeSensorTelemetry(deviceId, rows) {
  const header = ['ts', 'pressure_kpa', 'flow_lpm', 'vibration_mm_s', 'total_flow_l'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([r.ts, r.pressure_kpa, r.flow_lpm, r.vibration_mm_s, r.total_flow_l].join(','));
  }
  fs.mkdirSync(telemetryDir, { recursive: true });
  const file = path.join(telemetryDir, `${deviceId}.csv`);
  fs.writeFileSync(file, lines.join('\n'));
  return file;
}

function ensureIAQForZone(zoneNode, buildingNode, floorNode, nodes, links) {
  const typeOf = (n) => (n?.nodeType || n?.label);
  const zName = zoneNode?.name || zoneNode?.id || 'Zone';
  const bName = buildingNode?.name || buildingNode?.id || 'Building';
  const slugged = slug(`${bName}-${zName}`);
  const cloudId = `iaq-${slugged}`;
  const devId = `Device:iaq:${slugged}`;
  const existing = nodes.find((n) => n.id === devId || n.cloudId === cloudId);
  if (existing) return { created: false, node: existing };
  const name = `IAQ Sensor - ${zName}`;
  const deviceNode = {
    id: devId,
    label: 'Device',
    name,
    nodeType: 'Device',
    type: 'IAQ Sensor',
    hasData: true,
    properties: {
      name,
      label: 'IAQ Sensor',
      id: devId,
      isActive: true,
      cloudId,
      deviceType: 'Sensor'
    },
    cloudId
  };
  nodes.push(deviceNode);
  links.push({ source: devId, target: zoneNode.id, rel: 'LOCATED_IN_ZONE' });
  if (floorNode) links.push({ source: devId, target: floorNode.id, rel: 'LOCATED_ON_FLOOR' });
  if (buildingNode) links.push({ source: devId, target: buildingNode.id, rel: 'IN_BUILDING' });
  return { created: true, node: deviceNode };
}

function generateIAQRows(seed = 22, hours = 24 * 7) {
  const start = Date.parse('2024-09-01T00:00:00Z');
  const rows = [];
  let waterTotal = 0;
  for (let i = 0; i < hours; i++) {
    const ts = start + i * 60 * 60 * 1000;
    const dayPhase = Math.sin((i % 24) / 24 * Math.PI * 2);
    const temp = seed + dayPhase * 3 + (Math.random() * 1.5 - 0.75);
    const humidity = 40 + dayPhase * 10 + (Math.random() * 5 - 2.5);
    const nh3 = 3 + Math.random() * 2;
    const o3 = 18 + Math.random() * 10;
    const lux = Math.max(50, 200 + dayPhase * 120 + Math.random() * 50);
    const water = Math.max(0.1, 0.3 + Math.random() * 0.5);
    waterTotal += water;
    rows.push({
      ts,
      temperature_c: Number(temp.toFixed(2)),
      humidity_pct: Number(humidity.toFixed(1)),
      nh3_ppm: Number(nh3.toFixed(2)),
      o3_ppb: Number(o3.toFixed(1)),
      lux: Number(lux.toFixed(0)),
      water_usage_l: Number(waterTotal.toFixed(2))
    });
  }
  return rows;
}

function writeIAQTelemetry(deviceId, rows) {
  const header = ['ts', 'temperature_c', 'humidity_pct', 'nh3_ppm', 'o3_ppb', 'lux', 'water_usage_l'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([r.ts, r.temperature_c, r.humidity_pct, r.nh3_ppm, r.o3_ppb, r.lux, r.water_usage_l].join(','));
  }
  fs.mkdirSync(telemetryDir, { recursive: true });
  const file = path.join(telemetryDir, `${deviceId}.csv`);
  fs.writeFileSync(file, lines.join('\n'));
  return file;
}

function ensurePeopleCounterForZone(zoneNode, buildingNode, floorNode, nodes, links) {
  const typeOf = (n) => (n?.nodeType || n?.label);
  const zName = zoneNode?.name || zoneNode?.id || 'Zone';
  const bName = buildingNode?.name || buildingNode?.id || 'Building';
  const slugged = slug(`${bName}-${zName}-people`);
  const cloudId = `people-${slugged}`;
  const devId = `Device:people:${slugged}`;
  const existing = nodes.find((n) => n.id === devId || n.cloudId === cloudId);
  if (existing) return { created: false, node: existing };
  const name = `People Counter - ${zName}`;
  const deviceNode = {
    id: devId,
    label: 'Device',
    name,
    nodeType: 'Device',
    type: 'People Counter',
    hasData: true,
    properties: {
      name,
      label: 'People Counter',
      id: devId,
      isActive: true,
      cloudId,
      deviceType: 'Sensor'
    },
    cloudId
  };
  nodes.push(deviceNode);
  links.push({ source: devId, target: zoneNode.id, rel: 'LOCATED_IN_ZONE' });
  if (floorNode) links.push({ source: devId, target: floorNode.id, rel: 'LOCATED_ON_FLOOR' });
  if (buildingNode) links.push({ source: devId, target: buildingNode.id, rel: 'IN_BUILDING' });
  return { created: true, node: deviceNode };
}

function generatePeopleRows(seed = 10, hours = 24 * 7) {
  const start = Date.parse('2024-09-01T00:00:00Z');
  const rows = [];
  for (let i = 0; i < hours; i++) {
    const ts = start + i * 60 * 60 * 1000;
    const hour = i % 24;
    const peak = hour >= 8 && hour <= 18 ? 1 : 0.2;
    const variance = Math.max(0, seed * peak + (Math.random() * seed * 0.5 - seed * 0.25));
    const entry = Math.max(0, Math.round(variance * 0.6 + Math.random() * 3));
    const exit = Math.max(0, Math.round(variance * 0.4 + Math.random() * 2));
    const people = Math.max(0, Math.round(variance));
    rows.push({ ts, people_count: people, entry_count: entry, exit_count: exit });
  }
  return rows;
}

function writePeopleTelemetry(deviceId, rows) {
  const header = ['ts', 'people_count', 'entry_count', 'exit_count'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([r.ts, r.people_count, r.entry_count, r.exit_count].join(','));
  }
  fs.mkdirSync(telemetryDir, { recursive: true });
  const file = path.join(telemetryDir, `${deviceId}.csv`);
  fs.writeFileSync(file, lines.join('\n'));
  return file;
}

function upsertAlias(aliasData, aliases) {
  const key = aliasData.name || aliasData.id;
  if (!key) return;
  const existing = aliases[key] || {};
  const syns = new Set([...(existing.synonyms || []), ...(aliasData.synonyms || [])]);
  aliases[key] = {
    ...existing,
    id: aliasData.id,
    name: aliasData.name || key,
    building: aliasData.building || existing.building || null,
    floor: aliasData.floor || existing.floor || null,
    zone: aliasData.zone || existing.zone || null,
    synonyms: Array.from(syns)
  };
}

function main() {
  const snapshots = listSnapshots();
  if (!snapshots.length) {
    console.error('No graph_snapshot*.json files found in data/.');
    process.exit(1);
  }

  const meterDevices = [];
  const sensorDevices = [];
  const iaqDevices = [];
  const peopleDevices = [];
  for (const file of snapshots) {
    const snap = loadJson(file, null);
    if (!snap || !Array.isArray(snap.nodes) || !Array.isArray(snap.links)) continue;
    const nodes = snap.nodes;
    const links = snap.links;
    const buildings = nodes.filter((n) => (n.nodeType || n.label) === 'Building');
    let updated = false;
    console.log(`[process] ${path.basename(file)} -> buildings ${buildings.length}`);
    for (const b of buildings) {
      const added = ensureMeterDevice(b, nodes, links);
      for (const { node, created } of added) {
        const meta = { building: b.name || b.id, id: node.cloudId || node.id, name: node.name };
        meterDevices.push(meta);
        if (created) updated = true;
      }
      // Per-zone meters
      const zones = nodes.filter((n) => (n.nodeType || n.label) === 'Zone')
        .filter((z) => {
          // Keep zones that belong to this building via links
          return links.some((l) => l.source === z.id && ['LOCATED_IN_BUILDING', 'PART_OF_BUILDING', 'BELONGS_TO_BUILDING'].includes(l.rel) && l.target === b.id)
            || links.some((l) => l.source === z.id && ['BELONGS_TO_FLOOR', 'LOCATED_ON_FLOOR', 'PART_OF_FLOOR'].includes(l.rel) && (() => {
              const floorNode = nodes.find((n) => n.id === l.target);
              if (!floorNode) return false;
              return links.some((lf) => lf.source === floorNode.id && ['LOCATED_IN_BUILDING', 'PART_OF_BUILDING', 'BELONGS_TO_BUILDING'].includes(lf.rel) && lf.target === b.id);
            })());
        });
      for (const z of zones) {
        const meta = inferDeviceBuilding(nodes, links, z);
        const addedZone = ensureMeterForZone(z, nodes, links, meta.building || b.name || b.id, meta.floor);
        for (const { node, created } of addedZone) {
          meterDevices.push({ building: meta.building || b.name || b.id, zone: z.name || z.id, id: node.cloudId || node.id, name: node.name });
          if (created) updated = true;
        }
      }
      // Add new sensor devices to a subset of zones (10 zones per snapshot, deterministic by name)
      const allZones = nodes.filter((n) => (n.nodeType || n.label) === 'Zone').sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
      const targetZones = allZones.slice(0, 10);
      targetZones.forEach((z, idx) => {
        const result = ensureSensorForZone(z, nodes, links, idx);
        if (result.created) {
          const ctx = result.context;
          const meta = { building: ctx.building || b.name || b.id, zone: ctx.zone, id: result.node.cloudId || result.node.id, name: result.node.name };
          sensorDevices.push(meta);
          updated = true;
        }
      });

      // Mirror in hierarchical convenience block if present
      const hb = Array.isArray(snap.buildings) ? snap.buildings.find((x) => (x.id === b.id) || (x.name === b.name)) : null;
      if (hb && !Array.isArray(hb.devices)) hb.devices = [];
      if (hb && added.some(({ created }) => created)) {
        const newDevNodes = added.filter(({ created }) => created).map(({ node }) => ({
          id: node.id,
          name: node.name,
          label: node.label,
          properties: node.properties,
          type: node.type,
          cloudId: node.cloudId
        }));
        hb.devices.push(...newDevNodes);
        updated = true;
      }
      if (hb) {
        // Attach zone-level meters into hierarchical zones
        const zoneMeters = meterDevices.filter((m) => m.zone && m.building === (b.name || b.id));
        for (const zm of zoneMeters) {
          const devNode = nodes.find((n) => (n.cloudId === zm.id || n.id === zm.id));
          const zoneNode = nodes.find((n) => (n.nodeType || n.label) === 'Zone' && (n.name === zm.zone || n.id === zm.zone));
          if (devNode && zoneNode) {
            const attached = attachDeviceToHierarchy(hb, zoneNode, devNode);
            if (attached) updated = true;
          }
        }
        // Attach sensor devices into hierarchical zones
        const zoneSensors = sensorDevices.filter((m) => m.zone && m.building === (b.name || b.id));
        for (const zs of zoneSensors) {
          const devNode = nodes.find((n) => (n.cloudId === zs.id || n.id === zs.id));
          const zoneNode = nodes.find((n) => (n.nodeType || n.label) === 'Zone' && (n.name === zs.zone || n.id === zs.zone));
          if (devNode && zoneNode) {
            const attached = attachDeviceToHierarchy(hb, zoneNode, devNode);
            if (attached) updated = true;
          }
        }
        // Attach IAQ devices into hierarchical zones
        const zoneIAQs = iaqDevices.filter((m) => m.zone && m.building === (b.name || b.id));
        for (const zs of zoneIAQs) {
          const devNode = nodes.find((n) => (n.cloudId === zs.id || n.id === zs.id));
          const zoneNode = nodes.find((n) => (n.nodeType || n.label) === 'Zone' && (n.name === zs.zone || n.id === zs.zone));
          if (devNode && zoneNode) {
            const attached = attachDeviceToHierarchy(hb, zoneNode, devNode);
            if (attached) updated = true;
          }
        }
      }
      // Add IAQ device for every zone in the building
      for (const z of zones) {
        const floorLink = links.find((l) => l.source === z.id && ['BELONGS_TO_FLOOR', 'LOCATED_ON_FLOOR', 'PART_OF_FLOOR'].includes(l.rel));
        const floorNode = floorLink ? nodes.find((n) => n.id === floorLink.target) : null;
        const { created, node } = ensureIAQForZone(z, b, floorNode, nodes, links);
        iaqDevices.push({ building: b.name || b.id, zone: z.name || z.id, id: node.cloudId || node.id, name: node.name });
        if (created) updated = true;
        const pc = ensurePeopleCounterForZone(z, b, floorNode, nodes, links);
        peopleDevices.push({ building: b.name || b.id, zone: z.name || z.id, id: pc.node.cloudId || pc.node.id, name: pc.node.name });
        if (pc.created) updated = true;
      }
      console.log(`[process] ${b.name || b.id}: zones ${zones.length}, meters ${added.length}, iaq+people ${zones.length * 2}`);
    }
    if (updated) {
      snap.nodes = nodes;
      snap.links = links;
      writeJson(file, snap);
      console.log(`[meters] Updated snapshot ${path.basename(file)} (buildings=${buildings.length})`);
    }
  }

  // Final pass: normalize all meter identities/placement to match their buildings.
  for (const file of snapshots) {
    const snap = loadJson(file, null);
    if (!snap || !Array.isArray(snap.nodes) || !Array.isArray(snap.links)) continue;
    const nodes = snap.nodes;
    const links = snap.links;
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const typeOf = (n) => (n?.nodeType || n?.label);
    let changed = false;
    for (const m of nodes.filter((n) => typeOf(n) === 'Device' && isMeterDevice(n))) {
      let buildingLink = links.find((l) => l.source === m.id && l.rel === 'IN_BUILDING');
      let building = buildingLink ? byId.get(buildingLink.target) : null;
      // If missing building link, try to infer from name or cloudId
      if (!building) {
        const inferredName = (m.name || '').replace(/^Utility Meter - /i, '').trim() || (m.cloudId || '').replace(/^meter-/, '').replace(/_/g, ' ').trim();
        const cand = nodes.find((n) => typeOf(n) === 'Building' && (n.name === inferredName || slug(n.name) === slug(inferredName) || slug(n.id || '') === slug(inferredName)));
        if (cand) {
          building = cand;
          links.push({ source: m.id, target: cand.id, rel: 'IN_BUILDING' });
        }
      }
      if (!building) continue;
      const bName = building.name || building.id;
      const desiredSlug = slug(bName);
      const desiredId = `Device:meter:${desiredSlug}`;
      const desiredCloud = `meter-${desiredSlug}`;
      const desiredName = `Utility Meter - ${bName}`;
      if (m.id !== desiredId) {
        for (const l of links) {
          if (l.source === m.id) l.source = desiredId;
          if (l.target === m.id) l.target = desiredId;
        }
        m.id = desiredId;
        changed = true;
      }
      if (m.cloudId !== desiredCloud) { m.cloudId = desiredCloud; changed = true; }
      if (!m.properties) m.properties = {};
      if (m.properties.cloudId !== desiredCloud) { m.properties.cloudId = desiredCloud; changed = true; }
      if (m.name !== desiredName) { m.name = desiredName; m.properties.name = desiredName; m.properties.label = 'Utility Meter'; changed = true; }
      // ensure zone placement exists
      const hasZone = links.some((l) => l.source === m.id && l.rel === 'LOCATED_IN_ZONE');
      if (!hasZone) {
        const zones = nodes.filter((n) => typeOf(n) === 'Zone' && links.some((l) => l.source === n.id && ['LOCATED_IN_BUILDING', 'PART_OF_BUILDING', 'BELONGS_TO_BUILDING'].includes(l.rel) && l.target === building.id));
        let pickedZone = zones[0];
        if (!pickedZone) {
          const zoneId = `Zone:utility:${desiredSlug}`;
          pickedZone = byId.get(zoneId);
          if (!pickedZone) {
            pickedZone = {
              id: zoneId,
              label: 'Zone',
              name: `${bName} Utility`,
              nodeType: 'Zone',
              roomId: `utility-${desiredSlug}`,
              properties: { name: `${bName} Utility`, isActive: true }
            };
            nodes.push(pickedZone);
            byId.set(zoneId, pickedZone);
            links.push({ source: zoneId, target: building.id, rel: 'LOCATED_IN_BUILDING' });
          }
        }
        links.push({ source: m.id, target: pickedZone.id, rel: 'LOCATED_IN_ZONE' });
        changed = true;
      }
    }
    if (changed) {
      writeJson(file, snap);
      console.log(`[normalize] ${path.basename(file)} meters normalized`);
    }
  }

  // Ensure aliases so the agent can resolve meters by building name.
  const aliases = loadJson(aliasPath, {});
  for (const m of meterDevices) {
    const syns = [
      `${m.building} meter`,
      `${m.building} utility meter`,
      `${m.building} energy`
    ];
    if (m.zone) {
      syns.push(`${m.zone} meter`, `${m.zone} utility meter`, `${m.zone} energy`, `${m.zone} (${m.building}) meter`);
    }
    upsertAlias({
      id: m.id,
      name: m.name || (m.zone ? `${m.zone} meter` : `${m.building} meter`),
      building: m.building,
      zone: m.zone || null,
      synonyms: syns
    }, aliases);
  }
  for (const s of sensorDevices) {
    const syns = [
      `${s.building} ${s.zone} sensor`,
      `${s.zone} sensor`,
      `${s.zone} pressure`,
      `${s.zone} flow`,
      `${s.zone} vibration`
    ];
    upsertAlias({
      id: s.id,
      name: s.name || `${s.zone} sensor`,
      building: s.building,
      zone: s.zone || null,
      synonyms: syns
    }, aliases);
  }
  for (const s of iaqDevices) {
    const syns = [
      `${s.building} ${s.zone} iaq`,
      `${s.zone} iaq`,
      `${s.zone} air quality`,
      `${s.zone} humidity`,
      `${s.zone} temperature`,
      `${s.zone} nh3`,
      `${s.zone} o3`,
      `${s.zone} lux`,
      `${s.zone} water`
    ];
    upsertAlias({
      id: s.id,
      name: s.name || `${s.zone} IAQ`,
      building: s.building,
      zone: s.zone || null,
      synonyms: syns
    }, aliases);
  }
  for (const s of peopleDevices) {
    const syns = [
      `${s.building} ${s.zone} people`,
      `${s.zone} people`,
      `${s.zone} occupancy`,
      `${s.zone} footfall`
    ];
    upsertAlias({
      id: s.id,
      name: s.name || `${s.zone} people counter`,
      building: s.building,
      zone: s.zone || null,
      synonyms: syns
    }, aliases);
  }
  writeJson(aliasPath, aliases);

  // Generate telemetry for each meter (existing or newly created)
  const uniqueMeters = Array.from(new Map(meterDevices.map((m) => [m.id, m])).values());
  uniqueMeters.forEach((m, idx) => {
    const rows = generateTelemetryRows(10 + idx % 5);
    writeTelemetryCsv(m.id, rows);
  });

  // Telemetry for sensors
  const uniqueSensors = Array.from(new Map(sensorDevices.map((m) => [m.id, m])).values());
  uniqueSensors.forEach((m, idx) => {
    const rows = generateSensorRows(50 + (idx % 7));
    writeSensorTelemetry(m.id, rows);
  });
  const uniqueIAQ = Array.from(new Map(iaqDevices.map((m) => [m.id, m])).values());
  uniqueIAQ.forEach((m, idx) => {
    const rows = generateIAQRows(20 + (idx % 5));
    writeIAQTelemetry(m.id, rows);
  });
  const uniquePeople = Array.from(new Map(peopleDevices.map((m) => [m.id, m])).values());
  uniquePeople.forEach((m, idx) => {
    const rows = generatePeopleRows(10 + (idx % 6));
    writePeopleTelemetry(m.id, rows);
  });
  console.log(`Done. Generated telemetry in ${path.relative(root, telemetryDir)} for ${uniqueMeters.length} meter(s), ${uniqueSensors.length} sensor(s), ${uniqueIAQ.length} IAQ device(s), ${uniquePeople.length} people counter(s).`);
}

main();
