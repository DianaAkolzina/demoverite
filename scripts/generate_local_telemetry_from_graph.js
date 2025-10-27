#!/usr/bin/env node
// Generate realistic per-device telemetry CSVs from live Neo4j graph metadata.
// Uses Device -> HAS_TELEMETRY_KEY (TelemetryKey.name) if present; otherwise infers by Device label/name.
// Writes to S3_LOCAL_DIR (default CSVex_s3) with filenames <deviceId>.csv where deviceId = d.id or d.cloud_id.

import fs from 'fs';
import path from 'path';

// Lightweight .env loader (respect existing env)
try {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const envPath = path.join(root, '.env');
  if (fs.existsSync(envPath)) {
    const raw = fs.readFileSync(envPath, 'utf8');
    raw.split(/\r?\n/).forEach((line) => {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (m) {
        const k = m[1].trim();
        if (process.env[k] == null || process.env[k] === '') process.env[k] = m[2];
      }
    });
  }
} catch {}

const DAYS = Number(process.env.DAYS || 120);
const OUT_DIR = path.resolve(process.cwd(), process.env.S3_LOCAL_DIR || 'CSVex_s3');
const ONLY_MISSING = String(process.env.ONLY_MISSING || '0') === '1';
const STEP = { iaq: 10, energy: 5, people: 15, water: 10, gas: 10 }; // minutes

function pr(...a) { console.log('[gen-telemetry-graph]', ...a); }

function hash32(s) { let h=2166136261>>>0; for (let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h = Math.imul(h, 16777619);} return h>>>0; }

function inferType(labels= [], name = '', profile = '') {
  const l = (labels||[]).map(String).join(' ').toLowerCase() + ' ' + String(name||'').toLowerCase() + ' ' + String(profile||'').toLowerCase();
  if (l.includes('occup') || l.includes('people')) return 'people';
  if (l.includes('iaq') || l.includes('air')) return 'iaq';
  if (l.includes('water')) return 'water';
  if (l.includes('odor') || l.includes('gas')) return 'gas';
  if (l.includes('energy') || l.includes('power') || l.includes('meter')) return 'energy';
  return 'iaq';
}

function fieldsFor(type, keys) {
  if (Array.isArray(keys) && keys.length) return ['ts', ...Array.from(new Set(keys.filter(k => k && k !== 'ts')))]
  if (type === 'people') return ['ts','raw','motion'];
  if (type === 'energy') return ['ts','value','powerFailure','unit','raw_data','total_kwh'];
  if (type === 'water') return ['ts','temperature','humidity','battery','raw_data','water_total','cubic_value'];
  if (type === 'gas') return ['ts','temperature','humidity','battery','h2s','nh3','raw_data'];
  // iaq default rich set
  return ['ts','temperature','humidity','airExchangeRate','battery','co2','lux','pm1','pm25','pm10','pressure','rssi','time','virusRisk','voc','occupants','mold','occupantsLower','occupantsUpper','radonShortTermAvg','sla'];
}

function genValue(field, i, startMs, stepMin, seed) {
  const rndVal = (min, max) => { const r = (hash32(field + ':' + seed + ':' + i) % 1e6)/1e6; return min + (max-min)*r; };
  const ts = startMs + i*stepMin*60*1000;
  const d = new Date(ts);
  const h = d.getUTCHours();
  if (field==='ts') return ts;
  if (field==='temperature') return +(21.5 + 3*Math.sin(2*Math.PI*(h/24)) + (hash32('t'+seed+i)%100)/200 - 0.25).toFixed(3);
  if (field==='humidity') return +Math.max(30, Math.min(75, 55 - (21.5-20)*0.9 + (hash32('h'+seed+i)%100)/50 - 1)).toFixed(3);
  if (field==='airExchangeRate') return +Math.max(0.1, Math.min(0.8, 0.3 + (hash32('a'+seed+i)%100)/1000 - 0.05)).toFixed(3);
  if (field==='battery') return +Math.max(85, 100 - (Date.now() - ts)/(1000*3600*24*365) + (hash32('b'+seed+i)%100)/200 - 0.25).toFixed(3);
  if (field==='co2') return +Math.max(380, 500 + (hash32('c'+seed+i)%200) - 100).toFixed(2);
  if (field==='lux') return +Math.max(0, 20 + 400*Math.max(0, Math.sin(2*Math.PI*((h-7)/24))) + (hash32('l'+seed+i)%60) - 30).toFixed(2);
  if (field==='pm1') return +Math.abs(((hash32('p1'+seed+i)%300)/10 - 15)).toFixed(3);
  if (field==='pm25') return +Math.abs(((hash32('p2'+seed+i)%300)/8 - 12)).toFixed(3);
  if (field==='pm10') return +Math.abs(((hash32('p3'+seed+i)%300)/6 - 10)).toFixed(3);
  if (field==='pressure') return +(1013 + ((hash32('pr'+seed+i)%100)/10 - 5)).toFixed(2);
  if (field==='rssi') return +(-50 + ((hash32('rs'+seed+i)%80)/10 - 4)).toFixed(2);
  if (field==='time') return Math.floor(ts/1000);
  if (field==='virusRisk') return +(1.2 + ((hash32('vr'+seed+i)%100)/500 - 0.1)).toFixed(3);
  if (field==='voc') return +(100 + ((hash32('vo'+seed+i)%200) - 100)/2).toFixed(3);
  if (field==='occupants') return +Math.max(0, ((hash32('oc'+seed+i)%300)/100)).toFixed(3);
  if (field==='occupantsLower') { const base = ((hash32('ol'+seed+i)%300)/100); return +Math.max(0, base - ((hash32('ol2'+seed+i)%50)/100)).toFixed(3); }
  if (field==='occupantsUpper') { const base = ((hash32('ou'+seed+i)%300)/100); return +(base + ((hash32('ou2'+seed+i)%50)/100)).toFixed(3); }
  if (field==='radonShortTermAvg') return +Math.max(10, ((hash32('ra'+seed+i)%400)/4)).toFixed(3);
  if (field==='mold') return +Math.max(0, Math.min(1, ((hash32('mo'+seed+i)%100)/300))).toFixed(3);
  if (field==='value') return +Math.max(0.1, ((hash32('va'+seed+i)%400)/10)).toFixed(3);
  if (field==='powerFailure') return ((hash32('pf'+seed+i)%10000)===0) ? 1.0 : 0.0;
  if (field==='unit') return 'A';
  if (field==='raw_data') return JSON.stringify({ ok: true });
  if (field==='total_kwh') return +((i* (STEP.energy/60) * 0.25)).toFixed(3);
  if (field==='raw') return JSON.stringify({ motion: genValue('motion', i, startMs, stepMin, seed) > 0 });
  if (field==='motion') return (h>=7 && h<=20) ? (((hash32('m'+seed+i)%10)<2)?1.0:0.0) : (((hash32('m'+seed+i)%50)<1)?1.0:0.0);
  if (field==='water_total' || field==='cubic_value') return +((hash32('w'+seed+i)%100000)/10 + i*0.5).toFixed(3);
  if (field==='h2s') return +Math.max(0.001, ((hash32('h2'+seed+i)%100)/1000)).toFixed(4);
  if (field==='nh3') return +Math.max(0.02, ((hash32('nh'+seed+i)%100)/500)).toFixed(4);
  return null;
}

