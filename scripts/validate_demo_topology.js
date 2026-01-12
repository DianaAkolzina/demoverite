#!/usr/bin/env node
// Quick sanity checker for demo topology/telemetry mapping.
// Validates that devices are linked to zones/floors/buildings and reports any gaps.

import fs from 'fs';
import path from 'path';
import url from 'url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, 'data');
const snapFile = path.join(dataDir, 'graph_snapshot.json');

function loadSnap(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const j = JSON.parse(raw);
  if (!Array.isArray(j.nodes) || !Array.isArray(j.links)) throw new Error('Bad snapshot');
  return j;
}

function typeOf(n) { return n?.nodeType || n?.label; }

function summarize() {
  const snap = loadSnap(snapFile);
  const nodes = snap.nodes;
  const links = snap.links;
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const rels = (id, rel) => links.filter((l) => l.source === id && l.rel === rel).map((l) => byId.get(l.target)).filter(Boolean);
  const counts = { buildings: 0, floors: 0, zones: 0, devices: 0 };
  const missing = { building: [], floor: [], zone: [] };

  for (const n of nodes) {
    const t = typeOf(n);
    if (t === 'Building') counts.buildings++;
    if (t === 'Floor') counts.floors++;
    if (t === 'Zone') counts.zones++;
    if (t === 'Device') {
      counts.devices++;
      let building = null, floor = null, zone = null;
      rels(n.id, 'IN_BUILDING').some((b) => { building = b?.name || b?.id; return !!building; });
      rels(n.id, 'LOCATED_ON_FLOOR').some((f) => { floor = f?.name || f?.id; return !!floor; });
      rels(n.id, 'LOCATED_IN_ZONE').some((z) => { zone = z?.name || z?.id; return !!zone; });
      if (!building) missing.building.push(n.name || n.id);
      if (!floor && zone) {
        // infer floor via zone
        const zoneNode = rels(n.id, 'LOCATED_IN_ZONE')[0];
        if (zoneNode) {
          const zFloor = rels(zoneNode.id, 'BELONGS_TO_FLOOR')[0];
          if (zFloor) floor = zFloor.name || zFloor.id;
        }
      }
      if (!floor && !zone) missing.floor.push(n.name || n.id);
      if (!zone) missing.zone.push(n.name || n.id);
    }
  }

  console.log('Snapshot:', path.basename(snapFile));
  console.log('Counts:', counts);
  const show = (label, arr) => {
    const uniq = Array.from(new Set(arr));
    console.log(`${label} missing: ${uniq.length}${uniq.length ? ' e.g. ' + uniq.slice(0, 5).join(', ') : ''}`);
  };
  show('Devices missing building', missing.building);
  show('Devices missing zone', missing.zone);
  show('Devices missing floor', missing.floor);
}

summarize();
