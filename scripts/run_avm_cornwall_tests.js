#!/usr/bin/env node
/**
 * Scenario test runner for AVM Solutions – Cornwall Building.
 *
 * Generates 30 metric-focused chat queries across 1/2/3 week ranges,
 * assuming the current date is 24 October 2025. Results (answers, chart metadata,
 * elapsed time, trace size) are persisted under data/tests/.
 *
 * Requirements:
 *  - Local server running (scripts/dev_controls.sh start)
 *  - Node 18+ (built-in fetch)
 *
 * Usage:
 *   node scripts/run_avm_cornwall_tests.js
 *
 * Environment overrides:
 *   TEST_BASE_URL     (default http://localhost:3000)
 *   TEST_RESULTS_DIR  (default data/tests)
 *   TEST_REF_DATE     (default 2025-10-24T23:59:00Z)
 *   TEST_DURATIONS    (comma list in days, default "7,14,21")
 */
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const RESULTS_DIR = process.env.TEST_RESULTS_DIR || path.join('data', 'tests');
const TENANT = 'AVM Solutions';
const BUILDING = 'Cornwall Building';
const REF_DATE = Date.parse(process.env.TEST_REF_DATE || '2025-10-24T23:59:00Z');
const CSV_DIR = process.env.TEST_CSV_DIR || path.join('CSVex_s3');

if (!Number.isFinite(REF_DATE)) {
  throw new Error('Invalid TEST_REF_DATE; expected an ISO timestamp.');
}

async function fetchJson(url, init) {
  const res = await fetch(`${BASE_URL}${url}`, init);
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`HTTP ${res.status} ${url}: ${msg}`);
  }
  return res.json();
}

function canonicalFieldName(label) {
  return String(label || '').trim();
}

