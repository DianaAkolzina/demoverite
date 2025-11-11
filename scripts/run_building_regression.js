#!/usr/bin/env node
import fs from 'fs';
import fsAsync from 'fs/promises';
import path from 'path';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const SNAPSHOT_FILE = path.join(DATA_DIR, 'graph_snapshot.json');
const CSV_DIR = process.env.TEST_CSV_DIR
  ? path.resolve(process.cwd(), process.env.TEST_CSV_DIR)
  : path.join(ROOT, 'CSVex_s3');
const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const RESULTS_DIR = process.env.TEST_RESULTS_DIR || path.join(DATA_DIR, 'tests');

const TARGET_BUILDINGS = [
  { tenant: 'AVM Solutions', building: 'Bolton', slug: 'avm_bolton' },
  { tenant: null, building: '111 Piccadilly', slug: '111_piccadilly' },
  { tenant: null, building: '55 King Street', slug: 'king_street' }
];

const METRIC_GROUPS = {
  temperature: ['temperature', 'temp'],
  humidity: ['humidity', 'relativehumidity', 'rh'],
  co2: ['co2', 'concentration'],
  occupancy: ['people_count', 'occupancy', 'is_used'],
  energy: ['total_kwh', 'energy', 'value', 'kw'],
  lux: ['lux', 'light', 'illuminance'],
  voc: ['voc', 'tvoc'],
  water: ['water_total', 'water', 'cubic_value']
};

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_SPAN_MS = 6 * 60 * 60 * 1000;

const deviceMetaCache = new Map();

function loadSnapshot() {
  if (!fs.existsSync(SNAPSHOT_FILE)) {
    throw new Error(`Snapshot file not found: ${SNAPSHOT_FILE}`);
  }
  return JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
}

function buildIndex(snapshot) {
  const nodeMap = new Map(snapshot.nodes.map((n) => [n.id, n]));
  const buildingZones = new Map();
  const deviceZone = new Map();

  for (const link of snapshot.links || []) {
    if (link.rel !== 'LOCATED_IN_ZONE') continue;
    const deviceNode = nodeMap.get(link.source);
    const zoneNode = nodeMap.get(link.target);
    if (!deviceNode || !zoneNode) continue;
    const cloudId = deviceNode.cloudId;
    if (!cloudId) continue;
    const zoneParts = zoneNode.id.split(':');
    const zoneName = zoneNode.name || zoneParts.slice(1, -1).join(':') || zoneParts[1] || null;
    const buildingName = zoneParts[zoneParts.length - 1];
    if (!zoneName || !buildingName) continue;
    if (!buildingZones.has(buildingName)) buildingZones.set(buildingName, new Map());
    const zoneMap = buildingZones.get(buildingName);
    if (!zoneMap.has(zoneName)) zoneMap.set(zoneName, new Set());
    zoneMap.get(zoneName).add(cloudId);
    deviceZone.set(cloudId, zoneName);
  }

  return { buildingZones, deviceZone };
}

function readCsvMeta(deviceId) {
  if (deviceMetaCache.has(deviceId)) return deviceMetaCache.get(deviceId);
  const file = path.join(CSV_DIR, `${deviceId}.csv`);
  if (!fs.existsSync(file)) {
    deviceMetaCache.set(deviceId, null);
    return null;
  }
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length);
  if (lines.length < 2) {
    deviceMetaCache.set(deviceId, null);
    return null;
  }
  const headers = lines[0].split(',').map((h) => h.trim());
  const tsIndex = headers.indexOf('ts');
  if (tsIndex === -1) {
    deviceMetaCache.set(deviceId, null);
    return null;
  }
  const firstRow = lines[1].split(',');
  const lastRow = lines[lines.length - 1].split(',');
  const startTs = Number(firstRow[tsIndex]);
  const endTs = Number(lastRow[tsIndex]);
  if (!Number.isFinite(startTs) || !Number.isFinite(endTs) || startTs >= endTs) {
    deviceMetaCache.set(deviceId, null);
    return null;
  }
  const metrics = headers.filter((h) => h !== 'ts' && h.trim().length);
  const meta = { metrics, startTs, endTs };
  deviceMetaCache.set(deviceId, meta);
  return meta;
}