async function main() {
  const outDir = OUT_DIR; try { fs.mkdirSync(outDir, { recursive: true }); } catch {}
  const startMs = Date.now() - DAYS*24*3600*1000;
  let neo4j = null;
  try { neo4j = await import('neo4j-driver').then(m => m.default || m); } catch {}
  if (!neo4j) { console.error('[gen-telemetry-graph] neo4j-driver not installed'); process.exit(2); }
  const uri = process.env.NEO4J_URI, user = process.env.NEO4J_USERNAME, pass = process.env.NEO4J_PASSWORD, db = process.env.NEO4J_DATABASE || 'neo4j';
  const driver = neo4j.driver(uri, neo4j.auth.basic(user, pass));
  const session = driver.session({ database: db });
  try {
    const cy = `
      MATCH (d:Device)
      OPTIONAL MATCH (d)-[:BELONGS_TO_TENANT]->(t:Tenant)
      OPTIONAL MATCH (d)-[:IN_BUILDING]->(b:Building)
      OPTIONAL MATCH (d)-[:LOCATED_ON_FLOOR]->(f:Floor)
      OPTIONAL MATCH (d)-[:LOCATED_IN_ZONE]->(z:Zone)
      OPTIONAL MATCH (d)-[:HAS_DEVICE_PROFILE]->(p:DeviceProfile)
      OPTIONAL MATCH (d)-[:HAS_TELEMETRY_KEY]->(k:TelemetryKey)
      RETURN d, t, b, f, z, p.name AS profile, collect(DISTINCT k.name) AS keys
    `;
    const res = await session.run(cy, {});
    let n = 0;
    for (const r of res.records) {
      const d = r.get('d');
      const props = d.properties || {};
      const labels = d.labels || [];
      const deviceId = props.cloud_id || props.id || props.deviceId || props.name || null;
      if (!deviceId) continue;
      const keys = (r.get('keys') || []).filter(Boolean);
      const profile = r.get('profile') || '';
      const type = inferType(labels, props.name, profile);
      const fields = fieldsFor(type, keys);
      // compute rows count from step
      const stepMin = (type==='people')? STEP.people : (type==='energy')? STEP.energy : (type==='water')? STEP.water : (type==='gas')? STEP.gas : STEP.iaq;
      const num = Math.ceil((Date.now() - startMs) / (stepMin*60*1000));
      const seed = hash32(String(deviceId))
      const rows = [];
      for (let i=0;i<num;i++) {
        const row = fields.map(f => genValue(f, i, startMs, stepMin, seed));
        rows.push(row);
      }
      const file = path.join(outDir, `${deviceId}.csv`);
      if (ONLY_MISSING && fs.existsSync(file)) { continue; }
      const header = fields.join(',');
      const lines = [header].concat(rows.map(r => r.join(',')));
      fs.writeFileSync(file, lines.join('\n'));
      n++;
    }
    pr(`Generated ${n} device CSVs in ${outDir}`);
  } finally {
    await session.close().catch(()=>{}); await driver.close().catch(()=>{});
  }
}

main().catch(e => { console.error('[gen-telemetry-graph] failed:', e?.stack||String(e)); process.exit(1); });
