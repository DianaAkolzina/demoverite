#!/usr/bin/env node
// Populate Neo4j with mock multi-tenant building graph data.
// Env: NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD, NEO4J_DATABASE

import 'node-fetch';
import neo4j from 'neo4j-driver';

async function run() {
  const uri = process.env.NEO4J_URI;
  const user = process.env.NEO4J_USERNAME;
  const pass = process.env.NEO4J_PASSWORD;
  const database = process.env.NEO4J_DATABASE || 'neo4j';
  if (!uri || !user || !pass) {
    console.error('Missing Neo4j env (NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD).');
    process.exit(1);
  }
  const driver = neo4j.driver(uri, neo4j.auth.basic(user, pass));
  const session = driver.session({ database });
  try {
    const cyphers = [
      // Tenants & Buildings (two buildings only)
      `MERGE (t:Tenant {name:'Tenant A'})
       MERGE (ba:Building {name:'Building A'})-[:BELONGS_TO_TENANT]->(t)
       MERGE (bb:Building {name:'Building B'})-[:BELONGS_TO_TENANT]->(t)`,

      // Weather source example
      `UNWIND [
        {building:'Alpha Tower', source:'OpenWeather:Manchester'},
        {building:'Alpha Annex', source:'OpenWeather:Manchester'},
        {building:'Beta Plaza', source:'OpenWeather:Leeds'},
        {building:'Beta Lofts', source:'OpenWeather:Leeds'}
      ] AS w
      MERGE (bd:Building {name:w.building})
      MERGE (ws:WeatherStation {name:w.source})
      MERGE (bd)-[:HAS_WEATHER_SOURCE]->(ws)`,

      // Floors (2 per building)
      `MATCH (bd:Building)
       UNWIND [1,2] AS fnum
       MERGE (fl:Floor {name: 'Floor ' + fnum, floorNumber:fnum})
       MERGE (fl)-[:BELONGS_TO_BUILDING]->(bd)`,

      // Zones (rooms) with capacity & type (2 per floor, mapping to dataset roomIds)
      `MATCH (bd:Building)<-[:BELONGS_TO_BUILDING]-(fl:Floor)
       WITH bd, fl,
         CASE fl.floorNumber WHEN 1 THEN ['Cafe','Boardroom'] ELSE ['Lab','Toilet'] END AS ztypes
       UNWIND ztypes AS zname
       WITH bd, fl, zname,
         CASE bd.name WHEN 'Building A' THEN 'A' ELSE 'B' END AS bid
       WITH bd, fl, zname, bid,
         (bid + '_F' + toString(fl.floorNumber) + '_' + toLower(zname)) AS roomId
       MERGE (zn:Zone {name: zname + ' ' + fl.floorNumber, type: zname, roomId: roomId})
       MERGE (zn)-[:BELONGS_TO_FLOOR]->(fl)
       WITH zn, fl
       MATCH (bd:Building)<-[:BELONGS_TO_BUILDING]-(fl)
       MERGE (zn)-[:BELONGS_TO_BUILDING]->(bd)
       WITH zn
       SET zn.capacity = CASE zn.type WHEN 'Boardroom' THEN 12 WHEN 'Cafe' THEN 40 WHEN 'Lab' THEN 15 WHEN 'Toilet' THEN 6 ELSE 10 END`,

      // MetricTypes
      `UNWIND [
         'temperature','humidity','co2','pm25','pm10','lux',
         'people_count','value','total_kwh','water_value','odor_level',
         'nh3','h2s','airExchangeRate','virusrisk'
       ] AS m
       MERGE (:MetricType {name:m})`,

      // DeviceProfiles
      `UNWIND [
        {name:'IAQ_Sensor_v1', model:'IAQ-100', caps:['temperature','humidity','co2','pm25','pm10','lux']},
        {name:'Energy_Meter_v1', model:'EM-200', caps:['value','total_kwh']},
        {name:'People_Counter_v1', model:'PC-50', caps:['people_count']},
        {name:'Water_Meter_v1', model:'WM-10', caps:['water_value']},
        {name:'Odor_Sensor_v1', model:'OS-5', caps:['odor_level','nh3','h2s']},
        {name:'IAQ_Advanced_v2', model:'IAQ-200', caps:['temperature','humidity','co2','pm25','pm10','lux','airExchangeRate','virusrisk']}
      ] AS p
      MERGE (dp:DeviceProfile {name:p.name})
      SET dp.model = p.model, dp.caps = p.caps`,

      // Devices per Zone (no FOREACH; use WHERE and step-wise WITH)
      `MATCH (zn:Zone)
       WHERE zn.type IN ['Cafe','Boardroom','Lab','Toilet']
       MERGE (d1:Device {id: zn.name + ':IAQ'})
         ON CREATE SET d1.name = zn.name + ' IAQ', d1.type = 'IAQ_Sensor'
         ON MATCH SET d1.type = 'IAQ_Sensor'
       MERGE (d2:Device {id: zn.name + ':Energy'})
         ON CREATE SET d2.name = zn.name + ' Energy Meter', d2.type = 'Energy_Meter'
         ON MATCH SET d2.type = 'Energy_Meter'
       MERGE (d3:Device {id: zn.name + ':People'})
         ON CREATE SET d3.name = zn.name + ' People Counter', d3.type = 'People_Counter'
         ON MATCH SET d3.type = 'People_Counter'
       MERGE (d1)-[:LOCATED_IN_ZONE]->(zn)
       MERGE (d2)-[:LOCATED_IN_ZONE]->(zn)
       MERGE (d3)-[:LOCATED_IN_ZONE]->(zn)
       WITH d1,d2,d3,zn
       MATCH (bd:Building)<-[:BELONGS_TO_BUILDING]-(:Floor)<-[:BELONGS_TO_FLOOR]-(zn)
       MERGE (d1)-[:LOCATED_IN_BUILDING]->(bd)
       MERGE (d2)-[:LOCATED_IN_BUILDING]->(bd)
       MERGE (d3)-[:LOCATED_IN_BUILDING]->(bd)
       WITH d1,d2,d3,zn
       MATCH (p1:DeviceProfile {name: CASE WHEN zn.type='Cafe' THEN 'IAQ_Advanced_v2' ELSE 'IAQ_Sensor_v1' END})
       MATCH (p2:DeviceProfile {name:'Energy_Meter_v1'})
       MATCH (p3:DeviceProfile {name:'People_Counter_v1'})
       MERGE (d1)-[:HAS_PROFILE]->(p1)
       MERGE (d2)-[:HAS_PROFILE]->(p2)
       MERGE (d3)-[:HAS_PROFILE]->(p3)`,

      // Device -> MetricType
      `MATCH (d:Device)-[:HAS_PROFILE]->(p:DeviceProfile)
       UNWIND p.caps AS cap
       MATCH (mt:MetricType {name:cap})
       MERGE (d)-[:MEASURES]->(mt)`,

      // Device -> WRITES_TABLE
      `MATCH (d:Device)
       WITH d,
         CASE d.type
           WHEN 'IAQ_Sensor' THEN 'iaq'
           WHEN 'Energy_Meter' THEN 'energy'
           WHEN 'People_Counter' THEN 'people'
           ELSE 'iaq' END AS tableName
       MERGE (t:Table {name: tableName})
       MERGE (d)-[:WRITES_TABLE {table: tableName}]->(t)`,

      // Users/Roles
      `UNWIND [
        {email:'ops.diana@example.com', name:'Diana', tenant:'Tenant A', roles:['Admin','Analyst']},
        {email:'ops.krishan@example.com', name:'Krishan', tenant:'Tenant B', roles:['Viewer']}
      ] AS u
      MERGE (usr:User {email:u.email})
      SET usr.name = u.name
      MERGE (t:Tenant {name:u.tenant})
      MERGE (usr)-[:BELONGS_TO]->(t)
      WITH usr, u
      UNWIND u.roles AS r
      MERGE (role:Role {name:r})
      MERGE (usr)-[:HAS_ROLE]->(role)`
    ];

    for (const stmt of cyphers) {
      await session.run(stmt);
    }
    console.log('Neo4j mock data populated.');
  } catch (e) {
    console.error('Neo4j population error:', e);
    process.exit(1);
  } finally {
    await session.close();
    await driver.close();
  }
}

run();
