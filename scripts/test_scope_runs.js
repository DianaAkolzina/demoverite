#!/usr/bin/env node
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const RESULTS_DIR = process.env.TEST_RESULTS_DIR || path.join('data', 'tests');
const REQUIRED_SCENARIO_COUNT = Number(process.env.TEST_SCENARIO_COUNT || 10);
const DURATIONS_HOURS = [6, 12, 24, 48, 72, 96, 168, 240, 336, 504];
const ALLOWED_DAY_WINDOWS = [1, 7, 30];
const DEFAULT_WINDOW_DAYS = 7;
const FIXED_TODAY_MS = Date.UTC(2025, 9, 20, 23, 59, 59, 999); // 20 Oct 2025 23:59:59Z

async function fetchJson(url, init) {
  const res = await fetch(`${BASE_URL}${url}`, init);
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`HTTP ${res.status} for ${url}: ${msg}`);
  }
  return res.json();
}

function ensureDir(dir) {
  return fs.mkdir(dir, { recursive: true });
}

function timestampFilename(prefix, ext = '.json') {
  return `${prefix}_${new Date().toISOString().replace(/[:.]/g, '-')}${ext}`;
}

function epochRange(hours) {
  const end = Date.now();
  const start = end - hours * 3600_000;
  return { start, end };
}

function collectMetrics(meta) {
  const metrics = new Set();
  const add = (arr) => {
    if (!arr) return;
    if (Array.isArray(arr)) {
      for (const m of arr) {
        if (!m || m === 'ts') continue;
        metrics.add(String(m));
      }
    } else if (typeof arr === 'object') {
      for (const value of Object.values(arr)) add(value);
    }
  };
  add(meta?.metrics);
  add(meta?.coverage);
  add(meta?.byZone);
  if (Array.isArray(meta?.deviceIndex)) {
    for (const d of meta.deviceIndex) add(d.metrics);
  }
  if (Array.isArray(meta?.groups)) {
    for (const g of meta.groups) {
      for (const f of g.floors || []) {
        for (const z of f.zones || []) {
          add(z.metrics);
          for (const d of z.devices || []) add(d.metrics);
        }
      }
    }
  }
  return Array.from(metrics);
}

function normaliseList(value) {
  return Array.isArray(value) ? value.map((v) => String(v)) : [];
}

