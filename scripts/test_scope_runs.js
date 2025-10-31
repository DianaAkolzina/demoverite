#!/usr/bin/env node
/**
 * Automated scope tester.
 *
 * Discovers buildings/floors/zones with active telemetry, poses targeted chat questions,
 * and saves responses (including charts) to data/tests/chat_scope_results-<timestamp>.json.
 *
 * The server must be running locally when this script executes.
 */
import fs from 'fs/promises';
import path from 'path';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const RESULTS_DIR = process.env.TEST_RESULTS_DIR || path.join('data', 'tests');
const TARGET_SCENARIOS = Number(process.env.TEST_SCENARIO_COUNT || 10);
const DURATIONS_HOURS = [6, 12, 24, 48, 72, 96, 168, 240, 336, 504];
const METRIC_PREFERENCE = [
  'humidity',
  'co2',
  'people_count',
  'temperature',
  'lux',
  'occupancy',
  'total_kwh',
  'voc'
];

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
    if (!Array.isArray(arr)) return;
    for (const m of arr) {
      if (m && m !== 'ts') metrics.add(String(m));
    }
  };
  add(meta?.metrics);
  if (meta?.coverage) add(Object.keys(meta.coverage));
  if (meta?.byZone) {
    for (const arr of Object.values(meta.byZone)) add(arr);
  }
  if (Array.isArray(meta?.deviceIndex)) {
    for (const d of meta.deviceIndex) add(d.metrics);
  }
  if (Array.isArray(meta?.groups)) {
    for (const g of meta.groups) {
      for (const f of g.floors || []) {
        for (const z of f.zones || []) {
          for (const d of z.devices || []) add(d.metrics);
        }
      }
    }
  }
  return Array.from(metrics);
}

function chooseMetric(metrics) {
  if (!metrics.length) return null;
  const lower = metrics.map((m) => String(m).toLowerCase());
  for (const pref of METRIC_PREFERENCE) {
    const idx = lower.findIndex((m) => m.includes(pref));
    if (idx >= 0) return metrics[idx];
  }
  return metrics[0];
}

function normaliseList(value) {
  return Array.isArray(value) ? value.map((v) => String(v)) : [];
}

async function discoverScenarios() {
  const scenarios = [];
  const tenantsResp = await fetchJson('/api/tenants').catch(() => ({ tenants: [] }));
  const tenantNames = Array.isArray(tenantsResp?.tenants) && tenantsResp.tenants.length
    ? tenantsResp.tenants
    : [null];

  for (const tenant of tenantNames) {
    if (scenarios.length >= TARGET_SCENARIOS) break;

    const tenantParam = tenant ? `?tenant=${encodeURIComponent(tenant)}` : '';
    const buildingsResp = await fetchJson(`/api/buildings${tenantParam}`).catch(() => ({ buildings: [] }));
    const buildings = Array.isArray(buildingsResp?.buildings) ? buildingsResp.buildings : [];

    for (const building of buildings) {
      if (scenarios.length >= TARGET_SCENARIOS) break;
      const buildingName = building.name;
      if (!buildingName) continue;

      const params = new URLSearchParams();
      if (tenant) params.append('tenant', tenant);
      params.append('building', buildingName);

      const meta = await fetchJson(`/api/scope/metrics?${params.toString()}`).catch(() => null);
      if (!meta) continue;

      const buildingMetrics = collectMetrics(meta);
      const buildingDevices = [];
      const buildingFloors = new Set();
      const buildingZones = new Set();
      const deviceZoneMap = {};

      const groups = Array.isArray(meta.groups) ? meta.groups : [];
      for (const group of groups) {
        for (const floor of group.floors || []) {
          buildingFloors.add(floor.floor);
          for (const zone of floor.zones || []) {
            buildingZones.add(zone.zone);
            for (const device of zone.devices || []) {
              if (device.name) {
                buildingDevices.push(device.name);
                deviceZoneMap[device.name] = zone.zone || null;
              }
            }
          }
        }
      }

      if (!buildingMetrics.length) continue;

      // Building-level scenario
      const buildingMetric = chooseMetric(buildingMetrics) || 'temperature';
      scenarios.push({
        label: `Building ${buildingName}`,
        scope: {
          tenant,
          building: buildingName,
          floors: Array.from(buildingFloors).filter(Boolean),
          zones: Array.from(buildingZones).filter(Boolean),
          devices: buildingDevices,
          deviceZones: deviceZoneMap
        },
        question: `Plot ${buildingMetric} trends for each floor in this building over the selected window and highlight any anomalies.`,
        durationHours: DURATIONS_HOURS[scenarios.length % DURATIONS_HOURS.length],
        expectedMetric: buildingMetric
      });
      if (scenarios.length >= TARGET_SCENARIOS) break;

      // Floor & zone scenarios
      const floors = [];
      for (const group of groups) {
        for (const floor of group.floors || []) {
          const zones = [];
          for (const zone of floor.zones || []) {
            const zoneMetrics = new Set();
            const zoneDevices = [];
            for (const device of zone.devices || []) {
              zoneDevices.push(device.name);
              for (const m of device.metrics || []) zoneMetrics.add(m);
            }
            zones.push({
              name: zone.zone,
              devices: zoneDevices,
              metrics: Array.from(zoneMetrics)
            });
          }
          floors.push({
            name: floor.floor,
            zones
          });
        }
      }

      for (const floor of floors) {
        if (!floor.name || !floor.zones.length) continue;
        const floorMetrics = collectMetrics({ zones: floor.zones.map((z) => z.metrics), deviceIndex: floor.zones.flatMap((z) => z.devices) });
        const floorMetric = chooseMetric(floorMetrics) || buildingMetric;
        scenarios.push({
          label: `Floor ${floor.name} @ ${buildingName}`,
          scope: {
            tenant,
            building: buildingName,
            floor: floor.name,
            floors: [floor.name],
            zones: floor.zones.map((z) => z.name).filter(Boolean),
            devices: floor.zones.flatMap((z) => z.devices).filter(Boolean),
            deviceZones: floor.zones.reduce((acc, z) => {
              for (const dev of z.devices || []) acc[dev] = z.name || null;
              return acc;
            }, {})
          },
          question: `Compare ${floorMetric} across zones on this floor during the selected window.`,
          durationHours: DURATIONS_HOURS[scenarios.length % DURATIONS_HOURS.length],
          expectedMetric: floorMetric
        });
        if (scenarios.length >= TARGET_SCENARIOS) break;

        for (const zone of floor.zones) {
          if (!zone.name || !zone.metrics.length) continue;
          const zoneMetric = chooseMetric(zone.metrics) || floorMetric;
          scenarios.push({
            label: `Zone ${zone.name} @ ${floor.name} / ${buildingName}`,
            scope: {
              tenant,
              building: buildingName,
              floor: floor.name,
              zone: zone.name,
              floors: [floor.name],
              zones: [zone.name],
              devices: zone.devices,
              deviceZones: zone.devices.reduce((acc, dev) => {
                acc[dev] = zone.name;
                return acc;
              }, {})
            },
            question: `Plot ${zoneMetric} for this zone and describe any notable changes in the selected window.`,
            durationHours: DURATIONS_HOURS[scenarios.length % DURATIONS_HOURS.length],
            expectedMetric: zoneMetric
          });
          if (scenarios.length >= TARGET_SCENARIOS) break;
        }
        if (scenarios.length >= TARGET_SCENARIOS) break;
      }
    }
  }

  return scenarios.slice(0, TARGET_SCENARIOS);
}

async function runScenario(index, scenario) {
  const { durationHours, scope, question } = scenario;
  const range = epochRange(durationHours);
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
