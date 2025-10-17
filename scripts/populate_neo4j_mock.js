#!/usr/bin/env node
// Populate Neo4j with a 2x3x2 Building/Floor/Room mock graph and random detectors per room.

import neo4j from 'neo4j-driver';

function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

async function run() {
  const uri = process.env.NEO4J_URI;
  const user = process.env.NEO4J_USERNAME;
  const pass = process.env.NEO4J_PASSWORD;
  const database = process.env.NEO4J_DATABASE || 'neo4j';
  const driver = neo4j.driver(uri, neo4j.auth.basic(user, pass));
  const session = driver.session({ database });
  try {
    // Clear existing
    await session.run('MATCH (n) DETACH DELETE n');

    // Buildings
    await session.run(`UNWIND ['Building A','Building B'] AS name MERGE (:Building {name:name})`);
    // Floors
    await session.run(`MATCH (b:Building) UNWIND [1,2,3] AS fnum MERGE (f:Floor {name:'Floor '+fnum, floorNumber:fnum})-[:BELONGS_TO_BUILDING]->(b)`);
    // MetricTypes
    const metricTypes = ['temperature','humidity','co2','pm25','pm10','lux','people_count','value','total_kwh','water_value','odor_level','nh3','h2s'];
    await session.run('UNWIND $mts AS m MERGE (:MetricType {name:m})', { mts: metricTypes });
    // DeviceProfiles
    const profiles = [
      {name:'IAQ_Sensor_v1', model:'IAQ-100', caps:['temperature','humidity','co2','pm25','pm10','lux']},
      {name:'Energy_Meter_v1', model:'EM-200', caps:['value','total_kwh']},
      {name:'People_Counter_v1', model:'PC-50', caps:['people_count']},
      {name:'Water_Meter_v1', model:'WM-10', caps:['water_value']},
      {name:'Odor_Sensor_v1', model:'OS-5', caps:['odor_level','nh3','h2s']}
    ];
    await session.run('UNWIND $ps AS p MERGE (dp:DeviceProfile {name:p.name}) SET dp.model=p.model, dp.caps=p.caps', { ps: profiles });

    // Rooms: 2 per floor, with deterministic types to match CSV folder names
    const roomTypes = ['cafe','boardroom','lab','toilet'];
    const rooms = [];
    const res = await session.run('MATCH (b:Building)<-[:BELONGS_TO_BUILDING]-(f:Floor) RETURN b.name AS b, f.name AS f, f.floorNumber AS n');
    for (const r of res.records) {
      const bname = r.get('b');
      const floorName = r.get('f');
      const fnum = r.get('n').toNumber ? r.get('n').toNumber() : r.get('n');
      for (let i = 0; i < 2; i++) {
        const t = roomTypes[(i + (fnum-1)) % roomTypes.length];
        const roomId = `${bname.endsWith('A')?'A':'B'}_F${fnum}_${t}`; // align with CSV folders
        rooms.push({ bname, floorName, fnum, type: t, roomId });
      }
    }
    for (const z of rooms) {
      await session.run(`
        MATCH (b:Building {name:$b}), (f:Floor {name:$f})
        MERGE (z:Zone {name: $type + ' ' + $fnum, type: $type, roomId: $roomId})
        MERGE (z)-[:BELONGS_TO_FLOOR]->(f)
        MERGE (z)-[:BELONGS_TO_BUILDING]->(b)
      `, { b: z.bname, f: z.floorName, type: z.type[0].toUpperCase() + z.type.slice(1), fnum: z.fnum, roomId: z.roomId });
    }
    // Devices per room - randomize 2..5 types
    const deviceDefs = [
      { t: 'IAQ_Sensor', prof: 'IAQ_Sensor_v1', tables: ['iaq'] },
      { t: 'Energy_Meter', prof: 'Energy_Meter_v1', tables: ['energy'] },
      { t: 'People_Counter', prof: 'People_Counter_v1', tables: ['people'] },
      { t: 'Water_Meter', prof: 'Water_Meter_v1', tables: ['water'] },
      { t: 'Odor_Sensor', prof: 'Odor_Sensor_v1', tables: ['iaq'] }
    ];
    for (const z of rooms) {
      const num = randInt(2, 5);
      const picks = [...deviceDefs].sort(()=>Math.random()-0.5).slice(0, num);
      for (const d of picks) {
        const dn = `${z.type} ${z.fnum}:${d.t}`;
        await session.run(`
          MATCH (z:Zone {roomId:$roomId})
          MATCH (b:Building)<-[:BELONGS_TO_BUILDING]-(:Floor)<-[:BELONGS_TO_FLOOR]-(z)
          MATCH (p:DeviceProfile {name:$profile})
          MERGE (dev:Device {id: $id})
            ON CREATE SET dev.name = $name, dev.type = $dtype
            ON MATCH SET dev.type = $dtype
          MERGE (dev)-[:LOCATED_IN_ZONE]->(z)
          MERGE (dev)-[:LOCATED_IN_BUILDING]->(b)
          MERGE (dev)-[:HAS_PROFILE]->(p)
        `, { roomId: z.roomId, profile: d.prof, id: `${z.roomId}:${d.t}`, name: `${z.roomId} ${d.t}`, dtype: d.t });
        // MEASURES from profile caps
        await session.run(`
          MATCH (dev:Device {id:$id})-[:HAS_PROFILE]->(p:DeviceProfile)
          UNWIND p.caps AS cap
          MATCH (mt:MetricType {name:cap})
          MERGE (dev)-[:MEASURES]->(mt)
        `, { id: `${z.roomId}:${d.t}` });
        // WRITES_TABLE
        for (const table of d.tables) {
          await session.run(`
            MATCH (dev:Device {id:$id})
            MERGE (t:Table {name:$table})
            MERGE (dev)-[:WRITES_TABLE {table:$table}]->(t)
          `, { id: `${z.roomId}:${d.t}`, table });
        }
      }
    }
    console.log('Neo4j mock graph populated (2x3x2 with random detectors).');
  } catch (e) {
    console.error('populate_neo4j_mock error:', e.message || String(e));
    process.exit(1);
  } finally {
    await session.close();
    await driver.close();
  }
}

run();