function clampRange(meta, days = 14) {
  if (!meta) return null;
  const end = meta.endTs;
  let start = Math.max(meta.startTs, end - days * DAY_MS);
  if (end - start < MIN_SPAN_MS) start = Math.max(meta.startTs, end - MIN_SPAN_MS);
  if (start >= end) return null;
  return { start, end };
}

function intersectRanges(ranges) {
  if (!ranges.length) return null;
  let start = ranges[0].start;
  let end = ranges[0].end;
  for (let i = 1; i < ranges.length; i += 1) {
    start = Math.max(start, ranges[i].start);
    end = Math.min(end, ranges[i].end);
    if (start >= end) return null;
  }
  if (end - start < MIN_SPAN_MS) {
    start = end - MIN_SPAN_MS;
    if (start < 0) start = 0;
  }
  return { start, end };
}

function formatDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function formatRange(range) {
  return `${formatDate(range.start)} and ${formatDate(range.end)}`;
}

function metricLabel(metric) {
  if (!metric) return 'the metric';
  const key = metric.toLowerCase();
  if (key === 'co2' || key === 'concentration') return 'CO₂';
  if (key === 'total_kwh') return 'total kWh';
  if (key === 'people_count') return 'people count';
  return key.replace(/_/g, ' ');
}

function pickDevice(devices, aliases, exclude = new Set()) {
  for (const device of devices) {
    if (exclude.has(device.id)) continue;
    if (device.metricsLC.some((m) => aliases.includes(m))) return device;
  }
  return null;
}

function pickDevicePair(devices, aliases) {
  const seenZones = new Set();
  const picked = [];
  for (const device of devices) {
    if (!device.metricsLC.some((m) => aliases.includes(m))) continue;
    if (seenZones.has(device.zone)) continue;
    picked.push(device);
    seenZones.add(device.zone);
    if (picked.length === 2) break;
  }
  return picked.length === 2 ? picked : [];
}

function pickDeviceList(devices, aliases, count) {
  const seenZones = new Set();
  const picked = [];
  for (const device of devices) {
    if (!device.metricsLC.some((m) => aliases.includes(m))) continue;
    if (seenZones.has(device.zone)) continue;
    picked.push(device);
    seenZones.add(device.zone);
    if (picked.length === count) break;
  }
  return picked;
}

function findZoneWithMetricCombo(devices, groupNames) {
  const zoneMatches = new Map();
  for (const device of devices) {
    for (const group of groupNames) {
      const aliases = METRIC_GROUPS[group];
      if (!aliases) continue;
      if (device.metricsLC.some((m) => aliases.includes(m))) {
        if (!zoneMatches.has(device.zone)) zoneMatches.set(device.zone, {});
        const store = zoneMatches.get(device.zone);
        if (!store[group]) store[group] = device;
      }
    }
  }
  for (const [zone, mapping] of zoneMatches.entries()) {
    if (groupNames.every((group) => mapping[group])) {
      return {
        zone,
        devices: groupNames.map((group) => mapping[group])
      };
    }
  }
  return null;
}

function hasAllMetrics(device, groups) {
  return groups.every((aliases) => device.metricsLC.some((m) => aliases.includes(m)));
}