const DAY_MS = 24 * 60 * 60 * 1000;
function startOfDayUtc(ts) {
  const d = new Date(ts);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

function anchorRange(days = DEFAULT_WINDOW_DAYS) {
  const windowDays = ALLOWED_DAY_WINDOWS.includes(days) ? days : DEFAULT_WINDOW_DAYS;
  const end = FIXED_TODAY_MS;
  const start = startOfDayUtc(end - (windowDays - 1) * DAY_MS);
  return { start, end };
}

function createTimeRange() {
  const choice = ALLOWED_DAY_WINDOWS[Math.floor(Math.random() * ALLOWED_DAY_WINDOWS.length)];
  return anchorRange(choice);
}

function formatRangeText(range) {
  const startIso = new Date(range.start).toISOString().slice(0, 10);
  const endIso = new Date(range.end).toISOString().slice(0, 10);
  return `${startIso} to ${endIso}`;
}

function formatMetricName(metric = '') {
  if (!metric) return 'the metric';
  return String(metric)
    .replace(/_/g, ' ')
    .replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

function findDeviceMatch(devices, regex) {
  for (const device of devices) {
    const idx = device.metricsLC.findIndex((m) => regex.test(m));
    if (idx >= 0) {
      return {
        device,
        metric: device.metrics[idx] || device.metricsLC[idx],
        metricLC: device.metricsLC[idx]
      };
    }
  }
  return null;
}

function findDevicePair(devices, regexA, regexB) {
  const first = findDeviceMatch(devices, regexA);
  const second = findDeviceMatch(devices.filter((d) => d !== (first && first.device)), regexB);
  if (first && second) return { first, second };
  if (first) {
    const fallbackSecond = devices.find((d) => d !== first.device);
    if (fallbackSecond) {
      return {
        first,
        second: {
          device: fallbackSecond,
          metric: fallbackSecond.metrics[0] || 'value',
          metricLC: fallbackSecond.metricsLC[0] || 'value'
        }
      };
    }
  }
  return null;
}

function getZoneForDevice(ctx, device) {
  if (!device) return null;
  const zoneName = ctx.deviceZoneMap[device.id] || device.zone || null;
  if (!zoneName) return null;
  return ctx.zoneByName.get(zoneName) || null;
}

function createScenarioScope(ctx, { devices = [], zone = null, additionalZones = [] } = {}) {
  const deviceIds = devices.map((d) => d.id).filter(Boolean);
  const floors = new Set();
  const zones = new Set();

  if (zone) {
    if (zone.floor) floors.add(zone.floor);
    if (zone.name) zones.add(zone.name);
  }

  for (const dev of devices) {
    if (dev.floor) floors.add(dev.floor);
    const z = ctx.deviceZoneMap[dev.id] || dev.zone;
    if (z) zones.add(z);
  }

  for (const extraZone of additionalZones) {
    if (extraZone) zones.add(extraZone);
  }

  const deviceZones = {};
  for (const id of deviceIds) {
    deviceZones[id] = ctx.deviceZoneMap[id] || (zone ? zone.name : null) || null;
  }

  return createScope({
    tenant: ctx.tenant,
    building: ctx.building,
    floor: zone?.floor || null,
    zone: zone?.name || null,
    floors: Array.from(floors).filter(Boolean),
    zones: Array.from(zones).filter(Boolean),
    devices: deviceIds,
    deviceZones
  });
}

function createScope({ tenant, building, floor = null, zone = null, floors = [], zones = [], devices = [], deviceZones = {} }) {
  return {
    tenant: tenant || null,
    building: building || null,
    floor: floor || null,
    zone: zone || null,
    room: zone || (zones.length === 1 ? zones[0] : null),
    floors: normaliseList(floors.length ? floors : (floor ? [floor] : [])),
    zones: normaliseList(zones.length ? zones : (zone ? [zone] : [])),
    devices: normaliseList(devices),
    deviceZones
  };
}

function fixedRange(startIso, endIso) {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return createTimeRange();
  }
  return { start, end };
}

const FALLBACK_BOLTON_ZONES = [
  'Booths',
  'Brainstorm',
  'Cafe',
  'Comms',
  'Entrance',
  'Huddle',
  'Lounge',
  'Sitdown',
  'Standup',
  'Toilet'
];

function loadBoltonZonesWithData() {
  try {
    const snapPath = path.resolve(process.cwd(), 'data', 'graph_snapshot.avm_solutions.json');
    const csvDir = path.resolve(process.cwd(), process.env.S3_LOCAL_DIR || 'CSVex_s3');
    if (!fsSync.existsSync(snapPath)) return FALLBACK_BOLTON_ZONES;
    const raw = fsSync.readFileSync(snapPath, 'utf8');
    const snap = JSON.parse(raw);
    const nodes = new Map((snap.nodes || []).map((n) => [n.id, n]));
    const zones = new Set();
    const hasCsv = (deviceId) => {
      if (!deviceId) return false;
      return fsSync.existsSync(path.join(csvDir, `${deviceId}.csv`));
    };
    for (const link of snap.links || []) {
      if (!link || link.rel !== 'LOCATED_IN_ZONE') continue;
      const device = nodes.get(link.source);
      const zone = nodes.get(link.target);
      if (!device || !zone) continue;
      const zoneIdParts = String(zone.id || '').split(':');
      const zoneBuilding = zoneIdParts[zoneIdParts.length - 1];
      if (zoneBuilding !== 'Bolton') continue;
      const deviceId = device.cloudId || device.name || device.id;
      if (!hasCsv(deviceId)) continue;
      zones.add(zone.name || zoneIdParts[1] || deviceId);
    }
    const list = Array.from(zones).filter(Boolean).sort();
    return list.length ? list : FALLBACK_BOLTON_ZONES;
  } catch (err) {
    console.warn('[scope-tests] Unable to derive Bolton zones from snapshot:', err.message);
    return FALLBACK_BOLTON_ZONES;
  }
}

const BOLTON_FIRST_FLOOR_ZONES = loadBoltonZonesWithData();

const MANUAL_SCENARIOS = [
  {
    label: 'Bolton First Floor scope snapshot',
    scope: createScope({
      tenant: 'AVM Solutions',
      building: 'Bolton',
      floor: 'First Floor',
      floors: ['First Floor'],
      zones: BOLTON_FIRST_FLOOR_ZONES
    }),
    question: 'Confirm the visible scope for Bolton First Floor between 2025-09-21 and 2025-10-20 and list the rooms/devices with data.',
    range: anchorRange(30)
  },
  {
    label: 'Standup temperature and humidity',
    scope: createScope({
      tenant: 'AVM Solutions',
      building: 'Bolton',
      floor: 'First Floor',
      zone: 'Standup',
      zones: ['Standup'],
      devices: ['64214e60-479c-11f0-bf13-bf19a72566f6'],
      deviceZones: { '64214e60-479c-11f0-bf13-bf19a72566f6': 'Standup' }
    }),
    question: 'Plot temperature and humidity in Standup between 2025-09-21 and 2025-10-20 and summarise highs and lows.',
    range: anchorRange(30)
  },
  {
    label: 'Huddle people count',
    scope: createScope({
      tenant: 'AVM Solutions',
      building: 'Bolton',
      floor: 'First Floor',
      zone: 'Huddle',
      zones: ['Huddle'],
      devices: ['29436890-4798-11f0-bf13-bf19a72566f6'],
      deviceZones: { '29436890-4798-11f0-bf13-bf19a72566f6': 'Huddle' }
    }),
    question: 'Chart people_count for Huddle between 2025-09-21 and 2025-10-20 and call out peak periods.',
    range: anchorRange(30)
  },
  {
    label: 'Cafe IAQ and comfort',
    scope: createScope({
      tenant: 'AVM Solutions',
      building: 'Bolton',
      floor: 'First Floor',
      zone: 'Cafe',
      zones: ['Cafe'],
      devices: ['abc73b80-4797-11f0-bf13-bf19a72566f6'],
      deviceZones: { 'abc73b80-4797-11f0-bf13-bf19a72566f6': 'Cafe' }
    }),
    question: 'Between 2025-09-21 and 2025-10-20, summarise Cafe CO2, temperature, humidity, and lux; mention any gaps.',
    range: anchorRange(30)
  },
  {
    label: 'Comms energy trend',
    scope: createScope({
      tenant: 'AVM Solutions',
      building: 'Bolton',
      floor: 'First Floor',
      zone: 'Comms',
      zones: ['Comms'],
      devices: ['8e00d400-479a-11f0-bf13-bf19a72566f6'],
      deviceZones: { '8e00d400-479a-11f0-bf13-bf19a72566f6': 'Comms' }
    }),
    question: 'Show total_kwh for Comms between 2025-09-21 and 2025-10-20 and describe daily highs/lows.',
    range: anchorRange(30)
  },
  {
    label: 'Comms water usage',
    scope: createScope({
      tenant: 'AVM Solutions',
      building: 'Bolton',
      floor: 'First Floor',
      zone: 'Comms',
      zones: ['Comms'],
      devices: ['4a829030-58b9-11f0-a19e-8f874a1c01d3'],
      deviceZones: { '4a829030-58b9-11f0-a19e-8f874a1c01d3': 'Comms' }
    }),
    question: 'Chart water_total for Comms between 2025-09-21 and 2025-10-20 and highlight any step changes.',
    range: anchorRange(30)
  },
  {
    label: 'Toilet ammonia and odour',
    scope: createScope({
      tenant: 'AVM Solutions',
      building: 'Bolton',
      floor: 'First Floor',
      zone: 'Toilet',
      zones: ['Toilet'],
      devices: ['2e857e60-58b9-11f0-a19e-8f874a1c01d3'],
      deviceZones: { '2e857e60-58b9-11f0-a19e-8f874a1c01d3': 'Toilet' }
    }),
    question: 'Plot NH3 and H2S in the Toilet between 2025-09-21 and 2025-10-20 and flag any spikes.',
    range: anchorRange(30)
  },
  {
    label: 'Toilet leak status',
    scope: createScope({
      tenant: 'AVM Solutions',
      building: 'Bolton',
      floor: 'First Floor',
      zone: 'Toilet',
      zones: ['Toilet'],
      devices: ['002f9dc0-58b9-11f0-a19e-8f874a1c01d3'],
      deviceZones: { '002f9dc0-58b9-11f0-a19e-8f874a1c01d3': 'Toilet' }
    }),
    question: 'Check the leak status readings for the Toilet between 2025-09-21 and 2025-10-20 and confirm if any alerts occurred.',
    range: anchorRange(30)
  },
  {
    label: 'Brainstorm occupancy and comfort',
    scope: createScope({
      tenant: 'AVM Solutions',
      building: 'Bolton',
      floor: 'First Floor',
      zone: 'Brainstorm',
      zones: ['Brainstorm'],
      devices: ['6ef94be0-479b-11f0-bf13-bf19a72566f6', 'f22ffa70-47a2-11f0-bf13-bf19a72566f6'],
      deviceZones: {
        '6ef94be0-479b-11f0-bf13-bf19a72566f6': 'Brainstorm',
        'f22ffa70-47a2-11f0-bf13-bf19a72566f6': 'Brainstorm'
      }
    }),
    question: 'Summarise occupancy (is_used) alongside temperature and humidity for Brainstorm between 2025-09-21 and 2025-10-20.',
    range: anchorRange(30)
  },
  {
    label: 'Cafe temperature vs weather',
    scope: createScope({
      tenant: 'AVM Solutions',
      building: 'Bolton',
      floor: 'First Floor',
      zone: 'Cafe',
      zones: ['Cafe'],
      devices: ['abc73b80-4797-11f0-bf13-bf19a72566f6'],
      deviceZones: { 'abc73b80-4797-11f0-bf13-bf19a72566f6': 'Cafe' }
    }),
    question: 'Compare Cafe indoor temperature against Bolton outdoor weather between 2025-10-14 and 2025-10-20 and describe any relationship.',
    range: anchorRange(7)
  }
];

function buildManualScenarios() {
  return MANUAL_SCENARIOS.map((scenario, idx) => ({
    ...scenario,
    label: scenario.label || `manual-${idx + 1}`
  }));
}

function pushScenario(list, scenario) {
  if (!scenario || !scenario.question) return;
  if (list.length >= REQUIRED_SCENARIO_COUNT) return;
  const key = `${scenario.label}::${scenario.question}`;
  if (list.some((s) => `${s.label}::${s.question}` === key)) return;
  list.push(scenario);
}

async function discoverScenarios() {
  const scenarios = [];
  for (const scenario of buildManualScenarios()) {
    pushScenario(scenarios, scenario);
  }
  if (scenarios.length >= REQUIRED_SCENARIO_COUNT) {
    return scenarios.slice(0, REQUIRED_SCENARIO_COUNT);
  }
  const buildingContexts = [];
  const tenantsResp = await fetchJson('/api/tenants').catch(() => ({ tenants: [] }));
  const tenantNames = Array.isArray(tenantsResp?.tenants) && tenantsResp.tenants.length
    ? tenantsResp.tenants
    : [null];

  for (const tenant of tenantNames) {
    const tenantParam = tenant ? `?tenant=${encodeURIComponent(tenant)}` : '';
    const buildingsResp = await fetchJson(`/api/buildings${tenantParam}`).catch(() => ({ buildings: [] }));
    const buildings = Array.isArray(buildingsResp?.buildings) ? buildingsResp.buildings : [];

    for (const building of buildings) {
      const buildingName = building.name;
      if (!buildingName) continue;

      const params = new URLSearchParams();
      if (tenant) params.append('tenant', tenant);
      params.append('building', buildingName);

      const meta = await fetchJson(`/api/scope/metrics?${params.toString()}`).catch(() => null);
      if (!meta) continue;

      const buildingMetrics = collectMetrics(meta);
      if (!buildingMetrics.length) continue;

      const deviceZoneMap = {};
      const deviceMap = new Map();
      const zoneMap = new Map();
      const buildingFloors = new Set();

      const groups = Array.isArray(meta.groups) ? meta.groups : [];
      groups.forEach((group) => {
        (group.floors || []).forEach((floor) => {
          const floorName = floor.floor || null;
          if (floorName) buildingFloors.add(floorName);
          (floor.zones || []).forEach((zone, zoneIdx) => {
            const zoneName = zone.zone || `${floorName || 'Floor'} Zone ${zoneIdx + 1}`;
            const zoneKey = zoneName;
            if (!zoneMap.has(zoneKey)) {
              zoneMap.set(zoneKey, {
                name: zoneName,
                floor: floorName,
                deviceIds: new Set(),
                metricsSet: new Set()
              });
            }
            const zoneEntry = zoneMap.get(zoneKey);

            (zone.devices || []).forEach((device) => {
              const rawId = device.cloudId || device.deviceId || device.id || device.name;
              if (!rawId) return;
              const deviceId = String(rawId);
              let deviceEntry = deviceMap.get(deviceId);
              if (!deviceEntry) {
                deviceEntry = {
                  id: deviceId,
                  name: device.name || deviceId,
                  zone: zoneName,
                  floor: floorName,
                  type: device.deviceType || device.type || null,
                  metricsSet: new Set()
                };
                deviceMap.set(deviceId, deviceEntry);
              }
              const metrics = Array.isArray(device.metrics)
                ? device.metrics.map((m) => String(m)).filter(Boolean)
                : [];
              metrics.forEach((m) => deviceEntry.metricsSet.add(m));
              if (!deviceEntry.zone && zoneName) deviceEntry.zone = zoneName;
              if (!deviceEntry.floor && floorName) deviceEntry.floor = floorName;
              zoneEntry.deviceIds.add(deviceId);
              metrics.forEach((m) => zoneEntry.metricsSet.add(m));
              if (zoneName) {
                deviceZoneMap[deviceId] = zoneName;
                if (device.name) {
                  deviceZoneMap[device.name] = zoneName;
                  deviceZoneMap[device.name.toLowerCase()] = zoneName;
                }
              }
            });
          });
        });
      });

      const devices = Array.from(deviceMap.values()).map((device) => {
        const metrics = Array.from(device.metricsSet);
        return {
          id: device.id,
          name: device.name,
          zone: device.zone || null,
          floor: device.floor || null,
          type: device.type || null,
          metrics,
          metricsLC: metrics.map((m) => m.toLowerCase())
        };
      });

      if (!devices.length) continue;

      const zones = Array.from(zoneMap.values()).map((zone) => {
        const zoneDevices = Array.from(zone.deviceIds)
          .map((id) => deviceMap.get(id))
          .filter(Boolean);
        if (!zoneDevices.length) return null;
        return {
          name: zone.name,
          floor: zone.floor || null,
          devices: zoneDevices.map((d) => ({
            id: d.id,
            name: d.name,
            zone: d.zone || zone.name,
            floor: d.floor || zone.floor,
            metrics: Array.from(d.metricsSet || []),
            metricsLC: Array.from(d.metricsSet || []).map((m) => m.toLowerCase())
          })),
          metrics: Array.from(zone.metricsSet)
        };
      }).filter(Boolean);

      if (!zones.length) continue;

      const context = {
        tenant,
        building: buildingName,
        buildingMetrics,
        floors: Array.from(buildingFloors).filter(Boolean),
        devices,
        zones,
        deviceZoneMap,
        zoneByName: new Map(zones.map((z) => [z.name, {
          name: z.name,
          floor: z.floor,
          devices: devices.filter((d) => d.zone === z.name),
          metrics: z.metrics
        }]))
      };

      buildingContexts.push(context);
    }
  }

  if (!buildingContexts.length) {
    return scenarios;
  }

  const primaryContexts = buildingContexts.slice(0, Math.min(5, buildingContexts.length));
  for (const ctx of primaryContexts) {
    const items = buildBuildingScenarios(ctx);
    for (const scenario of items) {
      pushScenario(scenarios, scenario);
      if (scenarios.length >= REQUIRED_SCENARIO_COUNT) break;
    }
    if (scenarios.length >= REQUIRED_SCENARIO_COUNT) break;
  }

  if (scenarios.length < REQUIRED_SCENARIO_COUNT) {
    for (const ctx of buildingContexts) {
      if (primaryContexts.includes(ctx)) continue;
      const items = buildBuildingScenarios(ctx);
      for (const scenario of items) {
        pushScenario(scenarios, scenario);
        if (scenarios.length >= REQUIRED_SCENARIO_COUNT) break;
      }
      if (scenarios.length >= REQUIRED_SCENARIO_COUNT) break;
    }
  }

  return scenarios.slice(0, REQUIRED_SCENARIO_COUNT);
}

function buildBuildingScenarios(ctx) {
  const scenarios = [];
  if (!ctx.devices.length) return scenarios;

  const zoneList = Array.from(ctx.zoneByName.values()).filter((zone) => zone && zone.devices && zone.devices.length);
  const primaryZone = zoneList[0] || null;
  const secondaryZone = zoneList.find((zone) => zone !== primaryZone) || primaryZone;

  const fallbackDevice = ctx.devices[0];

  function ensureMatch(match) {
    if (match && match.device) return match;
    return {
      device: fallbackDevice,
      metric: fallbackDevice?.metrics?.[0] || 'value',
      metricLC: fallbackDevice?.metricsLC?.[0] || 'value'
    };
  }

  const occupancyMatch = ensureMatch(findDeviceMatch(ctx.devices, /(people_count|occupancy|is_used|utilization)/i));
  const co2Match = findDeviceMatch(ctx.devices, /\bco2\b/i);
  const humidityMatch = findDeviceMatch(ctx.devices, /humidity/i);
  const temperatureMatch = findDeviceMatch(ctx.devices, /(temperature|temp)/i);
  const energyMatch = findDeviceMatch(ctx.devices, /(total_kwh|energy|power|kw)/i);
  const vocMatch = findDeviceMatch(ctx.devices, /(voc|tvoc)/i);
  const luxMatch = findDeviceMatch(ctx.devices, /lux/i);

  const buildingScope = createScenarioScope(ctx, { devices: ctx.devices });

  function addScenario(label, scope, question, range) {
    scenarios.push({
      label,
      scope,
      question,
      range
    });
  }

  const scopeRange1 = createTimeRange();
  addScenario(
    `${ctx.building} scope overview`,
    buildingScope,
    `Between ${formatRangeText(scopeRange1)}, summarise the active floors, zones, and telemetry devices for ${ctx.building}. Confirm the scope is complete and note any gaps.`,
    scopeRange1
  );

  if (primaryZone) {
    const zoneScopeRange = createTimeRange();
    const zoneScope = createScenarioScope(ctx, { zone: primaryZone, devices: primaryZone.devices || [] });
    addScenario(
      `${ctx.building} ${primaryZone.name} scope`,
      zoneScope,
      `During ${formatRangeText(zoneScopeRange)}, list the sensors deployed in ${primaryZone.name} and the metrics each one captures. Flag anything missing from the zone scope.`,
      zoneScopeRange
    );
  }

  const anomalyRange = createTimeRange();
  const anomalyZone = getZoneForDevice(ctx, occupancyMatch.device) || primaryZone;
  const anomalyScope = createScenarioScope(ctx, { zone: anomalyZone, devices: [occupancyMatch.device] });
  addScenario(
    `${ctx.building} ${formatMetricName(occupancyMatch.metric)} anomalies`,
    anomalyScope,
    `Detect anomalies in ${formatMetricName(occupancyMatch.metric)} for ${anomalyZone?.name || ctx.building} across ${formatRangeText(anomalyRange)}. Use the anomaly detection tools and describe the abnormal periods.`,
    anomalyRange
  );

  const forecastMatch = ensureMatch(energyMatch || temperatureMatch || occupancyMatch);
  const forecastZone = getZoneForDevice(ctx, forecastMatch.device) || anomalyZone || primaryZone;
  const forecastRange = createTimeRange();
  const forecastScope = createScenarioScope(ctx, { zone: forecastZone, devices: [forecastMatch.device] });
  addScenario(
    `${ctx.building} ${formatMetricName(forecastMatch.metric)} forecast`,
    forecastScope,
    `Forecast the next week of ${formatMetricName(forecastMatch.metric)} for ${forecastZone?.name || ctx.building} using data from ${formatRangeText(forecastRange)}. Include the historical baseline and the forecast confidence band.`,
    forecastRange
  );

  const correlationPair =
    findDevicePair(ctx.devices, /(people_count|occupancy|is_used|utilization)/i, /\bco2\b/i) ||
    findDevicePair(ctx.devices, /(temperature|temp)/i, /humidity/i);
  if (correlationPair) {
    const corrRange = createTimeRange();
    const devices = [correlationPair.first.device, correlationPair.second.device];
    const extraZones = devices.map((d) => ctx.deviceZoneMap[d.id]).filter(Boolean);
    const corrScope = createScenarioScope(ctx, { devices, additionalZones: extraZones });
    addScenario(
      `${ctx.building} correlation study`,
      corrScope,
      `Compute the correlation between ${formatMetricName(correlationPair.first.metric)} (${ctx.deviceZoneMap[correlationPair.first.device.id] || 'unknown zone'}) and ${formatMetricName(correlationPair.second.metric)} (${ctx.deviceZoneMap[correlationPair.second.device.id] || 'unknown zone'}) during ${formatRangeText(corrRange)}. Provide the correlation value and a visual explaining the relationship.`,
      corrRange
    );
  }

  const comparisonDevices = ctx.devices
    .filter((d) => d.metricsLC.some((m) => /(temperature|temp|humidity|co2|people_count|occupancy)/i.test(m)))
    .slice(0, 2);
  if (comparisonDevices.length === 2) {
    const comparisonRange = createTimeRange();
    const compScope = createScenarioScope(ctx, { devices: comparisonDevices });
    addScenario(
      `${ctx.building} metric comparison`,
      compScope,
      `Compare average ${formatMetricName(comparisonDevices[0].metrics[0] || 'temperature')} in ${ctx.deviceZoneMap[comparisonDevices[0].id] || 'zone A'} versus ${formatMetricName(comparisonDevices[1].metrics[0] || 'temperature')} in ${ctx.deviceZoneMap[comparisonDevices[1].id] || 'zone B'} for ${formatRangeText(comparisonRange)}. Explain the differences with supporting charts.`,
      comparisonRange
    );
  }

  const knowledgeRange = createTimeRange();
  const knowledgeDevice = ensureMatch(findDeviceMatch(ctx.devices, /(water|leak|voc|pm|lux|rssi)/i)).device;
  const knowledgeZone = getZoneForDevice(ctx, knowledgeDevice) || primaryZone;
  const knowledgeScope = createScenarioScope(ctx, { zone: knowledgeZone, devices: [knowledgeDevice] });
  addScenario(
    `${ctx.building} knowledge check`,
    knowledgeScope,
    `For ${formatRangeText(knowledgeRange)}, describe the telemetry from ${knowledgeDevice.name} in ${knowledgeZone?.name || ctx.building}. Include the metrics it measures and which analysis tools or dashboards are best suited to inspect it.`,
    knowledgeRange
  );

  const extremesMatch = ensureMatch(temperatureMatch || humidityMatch || occupancyMatch);
  const extremesZone = getZoneForDevice(ctx, extremesMatch.device) || primaryZone;
  const extremesRange = createTimeRange();
  const extremesScope = createScenarioScope(ctx, { zone: extremesZone, devices: [extremesMatch.device] });
  addScenario(
    `${ctx.building} ${formatMetricName(extremesMatch.metric)} extremes`,
    extremesScope,
    `Report the average, highest, and lowest ${formatMetricName(extremesMatch.metric)} in ${extremesZone?.name || ctx.building} during ${formatRangeText(extremesRange)}. Include a line chart and annotate the peaks.`,
    extremesRange
  );

  const histogramMatch = ensureMatch(humidityMatch || temperatureMatch || occupancyMatch);
  const histogramZone = getZoneForDevice(ctx, histogramMatch.device) || primaryZone;
  const histogramRange = createTimeRange();
  const histogramScope = createScenarioScope(ctx, { zone: histogramZone, devices: [histogramMatch.device] });
  addScenario(
    `${ctx.building} ${formatMetricName(histogramMatch.metric)} histogram`,
    histogramScope,
    `Create a histogram of ${formatMetricName(histogramMatch.metric)} readings for ${histogramZone?.name || ctx.building} covering ${formatRangeText(histogramRange)}. Describe the distribution and whether it suggests skew or multi-modal behaviour.`,
    histogramRange
  );

  const abnormalMatch = ensureMatch(co2Match || temperatureMatch || occupancyMatch);
  const abnormalZone = getZoneForDevice(ctx, abnormalMatch.device) || primaryZone;
  const abnormalRange = createTimeRange();
  const abnormalScope = createScenarioScope(ctx, { zone: abnormalZone, devices: [abnormalMatch.device] });
  addScenario(
    `${ctx.building} comfort review`,
    abnormalScope,
    `Evaluate whether ${formatMetricName(abnormalMatch.metric)} in ${abnormalZone?.name || ctx.building} stays within normal comfort thresholds across ${formatRangeText(abnormalRange)}. Flag abnormal periods and reference guideline values.`,
    abnormalRange
  );

  if (primaryZone && secondaryZone && primaryZone !== secondaryZone) {
    const crossRange = createTimeRange();
    const occSecond = findDeviceMatch(
      ctx.devices.filter((d) => d.zone === secondaryZone.name),
      /(people_count|occupancy|is_used|utilization)/i
    );
    const crossDevices = [occupancyMatch.device];
    if (occSecond) crossDevices.push(occSecond.device);
    const crossScope = createScenarioScope(ctx, { devices: crossDevices, additionalZones: [primaryZone.name, secondaryZone.name] });
    addScenario(
      `${ctx.building} cross-zone comparison`,
      crossScope,
      `Compare occupancy patterns between ${primaryZone.name} and ${secondaryZone.name} over ${formatRangeText(crossRange)}. Highlight differences in peak and low periods with supporting charts.`,
      crossRange
    );
  }

  const cleaningRange = createTimeRange();
  const cleaningZone = getZoneForDevice(ctx, occupancyMatch.device) || primaryZone;
  const cleaningScope = createScenarioScope(ctx, { zone: cleaningZone, devices: [occupancyMatch.device] });
  addScenario(
    `${ctx.building} cleaning window`,
    cleaningScope,
    `Using ${formatRangeText(cleaningRange)}, determine the best daily window for cleaning ${cleaningZone?.name || ctx.building} when occupancy is minimal. Provide evidence from occupancy charts and note any exceptions.`,
    cleaningRange
  );

  const reasonMatch = ensureMatch(vocMatch || energyMatch || co2Match || occupancyMatch);
  const reasonZone = getZoneForDevice(ctx, reasonMatch.device) || primaryZone;
  const reasonRange = createTimeRange();
  const reasonScope = createScenarioScope(ctx, { zone: reasonZone, devices: [reasonMatch.device] });
  addScenario(
    `${ctx.building} root cause analysis`,
    reasonScope,
    `Explain the causes behind any sustained elevations in ${formatMetricName(reasonMatch.metric)} for ${reasonZone?.name || ctx.building} during ${formatRangeText(reasonRange)}. Use correlations or comparisons to support the reasoning.`,
    reasonRange
  );

  if (luxMatch) {
    const luxZone = getZoneForDevice(ctx, luxMatch.device) || primaryZone;
    const luxRange = createTimeRange();
    const luxScope = createScenarioScope(ctx, { zone: luxZone, devices: [luxMatch.device] });
    addScenario(
      `${ctx.building} cleaning readiness`,
      luxScope,
      `Assess light levels (${formatMetricName(luxMatch.metric)}) in ${luxZone?.name || ctx.building} during ${formatRangeText(luxRange)} and determine if additional lighting adjustments are needed for after-hours cleaning.`,
      luxRange
    );
  }

  while (scenarios.length < 12) {
    const fillerRange = createTimeRange();
    addScenario(
      `${ctx.building} supplemental insight ${scenarios.length + 1}`,
      buildingScope,
      `Provide a comprehensive performance review for ${ctx.building} covering ${formatRangeText(fillerRange)}. Summarise energy, air quality, and utilisation trends, and flag anything requiring follow-up.`,
      fillerRange
    );
  }

  return scenarios.slice(0, 12);
}

async function runScenario(index, scenario) {
  const { durationHours, scope, question } = scenario;
  const range = scenario.range || epochRange(durationHours || DURATIONS_HOURS[0]);
  const payload = {
    messages: [{ role: 'user', content: question }],
    room: scope.zone || 'ALL',
    range,
    selection: {
      tenant: scope.tenant || null,
      building: scope.building || null,
      floor: scope.floor || null,
      room: scope.zone || null,
      devices: normaliseList(scope.devices),
      zones: normaliseList(scope.zones),
      floors: normaliseList(scope.floors),
      deviceZones: scope.deviceZones || {},
      labels: {
        tenant: scope.tenant || null,
        building: scope.building || null,
        floor: scope.floor || null,
        room: scope.zone || null
      }
    }
  };

  const response = await fetchJson('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).catch((error) => ({ error: error.message }));

  return {
    index,
    question,
    scope,
    range,
    response
  };
}

async function main() {
  console.log(`[tester] Discovering scopes via ${BASE_URL} ...`);
  const scenarios = await discoverScenarios();
  if (!scenarios.length) {
    console.error('[tester] No scenarios discovered. Is the API running and populated?');
    process.exit(1);
  }
  console.log(`[tester] Running ${scenarios.length} scenarios...`);

  const results = [];
  for (let i = 0; i < scenarios.length; i += 1) {
    const scenario = scenarios[i];
    process.stdout.write(`[tester] (${i + 1}/${scenarios.length}) ${scenario.label} ... `);
    try {
      const result = await runScenario(i + 1, scenario);
      results.push({ scenario, result });
      const hasChart = !!result.response?.chart;
      console.log(hasChart ? 'chart ✅' : 'chart —');
      // brief pause to avoid hammering the API
      await new Promise((resolve) => setTimeout(resolve, 150));
    } catch (err) {
      console.log('error ❌', err.message);
      results.push({ scenario, error: err.message });
    }
  }

  await ensureDir(RESULTS_DIR);
  const outfile = path.join(RESULTS_DIR, timestampFilename('chat_scope_results'));
  await fs.writeFile(outfile, JSON.stringify({
    baseUrl: BASE_URL,
    generatedAt: new Date().toISOString(),
    results
  }, null, 2));
  console.log(`[tester] Results saved to ${outfile}`);
}

main().catch((err) => {
  console.error('[tester] Failed:', err);
  process.exit(1);
});