function buildSelection(meta) {
  const floors = new Set();
  const zones = new Set();
  const devices = new Set();
  const deviceZones = {};

  const pushDevice = (device, zoneName) => {
    if (!device) return;
    const id =
      device.cloud_id ||
      device.cloudId ||
      device.deviceId ||
      device.id ||
      device.name ||
      null;
    if (!id) return;
    const key = String(id);
    devices.add(key);
    deviceZones[key] = zoneName || null;
  };

  const groups = Array.isArray(meta?.groups) ? meta.groups : [];
  for (const group of groups) {
    const floorsArr = Array.isArray(group?.floors) ? group.floors : [];
    for (const floor of floorsArr) {
      if (floor?.floor) floors.add(String(floor.floor));
      const zoneArr = Array.isArray(floor?.zones) ? floor.zones : [];
      for (const zone of zoneArr) {
        const zoneName = zone?.zone || zone?.name || null;
        if (zoneName) zones.add(String(zoneName));
        const deviceArr = Array.isArray(zone?.devices) ? zone.devices : [];
        for (const device of deviceArr) {
          pushDevice(device, zoneName);
        }
      }
    }
  }

  return {
    tenant: TENANT,
    building: BUILDING,
    floors: Array.from(floors),
    zones: Array.from(zones),
    devices: Array.from(devices),
    deviceZones,
    labels: {
      tenant: TENANT,
      building: BUILDING,
      floor: null,
      room: null
    }
  };
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

function formatTs(ms) {
  const d = new Date(ms);
  return `${d.toISOString().replace('T', ' ').slice(0, 16)} (${ms})`;
}

async function readDeviceMetrics(deviceId, cache) {
  if (cache.has(deviceId)) return cache.get(deviceId);
  const file = path.join(CSV_DIR, `${deviceId}.csv`);
  let metrics = [];
  try {
    const raw = await fs.readFile(file, 'utf8');
    const [header] = raw.split(/\r?\n/, 1);
    if (header) {
      metrics = header
        .split(',')
        .map((h) => h.trim())
        .filter((h) => h && h !== 'ts');
    }
  } catch {
    metrics = [];
  }
  cache.set(deviceId, metrics);
  return metrics;
}

function buildFriendlyToCloudMap() {
  const map = new Map();
  try {
    const csvPath = path.join('data', 'graph_form', 'devices.csv');
    if (!fsSync.existsSync(csvPath)) return map;
    const text = fsSync.readFileSync(csvPath, 'utf8');
    const lines = text.split(/\r?\n/).filter((line) => line.trim().length);
    if (!lines.length) return map;
    const headers = lines[0].split(',').map((h) => h.trim());
    for (let i = 1; i < lines.length; i += 1) {
      const parts = lines[i].split(',');
      const row = {};
      headers.forEach((h, idx) => { row[h] = (parts[idx] || '').trim(); });
      if (row.name && row.cloud_id) {
        map.set(row.name, row.cloud_id);
      }
    }
  } catch (err) {
    console.warn('[run_avm_cornwall_tests] failed to read devices.csv', err);
  }
  return map;
}

const FRIENDLY_TO_CLOUD = buildFriendlyToCloudMap();

const CORNWALL_HIERARCHY = {
  building: 'Cornwall Building',
  floors: {
    'Fourth Floor': {
      zones: {
        Comms: [
          {
            id: 'Water Meter_AmRUN3AzIrJd',
            metrics: ['battery', 'cubic_value', 'humidity', 'raw_data', 'temperature', 'water_total'],
            type: 'water'
          }
        ]
      }
    },
    'Ground Floor': {
      zones: {
        'Room 2': [
          {
            id: 'IAQ_y2mcNuuXcDTr',
            metrics: ['airExchangeRate', 'battery', 'co2', 'humidity', 'lux', 'mold', 'occupants', 'occupantsLower', 'occupantsUpper', 'pressure', 'radonShortTermAvg', 'rssi', 'temperature', 'time', 'virusRisk', 'voc'],
            type: 'iaq'
          }
        ],
        'Room 5': [
          {
            id: 'IAQ_jb6WMm7pPFHV',
            metrics: ['airExchangeRate', 'battery', 'co2', 'humidity', 'lux', 'mold', 'occupants', 'occupantsLower', 'occupantsUpper', 'pressure', 'radonShortTermAvg', 'rssi', 'temperature', 'time', 'virusRisk', 'voc'],
            type: 'iaq'
          }
        ],
        'Room 8': [
          {
            id: 'IAQ_BbanNjLRjJEK',
            metrics: ['airExchangeRate', 'battery', 'co2', 'humidity', 'lux', 'mold', 'occupants', 'occupantsLower', 'occupantsUpper', 'pressure', 'radonShortTermAvg', 'rssi', 'temperature', 'time', 'virusRisk', 'voc'],
            type: 'iaq'
          }
        ],
        'Room 4': [
          {
            id: 'IAQ_wUXUUolFJYK9',
            metrics: ['airExchangeRate', 'battery', 'co2', 'humidity', 'lux', 'occupants', 'pm1', 'pm10', 'pm25', 'pressure', 'rssi', 'sla', 'temperature', 'time', 'virusRisk', 'voc'],
            type: 'iaq'
          }
        ],
        Coworking: [
          {
            id: 'IAQ_snIQf0ZRGHAv',
            metrics: ['airExchangeRate', 'battery', 'co2', 'humidity', 'lux', 'occupants', 'pm1', 'pm10', 'pm25', 'pressure', 'rssi', 'sla', 'temperature', 'time', 'virusRisk', 'voc'],
            type: 'iaq'
          }
        ],
        Gem: [
          {
            id: 'IAQ_h9zKxsIn3YYV',
            metrics: ['airExchangeRate', 'battery', 'co2', 'humidity', 'lux', 'occupants', 'pm1', 'pm10', 'pm25', 'pressure', 'rssi', 'sla', 'temperature', 'time', 'virusRisk', 'voc'],
            type: 'iaq'
          }
        ],
        'Room 6': [
          {
            id: 'IAQ_2Mx02nIKVGL4',
            metrics: ['airExchangeRate', 'battery', 'co2', 'humidity', 'lux', 'mold', 'occupants', 'occupantsLower', 'occupantsUpper', 'pressure', 'radonShortTermAvg', 'rssi', 'temperature', 'time', 'virusRisk', 'voc'],
            type: 'iaq'
          }
        ],
        'Room 1': [
          {
            id: 'IAQ_LANa7c0nlzIi',
            metrics: ['airExchangeRate', 'battery', 'co2', 'humidity', 'lux', 'mold', 'occupants', 'occupantsLower', 'occupantsUpper', 'pressure', 'radonShortTermAvg', 'rssi', 'temperature', 'time', 'virusRisk', 'voc'],
            type: 'iaq'
          }
        ],
        'Room 3': [
          {
            id: 'IAQ_KcWGBiSXBgiH',
            metrics: ['airExchangeRate', 'battery', 'co2', 'humidity', 'lux', 'mold', 'occupants', 'occupantsLower', 'occupantsUpper', 'pressure', 'radonShortTermAvg', 'rssi', 'temperature', 'time', 'virusRisk', 'voc'],
            type: 'iaq'
          }
        ],
        'Room 7': [
          {
            id: 'IAQ_tkhi6FivR9TG',
            metrics: ['airExchangeRate', 'battery', 'co2', 'humidity', 'lux', 'mold', 'occupants', 'occupantsLower', 'occupantsUpper', 'pressure', 'radonShortTermAvg', 'rssi', 'temperature', 'time', 'virusRisk', 'voc'],
            type: 'iaq'
          }
        ],
        'Cafe + Lounge': [
          {
            id: 'Mechanical_6GLhDh3LhfoA',
            metrics: ['powerFailure', 'raw_data', 'total_kwh', 'unit', 'value'],
            type: 'energy'
          },
          {
            id: 'Lighting_AZ8sHHCcBlzW',
            metrics: ['powerFailure', 'raw_data', 'total_kwh', 'unit', 'value'],
            type: 'energy'
          },
          {
            id: 'SmallPower_cOApV9qH6UMo',
            metrics: ['powerFailure', 'raw_data', 'total_kwh', 'unit', 'value'],
            type: 'energy'
          }
        ],
        Lounge: [
          {
            id: 'IAQ_QhyE1TAlqL4E',
            metrics: ['airExchangeRate', 'battery', 'co2', 'humidity', 'lux', 'occupants', 'pm1', 'pm10', 'pm25', 'pressure', 'rssi', 'sla', 'temperature', 'time', 'virusRisk', 'voc'],
            type: 'iaq'
          }
        ],
        'Comms Room': [
          {
            id: 'People Flow_waTDvSKxFbK4',
            metrics: ['flow', 'raw_data'],
            type: 'people_flow'
          },
          {
            id: 'People Counter_eTcrozehAwoZ',
            metrics: ['people_count', 'raw_data'],
            type: 'people'
          }
        ]
      }
    },
    'First Floor': {
      zones: {
        Comms: [
          {
            id: 'Energy_BGi4Bzh1KWkJ',
            metrics: ['powerFailure', 'raw_data', 'total_kwh', 'unit', 'value'],
            type: 'energy'
          }
        ],
        Cafe: [
          {
            id: 'People Counter_xNrPaURS4r6p',
            metrics: ['dwell', 'heatmap', 'line_periodic_data', 'line_total_data', 'raw'],
            type: 'people'
          }
        ],
        Toilet: [
          {
            id: 'Odor _hjtgm3AUNSdO',
            metrics: ['battery', 'h2s', 'humidity', 'nh3', 'raw_data', 'temperature'],
            type: 'odor'
          },
          {
            id: 'Water Leak_MdGf5j3Ae9Zs',
            metrics: ['battery', 'leakage_status', 'raw_data'],
            type: 'leak'
          }
        ],
        Brainstorm: [
          {
            id: 'Temperature_AvYwOcSkqEZb',
            metrics: ['humidity', 'raw_data', 'temperature', 'units'],
            type: 'temperature'
          }
        ],
        'Cafe + Lounge': [
          {
            id: 'Occupancy_lzDbZpSWkLkT',
            metrics: ['is_used', 'occupancy', 'raw_data', 'supplyVoltage', 'units', 'value'],
            type: 'occupancy'
          }
        ]
      }
    }
  }
};

function extractDeviceMapping() {
  const zoneMetrics = {};
  const zoneDevices = {};
  const deviceMeta = {};
  const friendlyMeta = {};

  for (const [floorName, floor] of Object.entries(CORNWALL_HIERARCHY.floors)) {
    for (const [zoneName, devices] of Object.entries(floor.zones)) {
      const zoneKey = zoneName;
      if (!zoneMetrics[zoneKey]) zoneMetrics[zoneKey] = new Set();
      if (!zoneDevices[zoneKey]) zoneDevices[zoneKey] = [];
      devices.forEach((device) => {
        const friendly = device.id;
        const cloudId = FRIENDLY_TO_CLOUD.get(friendly) || friendly;
        zoneDevices[zoneKey].push(cloudId);
        const entry = {
          cloudId,
          friendlyName: friendly,
          metrics: device.metrics,
          type: device.type,
          floor: floorName,
          zone: zoneName
        };
        deviceMeta[cloudId] = entry;
        friendlyMeta[friendly] = entry;
        device.metrics.forEach((metric) => zoneMetrics[zoneKey].add(metric));
      });
    }
  }

  return {
    zoneMetrics: Object.fromEntries(Object.entries(zoneMetrics).map(([zone, set]) => [zone, Array.from(set)])),
    zoneDevices,
    deviceMeta,
    friendlyMeta
  };
}

const {
  zoneMetrics: STATIC_ZONE_METRICS,
  zoneDevices: STATIC_ZONE_DEVICES,
  deviceMeta: STATIC_DEVICE_META,
  friendlyMeta: STATIC_DEVICE_BY_FRIENDLY
} = extractDeviceMapping();

function zonesByType(deviceType) {
  const zones = new Set();
  for (const meta of Object.values(STATIC_DEVICE_META)) {
    if (meta.type === deviceType && meta.zone) zones.add(meta.zone);
  }
  return Array.from(zones);
}

function devicesByType(deviceType) {
  return Object.values(STATIC_DEVICE_META).filter((meta) => meta.type === deviceType);
}

function zoneHasType(zone, deviceType) {
  return Object.values(STATIC_DEVICE_META).some((meta) => meta.zone === zone && meta.type === deviceType);
}

function zonesWithMetric(zoneMetrics, metric) {
  const target = String(metric || '').toLowerCase();
  return Object.entries(zoneMetrics)
    .filter(([, metrics]) =>
      metrics.some((m) => String(m).toLowerCase() === target)
    )
    .map(([zone]) => zone);
}

function pickZone(zoneMetrics, metric, fallback = []) {
  const matches = zonesWithMetric(zoneMetrics, metric);
  if (matches.length) return matches[0];
  for (const candidate of fallback) {
    if (zoneMetrics[candidate]) return candidate;
  }
  return Object.keys(zoneMetrics)[0] || null;
}

function pickMultipleZones(zoneMetrics, metric, count, fallback = []) {
  const matches = Array.from(new Set(zonesWithMetric(zoneMetrics, metric)));
  if (matches.length >= count) return matches.slice(0, count);
  const extras = [];
  for (const candidate of fallback) {
    if (matches.includes(candidate) || extras.includes(candidate)) continue;
    const metrics = zoneMetrics[candidate] || [];
    const hasMetric = metrics.some((m) => canonicalFieldName(m) === canonicalFieldName(metric));
    if (hasMetric) extras.push(candidate);
    if (matches.length + extras.length >= count) break;
  }
  return matches.concat(extras).slice(0, count);
}

function cloneSelection(selection) {
  return JSON.parse(JSON.stringify(selection));
}

function buildScopedSelection(selection, zone, zoneDevices) {
  if (!zone) return selection;
  const devices = zoneDevices[zone] || [];
  if (!devices.length) return selection;
  const primaryDevice = devices[0];
  const deviceZones = {};
  for (const id of devices) {
    deviceZones[id] = STATIC_DEVICE_META[id]?.zone || zone;
  }
  const scoped = cloneSelection(selection);
  scoped.room = primaryDevice;
  scoped.zones = [zone];
  scoped.devices = devices;
  scoped.deviceZones = deviceZones;
  scoped.labels = { ...(selection.labels || {}), room: zone };
  scoped.building = selection.building || CORNWALL_HIERARCHY.building;
  return scoped;
}

function buildMultiZoneSelection(selection, zones = [], zoneDevices) {
  const uniqueZones = Array.from(
    new Set(
      zones
        .map((z) => String(z || '').trim())
        .filter(Boolean)
    )
  );
  const devices = [];
  const deviceZones = {};
  for (const zone of uniqueZones) {
    const ids = zoneDevices[zone] || [];
    for (const id of ids) {
      if (!devices.includes(id)) devices.push(id);
      deviceZones[id] = STATIC_DEVICE_META[id]?.zone || zone;
    }
  }
  if (!devices.length) return selection;
  const scoped = cloneSelection(selection);
  scoped.room = 'ALL';
  scoped.zones = uniqueZones;
  scoped.devices = devices;
  scoped.deviceZones = deviceZones;
  scoped.labels = { ...(selection.labels || {}), room: uniqueZones[0] || null };
  scoped.building = selection.building || CORNWALL_HIERARCHY.building;
  return scoped;
}

function buildDevicesSelection(selection, deviceIds) {
  const valid = deviceIds
    .map((id) => STATIC_DEVICE_META[id] ? id : null)
    .filter(Boolean);
  if (!valid.length) return selection;
  const deviceZones = {};
  const zones = [];
  valid.forEach((id) => {
    const meta = STATIC_DEVICE_META[id];
    const zone = meta?.zone || '(unknown)';
    deviceZones[id] = zone;
    if (!zones.includes(zone)) zones.push(zone);
  });
  const scoped = cloneSelection(selection);
  scoped.room = valid.length === 1 ? valid[0] : 'ALL';
  scoped.zones = zones;
  scoped.devices = valid;
  scoped.deviceZones = deviceZones;
  scoped.labels = {
    ...(selection.labels || {}),
    room: valid.length === 1 ? (STATIC_DEVICE_META[valid[0]]?.zone || null) : (zones.length === 1 ? zones[0] : 'ALL')
  };
  scoped.building = selection.building || CORNWALL_HIERARCHY.building;
  return scoped;
}

function uniqueNonEmpty(values, count) {
  return Array.from(
    new Set(
      (values || [])
        .map((v) => (v ? String(v) : ''))
        .filter(Boolean)
    )
  ).slice(0, count);
}

function ensureZones(list, fallback) {
  const clean = uniqueNonEmpty(list, list?.length || 0);
  if (clean.length) return clean;
  return uniqueNonEmpty(fallback, fallback?.length || 0);
}

function chooseZonesForMetric(zoneMetrics, metric, count, preferred = [], zoneList = []) {
  const canon = canonicalFieldName(metric);
  const seen = new Set();
  const out = [];
  const consider = (zone) => {
    if (!zone) return;
    const key = String(zone);
    if (seen.has(key)) return;
    const metrics = zoneMetrics[key] || [];
    if (metrics.some((m) => canonicalFieldName(m) === canon)) {
      out.push(key);
      seen.add(key);
    }
  };
  preferred.forEach(consider);
  zoneList.forEach(consider);
  return out.slice(0, count);
}

function chooseZoneForMetric(zoneMetrics, metric, preferred = [], zoneList = []) {
  const zones = chooseZonesForMetric(zoneMetrics, metric, 1, preferred, zoneList);
  return zones[0] || null;
}

function findZoneWithMetrics(zoneMetrics, metrics = [], preferred = [], zoneList = []) {
  const canonTargets = metrics.map((m) => canonicalFieldName(m));
  const consider = (zone) => {
    if (!zone) return null;
    const fields = (zoneMetrics[zone] || []).map((m) => canonicalFieldName(m));
    return canonTargets.every((t) => fields.includes(t)) ? zone : null;
  };
  for (const z of preferred) {
    const found = consider(z);
    if (found) return found;
  }
  for (const z of zoneList) {
    const found = consider(z);
    if (found) return found;
  }
  return null;
}

function chooseMany(zoneMetrics, metric, count, preferred = [], zoneList = []) {
  const canon = canonicalFieldName(metric);
  const base = chooseZonesForMetric(zoneMetrics, metric, count, preferred, zoneList);
  if (base.length >= count) return base.slice(0, count);
  const seen = new Set(base);
  for (const zone of zoneList) {
    if (seen.has(zone)) continue;
    const fields = zoneMetrics[zone] || [];
    if (fields.some((m) => canonicalFieldName(m) === canon)) {
      base.push(zone);
      seen.add(zone);
      if (base.length >= count) break;
    }
  }
  return base.slice(0, count);
}

async function main() {
  await ensureDir(RESULTS_DIR);

  const params = new URLSearchParams({ building: BUILDING });
  if (TENANT) params.set('tenant', TENANT);

  const metricsMeta = await fetchJson(`/api/scope/metrics?${params.toString()}`);
  const selection = buildSelection(metricsMeta);
  const allowedDeviceIds = new Set(Object.values(STATIC_ZONE_DEVICES).flat());
  selection.devices = selection.devices.filter((id) => allowedDeviceIds.has(id));
  selection.deviceZones = Object.fromEntries(
    Object.entries(selection.deviceZones)
      .filter(([id]) => allowedDeviceIds.has(id))
  );
  selection.zones = Array.from(new Set([
    ...selection.zones.filter((z) => STATIC_ZONE_DEVICES[z]),
    ...Object.keys(STATIC_ZONE_DEVICES)
  ]));
  if (!selection.devices.length) {
    selection.devices = Object.keys(STATIC_DEVICE_META);
    selection.deviceZones = Object.fromEntries(
      Object.entries(STATIC_DEVICE_META).map(([id, meta]) => [id, meta.zone])
    );
    selection.zones = Array.from(new Set(Object.values(STATIC_DEVICE_META).map((meta) => meta.zone)));
    selection.labels = selection.labels || {};
    selection.labels.building = CORNWALL_HIERARCHY.building;
    selection.building = CORNWALL_HIERARCHY.building;
  }

  const zoneMetrics = STATIC_ZONE_METRICS;
  const zoneDevices = STATIC_ZONE_DEVICES;

  const OCT_START = Date.parse('2025-10-01T00:00:00Z');
  const OCT_END = Date.parse('2025-10-24T23:59:59Z');
  const OCT_RANGE = { start: OCT_START, end: OCT_END };
  const OCT_DURATION_DAYS = Math.round((OCT_END - OCT_START) / 86400000);

  const GROUND_FLOOR_IAQ_ZONES = ['Room 2', 'Room 5', 'Room 8', 'Room 4', 'Coworking', 'Gem', 'Room 6', 'Room 1', 'Room 3', 'Room 7', 'Lounge'];
  const RADON_ROOMS = ['Room 2', 'Room 5', 'Room 6', 'Room 8'];
  const CAFE_ENERGY_DEVICES = ['Mechanical_6GLhDh3LhfoA', 'Lighting_AZ8sHHCcBlzW', 'SmallPower_cOApV9qH6UMo'];
  const ALL_SENSOR_DEVICES = Object.keys(STATIC_DEVICE_META);

  const QUESTION_SET = [
    {
      question: 'What was the humidity in Room 2 on October 15th 2025?',
      devices: ['IAQ_y2mcNuuXcDTr']
    },
    {
      question: 'Show me a plot comparing CO2 levels between Room 5 and Room 8 from October 1 to October 24 2025.',
      zones: ['Room 5', 'Room 8']
    },
    {
      question: 'Is the temperature in the Brainstorm room within normal range on October 24th 2025?',
      devices: ['Temperature_AvYwOcSkqEZb']
    },
    {
      question: 'What is the correlation between humidity and temperature across all Ground Floor IAQ sensors for October 1–24 2025?',
      zones: GROUND_FLOOR_IAQ_ZONES
    },
    {
      question: 'Create a heatmap showing VOC levels across all Ground Floor rooms for October 1–24 2025.',
      zones: GROUND_FLOOR_IAQ_ZONES
    },
    {
      question: 'Are there any anomalies in the air exchange rate for Coworking on October 24th 2025?',
      devices: ['IAQ_snIQf0ZRGHAv']
    },
    {
      question: 'Compare the virus risk metrics between Gem and Lounge over October 1–24 2025.',
      zones: ['Gem', 'Lounge']
    },
    {
      question: 'Is Room 4 unoccupied on October 24th 2025?',
      devices: ['IAQ_wUXUUolFJYK9']
    },
    {
      question: 'Show me a plot of occupant counts in Room 1 versus Room 3 for October 1–24 2025.',
      zones: ['Room 1', 'Room 3']
    },
    {
      question: 'What is the dwell time pattern in the First Floor Cafe on October 24th 2025?',
      devices: ['People Counter_xNrPaURS4r6p']
    },
    {
      question: 'Compare people flow in the Ground Floor Comms Room between weekdays and weekends for October 1–24 2025.',
      devices: ['People Flow_waTDvSKxFbK4']
    },
    {
      question: 'Is the Lounge occupied on October 24th 2025 based on the IAQ sensor?',
      devices: ['IAQ_QhyE1TAlqL4E']
    },
    {
      question: 'What is the correlation between occupants and CO2 levels in Room 6 for October 1–24 2025?',
      devices: ['IAQ_2Mx02nIKVGL4']
    },
    {
      question: 'Show me a heatmap of people counter data in the First Floor Cafe for October 1–24 2025.',
      devices: ['People Counter_xNrPaURS4r6p']
    },
    {
      question: 'What is the total kWh consumption for Cafe + Lounge Mechanical on October 24th 2025?',
      devices: ['Mechanical_6GLhDh3LhfoA']
    },
    {
      question: 'Compare energy usage between Lighting and SmallPower in Cafe + Lounge for October 1–24 2025.',
      devices: ['Lighting_AZ8sHHCcBlzW', 'SmallPower_cOApV9qH6UMo']
    },
    {
      question: 'Are there any anomalies in the First Floor Comms energy consumption pattern during October 1–24 2025?',
      devices: ['Energy_BGi4Bzh1KWkJ']
    },
    {
      question: 'Show me a plot of total_kwh trends for the Cafe + Lounge Mechanical, Lighting, and SmallPower meters for October 1–24 2025.',
      devices: CAFE_ENERGY_DEVICES
    },
    {
      question: 'Has there been a power failure in any energy meters on October 24th 2025?',
      devices: [...CAFE_ENERGY_DEVICES, 'Energy_BGi4Bzh1KWkJ']
    },
    {
      question: 'What is the cubic_value from the Fourth Floor Water Meter for October 1–24 2025?',
      devices: ['Water Meter_AmRUN3AzIrJd']
    },
    {
      question: 'Is there a leakage_status alert in the First Floor Toilet on October 24th 2025?',
      devices: ['Water Leak_MdGf5j3Ae9Zs']
    },
    {
      question: 'Show me the water_total consumption trend for the Fourth Floor from October 1 to October 24 2025.',
      devices: ['Water Meter_AmRUN3AzIrJd']
    },
    {
      question: 'Are there any anomalies in water usage patterns on the Fourth Floor during October 1–24 2025?',
      devices: ['Water Meter_AmRUN3AzIrJd']
    },
    {
      question: 'Create a correlation heatmap between temperature, humidity, and CO2 for Room 7 covering October 1–24 2025.',
      devices: ['IAQ_tkhi6FivR9TG']
    },
    {
      question: 'What is the relationship between lux and occupants across all Ground Floor rooms for October 1–24 2025?',
      zones: GROUND_FLOOR_IAQ_ZONES
    },
    {
      question: 'Compare mold risk metrics across Rooms 2, 5, 6, and 8 for October 1–24 2025.',
      zones: ['Room 2', 'Room 5', 'Room 6', 'Room 8']
    },
    {
      question: 'Show me a plot of radon short-term average for Rooms 2, 5, 6, and 8 for October 1–24 2025.',
      zones: RADON_ROOMS
    },
    {
      question: 'What are the H2S and NH3 levels in the First Floor Toilet odor sensor on October 24th 2025?',
      devices: ['Odor _hjtgm3AUNSdO']
    },
    {
      question: 'Is there a correlation between humidity and odor levels in the First Floor Toilet for October 1–24 2025?',
      devices: ['Odor _hjtgm3AUNSdO']
    },
    {
      question: 'Show me battery levels across all sensors in Cornwall Building for October 1–24 2025—are any running low?',
      devices: ALL_SENSOR_DEVICES
    }
  ];

  const scenarios = QUESTION_SET.map((item, index) => {
    let scopedSelection = selection;
    let targetZone = null;
    let targetZones = null;
    let targetDevices = null;

    if (item.devices && item.devices.length) {
      const cloudIds = item.devices.map((name) => STATIC_DEVICE_BY_FRIENDLY[name]?.cloudId || name);
      targetDevices = cloudIds;
      scopedSelection = buildDevicesSelection(selection, cloudIds);
      const zones = Array.from(new Set(cloudIds.map((id) => STATIC_DEVICE_META[id]?.zone).filter(Boolean)));
      if (zones.length === 1) targetZone = zones[0];
      else if (zones.length > 1) targetZones = zones;
    } else if (item.zones && item.zones.length) {
      targetZones = item.zones;
      scopedSelection = buildMultiZoneSelection(selection, item.zones, STATIC_ZONE_DEVICES);
    } else if (item.zone) {
      targetZone = item.zone;
      scopedSelection = buildScopedSelection(selection, item.zone, STATIC_ZONE_DEVICES);
    } else {
      targetDevices = Object.keys(STATIC_DEVICE_META);
      scopedSelection = buildDevicesSelection(selection, targetDevices);
    }

    return {
      index,
      question: item.question,
      selection: scopedSelection,
      targetZone,
      targetZones,
      targetDevices,
      friendlyDevices: item.devices || null
    };
  });

  const results = [];
  for (const scenario of scenarios) {
    const question = scenario.question;
    const range = OCT_RANGE;

    const payload = {
      messages: [{ role: 'user', content: question }],
      room: scenario.selection.room || 'ALL',
      range,
      selection: scenario.selection,
      scope: scenario.selection
    };

    const started = Date.now();
    let response = null;
    let error = null;
    let chartHasData = false;
    let chartSeriesCount = 0;

    try {
      response = await fetchJson('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const chart = response?.chart;
      const series = Array.isArray(chart?.series) ? chart.series : [];
      chartSeriesCount = series.length;
      chartHasData = series.some((s) => (Array.isArray(s?.data) && s.data.length > 0) || Boolean(s?.dataRef));
    } catch (err) {
      error = String(err?.message || err);
    }
    const elapsedMs = Date.now() - started;

    results.push({
      index: scenario.index + 1,
      question,
      durationDays: OCT_DURATION_DAYS,
      range: {
        start: formatTs(range.start),
        end: formatTs(range.end),
        startEpochMs: range.start,
        endEpochMs: range.end
      },
      scope: {
        tenant: scenario.selection.tenant,
        building: scenario.selection.building,
        floors: scenario.selection.floors,
        zones: scenario.selection.zones,
        devices: scenario.selection.devices,
        deviceZones: scenario.selection.deviceZones
      },
      payload: {
        messages: payload.messages,
        room: payload.room,
        range: payload.range,
        scope: payload.scope
      },
      elapsedMs,
      error,
      chartHasData,
      chartSeriesCount,
      targetZone: scenario.targetZone || null,
      targetZones: scenario.targetZones || null,
      targetDevices: scenario.targetDevices || null,
      friendlyDevices: scenario.friendlyDevices || null,
      response: response
        ? {
            message: response.message || null,
            answerText: response?.message?.content || null,
            chart: response.chart || null,
            extras: response.extras || null,
            trace: response.trace || null,
            mode: response.mode || null
          }
        : null
    });
  }

  const outfile = path.join(
    RESULTS_DIR,
    `chat_avm_cornwall_${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  );
  await fs.writeFile(
    outfile,
    JSON.stringify(
      {
        baseUrl: BASE_URL,
        tenant: TENANT,
        building: BUILDING,
        refDate: new Date(REF_DATE).toISOString(),
        dateWindow: {
          start: new Date(OCT_START).toISOString(),
          end: new Date(OCT_END).toISOString()
        },
        selectionSummary: {
          hierarchy: CORNWALL_HIERARCHY,
          zoneDevices: STATIC_ZONE_DEVICES,
          deviceMeta: STATIC_DEVICE_META
        },
        results
      },
      null,
      2
    )
  );

  const failures = results.filter((r) => r.error || !r.chartHasData);
  console.log(`Finished ${results.length} questions in ${((results.reduce((sum, r) => sum + r.elapsedMs, 0))/1000).toFixed(1)}s. Saved to ${outfile}.`);
  if (failures.length) {
    console.warn(`Encountered ${failures.length} issues:`);
    failures.forEach((f) => {
      const reason = f.error ? f.error : 'no chart data returned';
      console.warn(`  #${f.index}: ${reason}`);
    });
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[run_avm_cornwall_tests] fatal', err);
  process.exit(1);
});