function buildQuestions(spec, devices) {
  const questions = [];
  if (!devices.length) return questions;
  const uniqueZones = Array.from(new Set(devices.map((d) => d.zone).filter(Boolean)));
  const tempDevice = pickDevice(devices, METRIC_GROUPS.temperature);
  const scopeAnchor = devices[0];
  if (scopeAnchor) {
    const scopeRange = clampRange(scopeAnchor, 10);
    if (scopeRange) {
      questions.push({
        label: 'scope_summary_zone',
        metric: null,
        zones: [scopeAnchor.zone],
        devices: [scopeAnchor.id],
        range: scopeRange,
        question: `For ${spec.building}, summarise the current scope for ${scopeAnchor.zone} between ${formatRange(scopeRange)}. List the sensors, their metrics, and note any gaps in telemetry. Base the answer only on the active scope.`
      });
    }
  if (uniqueZones.length >= 3) {
    const buildingScopeRange = clampRange(scopeAnchor, 14);
    if (buildingScopeRange) {
      const subsetZones = uniqueZones.slice(0, 5);
      const deviceIds = devices.filter((d) => subsetZones.includes(d.zone)).map((d) => d.id);
      questions.push({
        label: 'building_scope_inventory',
        metric: null,
        zones: subsetZones,
        devices: deviceIds,
        range: buildingScopeRange,
        question: `Within ${spec.building}, explain the visible scope between ${formatRange(buildingScopeRange)}. Which floors, zones, and devices are currently selected? Highlight any missing areas in the scope.`
      });
      questions.push({
        label: 'building_scope_story',
        metric: null,
        zones: subsetZones,
        devices: deviceIds,
        range: buildingScopeRange,
        question: `Using the current selection for ${spec.building}, summarize the key comfort and utilization trends across ${subsetZones.slice(0, 4).join(', ')} between ${formatRange(buildingScopeRange)}. Mention any rooms that lack temperature, CO₂, or occupancy readings.`
      });
    }
  }
  }
  if (tempDevice) {
    const range = clampRange(tempDevice);
    if (range) {
      questions.push({
        label: 'temp_line',
        metric: tempDevice.metricsLC.find((m) => METRIC_GROUPS.temperature.includes(m)),
        zones: [tempDevice.zone],
        devices: [tempDevice.id],
        range,
        question: `Plot the temperature trend for ${tempDevice.zone} in ${spec.building} between ${formatRange(range)}.`
      });
    }
  }
  const tempMetricName = tempDevice?.metricsLC?.find((m) => METRIC_GROUPS.temperature.includes(m)) || 'temperature';
  const histogramRange = tempDevice ? clampRange(tempDevice, 14) : null;
  if (tempDevice && histogramRange) {
    questions.push({
      label: 'temp_histogram',
      metric: tempMetricName,
      zones: [tempDevice.zone],
      devices: [tempDevice.id],
      range: histogramRange,
      question: `Show a histogram of ${metricLabel(tempMetricName)} values for ${tempDevice.zone} in ${spec.building} between ${formatRange(histogramRange)}.`
    });
  }
  const co2Device = pickDevice(devices, METRIC_GROUPS.co2);
  if (co2Device) {
    const range = clampRange(co2Device);
    if (range) {
      const metric = co2Device.metricsLC.find((m) => METRIC_GROUPS.co2.includes(m));
      questions.push({
        label: 'co2_line',
        metric,
        zones: [co2Device.zone],
        devices: [co2Device.id],
        range,
        question: `Plot the ${metricLabel(metric)} readings for ${co2Device.zone} in ${spec.building} between ${formatRange(range)}.`
      });
    }
  }
  const rankingCandidates = pickDeviceList(devices, METRIC_GROUPS.temperature, 6);
  const rankingRanges = rankingCandidates.map((d) => clampRange(d, 14)).filter(Boolean);
  const rankingRange = intersectRanges(rankingRanges);
  if (rankingCandidates.length >= 3 && rankingRange) {
    questions.push({
      label: 'temp_rank_rooms',
      metric: tempMetricName,
      zones: rankingCandidates.map((d) => d.zone),
      devices: rankingCandidates.map((d) => d.id),
      range: rankingRange,
      question: `Rank the rooms in ${spec.building} by average ${metricLabel(tempMetricName)} between ${formatRange(rankingRange)}.`
    });
  }
  const humidityDevice = pickDevice(devices, METRIC_GROUPS.humidity);
  if (humidityDevice) {
    const range = clampRange(humidityDevice);
    if (range) {
      const metric = humidityDevice.metricsLC.find((m) => METRIC_GROUPS.humidity.includes(m));
      const pointEnd = Math.min(range.end, range.start + 2 * 60 * 60 * 1000);
      const pointRange = pointEnd > range.start ? { start: range.start, end: pointEnd } : range;
      const pointMid = new Date(Math.round(((pointRange.start ?? range.start) + (pointRange.end ?? range.end)) / 2))
        .toISOString()
        .replace('T', ' ')
        .slice(0, 16);
      questions.push({
        label: 'point_query',
        metric,
        zones: [humidityDevice.zone],
        devices: [humidityDevice.id],
        range: pointRange,
        question: `What was the ${metricLabel(metric)} in ${humidityDevice.zone} at ${pointMid} (local time)?`
      });
    }
  }
  const co2Pair = pickDevicePair(devices, METRIC_GROUPS.co2);
  if (co2Pair.length === 2) {
    const ranges = co2Pair.map((d) => clampRange(d, 10)).filter(Boolean);
    const range = intersectRanges(ranges);
    if (range) {
      const metric = co2Pair[0].metricsLC.find((m) => METRIC_GROUPS.co2.includes(m));
      questions.push({
        label: 'compare_rooms',
        metric,
        zones: co2Pair.map((d) => d.zone),
        devices: co2Pair.map((d) => d.id),
        range,
        question: `Compare ${metricLabel(metric)} levels between ${co2Pair[0].zone} and ${co2Pair[1].zone} in ${spec.building} from ${formatRange(range)}.`
      });
    }
  }
  const occupancyHeatmapDevices =
    pickDeviceList(devices, METRIC_GROUPS.occupancy, 4).length >= 3
      ? pickDeviceList(devices, METRIC_GROUPS.occupancy, 4)
      : pickDeviceList(devices, METRIC_GROUPS.co2, 4);
  if (occupancyHeatmapDevices.length >= 3) {
    const ranges = occupancyHeatmapDevices.map((d) => clampRange(d, 7)).filter(Boolean);
    const range = intersectRanges(ranges);
    if (range) {
      const metric = occupancyHeatmapDevices[0].metricsLC.find((m) =>
        (METRIC_GROUPS.occupancy.includes(m) ? METRIC_GROUPS.occupancy : METRIC_GROUPS.co2).includes(m)
      );
      questions.push({
        label: 'heatmap',
        metric,
        zones: occupancyHeatmapDevices.map((d) => d.zone),
        devices: occupancyHeatmapDevices.map((d) => d.id),
        range,
        question: `Show a heatmap of ${metricLabel(metric)} across ${occupancyHeatmapDevices
          .map((d) => d.zone)
          .slice(0, 4)
          .join(', ')} in ${spec.building} between ${formatRange(range)}.`
      });
    }
  }
  const scatterDevice = devices.find((d) =>
    hasAllMetrics(d, [METRIC_GROUPS.temperature, METRIC_GROUPS.humidity])
  );
  if (scatterDevice) {
    const range = clampRange(scatterDevice, 10);
    if (range) {
      questions.push({
        label: 'scatter',
        metric: 'temperature_vs_humidity',
        zones: [scatterDevice.zone],
        devices: [scatterDevice.id],
        range,
        question: `Show a scatter plot of temperature versus humidity for ${scatterDevice.zone} in ${spec.building} between ${formatRange(range)}.`
      });
    }
  }
  const compareDevice = devices.find((d) =>
    d.metricsLC.includes('temperature') && d.metricsLC.includes('humidity')
  );
  const compareRange = compareDevice ? clampRange(compareDevice, 14) : null;
  if (compareDevice && compareRange) {
    questions.push({
      label: 'temperature_humidity_compare',
      metric: 'temperature_humidity',
      zones: [compareDevice.zone],
      devices: [compareDevice.id],
      range: compareRange,
      question: `Compare the average temperature and humidity in ${compareDevice.zone} for ${spec.building} between ${formatRange(compareRange)}.`
    });
  }
  const occupancyDevice = pickDevice(devices, METRIC_GROUPS.occupancy);
  if (occupancyDevice) {
    const range = clampRange(occupancyDevice, 14);
    if (range) {
      questions.push({
        label: 'forecast_occupancy',
        metric: occupancyDevice.metricsLC.find((m) => METRIC_GROUPS.occupancy.includes(m)),
        zones: [occupancyDevice.zone],
        devices: [occupancyDevice.id],
        range,
        question: `Forecast ${metricLabel(
          occupancyDevice.metricsLC.find((m) => METRIC_GROUPS.occupancy.includes(m))
        )} for ${occupancyDevice.zone} in ${spec.building} for the next 7 days using data from ${formatRange(
          range
        )}. Explain what the forecast suggests about busy vs quiet periods.`
      });
    }
  }
  const energyDevice = pickDevice(devices, METRIC_GROUPS.energy);
  const waterDevice = pickDevice(devices, METRIC_GROUPS.water);
  if (energyDevice) {
    const range = clampRange(energyDevice, 10);
    if (range) {
      const metric = energyDevice.metricsLC.find((m) => METRIC_GROUPS.energy.includes(m));
      questions.push({
        label: 'energy_delta',
        metric,
        zones: [energyDevice.zone],
        devices: [energyDevice.id],
        range,
        question: `Calculate the ${metricLabel(metric)} usage for ${energyDevice.zone} in ${spec.building} between ${formatRange(range)}.`
      });
      if (occupancyDevice) {
        const overlap = intersectRanges([range, clampRange(occupancyDevice, 10)].filter(Boolean));
        if (overlap) {
          questions.push({
            label: 'energy_vs_occupancy_story',
            metric: null,
            zones: Array.from(new Set([energyDevice.zone, occupancyDevice.zone])),
            devices: [energyDevice.id, occupancyDevice.id],
            range: overlap,
            question: `Do energy readings in ${energyDevice.zone} track the occupancy seen in ${occupancyDevice.zone} between ${formatRange(overlap)}? Comment on any divergence and suggest reasons.`
          });
        }
      }
    }
  }
  const luxPair = pickDevicePair(devices, METRIC_GROUPS.lux);
  if (luxPair.length === 2) {
    const ranges = luxPair.map((d) => clampRange(d, 5)).filter(Boolean);
    const range = intersectRanges(ranges);
    if (range) {
      questions.push({
        label: 'lux_compare',
        metric: 'lux',
        zones: luxPair.map((d) => d.zone),
        devices: luxPair.map((d) => d.id),
        range,
        question: `Compare light levels between ${luxPair[0].zone} and ${luxPair[1].zone} in ${spec.building} from ${formatRange(range)}.`
      });
    }
  }
  if (occupancyDevice && co2Device) {
    const overlapRange = intersectRanges(
      [clampRange(occupancyDevice, 7), clampRange(co2Device, 7)].filter(Boolean)
    );
    if (overlapRange) {
      questions.push({
        label: 'co2_per_person_ratio',
        metric: 'co2_per_person',
        zones: Array.from(new Set([occupancyDevice.zone, co2Device.zone].filter(Boolean))),
        devices: [occupancyDevice.id, co2Device.id],
        range: overlapRange,
        question: `Calculate CO₂ per person using the available CO₂ and occupancy sensors between ${formatRange(
          overlapRange
        )} and explain what this indicates about ventilation in ${spec.building}.`
      });
    }
  }

  const warmIdleCombo = findZoneWithMetricCombo(devices, ['temperature', 'occupancy']);
  if (warmIdleCombo) {
    const ranges = warmIdleCombo.devices.map((d) => clampRange(d, 7)).filter(Boolean);
    const warmIdleRange = intersectRanges(ranges);
    if (warmIdleRange) {
      questions.push({
        label: 'warm_unoccupied_alert',
        metric: null,
        zones: [warmIdleCombo.zone],
        devices: warmIdleCombo.devices.map((d) => d.id),
        range: warmIdleRange,
        question: `During ${formatRange(warmIdleRange)}, identify windows where ${warmIdleCombo.zone} in ${spec.building} was unoccupied while temperatures stayed above 21 °C. Highlight how often this occurs.`
      });
    }
  }

  const meetingOccupancyDevices = pickDeviceList(devices, METRIC_GROUPS.occupancy, 5);
  const meetingRange = intersectRanges(
    meetingOccupancyDevices.map((d) => clampRange(d, 7)).filter(Boolean)
  );
  if (meetingOccupancyDevices.length >= 3 && meetingRange) {
    questions.push({
      label: 'meeting_room_usage_rank',
      metric: null,
      zones: meetingOccupancyDevices.map((d) => d.zone),
      devices: meetingOccupancyDevices.map((d) => d.id),
      range: meetingRange,
      question: `Which meeting rooms (${meetingOccupancyDevices
        .map((d) => d.zone)
        .slice(0, 4)
        .join(', ')}) are being used the most in ${spec.building} between ${formatRange(
        meetingRange
      )}? Rank them by occupancy and identify any underused rooms.`
    });
  }

  if (occupancyDevice) {
    const weatherCorrRange = clampRange(occupancyDevice, 10);
    if (weatherCorrRange) {
      questions.push({
        label: 'weather_vs_occupancy',
        metric: null,
        zones: [occupancyDevice.zone],
        devices: [occupancyDevice.id],
        range: weatherCorrRange,
        question: `What is the correlation between the outside weather and occupancy in ${spec.building} between ${formatRange(weatherCorrRange)}? Reference both the indoor occupancy data and weather readings.`
      });
    }
  }

  const comfortDevice = devices.find((d) =>
    hasAllMetrics(d, [METRIC_GROUPS.temperature, METRIC_GROUPS.humidity, METRIC_GROUPS.co2])
  );
  if (comfortDevice) {
    const range = clampRange(comfortDevice, 12);
    if (range) {
      questions.push({
        label: 'comfort_summary',
        metric: null,
        zones: [comfortDevice.zone],
        devices: [comfortDevice.id],
        range,
        question: `Provide a comfort summary for ${comfortDevice.zone} in ${spec.building} between ${formatRange(
          range
        )}. Comment on CO₂, temperature, and humidity peaks, and highlight any periods that fall outside typical comfort bands.`
      });
    }
  }

  if (tempDevice) {
    const weatherCompareRange = clampRange(tempDevice, 10);
    if (weatherCompareRange) {
      questions.push({
        label: 'temperature_weather_compare',
        metric: tempMetricName,
        zones: [tempDevice.zone],
        devices: [tempDevice.id],
        range: weatherCompareRange,
        question: `How does the indoor temperature in ${tempDevice.zone} compare with the outside weather for ${
          spec.building
        } between ${formatRange(weatherCompareRange)}? Highlight any divergences or lags.`
      });
      questions.push({
        label: 'heating_lead_time',
        metric: null,
        zones: [tempDevice.zone],
        devices: [tempDevice.id],
        range: weatherCompareRange,
        question: `Based on ${formatRange(weatherCompareRange)}, how long does it take to heat ${spec.building} to comfort levels and when should we turn the heating on to hit 21 °C before occupancy peaks?`
      });
    }
  }

  const holisticAnchor = scopeAnchor || tempDevice || occupancyDevice || devices[0] || null;
  const holisticRange = clampRange(holisticAnchor, 10);
  if (holisticRange) {
    const defaultZones = uniqueZones.slice(0, 6);
    const defaultDevices = devices.filter((d) => defaultZones.includes(d.zone)).map((d) => d.id);
    if (defaultZones.length && defaultDevices.length) {
      questions.push({
        label: 'rooms_unused',
        metric: null,
        zones: defaultZones,
        devices: defaultDevices,
        range: holisticRange,
        question: `Have any of the rooms in ${spec.building} gone unused between ${formatRange(holisticRange)}? Identify idle rooms and note whether they lack people-count telemetry.`
      });
      questions.push({
        label: 'people_forecast_week',
        metric: null,
        zones: defaultZones,
        devices: defaultDevices,
        range: holisticRange,
        question: `How many people will be in ${spec.building} today and over the next week based on the patterns observed between ${formatRange(holisticRange)}?`
      });
      questions.push({
        label: 'busiest_room_general',
        metric: null,
        zones: defaultZones,
        devices: defaultDevices,
        range: holisticRange,
        question: `Which rooms will be the busiest in ${spec.building} during ${formatRange(holisticRange)}, and which look underused?`
      });
      questions.push({
        label: 'cleaning_time_general',
        metric: null,
        zones: defaultZones,
        devices: defaultDevices,
        range: holisticRange,
        question: `What is the best date/time to arrange cleaning for the selected rooms in ${spec.building} based on low occupancy within ${formatRange(holisticRange)}?`
      });
      questions.push({
        label: 'coffee_promo_time',
        metric: null,
        zones: defaultZones,
        devices: defaultDevices,
        range: holisticRange,
        question: `What time do most people leave ${spec.building} according to the data in ${formatRange(holisticRange)} so we can entice them with discounted coffees or teas?`
      });
      questions.push({
        label: 'busiest_day_week',
        metric: null,
        zones: defaultZones,
        devices: defaultDevices,
        range: holisticRange,
        question: `What is the busiest day of the week for the selected scope in ${spec.building}? Use the data from ${formatRange(holisticRange)} to justify your answer.`
      });
      if (energyDevice && occupancyDevice) {
        const sharedRange = intersectRanges([holisticRange, clampRange(energyDevice, 10), clampRange(occupancyDevice, 10)].filter(Boolean));
        if (sharedRange) {
          questions.push({
            label: 'energy_per_occupant',
            metric: null,
            zones: Array.from(new Set([energyDevice.zone, occupancyDevice.zone, ...defaultZones])).slice(0, 6),
            devices: Array.from(new Set([energyDevice.id, occupancyDevice.id, ...defaultDevices])),
            range: sharedRange,
            question: `What is the average energy consumption per occupant in ${spec.building} between ${formatRange(sharedRange)}? Highlight any anomalies in energy versus occupancy.`
          });
          questions.push({
            label: 'energy_peak_time',
            metric: null,
            zones: Array.from(new Set([energyDevice.zone, ...defaultZones])).slice(0, 6),
            devices: Array.from(new Set([energyDevice.id, ...defaultDevices])),
            range: sharedRange,
            question: `What date/time during ${formatRange(sharedRange)} will ${spec.building} use the most energy, and why?`
          });
          questions.push({
            label: 'demand_response_energy',
            metric: null,
            zones: Array.from(new Set([energyDevice.zone, ...defaultZones])).slice(0, 6),
            devices: Array.from(new Set([energyDevice.id, ...defaultDevices])),
            range: sharedRange,
            question: `How much energy did ${spec.building} use during demand-side response hours (weekdays 16:00-19:00 local time) within ${formatRange(sharedRange)}, and what caused any spikes?`
          });
        }
      }
      if (waterDevice && occupancyDevice) {
        const waterRange = intersectRanges(
          [holisticRange, clampRange(waterDevice, 10), clampRange(occupancyDevice, 10)].filter(Boolean)
        );
        if (waterRange) {
          questions.push({
            label: 'water_vs_occupancy_anomaly',
            metric: null,
            zones: Array.from(new Set([waterDevice.zone, occupancyDevice.zone, ...defaultZones])).slice(0, 6),
            devices: Array.from(new Set([waterDevice.id, occupancyDevice.id, ...defaultDevices])),
            range: waterRange,
            question: `Are there anomalies in water usage relative to occupancy in ${spec.building} between ${formatRange(waterRange)}? Call out periods where flow stayed high despite low or no occupancy.`
          });
        }
      }
      if (tempDevice) {
        questions.push({
          label: 'comfort_guidance',
          metric: null,
          zones: defaultZones,
          devices: defaultDevices,
          range: holisticRange,
          question: `Are all monitored spaces within a comfortable temperature range between ${formatRange(holisticRange)} in ${spec.building}? What temperature should we target?`
        });
      }
      questions.push({
        label: 'energy_savings_general',
        metric: null,
        zones: defaultZones,
        devices: defaultDevices,
        range: holisticRange,
        question: `How can we save energy in ${spec.building} this week based on the telemetry between ${formatRange(holisticRange)}?`
      });
      questions.push({
        label: 'occupancy_forecast_story',
        metric: null,
        zones: defaultZones,
        devices: defaultDevices,
        range: holisticRange,
        question: `On average, how many people occupy the selected rooms in ${spec.building}? Use ${formatRange(holisticRange)} to provide the estimates.`
      });
    }
  }

  return questions;
}

