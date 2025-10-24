// Lightweight Neo4j adapter with safe fallbacks.
// Reads env: NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD, NEO4J_DATABASE

import fs from 'fs';

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
      MATCH (z:Zone {type:$zoneType})
      OPTIONAL MATCH (d:Device)-[:LOCATED_IN_ZONE]->(z)
      RETURN d.type AS type, count(d) AS c
    `;
    const { records, error } = await runQuery(cypher, { zoneType });
    if (error) return { counts: [], error };
    const counts = records.map(r => ({ type: r.get('type'), count: Number(r.get('c') || 0) }));
    return { counts };
  }

  async function subgraphByZoneType(zoneType, { maxZones = 12, maxDevicesPerZone = 4 } = {}) {
    // Fetch hierarchy using the canonical relationships from the model
    const hRes = await runQuery(`
      MATCH (t:Tenant)
      OPTIONAL MATCH (b:Building)-[:BELONGS_TO_TENANT]->(t)
      OPTIONAL MATCH (f:Floor)-[:LOCATED_IN_BUILDING]->(b)
      OPTIONAL MATCH (z:Zone {type:$zoneType})-[:LOCATED_ON_FLOOR]->(f)
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
      addLink(fid, bid, 'BELONGS_TO_BUILDING');
      addLink(zid, fid, 'BELONGS_TO_FLOOR');
    }

    // Limit zones to maxZones
    const limitedZones = Array.from(zoneIds).slice(0, maxZones);
    const zoneNames = limitedZones.map(id => nodes.get(id)?.name).filter(Boolean);

    // Devices per filtered zones
    if (limitedZones.length) {
      const dRes = await runQuery(`
        MATCH (z:Zone {type:$zoneType})
        WHERE z.name IN $zoneNames
        OPTIONAL MATCH (d:Device)-[:LOCATED_IN_ZONE]->(z)
        OPTIONAL MATCH (d)-[:HAS_DEVICE_PROFILE]->(p:DeviceProfile)
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
      MATCH (t:Tenant {name:$tenant})
      OPTIONAL MATCH (z:Zone)-[:BELONGS_TO_TENANT]->(t)
      RETURN DISTINCT coalesce(z.roomId, z.name) AS room
    `;
    const { records, error } = await runQuery(cypher, { tenant });
    if (error) return { rooms: [], error };
    const rooms = records.map(r => r.get('room')).filter(Boolean);
    return { rooms };
  }

  // Rooms by scope (building and/or floor), returns roomIds if present or zone names
  async function roomsByScope({ building = null, floor = null, tenant = null } = {}) {
    let cypher = '';
    const params = {};
    if (building && floor) {
      cypher = `
        MATCH (b:Building {name:$building})
        MATCH (f:Floor {name:$floor})-[:LOCATED_IN_BUILDING]->(b)
        OPTIONAL MATCH (z:Zone)-[:LOCATED_ON_FLOOR]->(f)
        RETURN coalesce(z.roomId, z.name) AS room
      `;
      params.building = building; params.floor = floor;
    } else if (building) {
      cypher = `
        MATCH (b:Building {name:$building})
        MATCH (f:Floor)-[:LOCATED_IN_BUILDING]->(b)
        OPTIONAL MATCH (z:Zone)-[:LOCATED_ON_FLOOR]->(f)
        RETURN coalesce(z.roomId, z.name) AS room
      `;
      params.building = building;
    } else if (tenant) {
      cypher = `
        MATCH (t:Tenant)
        WHERE t.name=$tenant OR toString(t.id)=$tenant
        OPTIONAL MATCH (b:Building)-[:BELONGS_TO_TENANT]->(t)
        WITH collect(DISTINCT b) AS bs
        UNWIND bs AS b
        WITH DISTINCT b
        OPTIONAL MATCH (f:Floor)-[:LOCATED_IN_BUILDING]->(b)
        OPTIONAL MATCH (z:Zone)-[:LOCATED_ON_FLOOR]->(f)
        RETURN coalesce(z.roomId, z.name) AS room
      `;
      params.tenant = tenant;
    } else {
      cypher = `MATCH (z:Zone) RETURN coalesce(z.roomId, z.name) AS room`;
    }
    const { records, error } = await runQuery(cypher, params);
    if (error) return { rooms: [], error };
    const rooms = records.map(r => r.get('room')).filter(Boolean);
    return { rooms };
  }

  // Devices by scope (tenant/building/floor/zone/type)
  async function devicesByScope({ tenant, building, floor, zone, type }) {
    const cypher = `
      MATCH (d:Device)
      OPTIONAL MATCH (d)-[:BELONGS_TO_TENANT]->(t:Tenant)
      OPTIONAL MATCH (d)-[:IN_BUILDING]->(b:Building)
      OPTIONAL MATCH (d)-[:LOCATED_ON_FLOOR]->(f:Floor)
      OPTIONAL MATCH (d)-[:LOCATED_IN_ZONE]->(z:Zone)
      WHERE ($tenant IS NULL OR (t.name = $tenant OR toString(t.id) = $tenant))
        AND ($building IS NULL OR b.name = $building)
        AND ($floor IS NULL OR f.name = $floor)
        AND ($zone IS NULL OR z.name = $zone)
        AND ($type IS NULL OR d.type = $type)
      WITH DISTINCT d, z, b
      RETURN d.id AS id, d.name AS name, d.type AS type, coalesce(z.name, d.zone) AS zone, coalesce(b.name, d.building) AS building
    `;
    const params = { tenant: tenant || null, building: building || null, floor: floor || null, zone: zone || null, type: type || null };
    const { records, error } = await runQuery(cypher, params);
    if (error) return { devices: [], error };
    const devices = records.map(r => ({
      id: r.get('id') ?? null,
      name: r.get('name') ?? null,
      type: r.get('type') ?? null,
      zone: r.get('zone') ?? null,
      building: r.get('building') ?? null
    }));
    return { devices };
  }

  return {
    roomsByTenant,
    roomsByScope,
    devicesByScope,
    devicesByZoneType,
    subgraphByZoneType,
    async fullHierarchy() {
      const outNodes = new Map();
      const outLinks = [];
      const addNode = (id, props) => { if (!outNodes.has(id)) outNodes.set(id, { id, ...props }); };
      const addLink = (a, b, rel) => { outLinks.push({ source: a, target: b, rel }); };
      // Fetch buildings, floors, zones, devices, metric types
      const q = `
        MATCH (b:Building)
        OPTIONAL MATCH (f:Floor)-[:LOCATED_IN_BUILDING]->(b)
        OPTIONAL MATCH (z:Zone)-[:LOCATED_ON_FLOOR]->(f)
        OPTIONAL MATCH (d:Device)-[:LOCATED_IN_ZONE]->(z)
        OPTIONAL MATCH (d)-[:IN_BUILDING]->(b)
        OPTIONAL MATCH (d)-[:HAS_DEVICE_PROFILE]->(:DeviceProfile)
        OPTIONAL MATCH (d)-[:HAS_TELEMETRY_KEY]->(:TelemetryKey)
        RETURN b,f,z,d
      `;
      const { records, error } = await runQuery(q, {});
      if (error) return { nodes: [], links: [], error };
      for (const r of records) {
        const b = r.get('b'); const f = r.get('f'); const z = r.get('z'); const d = r.get('d');
        const bid = b ? `Building:${b.properties?.name}` : null;
        const fid = f ? `Floor:${f.properties?.name}:${b?.properties?.name || ''}` : null;
        const zid = z ? `Zone:${z.properties?.name}:${f?.properties?.name || ''}:${b?.properties?.name || ''}` : null;
        const did = d ? `Device:${d.properties?.id || d.properties?.name}` : null;
        if (b) addNode(bid, { label: 'Building', name: b.properties?.name, nodeType: 'Building', tenantID: b.properties?.tenantID ?? null });
        if (f) addNode(fid, { label: 'Floor', name: f.properties?.name, nodeType: 'Floor' });
        if (z) addNode(zid, { label: 'Zone', name: z.properties?.name, nodeType: 'Zone', roomId: z.properties?.roomId || null, zoneType: z.properties?.type || null });
        if (d) addNode(did, { label: 'Device', name: d.properties?.name, nodeType: 'Device', deviceType: d.properties?.type || null, idProp: d.properties?.id || null });
        if (f && b) addLink(fid, bid, 'LOCATED_IN_BUILDING');
        if (z && f) addLink(zid, fid, 'LOCATED_ON_FLOOR');
        if (d && z) addLink(did, zid, 'LOCATED_IN_ZONE');
        if (d && b) addLink(did, bid, 'IN_BUILDING');
      }
      return { nodes: Array.from(outNodes.values()), links: outLinks };
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
