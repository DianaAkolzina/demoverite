#!/usr/bin/env node
// Rewrites building names in all graph snapshots to unique, fictional demo names.
// Uses per-building identifiers (originalId/id) to keep names stable across runs.

import fs from 'fs';
import path from 'path';
import url from 'url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, 'data');

const slug = (s) => String(s || '')
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '');

function listSnapshots() {
  if (!fs.existsSync(dataDir)) return [];
  return fs.readdirSync(dataDir)
    .filter((f) => /^graph_snapshot(\.|$)/.test(f) && f.endsWith('.json'))
    .map((f) => path.join(dataDir, f));
}

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

const adjectives = ['Alumni', 'Harbor', 'Summit', 'Cedar', 'Orchid', 'Atlas', 'Nimbus', 'Quartz', 'Juniper', 'Aspen', 'Horizon', 'Vertex', 'Aurora', 'Cobalt', 'Driftwood', 'Ember', 'Foxglove', 'Glacier', 'Harborview', 'Ironwood', 'Lumen', 'Mariner', 'Northwind', 'Oakridge', 'Prairie', 'Quarry', 'Redwood', 'Stonehaven', 'Timberline', 'Umber', 'Vale', 'Willow', 'Xenon', 'Yonder', 'Zephyr'];
const nouns = ['Campus', 'Works', 'Yard', 'House', 'Hub', 'Point', 'Harbor', 'Heights', 'Lofts', 'Commons', 'Studios', 'Exchange', 'Foundry', 'Quarter', 'Landing', 'Arcade', 'Harbour', 'Plaza', 'Grove', 'Bay'];

function makeName(idx) {
  const a = adjectives[idx % adjectives.length];
  const b = nouns[Math.floor(idx / adjectives.length) % nouns.length];
  const suffix = Math.floor(idx / (adjectives.length * nouns.length)) + 1;
  return suffix > 1 ? `${a} ${b} ${suffix}` : `${a} ${b}`;
}

function buildingKey(node) {
  return [
    node?.properties?.id,
    node?.properties?.originalId,
    node?.id,
    node?.name
  ].filter(Boolean)[0];
}

function buildMapping(buildingNodes) {
  const mapping = new Map();
  buildingNodes.forEach((n) => {
    const key = buildingKey(n);
    if (!key || mapping.has(key)) return;
    mapping.set(key, makeName(mapping.size));
  });
  return mapping;
}

function updateSnapshot(file, mapping) {
  const snap = loadJson(file, null);
  if (!snap || !Array.isArray(snap.nodes) || !Array.isArray(snap.links)) return;
  const nodes = snap.nodes;
  const links = snap.links;
  const typeOf = (n) => (n?.nodeType || n?.label);

  // Build ID mapping for building nodes
  const idMap = new Map();
  for (const n of nodes) {
    if (typeOf(n) !== 'Building') continue;
    const key = buildingKey(n);
    const newName = mapping.get(key);
    if (!newName) continue;
    const oldId = n.id;
    const newId = `Building:${slug(newName)}`;
    idMap.set(oldId, newId);
    n.id = newId;
    n.name = newName;
    if (n.properties) n.properties.name = newName;
  }

  // Update links to new building IDs
  for (const l of links) {
    if (idMap.has(l.source)) l.source = idMap.get(l.source);
    if (idMap.has(l.target)) l.target = idMap.get(l.target);
  }

  // Update hierarchical convenience structure
  if (Array.isArray(snap.buildings)) {
    for (const b of snap.buildings) {
      const key = buildingKey(b);
      const newName = mapping.get(key);
      if (!newName) continue;
      const newId = `Building:${slug(newName)}`;
      b.name = newName;
      b.id = newId;
      if (b.properties) b.properties.name = newName;
    }
  }

  writeJson(file, snap);
  console.log(`[anonymize] Updated ${path.basename(file)}`);
}

function main() {
  const snaps = listSnapshots();
  if (!snaps.length) {
    console.error('No graph_snapshot*.json files found in data/.');
    process.exit(1);
  }
  // Collect building nodes
  const buildings = [];
  for (const f of snaps) {
    const snap = loadJson(f, null);
    if (!snap || !Array.isArray(snap.nodes)) continue;
    for (const n of snap.nodes) {
      const type = n?.nodeType || n?.label;
      if (type === 'Building') buildings.push(n);
    }
  }
  const mapping = buildMapping(buildings);
  snaps.forEach((f) => updateSnapshot(f, mapping));
}

main();