function createSelection(spec, zones, devices, deviceZoneMap) {
  const zoneSet = new Set(zones.filter(Boolean));
  const deviceZones = {};
  for (const id of devices) {
    const zone = deviceZoneMap.get(id) || null;
    if (zone) zoneSet.add(zone);
    deviceZones[id] = zone;
  }
  const zoneList = Array.from(zoneSet);
  const room = zoneList.length === 1 ? zoneList[0] : 'ALL';
  return {
    tenant: spec.tenant,
    building: spec.building,
    floors: [],
    zones: zoneList,
    devices,
    deviceZones,
    labels: {
      tenant: spec.tenant,
      building: spec.building,
      floor: null,
      room
    },
    room
  };
}

function arrayHasData(arr, valueKey) {
  if (!Array.isArray(arr)) return false;
  return arr.some((item) => {
    if (Array.isArray(item)) {
      return item.length > 1 && item[1] != null;
    }
    if (item && typeof item === 'object') {
      const key = valueKey && item[valueKey] != null ? valueKey : Object.keys(item).find((k) => k !== 'ts');
      return key ? item[key] != null : false;
    }
    return item != null;
  });
}

function hasDataForSeries(series, trace) {
  if (!series) return false;
  if (Array.isArray(series.data) && arrayHasData(series.data, 'y')) return true;
  const ref = series.dataRef;
  if (!ref) return false;
  if (!Array.isArray(trace)) return false;
  for (let i = trace.length - 1; i >= 0; i -= 1) {
    const entry = trace[i];
    if (!entry || entry.tool !== ref.tool) continue;
    if (ref.room && entry.args?.room && String(entry.args.room) !== String(ref.room)) continue;
    if (Array.isArray(entry.result) && arrayHasData(entry.result, ref.yField || 'y')) return true;
    if (ref.field && Array.isArray(entry.result?.[ref.field]) && arrayHasData(entry.result[ref.field], ref.yField || ref.field)) return true;
    if (Array.isArray(entry.result?.series)) {
      if (entry.result.series.some((serie) => arrayHasData(serie.data, 'y'))) return true;
    }
  }
  return false;
}

