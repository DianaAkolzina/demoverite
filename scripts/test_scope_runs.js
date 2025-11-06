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
const REQUIRED_SCENARIO_COUNT = Number(process.env.TEST_SCENARIO_COUNT || 60);
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

function metricMatches(metrics, regex) {
  return metrics.some((m) => regex.test(String(m).toLowerCase()));
}

function pickMetricMatching(metrics, regex, fallback = null) {
  const match = metrics.find((m) => regex.test(String(m).toLowerCase()));
  return match || fallback;
}

function randomDuration(index) {
  return DURATIONS_HOURS[index % DURATIONS_HOURS.length];
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

function pushScenario(list, scenario) {
  if (!scenario || !scenario.question) return;
  if (list.length >= REQUIRED_SCENARIO_COUNT) return;
  const key = `${scenario.label}::${scenario.question}`;
  if (list.some((s) => `${s.label}::${s.question}` === key)) return;
  list.push(scenario);
}

function buildZoneDeviceMap(zones = []) {
  const map = {};
  for (const zone of zones) {
    for (const device of zone.devices || []) {
      map[device] = zone.name || null;
    }
  }
  return map;
}

function defaultMetricPairs(metrics) {
  const pairs = [];
  if (metricMatches(metrics, /(people_count|occupancy)/) && metricMatches(metrics, /co2/)) {
    pairs.push(['co2', 'people_count']);
  }
  if (metricMatches(metrics, /(temperature|temp)/) && metricMatches(metrics, /humidity/)) {
    pairs.push(['temperature', 'humidity']);
  }
  if (metricMatches(metrics, /lux/) && metricMatches(metrics, /(people_count|occupancy)/)) {
    pairs.push(['lux', 'people_count']);
  }
  return pairs;
}

async function discoverScenarios() {
  const scenarios = [];
  const tenantsResp = await fetchJson('/api/tenants').catch(() => ({ tenants: [] }));
  const tenantNames = Array.isArray(tenantsResp?.tenants) && tenantsResp.tenants.length
    ? tenantsResp.tenants
    : [null];

  for (const tenant of tenantNames) {
    if (scenarios.length >= REQUIRED_SCENARIO_COUNT) break;

    const tenantParam = tenant ? `?tenant=${encodeURIComponent(tenant)}` : '';
    const buildingsResp = await fetchJson(`/api/buildings${tenantParam}`).catch(() => ({ buildings: [] }));
    const buildings = Array.isArray(buildingsResp?.buildings) ? buildingsResp.buildings : [];

    for (const building of buildings) {
      if (scenarios.length >= REQUIRED_SCENARIO_COUNT) break;
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

      const baseScope = createScope({
        tenant,
        building: buildingName,
        floors: Array.from(buildingFloors).filter(Boolean),
        zones: Array.from(buildingZones).filter(Boolean),
        devices: buildingDevices,
        deviceZones: deviceZoneMap
      });

      const buildingMetric = chooseMetric(buildingMetrics) || 'temperature';
      pushScenario(scenarios, {
        label: `Building ${buildingName} trend`,
        scope: baseScope,
        question: `Plot ${buildingMetric} trends for each floor in this building and highlight daytime anomalies.`,
        durationHours: randomDuration(scenarios.length),
        expectedMetric: buildingMetric
      });

      const heatmapMetric = pickMetricMatching(buildingMetrics, /(people_count|occupancy)/, 'people_count');
      pushScenario(scenarios, {
        label: `Building ${buildingName} heatmap`,
        scope: baseScope,
        question: `Generate a heatmap of ${heatmapMetric} across all rooms this building sees and call out the quietest zones.`,
        durationHours: randomDuration(scenarios.length + 1),
        expectedMetric: heatmapMetric
      });

      const co2Metric = pickMetricMatching(buildingMetrics, /co2/, 'co2');
      pushScenario(scenarios, {
        label: `Building ${buildingName} CO2 vs occupancy`,
        scope: baseScope,
        question: `Create a scatter plot of ${co2Metric} versus ${heatmapMetric} for the busiest rooms and explain the relationship.`,
        durationHours: randomDuration(scenarios.length + 2),
        expectedMetric: `${co2Metric}/${heatmapMetric}`
      });

      pushScenario(scenarios, {
        label: `Building ${buildingName} daily profile`,
        scope: baseScope,
        question: `Use a daily profile to forecast the occupancy cycle for next week based on the selected window.`,
        durationHours: randomDuration(scenarios.length + 3),
        expectedMetric: heatmapMetric
      });

      pushScenario(scenarios, {
        label: `Building ${buildingName} data gaps`,
        scope: baseScope,
        question: `Identify data gaps longer than one hour for ${buildingMetric} across this building.`,
        durationHours: randomDuration(scenarios.length + 4),
        expectedMetric: buildingMetric
      });

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
        if (scenarios.length >= REQUIRED_SCENARIO_COUNT) break;
        if (!floor.name || !floor.zones.length) continue;
        const floorMetrics = collectMetrics({ zones: floor.zones.map((z) => z.metrics), deviceIndex: floor.zones.flatMap((z) => z.devices) });
        const floorScope = createScope({
          tenant,
          building: buildingName,
          floor: floor.name,
          floors: [floor.name],
          zones: floor.zones.map((z) => z.name).filter(Boolean),
          devices: floor.zones.flatMap((z) => z.devices).filter(Boolean),
          deviceZones: buildZoneDeviceMap(floor.zones)
        });

        const floorMetric = chooseMetric(floorMetrics) || buildingMetric;
        pushScenario(scenarios, {
          label: `Floor ${floor.name} comparison`,
          scope: floorScope,
          question: `Compare ${floorMetric} across zones on ${floor.name} and call out the peak performers.`,
          durationHours: randomDuration(scenarios.length),
          expectedMetric: floorMetric
        });

        const floorOccMetric = pickMetricMatching(floorMetrics, /(people_count|occupancy)/, 'people_count');
        pushScenario(scenarios, {
          label: `Floor ${floor.name} occupancy hour`,
          scope: floorScope,
          question: `Identify the lowest occupancy hour on ${floor.name} and include a column chart of ${floorOccMetric} by hour.`,
          durationHours: randomDuration(scenarios.length + 1),
          expectedMetric: floorOccMetric
        });

        pushScenario(scenarios, {
          label: `Floor ${floor.name} distribution`,
          scope: floorScope,
          question: `Build a histogram of ${floorMetric} readings across ${floor.name} for the selected window and describe the distribution shape.`,
          durationHours: randomDuration(scenarios.length + 2),
          expectedMetric: floorMetric
        });

        pushScenario(scenarios, {
          label: `Floor ${floor.name} heatmap`,
          scope: floorScope,
          question: `Create a zone-by-time heatmap of ${floorOccMetric} for ${floor.name} and highlight outliers.`,
          durationHours: randomDuration(scenarios.length + 3),
          expectedMetric: floorOccMetric
        });

        pushScenario(scenarios, {
          label: `Floor ${floor.name} data gaps`,
          scope: floorScope,
          question: `List data gaps longer than 45 minutes for ${floorMetric} on ${floor.name}.`,
          durationHours: randomDuration(scenarios.length + 4),
          expectedMetric: floorMetric
        });

        for (const zone of floor.zones) {
          if (scenarios.length >= REQUIRED_SCENARIO_COUNT) break;
          if (!zone.name || !zone.metrics.length) continue;
          const zoneMetric = chooseMetric(zone.metrics) || floorMetric;
          const zoneScope = createScope({
            tenant,
            building: buildingName,
            floor: floor.name,
            zone: zone.name,
            floors: [floor.name],
            zones: [zone.name],
            devices: zone.devices,
            deviceZones: buildZoneDeviceMap([zone])
          });

          pushScenario(scenarios, {
            label: `Zone ${zone.name} trend`,
            scope: zoneScope,
            question: `Plot ${zoneMetric} for ${zone.name} and describe any notable changes.`,
            durationHours: randomDuration(scenarios.length),
            expectedMetric: zoneMetric
          });

          if (metricMatches(zone.metrics, /total_kwh|energy|power/)) {
            const energyMetric = pickMetricMatching(zone.metrics, /total_kwh|energy|power/, zoneMetric);
            pushScenario(scenarios, {
              label: `Zone ${zone.name} energy histogram`,
              scope: zoneScope,
              question: `Provide a histogram of ${energyMetric} for ${zone.name} and highlight skew or spikes.`,
              durationHours: randomDuration(scenarios.length + 1),
              expectedMetric: energyMetric
            });
          }

          const pairCandidates = defaultMetricPairs(zone.metrics);
          for (const [m1, m2] of pairCandidates) {
            pushScenario(scenarios, {
              label: `Zone ${zone.name} ${m1} vs ${m2}`,
              scope: zoneScope,
              question: `Create a scatter plot of ${m1} versus ${m2} for ${zone.name} and interpret the relationship.`,
              durationHours: randomDuration(scenarios.length + 2),
              expectedMetric: `${m1}/${m2}`
            });
          }

          if (metricMatches(zone.metrics, /(co2|humidity)/) && metricMatches(zone.metrics, /(people_count|occupancy)/)) {
            const airMetric = pickMetricMatching(zone.metrics, /(co2|humidity)/, zoneMetric);
            const occMetric = pickMetricMatching(zone.metrics, /(people_count|occupancy)/, zoneMetric);
            pushScenario(scenarios, {
              label: `Zone ${zone.name} air vs occupancy`,
              scope: zoneScope,
              question: `Correlate ${airMetric} against ${occMetric} for ${zone.name} and include a scatter chart.`,
              durationHours: randomDuration(scenarios.length + 3),
              expectedMetric: `${airMetric}/${occMetric}`
            });
            pushScenario(scenarios, {
              label: `Zone ${zone.name} CO2 per person`,
              scope: zoneScope,
              question: `Calculate and plot ${airMetric} per person for ${zone.name}; flag any sustained values above guidelines.`,
              durationHours: randomDuration(scenarios.length + 4),
              expectedMetric: `${airMetric}/${occMetric}`
            });
          }

          pushScenario(scenarios, {
            label: `Zone ${zone.name} correlation matrix`,
            scope: zoneScope,
            question: `Build a correlation matrix for temperature, humidity, co2, and lux in ${zone.name}.`,
            durationHours: randomDuration(scenarios.length + 5),
            expectedMetric: 'correlation'
          });

          pushScenario(scenarios, {
            label: `Zone ${zone.name} spikes`,
            scope: zoneScope,
            question: `Detect any spikes where ${zoneMetric} in ${zone.name} exceeds the percentile-95 threshold and visualize them.`,
            durationHours: randomDuration(scenarios.length + 6),
            expectedMetric: zoneMetric
          });

          pushScenario(scenarios, {
            label: `Zone ${zone.name} forecast`,
            scope: zoneScope,
            question: `Forecast the next week of ${zoneMetric} for ${zone.name} using the recent window and include the historical context.`,
            durationHours: randomDuration(scenarios.length + 7),
            expectedMetric: zoneMetric
          });

          pushScenario(scenarios, {
            label: `Zone ${zone.name} weather correlation`,
            scope: zoneScope,
            question: `Analyze the correlation between outdoor humidity and ${zone.name} humidity over the selected window.`,
            durationHours: randomDuration(scenarios.length + 8),
            expectedMetric: zoneMetric
          });

          pushScenario(scenarios, {
            label: `Zone ${zone.name} best time`,
            scope: zoneScope,
            question: `Determine the best low occupancy hour in ${zone.name} and visualize the hourly occupancy profile.`,
            durationHours: randomDuration(scenarios.length + 9),
            expectedMetric: 'people_count'
          });

          pushScenario(scenarios, {
            label: `Zone ${zone.name} weather-adjusted`,
            scope: zoneScope,
            question: `Show how ${zoneMetric} in ${zone.name} changes on rainy vs. dry days using a comparison chart.`,
            durationHours: randomDuration(scenarios.length + 10),
            expectedMetric: zoneMetric
          });
        }
      }

      if (scenarios.length >= REQUIRED_SCENARIO_COUNT) break;
    }

    if (scenarios.length >= REQUIRED_SCENARIO_COUNT) break;
  }

  if (scenarios.length < REQUIRED_SCENARIO_COUNT && scenarios.length) {
    const needed = REQUIRED_SCENARIO_COUNT - scenarios.length;
    for (let i = 0; i < needed; i += 1) {
      const base = scenarios[i % scenarios.length];
      pushScenario(scenarios, {
        ...base,
        label: `${base.label} (extended ${i + 1})`,
        durationHours: randomDuration(scenarios.length + i),
        question: `${base.question} Also include any relevant seasonal insight.`
      });
    }
  }

  return scenarios.slice(0, REQUIRED_SCENARIO_COUNT);
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
