// Lightweight Neo4j adapter with safe fallbacks.
// Reads env: NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD, NEO4J_DATABASE

import fs from 'fs';
import path from 'path';

export function createGraphClient({ uri, username, password, database }) {
  let driver = null;
  let neo4j = null;
  async function ensure() {
    if (driver) return true;
    try {
      // Lazy import to avoid requiring dependency in environments without it
      neo4j = await import('neo4j-driver').catch(() => null);
      if (!neo4j) return false;
      driver = neo4j.driver(uri, neo4j.auth.basic(username, password));
      return true;
    } catch {
      return false;
    }
  }

  async function close() { try { await driver?.close?.(); } catch {}
  }

  async function runQuery(cypher, params = {}) {
    const ok = await ensure();
    if (!ok) return { records: [], error: 'neo4j-driver not available' };
    const session = driver.session({ database: database || 'neo4j' });
    try {
      const res = await session.run(cypher, params);
      return { records: res.records };
    } catch (e) {
      return { records: [], error: String(e) };
    } finally {
      await session.close();
    }
  }

  async function ping() {
    const { records, error } = await runQuery('RETURN 1 AS ok');
    if (error) return { ok: false, error };
    return { ok: true };
  }

  async function stats() {
    const nodeRes = await runQuery('MATCH (n) RETURN count(n) AS c');
    const relRes = await runQuery('MATCH ()-[r]->() RETURN count(r) AS c');
    const tenRes = await runQuery('MATCH (t:Tenant) RETURN count(t) AS c');
    const zoneRes = await runQuery('MATCH (z:Zone) RETURN count(z) AS c');
    const deviceRes = await runQuery('MATCH (d:Device) RETURN count(d) AS c');
    const take = (r) => (r.records && r.records[0] ? (r.records[0].get('c') ?? 0) : 0);
    return {
      nodes: take(nodeRes),
      relationships: take(relRes),
      tenants: take(tenRes),
      zones: take(zoneRes),
      devices: take(deviceRes),
      error: nodeRes.error || relRes.error || tenRes.error || zoneRes.error || deviceRes.error || null
    };
  }

  async function devicesByZoneType(zoneType) {
    const cypher = `
      MATCH (z:Zone {type:$zoneType})<-[:LOCATED_IN_ZONE]-(d:Device)
      RETURN d.type AS type, count(*) AS c
    `;
    const { records, error } = await runQuery(cypher, { zoneType });
    if (error) return { counts: [], error };
    const counts = records.map(r => ({ type: r.get('type'), count: Number(r.get('c') || 0) }));
    return { counts };
  }

  async function subgraphByZoneType(zoneType, { maxZones = 12, maxDevicesPerZone = 4 } = {}) {
    // Fetch hierarchy: Tenant -> Building -> Floor -> Zone (filtered by type)
    const hRes = await runQuery(`
      MATCH (t:Tenant)<-[:BELONGS_TO_TENANT]-(b:Building)<-[:LOCATED_IN_BUILDING|PART_OF_BUILDING|BELONGS_TO_BUILDING]-(f:Floor)<-[:BELONGS_TO_FLOOR|PART_OF_FLOOR]-(z:Zone {type:$zoneType})
      RETURN DISTINCT t,b,f,z
    `, { zoneType });
    if (hRes.error) return { nodes: [], links: [], error: hRes.error };
    const nodes = new Map();
    const links = [];
    const addNode = (node, extra = {}) => {
      if (!node) return null;
      const label = (node.labels && node.labels[0]) || 'Node';
      const name = node.properties?.name || node.properties?.id || node.properties?.type || 'unknown';
      const id = `${label}:${name}`;
      if (!nodes.has(id)) nodes.set(id, { id, label, name, type: node.properties?.type || null, ...extra });
      return id;
    };
    const addLink = (a, b, rel) => { if (a && b) links.push({ source: a, target: b, rel }); };

    // Convert hierarchy rows
    const zoneIds = new Set();
    for (const r of hRes.records) {
      const t = r.get('t');
      const b = r.get('b');
      const f = r.get('f');
      const z = r.get('z');
      const tid = addNode(t);
      const bid = addNode(b);
      const fid = addNode(f);
      const zid = addNode(z, { highlight: true });
      if (zid) zoneIds.add(zid);
      addLink(bid, tid, 'BELONGS_TO_TENANT');
      addLink(fid, bid, 'LOCATED_IN_BUILDING');
      addLink(zid, fid, 'BELONGS_TO_FLOOR');
    }

    // Limit zones to maxZones
    const limitedZones = Array.from(zoneIds).slice(0, maxZones);
    const zoneNames = limitedZones.map(id => nodes.get(id)?.name).filter(Boolean);

    // Devices per filtered zones
    if (limitedZones.length) {
      const dRes = await runQuery(`
        MATCH (z:Zone {type:$zoneType})<-[:LOCATED_IN_ZONE]-(d:Device)
        WHERE z.name IN $zoneNames
        OPTIONAL MATCH (d)-[:HAS_PROFILE]->(p:DeviceProfile)
        RETURN z,d,p
      `, { zoneType, zoneNames });
      if (!dRes.error) {
        const zCounts = new Map();
        for (const r of dRes.records) {
          const z = r.get('z');
          const d = r.get('d');
          const p = r.get('p');
          const zid = addNode(z, { highlight: true });
          const did = addNode(d);
          const pid = p ? addNode(p) : null;
          const cnt = zCounts.get(zid) || 0;
          if (cnt < maxDevicesPerZone) {
            addLink(did, zid, 'LOCATED_IN_ZONE');
            if (pid) addLink(did, pid, 'HAS_PROFILE');
            zCounts.set(zid, cnt + 1);
          }
        }
      }
    }

    return { nodes: Array.from(nodes.values()), links };
  }

  // Rooms by tenant (expects nodes/labels in your graph; adapt cypher as needed)
  async function roomsByTenant(tenant) {
    const cypher = `
      MATCH (t:Tenant {name:$tenant})-[:OWNS|:LEASES|:BELONGS_TO*1..3]->(z:Zone)
      OPTIONAL MATCH (z)-[:HAS_NAME]->(n)
      RETURN DISTINCT coalesce(z.name, n.value, z.id) AS room
    `;
    const { records, error } = await runQuery(cypher, { tenant });
    if (error) return { rooms: [], error };
    const rooms = records.map(r => r.get('room')).filter(Boolean);
    return { rooms };
  }

  // Rooms by scope (building and/or floor), returns roomIds if present or zone names
  async function roomsByScope({ building = null, floor = null } = {}) {
    // Strictly resolve zones (rooms) limited by building and/or floor using names or IDs.
    if (building && floor) {
      const cy = `
        MATCH (b:Building)
        WHERE b.name=$building OR toString(b.id)=$building OR toString(b.buildingID)=$building
        MATCH (f:Floor)
        WHERE (f.name=$floor OR toString(f.id)=$floor OR toString(f.floorID)=$floor)
          AND ( (f)-[:LOCATED_IN_BUILDING|PART_OF_BUILDING]->(b)
                OR toString(f.buildingID)=toString(b.id)
                OR toString(f.buildingID)=toString(b.buildingID) )
        MATCH (z:Zone)
        WHERE ( (z)-[:LOCATED_IN_BUILDING|PART_OF_BUILDING]->(b)
                OR toString(z.buildingID)=toString(b.id)
                OR toString(z.buildingID)=toString(b.buildingID) )
          AND (
            (toString(z.floorID)=toString(f.id) OR toString(z.floorID)=toString(f.floorID))
            AND (toString(z.tenantID)=toString(f.tenantID) OR z.tenantID IS NULL OR f.tenantID IS NULL)
          )
        RETURN DISTINCT coalesce(z.roomId, toString(z.id), z.name) AS room
      `;
      const { records, error } = await runQuery(cy, { building, floor });
      if (error) return { rooms: [], error };
      const rooms = records.map(r => r.get('room')).filter(Boolean);
      return { rooms };
    }
    if (building) {
      const cy = `
        MATCH (b:Building)
        WHERE b.name=$building OR toString(b.id)=$building OR toString(b.buildingID)=$building
        MATCH (z:Zone)
        WHERE ( (z)-[:LOCATED_IN_BUILDING|PART_OF_BUILDING]->(b)
                OR toString(z.buildingID)=toString(b.id)
                OR toString(z.buildingID)=toString(b.buildingID) )
        RETURN DISTINCT coalesce(z.roomId, toString(z.id), z.name) AS room
      `;
      const { records, error } = await runQuery(cy, { building });
      if (error) return { rooms: [], error };
      const rooms = records.map(r => r.get('room')).filter(Boolean);
      return { rooms };
    }
    const { records, error } = await runQuery(`MATCH (z:Zone) RETURN DISTINCT coalesce(z.roomId, toString(z.id), z.name) AS room`);
    if (error) return { rooms: [], error };
    const rooms = records.map(r => r.get('room')).filter(Boolean);
    return { rooms };
  }

  // Devices by scope (tenant/building/floor/zone/type)
  async function devicesByScope({ tenant, building, floor, zone, type }) {
    // Build S3 device id set (cloud_id filenames without .csv)
    let s3Ids = new Set();
    try {
      const root = path.resolve('.');
      const dir = path.join(root, process.env.S3_LOCAL_DIR || 'CSVex_s3');
      if (fs.existsSync(dir)) {
        for (const f of fs.readdirSync(dir)) {
          if (f.toLowerCase().endsWith('.csv')) s3Ids.add(f.replace(/\.csv$/i, ''));
        }
      }
    } catch {}
    const cypher = `
      MATCH (d:Device)
      OPTIONAL MATCH (d)-[:LOCATED_IN_ZONE]->(z:Zone)
      OPTIONAL MATCH (d)-[:LOCATED_ON_FLOOR]->(f:Floor)
      OPTIONAL MATCH (d)-[:IN_BUILDING]->(b:Building)
      OPTIONAL MATCH (d)-[:BELONGS_TO_TENANT]->(td:Tenant)
      OPTIONAL MATCH (z)-[:BELONGS_TO_TENANT]->(tz:Tenant)
      OPTIONAL MATCH (f)-[:BELONGS_TO_TENANT]->(tf:Tenant)
      OPTIONAL MATCH (b)-[:BELONGS_TO_TENANT]->(tb:Tenant)
      // Derive building from zone/floor links
      OPTIONAL MATCH (z)-[:LOCATED_IN_BUILDING|PART_OF_BUILDING]->(bz:Building)
      OPTIONAL MATCH (f)-[:LOCATED_IN_BUILDING|PART_OF_BUILDING]->(bf:Building)
      // Derive floor from zone.floorID when device lacks LOCATED_ON_FLOOR
      OPTIONAL MATCH (zf:Floor)
      WHERE z IS NOT NULL AND (toString(z.floorID) = toString(zf.id) OR toString(z.floorID) = toString(zf.floorID))
      // Derive building via zone.buildingID or floor.buildingID
      OPTIONAL MATCH (zb:Building)
      WHERE z IS NOT NULL AND (toString(z.buildingID) = toString(zb.id) OR toString(z.buildingID) = toString(zb.buildingID))
      OPTIONAL MATCH (fb:Building)
      WHERE (f IS NOT NULL AND (toString(f.buildingID) = toString(fb.id) OR toString(f.buildingID) = toString(fb.buildingID)))
         OR (zf IS NOT NULL AND (toString(zf.buildingID) = toString(fb.id) OR toString(zf.buildingID) = toString(fb.buildingID)))
      // Derive building via device.buildingID when present
      OPTIONAL MATCH (db:Building)
      WHERE (toString(db.id) = toString(d.buildingID) OR toString(db.buildingID) = toString(d.buildingID))
      // Derive floor via device.floorID when present
      OPTIONAL MATCH (df:Floor)
      WHERE (toString(df.id) = toString(d.floorID) OR toString(df.floorID) = toString(d.floorID))
        AND (toString(df.buildingID) = toString(d.buildingID) OR df.buildingID IS NULL OR d.buildingID IS NULL)
      // Derive zone via device.zoneID when present
      OPTIONAL MATCH (dz:Zone)
      WHERE (toString(dz.id) = toString(d.zoneID) OR toString(dz.zoneID) = toString(d.zoneID))
        AND (toString(dz.buildingID) = toString(d.buildingID) OR dz.buildingID IS NULL OR d.buildingID IS NULL)
      WITH d, coalesce(dz, z) AS z, coalesce(df, f, zf) AS f, coalesce(db, b, bz, bf, zb, fb) AS b,
           coalesce(td, tz, tf, tb) AS t
      ${tenant ? 'WHERE (t.name = $tenant OR toString(t.id) = $tenant)' : ''}
      ${type ? (tenant ? 'AND d.type = $type' : 'WHERE d.type = $type') : ''}
      WITH d, z, f, b, t
      ${floor ? 'WHERE (toLower(f.name) = toLower($floor) OR toString(f.id) = $floor OR toString(f.floorID) = $floor)' : ''}
      WITH d, z, f, b, t
      ${zone ? 'WHERE (toLower(z.name) = toLower($zone) OR toString(z.id) = $zone OR toString(z.roomId) = $zone)' : ''}
      WITH d, z, f, b, t
      ${building ? 'WHERE (toLower(b.name) = toLower($building) OR toString(b.id) = $building OR toString(b.buildingID) = $building)' : ''}
      RETURN DISTINCT
             coalesce(d.cloud_id, d.cloudId, d.cloudID, d.id, d.deviceId, d.name) AS id,
             d.name AS name,
             coalesce(d.type, d.deviceType) AS type,
             coalesce(z.name, d.zone) AS zone,
             coalesce(b.name, d.building) AS building,
             f.name AS floor
    `;
    const params = { tenant, building, floor, zone, type };
    const { records, error } = await runQuery(cypher, params);
    if (error) return { devices: [], error };
    const devicesAll = records.map(r => ({
      id: r.get('id') ?? null,
      name: r.get('name') ?? null,
      type: r.get('type') ?? null,
      zone: r.get('zone') ?? null,
      building: r.get('building') ?? null,
      floor: r.get('floor') ?? null
    }));
    // Filter to devices that have matching S3 CSV (cloud_id-based name)
    const devices = devicesAll.filter(d => d.id && s3Ids.has(String(d.id)));
    try {
      for (const d of devices) {
        console.log('[s3-match][scope]', d.id, 'building=', d.building || 'n/a', 'floor=', d.floor || 'n/a', 'zone=', d.zone || 'n/a');
      }
    } catch {}
    return { devices };
  }

  return {
    roomsByTenant,
    roomsByScope,
    devicesByScope,
    devicesByZoneType,
    subgraphByZoneType,
    async fullHierarchy(tenant = null) {
      const outNodes = new Map();
      const outLinks = [];
      const addNode = (id, props) => { if (!outNodes.has(id)) outNodes.set(id, { id, ...props }); };
      const linkCache = new Set();
      const addLink = (a, b, rel) => {
        if (!a || !b || !rel) return;
        const key = `${a}::${b}::${rel}`;
        if (linkCache.has(key)) return;
        linkCache.add(key);
        outLinks.push({ source: a, target: b, rel });
      };
      const removeLink = (a, b, rel) => {
        if (!a || !b || !rel) return;
        const key = `${a}::${b}::${rel}`;
        if (!linkCache.has(key)) return;
        linkCache.delete(key);
        for (let i = outLinks.length - 1; i >= 0; i -= 1) {
          const link = outLinks[i];
          if (link && link.source === a && link.target === b && link.rel === rel) {
            outLinks.splice(i, 1);
          }
        }
      };
      const bumpBuildingCount = (bid) => {
        if (!bid) return;
        const n = outNodes.get(bid) || null;
        if (n) { n.dataDevices = (n.dataDevices || 0) + 1; n.hasData = true; outNodes.set(bid, n); }
      };
      const zoneFloorAttachment = new Map();
      const attachZoneFloor = (zid, fid, zoneName, priority = 5) => {
        if (!zid || !fid) return;
        const existing = zoneFloorAttachment.get(zid);
        if (!existing) {
          zoneFloorAttachment.set(zid, { fid, priority });
          addLink(zid, fid, 'BELONGS_TO_FLOOR');
          return;
        }
        if (existing.fid === fid) return;
        if (priority < existing.priority) {
          removeLink(zid, existing.fid, 'BELONGS_TO_FLOOR');
          zoneFloorAttachment.set(zid, { fid, priority });
          console.warn(`[graph][snapshot] Zone ${zoneName || zid} floor reassigned to ${fid} (higher-confidence source).`);
          addLink(zid, fid, 'BELONGS_TO_FLOOR');
          return;
        }
        console.warn(`[graph][snapshot] Zone ${zoneName || zid} floor candidate ${fid} ignored; keeping ${existing.fid}.`);
      };
      const normalizeToken = (val) => {
        if (val === null || val === undefined) return null;
        const str = String(val).trim().toLowerCase();
        return str || null;
      };
      const zoneMatchesFloorNode = (zoneNode, floorNode) => {
        if (!zoneNode || !floorNode) return false;
        const zProps = zoneNode.properties || {};
        const fProps = floorNode.properties || {};
        const zoneTokens = [
          zProps.floorID,
          zProps.floorId,
          zProps.floor,
          zProps.floor_name,
          zProps.level
        ].map(normalizeToken).filter(Boolean);
        if (!zoneTokens.length) return false;
        const floorTokens = [
          fProps.id,
          fProps.floorID,
          fProps.name
        ].map(normalizeToken).filter(Boolean);
        if (!floorTokens.length) return false;
        return zoneTokens.some((token) => floorTokens.includes(token));
      };
      const buildingFloorsCache = new Map();
      const ensureFloorNode = (floorNode, buildingNode, buildingKey, bid, floorMap) => {
        if (!floorNode) return null;
        const fKeyRaw = floorNode.properties?.id ?? floorNode.properties?.floorID ?? floorNode.properties?.name ?? '';
        if (!fKeyRaw) return null;
        const fid = `Floor:${String(fKeyRaw)}:${String(buildingKey)}`;
        addNode(fid, { label: 'Floor', name: floorNode.properties?.name, nodeType: 'Floor', node: floorNode });
        if (buildingNode) addLink(fid, bid, 'LOCATED_IN_BUILDING');
        if (floorMap && !floorMap.has(fid)) floorMap.set(fid, floorNode);
        return fid;
      };
      // Build S3 device id set to include only matched devices
      let s3Ids = new Set();
      try {
        const root = path.resolve('.');
        const dir = path.join(root, process.env.S3_LOCAL_DIR || 'CSVex_s3');
        if (fs.existsSync(dir)) {
          for (const f of fs.readdirSync(dir)) {
            if (f.toLowerCase().endsWith('.csv')) s3Ids.add(f.replace(/\.csv$/i, ''));
          }
        }
      } catch {}
      // Canonical relationships per model with property-based fallbacks:
      // floors/zones located in building (via rel or buildingID), devices in building, on floor, or in zone
      const q = `
        ${tenant ? 'MATCH (t:Tenant {name:$tenant})' : ''}
        MATCH (b:Building)
        ${tenant ? 'WHERE (b)-[:BELONGS_TO_TENANT]->(t)' : ''}
        WITH DISTINCT b
        OPTIONAL MATCH (b)<-[:LOCATED_IN_BUILDING|PART_OF_BUILDING]-(fr:Floor)
        WITH b, collect(DISTINCT fr) AS floorsRel
        OPTIONAL MATCH (fp:Floor)
        WHERE toString(fp.buildingID)=toString(b.id) OR toString(fp.buildingID)=toString(b.buildingID)
        WITH b, floorsRel, collect(DISTINCT fp) AS floorsProp
        WITH b, [f IN (coalesce(floorsRel, []) + coalesce(floorsProp, [])) WHERE f IS NOT NULL] AS floors
        OPTIONAL MATCH (b)<-[:LOCATED_IN_BUILDING|PART_OF_BUILDING]-(z:Zone)
        OPTIONAL MATCH (z)-[:BELONGS_TO_FLOOR|PART_OF_FLOOR]->(zf:Floor)
        RETURN b, floors, z, zf
      `;
      const { records, error } = await runQuery(q, tenant ? { tenant } : {});
      if (error) return { nodes: [], links: [], error };
      const logged = new Set();
      const includedDevices = new Set();
      for (const r of records) {
        const b = r.get('b');
        if (!b) continue;
        const z = r.get('z');
        const zf = r.get('zf');
        const floorsRaw = (r.get('floors') || []).filter(Boolean);
        const bName = b.properties?.name || String(b.properties?.buildingID || b.properties?.id || 'Building');
        const bid = `Building:${bName}`;
        const bKeyId = b.properties?.id ?? b.properties?.buildingID ?? b.properties?.name ?? '';
        addNode(bid, { label: 'Building', name: bName, nodeType: 'Building', hasData: false, dataDevices: 0 });
        if (!buildingFloorsCache.has(bid) || (floorsRaw.length && (buildingFloorsCache.get(bid)?.size || 0) === 0)) {
          const floorMap = buildingFloorsCache.get(bid) || new Map();
          for (const floorNode of floorsRaw) {
            ensureFloorNode(floorNode, b, bKeyId, bid, floorMap);
          }
          buildingFloorsCache.set(bid, floorMap);
        }
        const floorMap = buildingFloorsCache.get(bid) || new Map();
        let zoneFloorFromRel = null;
        if (zf) {
          zoneFloorFromRel = ensureFloorNode(zf, b, bKeyId, bid, floorMap);
        }
        if (z) {
          const rawRid = (z.properties?.roomId != null ? z.properties.roomId : (z.properties?.id != null ? z.properties.id : null));
          const roomId = rawRid != null ? String(rawRid) : null;
          const zid = `Zone:${z.properties?.name || roomId}:${bName}`;
          addNode(zid, { label: 'Zone', name: z.properties?.name || roomId, nodeType: 'Zone', roomId, zoneType: z.properties?.type || null });
          addLink(zid, bid, 'LOCATED_IN_BUILDING');
          let floorIdForZone = zoneFloorFromRel;
          if (!floorIdForZone && !zoneFloorFromRel && floorMap && floorMap.size) {
            for (const [fidCandidate, floorNode] of floorMap.entries()) {
              if (zoneMatchesFloorNode(z, floorNode)) {
                floorIdForZone = fidCandidate;
                break;
              }
            }
          }
          if (floorIdForZone) {
            const attachPriority = zoneFloorFromRel ? 0 : 1;
            attachZoneFloor(zid, floorIdForZone, z.properties?.name || roomId, attachPriority);
          }
        }
      }

      // Second pass: include all devices present in S3, deriving building/floor/zone via rels OR properties
      const qDevices = `
        MATCH (d:Device)
        OPTIONAL MATCH (d)-[:LOCATED_IN_ZONE]->(z1:Zone)
        OPTIONAL MATCH (z1)-[:BELONGS_TO_FLOOR|PART_OF_FLOOR]->(zf:Floor)
        OPTIONAL MATCH (d)-[:LOCATED_ON_FLOOR]->(f1:Floor)
        OPTIONAL MATCH (d)-[:IN_BUILDING]->(b1:Building)
        WITH d, z1, coalesce(f1, zf) AS fRel, b1
        OPTIONAL MATCH (dz:Zone)
        WHERE z1 IS NULL AND (toString(dz.id) = toString(d.zoneID) OR toString(dz.zoneID) = toString(d.zoneID))
        OPTIONAL MATCH (dz)-[:BELONGS_TO_FLOOR|PART_OF_FLOOR]->(dfz:Floor)
        OPTIONAL MATCH (df:Floor)
        WHERE fRel IS NULL AND (toString(df.id) = toString(d.floorID) OR toString(df.floorID) = toString(d.floorID))
        OPTIONAL MATCH (db:Building)
        WHERE b1 IS NULL AND (toString(db.id) = toString(d.buildingID) OR toString(db.buildingID) = toString(d.buildingID))
        WITH d,
             coalesce(z1, dz) AS z,
             coalesce(fRel, dfz, df) AS f,
             coalesce(b1, db) AS b
        OPTIONAL MATCH (z)-[:LOCATED_IN_BUILDING|PART_OF_BUILDING]->(bz2:Building)
        OPTIONAL MATCH (f)-[:LOCATED_IN_BUILDING|PART_OF_BUILDING]->(bf2:Building)
        WITH d, z, f, coalesce(b, bz2, bf2) AS b
        ${tenant ? 'WITH d, z, f, b OPTIONAL MATCH (bt:Tenant)<-[:BELONGS_TO_TENANT]-(b) WITH d, z, f, b, bt WHERE bt.name=$tenant OR $tenant IS NULL' : ''}
        RETURN d, z, f, b
      `;
      const { records: devRows, error: devErr } = await runQuery(qDevices, tenant ? { tenant } : {});
      if (devErr) return { nodes: Array.from(outNodes.values()), links: outLinks, error: devErr };
      for (const r of devRows) {
        const d = r.get('d'); const z = r.get('z'); const f = r.get('f'); const b = r.get('b');
        const cloudId = d?.properties?.cloud_id || d?.properties?.cloudId || d?.properties?.cloudID || null;
        const includeDevice = d ? (cloudId ? s3Ids.has(String(cloudId)) : false) : false;
        if (!includeDevice) continue;
        const did = `Device:${d.properties?.id || d.properties?.name}`;
        const bid = b ? `Building:${b.properties?.name}` : null;
        const bKeyId = b ? (b.properties?.id ?? b.properties?.buildingID ?? b.properties?.name ?? '') : '';
        const fKeyRaw = f ? (f.properties?.id ?? f.properties?.floorID ?? f.properties?.name ?? '') : '';
        const fid = f ? `Floor:${String(fKeyRaw)}:${String(bKeyId)}` : null;
        const zid = z ? `Zone:${z.properties?.name}:${b?.properties?.name || ''}` : null;
        if (b) {
          const bName = b.properties?.name || String(b.properties?.buildingID || b.properties?.id || 'Building');
          addNode(bid, { label: 'Building', name: bName, nodeType: 'Building', hasData: false, dataDevices: 0 });
        }
        if (f) addNode(fid, { label: 'Floor', name: f.properties?.name, nodeType: 'Floor' });
        if (z) {
          const rawRid = (z.properties?.roomId != null ? z.properties.roomId : (z.properties?.id != null ? z.properties.id : null));
          const roomId = rawRid != null ? String(rawRid) : null;
          addNode(zid, { label: 'Zone', name: z.properties?.name, nodeType: 'Zone', roomId, zoneType: z.properties?.type || null });
        }
        addNode(did, { label: 'Device', name: d.properties?.name, nodeType: 'Device', deviceType: d.properties?.type || null, cloudId });
        includedDevices.add(did);
        if (f && b) addLink(fid, bid, 'LOCATED_IN_BUILDING');
        if (z && fid) attachZoneFloor(zid, fid, z.properties?.name);
        if (z && bid) addLink(zid, bid, 'LOCATED_IN_BUILDING');
        if (z) addLink(did, zid, 'LOCATED_IN_ZONE');
        if (f) addLink(did, fid, 'LOCATED_ON_FLOOR');
        if (b) { addLink(did, bid, 'IN_BUILDING'); bumpBuildingCount(bid); }
        const bName = (b?.properties?.name) || String(b?.properties?.buildingID || b?.properties?.id || '') || null;
        const fName = f?.properties?.name || null;
        const zName = z?.properties?.name || null;
        const key = `${cloudId}|${bName}|${fName}|${zName}`;
        if (cloudId && !logged.has(key)) { console.log('[s3-match][snapshot]', cloudId, 'building=', bName||'n/a', 'floor=', fName||'n/a', 'zone=', zName||'n/a'); logged.add(key); }
      }

      // Attach TelemetryKey nodes for included devices; add both HAS_TELEMETRY_KEY and MEASURES links
      try {
        if (includedDevices.size) {
          const { records: keyRows } = await runQuery(`
            MATCH (d:Device)-[:HAS_TELEMETRY_KEY]->(k:TelemetryKey)
            RETURN d, collect(DISTINCT k) AS ks
          `);
          for (const rec of (keyRows || [])) {
            const d = rec.get('d');
            const ks = rec.get('ks') || [];
            const did = `Device:${d.properties?.id || d.properties?.name}`;
            if (!includedDevices.has(did)) continue;
            for (const k of ks) {
              if (!k) continue;
              const kname = k.properties?.name || k.properties?.key || k.properties?.id || null;
              if (!kname) continue;
              const kid = `TelemetryKey:${kname}`;
              addNode(kid, { label: 'TelemetryKey', name: kname, nodeType: 'TelemetryKey' });
              addLink(did, kid, 'HAS_TELEMETRY_KEY');
              addLink(kid, did, 'MEASURES');
            }
          }
        }
      } catch {}
      // Position nodes: buildings in rows, floors below buildings, zones below floors, devices below zones
      try {
        const nodes = Array.from(outNodes.values());
        const links = outLinks;
        const byId = new Map(nodes.map(n => [n.id, n]));
        const children = new Map();
        const addChild = (p, c) => { if (!p || !c) return; if (!children.has(p)) children.set(p, []); children.get(p).push(c); };
        for (const l of links) addChild(l.target, l.source);
        const buildings = nodes.filter(n => n.nodeType === 'Building');
        // layout params
        const B_COLS = 4, X_B = 360, Y_STEP = 220, X_F = 180, X_Z = 140, X_D = 100;
        buildings.forEach((b, i) => {
          const row = Math.floor(i / B_COLS), col = i % B_COLS;
          b.x = col * X_B; b.y = row * (Y_STEP * 3);
          const floors = (children.get(b.id) || []).map(cid => byId.get(cid)).filter(n => n && n.nodeType === 'Floor');
          floors.forEach((f, j) => {
            f.x = b.x + (j - (floors.length - 1) / 2) * X_F; f.y = b.y + Y_STEP;
            const zones = (children.get(f.id) || []).map(cid => byId.get(cid)).filter(n => n && n.nodeType === 'Zone');
            zones.forEach((z, k) => {
              z.x = f.x + (k - (zones.length - 1) / 2) * X_Z; z.y = f.y + Y_STEP;
              const devs = (children.get(z.id) || []).map(cid => byId.get(cid)).filter(n => n && n.nodeType === 'Device');
              devs.forEach((d, m) => { d.x = z.x + (m - (devs.length - 1) / 2) * X_D; d.y = z.y + Y_STEP; });
            });
          });
        });
        // Fallback: any nodes without position
        let rr = 0; for (const n of nodes) if (typeof n.x !== 'number') { n.x = rr * 50; n.y = 0; rr++; }
        return { nodes, links };
      } catch {
        return { nodes: Array.from(outNodes.values()), links: outLinks };
      }
    },
    runQuery,
    stats,
    ping,
    close
  };
}

export function createGraphFromEnv(env = process.env) {
  const uri = env.NEO4J_URI;
  const username = env.NEO4J_USERNAME;
  const password = env.NEO4J_PASSWORD;
  const database = env.NEO4J_DATABASE || 'neo4j';
  if (!uri || !username || !password) return null;
  return createGraphClient({ uri, username, password, database });
}