function evaluateChartPresence(response) {
  const chart = response?.chart;
  if (!chart || !Array.isArray(chart.series)) {
    return { hasData: false, seriesCount: 0 };
  }
  const trace = response?.trace || [];
  let count = 0;
  let hasData = false;
  for (const series of chart.series) {
    if (!series) continue;
    count += 1;
    if (hasDataForSeries(series, trace)) hasData = true;
  }
  return { hasData, seriesCount: count };
}

async function runQuestion(payload) {
  const res = await fetch(`${BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`HTTP ${res.status}: ${msg}`);
  }
  return res.json();
}

async function main() {
  await fsAsync.mkdir(RESULTS_DIR, { recursive: true });
  const snapshot = loadSnapshot();
  const index = buildIndex(snapshot);
  const summaries = [];

  for (const spec of TARGET_BUILDINGS) {
    const zoneMap = index.buildingZones.get(spec.building);
    if (!zoneMap) {
      console.warn(`[run_building_regression] No zones found for ${spec.building}, skipping.`);
      continue;
    }
    const devices = [];
    for (const [zoneName, ids] of zoneMap.entries()) {
      for (const id of ids) {
        const meta = readCsvMeta(id);
        if (!meta) continue;
        devices.push({
          id,
          zone: zoneName,
          metrics: meta.metrics,
          metricsLC: meta.metrics.map((m) => m.toLowerCase()),
          startTs: meta.startTs,
          endTs: meta.endTs
        });
      }
    }
    if (!devices.length) {
      console.warn(`[run_building_regression] No telemetry for ${spec.building}, skipping.`);
      continue;
    }
    devices.sort((a, b) => b.endTs - a.endTs);
    const questions = buildQuestions(spec, devices);
    if (!questions.length) {
      console.warn(`[run_building_regression] Unable to assemble questions for ${spec.building}.`);
      continue;
    }
    const results = [];
    for (let i = 0; i < questions.length; i += 1) {
      const item = questions[i];
      const selection = createSelection(spec, item.zones, item.devices, index.deviceZone);
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
        response = await runQuestion(payload);
        const chartInfo = evaluateChartPresence(response);
        chartSeriesCount = chartInfo.seriesCount;
        chartHasData = chartInfo.hasData;
        const expectsMulti = /\bcompare\b|heatmap|scatter|versus/i.test(item.question);
        if (expectsMulti && chartSeriesCount < 2) chartHasData = false;
      } catch (err) {
        error = String(err?.message || err);
      }
      const elapsedMs = Date.now() - started;
      results.push({
        index: i + 1,
        label: item.label,
        question: item.question,
        range: item.range
          ? {
              start: item.range.start,
              end: item.range.end
            }
          : null,
        scope: {
          tenant: selection.tenant,
          building: selection.building,
          zones: selection.zones,
          devices: selection.devices,
          deviceZones: selection.deviceZones
        },
        elapsedMs,
        error,
        chartHasData,
        chartSeriesCount,
        response: response
          ? {
              message: response.message || null,
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
      `chat_${spec.slug}_${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    );
    await fsAsync.writeFile(
      outfile,
      JSON.stringify(
        {
          baseUrl: BASE_URL,
          tenant: spec.tenant,
          building: spec.building,
          generatedAt: new Date().toISOString(),
          results
        },
        null,
        2
      )
    );
    const failures = results.filter((r) => r.error || !r.chartHasData);
    console.log(
      `[run_building_regression] ${spec.building}: ${results.length} questions processed in ${(
        results.reduce((sum, r) => sum + r.elapsedMs, 0) / 1000
      ).toFixed(1)}s. Saved to ${outfile}.`
    );
    if (failures.length) {
      console.warn(
        `[run_building_regression] ${spec.building}: ${failures.length} potential issues detected.`
      );
    }
    summaries.push({ spec, failures });
  }

  const totalFailures = summaries.reduce((sum, s) => sum + s.failures.length, 0);
  if (totalFailures) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[run_building_regression] fatal', err);
  process.exit(1);
});
