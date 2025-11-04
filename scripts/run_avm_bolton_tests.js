#!/usr/bin/env node
/**
 * Scenario test runner for AVM Solutions – Bolton.
 *
 * Executes 30 building-scope chat questions that mirror the
 * user-provided October 2025 scenarios, ensuring the agent
 * accesses real devices (only those with S3 data) and returns
 * plots/answers without “no data” fallbacks.
 */

import fs from 'fs';
import fsAsync from 'fs/promises';
import path from 'path';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const RESULTS_DIR = process.env.TEST_RESULTS_DIR || path.join('data', 'tests');
const TENANT = 'AVM Solutions';
const BUILDING = 'Bolton';
const REF_DATE = Date.parse(process.env.TEST_REF_DATE || '2025-10-24T23:59:00Z');
const snapshotCandidates = (() => {
  const slug = TENANT.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return [
    path.join('data', `graph_snapshot.${slug}.json`),
    path.join('data', 'graph_snapshot.json')
  ];
})();
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

function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function formatTs(ms) {
  if (ms == null || !Number.isFinite(ms)) return 'n/a';
  const d = new Date(ms);
  return `${d.toISOString().replace('T', ' ').slice(0, 16)} (${ms})`;
}

function loadSnapshot() {
  const found = snapshotCandidates.find((file) => fs.existsSync(file));
  if (!found) throw new Error(`No graph snapshot found for ${TENANT}. Did the server regenerate snapshots at startup?`);
  return JSON.parse(fs.readFileSync(found, 'utf8'));
}

function buildScopeIndex(snapshot) {
  const nodesById = new Map(snapshot.nodes.map((n) => [n.id, n]));
  const zoneDevices = new Map(); // zoneName -> [{ cloudId, name, deviceId }]
  const deviceFloors = new Map(); // device node id -> floorName
  const deviceCloud = new Map();  // device node id -> cloudId
  const floorNames = new Map();   // floor node id -> floor name
  const zoneNames = new Map();    // zone node id -> zone name

  for (const node of snapshot.nodes) {
    if (node.label === 'Floor') {
      floorNames.set(node.id, node.name || null);
    }
    if (node.label === 'Zone') {
      zoneNames.set(node.id, node.name || null);
    }
    if (node.label === 'Device') {
      deviceCloud.set(node.id, node.cloudId || node.name || null);
    }
  }

  for (const link of snapshot.links) {
    if (link.rel === 'LOCATED_ON_FLOOR' && deviceCloud.has(link.source)) {
      const floorName = floorNames.get(link.target) || null;
      deviceFloors.set(link.source, floorName);
    }
    if (link.rel === 'LOCATED_IN_ZONE' && deviceCloud.has(link.source)) {
      const zoneName = zoneNames.get(link.target) || null;
      if (!zoneName) continue;
      if (!zoneDevices.has(zoneName)) zoneDevices.set(zoneName, []);
      const deviceNode = nodesById.get(link.source);
      const cloudId = deviceCloud.get(link.source);
      if (!cloudId) continue;
      zoneDevices.get(zoneName).push({
        cloudId,
        name: deviceNode?.name || cloudId,
        deviceNodeId: link.source,
        floorName: deviceFloors.get(link.source) || null
      });
    }
  }

  return { zoneDevices };
}

function readCsvHeader(deviceId) {
  const file = path.join(CSV_DIR, `${deviceId}.csv`);
  if (!fs.existsSync(file)) return [];
  const data = fs.readFileSync(file, 'utf8');
  const [header] = data.split(/\r?\n/, 1);
  if (!header) return [];
  return header.split(',').map((h) => h.trim()).filter((h) => h && h !== 'ts');
}

function makeRange(startIso, endIso) {
  return {
    start: Date.parse(startIso),
    end: Date.parse(endIso)
  };
}

function dayRange(date) {
  return makeRange(`${date}T00:00:00Z`, `${date}T23:59:59Z`);
}

function inclusiveRange(startDate, endDate) {
  return makeRange(`${startDate}T00:00:00Z`, `${endDate}T23:59:59Z`);
}

