#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

const SNAPSHOT_PATH = process.argv[2] || path.join(process.cwd(), 'data', 'graph_snapshot.json');
const S3_DIR = process.env.S3_LOCAL_DIR
  ? path.resolve(process.cwd(), process.env.S3_LOCAL_DIR)
  : path.join(process.cwd(), 'CSVex_s3');

if (!fs.existsSync(SNAPSHOT_PATH)) {
  console.error(`[graph-check] Snapshot not found: ${SNAPSHOT_PATH}`);
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
const nodes = Array.isArray(raw.nodes) ? raw.nodes : [];
const links = Array.isArray(raw.links) ? raw.links : [];
const nodesById = new Map(nodes.map((n) => [n.id, n]));
const adjacency = new Map();

for (const link of links) {
  if (!link || !link.source) continue;
  if (!adjacency.has(link.source)) adjacency.set(link.source, []);
  adjacency.get(link.source).push(link);
}

const floorToBuildingRels = ['LOCATED_IN_BUILDING', 'PART_OF_BUILDING', 'IN_BUILDING'];
const zoneToFloorRels = ['BELONGS_TO_FLOOR', 'PART_OF_FLOOR'];
const deviceToZoneRels = ['LOCATED_IN_ZONE', 'IN_ZONE'];
const deviceToFloorRels = ['LOCATED_ON_FLOOR', 'ON_FLOOR'];
const deviceToBuildingRels = ['LOCATED_IN_BUILDING', 'IN_BUILDING'];

const stats = {
  missingFloorParent: [],
  missingZoneParent: [],
  missingDeviceZone: [],
  missingDeviceFloor: [],
  missingDeviceBuilding: [],
  devicesWithoutCsv: [],
  devicesWithoutCloudId: []
};

const hasLink = (sourceId, allowedRels, expectedLabel) => {
  const edges = adjacency.get(sourceId) || [];
  return edges.some((edge) => {
    if (!allowedRels.includes(edge.rel)) return false;
    const target = nodesById.get(edge.target);
    if (!target) return false;
    if (!expectedLabel) return true;
    return target.label === expectedLabel;
  });
};

for (const node of nodes) {
  if (node.label === 'Floor') {
    if (!hasLink(node.id, floorToBuildingRels, 'Building')) {
      stats.missingFloorParent.push(node.id);
    }
  } else if (node.label === 'Zone') {
    if (!hasLink(node.id, zoneToFloorRels, 'Floor')) {
      stats.missingZoneParent.push(node.id);
    }
  } else if (node.label === 'Device') {
    if (!hasLink(node.id, deviceToZoneRels, 'Zone')) {
      stats.missingDeviceZone.push(node.id);
    }
    if (!hasLink(node.id, deviceToFloorRels, 'Floor')) {
      stats.missingDeviceFloor.push(node.id);
    }
    if (!hasLink(node.id, deviceToBuildingRels, 'Building')) {
      stats.missingDeviceBuilding.push(node.id);
    }
    const cloudId = node.cloudId || node.deviceId || null;
    if (!cloudId) {
      stats.devicesWithoutCloudId.push(node.id);
    } else {
      const csvPath = path.join(S3_DIR, `${cloudId}.csv`);
      if (!fs.existsSync(csvPath)) {
        stats.devicesWithoutCsv.push(cloudId);
      }
    }
  }
}

const summary = [
  `Graph consistency report (${SNAPSHOT_PATH}):`,
  `  Nodes: ${nodes.length}`,
  `    Buildings: ${nodes.filter((n) => n.label === 'Building').length}`,
  `    Floors: ${nodes.filter((n) => n.label === 'Floor').length}`,
  `    Zones: ${nodes.filter((n) => n.label === 'Zone').length}`,
  `    Devices: ${nodes.filter((n) => n.label === 'Device').length}`,
  `  Links: ${links.length}`
];

const issues = [];
const pushIssue = (label, arr) => {
  if (arr.length) {
    const sample = arr.slice(0, 10).join(', ');
    issues.push(`- ${label}: ${arr.length} (examples: ${sample}${arr.length > 10 ? '…' : ''})`);
  }
};

pushIssue('Floors missing building relationship', stats.missingFloorParent);
pushIssue('Zones missing floor relationship', stats.missingZoneParent);
pushIssue('Devices missing zone link', stats.missingDeviceZone);
pushIssue('Devices missing floor link', stats.missingDeviceFloor);
pushIssue('Devices missing building link', stats.missingDeviceBuilding);
pushIssue('Devices without cloudId/deviceId', stats.devicesWithoutCloudId);
pushIssue('Devices without local CSV data (CSVex_s3)', stats.devicesWithoutCsv);

console.log(summary.join('\n'));

if (issues.length) {
  console.warn('\nIssues detected:');
  issues.forEach((line) => console.warn(line));
  process.exitCode = 1;
} else {
  console.log('\nNo structural issues detected.');
}