function shortIso(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function buildSelection({ zones = [], devices = [] }, zoneIndex) {
  const uniqueZones = Array.from(new Set(zones.map((z) => String(z).trim()).filter(Boolean)));
  const uniqueDevices = Array.from(new Set(devices.map((d) => String(d).trim()).filter(Boolean)));

  const floors = new Set();
  const deviceZones = {};

  for (const zone of uniqueZones) {
    const entries = zoneIndex.zoneDevices.get(zone) || [];
    for (const entry of entries) {
      if (uniqueDevices.length && !uniqueDevices.includes(entry.cloudId)) continue;
      if (entry.floorName) floors.add(entry.floorName);
      deviceZones[entry.cloudId] = zone;
    }
  }

  // ensure device list aligns with zone mapping
  const resolvedDevices = uniqueDevices.length
    ? uniqueDevices
    : uniqueZones
        .flatMap((zone) => (zoneIndex.zoneDevices.get(zone) || []).map((d) => d.cloudId));

  resolvedDevices.forEach((id) => {
    if (!deviceZones[id]) {
      const zoneMatch = uniqueZones.find((zone) =>
        (zoneIndex.zoneDevices.get(zone) || []).some((d) => d.cloudId === id)
      );
      if (zoneMatch) deviceZones[id] = zoneMatch;
    }
  });

  const selection = {
    tenant: TENANT,
    building: BUILDING,
    floors: Array.from(floors),
    zones: uniqueZones,
    devices: resolvedDevices,
    deviceZones,
    labels: {
      tenant: TENANT,
      building: BUILDING,
      floor: null,
      room: uniqueZones.length === 1 ? uniqueZones[0] : (uniqueZones.length ? 'ALL' : null)
    },
    room: uniqueZones.length === 1 ? uniqueZones[0] : 'ALL'
  };
  return selection;
}

function collectDeviceStats(ids) {
  const entries = [];
  for (const id of ids) {
    const headers = readCsvHeader(id);
    entries.push({ id, headers, hasData: headers.length > 0 });
  }
  return entries;
}

function buildQuestionSet(devices) {
  const ids = {
    standup: '64214e60-479c-11f0-bf13-bf19a72566f6',
    huddle: '29436890-4798-11f0-bf13-bf19a72566f6',
    booths: 'c27807e0-4799-11f0-bf13-bf19a72566f6',
    sitdown: 'b19aae20-479c-11f0-bf13-bf19a72566f6',
    commsEnergy: '8e00d400-479a-11f0-bf13-bf19a72566f6',
    commsWater: '4a829030-58b9-11f0-a19e-8f874a1c01d3',
    cafeIaq: 'abc73b80-4797-11f0-bf13-bf19a72566f6',
    cafePeople: 'ab5fb660-872d-11f0-a19e-8f874a1c01d3',
    loungePeople: '7318f830-4799-11f0-bf13-bf19a72566f6',
    toiletOdor: '2e857e60-58b9-11f0-a19e-8f874a1c01d3',
    toiletLeak: '002f9dc0-58b9-11f0-a19e-8f874a1c01d3',
    brainstormOcc: '6ef94be0-479b-11f0-bf13-bf19a72566f6',
    brainstormTemp: 'f22ffa70-47a2-11f0-bf13-bf19a72566f6'
  };

  const deviceStats = collectDeviceStats(Object.values(ids));
  const missing = deviceStats.filter((d) => !d.hasData);
  if (missing.length) {
    console.warn('[run_avm_bolton_tests] Warning: devices with no data:', missing.map((m) => m.id));
  }

  const qs = [
    {
      question: 'What was the humidity in Standup on October 15th, 2025?',
      zones: ['Standup'],
      devices: [ids.standup],
      range: dayRange('2025-10-15')
    },
    {
      question: 'Show me the temperature readings from the Brainstorm temperature sensor for the week of October 13-20, 2025.',
      zones: ['Brainstorm'],
      devices: [ids.brainstormTemp],
      range: inclusiveRange('2025-10-13', '2025-10-20')
    },
    {
      question: 'What was the CO2 level in Booths at 2pm on October 18th, 2025?',
      zones: ['Booths'],
      devices: [ids.booths],
      range: makeRange('2025-10-18T13:00:00Z', '2025-10-18T15:00:00Z')
    },
    {
      question: 'Can you show me the total_kwh consumption for the Comms energy meter on October 10th, 2025?',
      zones: ['Comms'],
      devices: [ids.commsEnergy],
      range: dayRange('2025-10-10')
    },
    {
      question: 'What was the water_total reading from the Comms water meter on October 1st, 2025?',
      zones: ['Comms'],
      devices: [ids.commsWater],
      range: dayRange('2025-10-01')
    },
    {
      question: 'Was Sitdown unoccupied during the weekend of October 11-12, 2025?',
      zones: ['Sitdown'],
      devices: [ids.sitdown],
      range: inclusiveRange('2025-10-11', '2025-10-12')
    },
    {
      question: 'Show me occupancy patterns for Brainstorm throughout October 2025.',
      zones: ['Brainstorm'],
      devices: [ids.brainstormOcc],
      range: inclusiveRange('2025-10-01', '2025-10-24')
    },
    {
      question: 'Which collaboration zones had zero occupancy on October 20th, 2025 after 6pm?',
      zones: ['Sitdown', 'Brainstorm'],
      devices: [ids.sitdown, ids.brainstormOcc],
      range: makeRange('2025-10-20T18:00:00Z', '2025-10-21T00:00:00Z')
    },
    {
      question: 'Compare occupancy levels between Sitdown and Brainstorm for the first week of October 2025.',
      zones: ['Sitdown', 'Brainstorm'],
      devices: [ids.sitdown, ids.brainstormOcc],
      range: inclusiveRange('2025-10-01', '2025-10-07')
    },
    {
      question: 'Were there any temperature anomalies in Standup during October 2025?',
      zones: ['Standup'],
      devices: [ids.standup],
      range: inclusiveRange('2025-10-01', '2025-10-24')
    },
    {
      question: 'Did the Toilet odor sensor detect any unusual H2S or NH3 spikes in October 2025?',
      zones: ['Toilet'],
      devices: [ids.toiletOdor],
      range: inclusiveRange('2025-10-01', '2025-10-24')
    },
    {
      question: 'Show me any powerFailure events for the Comms energy meter in October 2025.',
      zones: ['Comms'],
      devices: [ids.commsEnergy],
      range: inclusiveRange('2025-10-01', '2025-10-24')
    },
    {
      question: 'Were there any abnormal humidity readings in Booths on October 17th, 2025?',
      zones: ['Booths'],
      devices: [ids.booths],
      range: dayRange('2025-10-17')
    },
    {
      question: 'Did the Toilet leak sensor detect any leakage_status changes in October 2025?',
      zones: ['Toilet'],
      devices: [ids.toiletLeak],
      range: inclusiveRange('2025-10-01', '2025-10-24')
    },
    {
      question: 'Plot CO2 levels comparing Booths and Cafe for October 15-20, 2025.',
      zones: ['Booths', 'Cafe'],
      devices: [ids.booths, ids.cafeIaq],
      range: inclusiveRange('2025-10-15', '2025-10-20')
    },
    {
      question: 'Compare VOC readings across Booths and Cafe for October 2025.',
      zones: ['Booths', 'Cafe'],
      devices: [ids.booths, ids.cafeIaq],
      range: inclusiveRange('2025-10-01', '2025-10-24')
    },
    {
      question: 'Show me a plot of temperature vs humidity for Standup for October 2025.',
      zones: ['Standup'],
      devices: [ids.standup],
      range: inclusiveRange('2025-10-01', '2025-10-24')
    },
    {
      question: 'Compare total_kwh from the Comms energy meter with occupancy in Sitdown during October 2025.',
      zones: ['Comms', 'Sitdown'],
      devices: [ids.commsEnergy, ids.sitdown],
      range: inclusiveRange('2025-10-01', '2025-10-24')
    },
    {
      question: 'Plot people-count trends for Lounge and Cafe for October 1-20, 2025.',
      zones: ['Lounge', 'Cafe'],
      devices: [ids.loungePeople, ids.cafePeople],
      range: inclusiveRange('2025-10-01', '2025-10-20')
    },
    {
      question: 'Create a heatmap of occupancy across Sitdown and Brainstorm for October 14-18, 2025.',
      zones: ['Sitdown', 'Brainstorm'],
      devices: [ids.sitdown, ids.brainstormOcc],
      range: inclusiveRange('2025-10-14', '2025-10-18')
    },
    {
      question: 'Show me a heatmap of CO2 concentrations for Booths and Cafe during October 2025.',
      zones: ['Booths', 'Cafe'],
      devices: [ids.booths, ids.cafeIaq],
      range: inclusiveRange('2025-10-01', '2025-10-24')
    },
    {
      question: 'Generate a heatmap showing humidity levels in Standup and Booths on October 19th, 2025.',
      zones: ['Standup', 'Booths'],
      devices: [ids.standup, ids.booths],
      range: dayRange('2025-10-19')
    },
    {
      question: 'Create a heatmap from the Cafe people counter for October 2025.',
      zones: ['Cafe'],
      devices: [ids.cafePeople],
      range: inclusiveRange('2025-10-01', '2025-10-24')
    },
    {
      question: 'Is there a correlation between occupancy in Sitdown and CO2 levels in Booths during October 2025?',
      zones: ['Sitdown', 'Booths'],
      devices: [ids.sitdown, ids.booths],
      range: inclusiveRange('2025-10-01', '2025-10-24')
    },
    {
      question: 'Show the correlation between humidity and temperature in Booths during October 2025.',
      zones: ['Booths'],
      devices: [ids.booths],
      range: inclusiveRange('2025-10-01', '2025-10-24')
    },
    {
      question: 'Show correlation between line_total_data and dwell from the Cafe people counter during October 2025.',
      zones: ['Cafe'],
      devices: [ids.cafePeople],
      range: inclusiveRange('2025-10-01', '2025-10-24')
    },
    {
      question: 'Analyze correlation between temperature and pressure readings in Standup throughout October 2025.',
      zones: ['Standup'],
      devices: [ids.standup],
      range: inclusiveRange('2025-10-01', '2025-10-24')
    },
    {
      question: 'Forecast total_kwh for the Comms energy meter for the next week based on October 1-20 data.',
      zones: ['Comms'],
      devices: [ids.commsEnergy],
      range: inclusiveRange('2025-10-01', '2025-10-20')
    },
    {
      question: 'Predict expected occupancy patterns for Sitdown for next week based on October 2025 trends.',
      zones: ['Sitdown'],
      devices: [ids.sitdown],
      range: inclusiveRange('2025-10-01', '2025-10-24')
    },
    {
      question: 'Forecast CO2 levels in Booths for October 21-25 based on earlier October data.',
      zones: ['Booths'],
      devices: [ids.booths],
      range: inclusiveRange('2025-10-01', '2025-10-20')
    }
  ];
  if (qs.length !== 30) {
    throw new Error(`Expected 30 questions, have ${qs.length}`);
  }
  return qs;
}

async function main() {
  ensureDirSync(RESULTS_DIR);
  const snapshot = loadSnapshot();
  const zoneIndex = buildScopeIndex(snapshot);
  const questions = buildQuestionSet(zoneIndex);

  const results = [];

  for (let i = 0; i < questions.length; i += 1) {
    const item = questions[i];
    const selection = buildSelection({ zones: item.zones, devices: item.devices }, zoneIndex);
    const payload = {
      messages: [{ role: 'user', content: item.question }],
      room: selection.room || 'ALL',
      range: item.range,
      selection,
      scope: selection
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
      chartHasData = series.some(
        (s) => (Array.isArray(s?.data) && s.data.length > 0) || Boolean(s?.dataRef)
      );
    } catch (err) {
      error = String(err?.message || err);
    }
    const elapsedMs = Date.now() - started;

    results.push({
      index: i + 1,
      question: item.question,
      range: {
        start: item.range?.start != null ? formatTs(item.range.start) : null,
        end: item.range?.end != null ? formatTs(item.range.end) : null,
        startEpochMs: item.range?.start ?? null,
        endEpochMs: item.range?.end ?? null
      },
      scope: {
        tenant: selection.tenant,
        building: selection.building,
        floors: selection.floors,
        zones: selection.zones,
        devices: selection.devices,
        deviceZones: selection.deviceZones
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
    `chat_avm_bolton_${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  );
  await fsAsync.writeFile(
    outfile,
    JSON.stringify(
      {
        baseUrl: BASE_URL,
        tenant: TENANT,
        building: BUILDING,
        refDate: new Date(REF_DATE).toISOString(),
        results
      },
      null,
      2
    )
  );

  const failures = results.filter((r) => r.error || !r.chartHasData);
  console.log(
    `Finished ${results.length} questions in ${(results.reduce((sum, r) => sum + r.elapsedMs, 0) / 1000).toFixed(1)}s. Saved to ${outfile}.`
  );
  if (failures.length) {
    console.warn(`Encountered ${failures.length} potential issues:`);
    failures.forEach((f) => {
      const reason = f.error ? f.error : 'no chart data returned';
      console.warn(`  #${f.index}: ${reason}`);
    });
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[run_avm_bolton_tests] fatal', err);
  process.exit(1);
});
