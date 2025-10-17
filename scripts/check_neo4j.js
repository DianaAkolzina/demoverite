#!/usr/bin/env node
// Connectivity checker for Neo4j (Aura or self‑hosted)
// Usage:
//   node scripts/check_neo4j.js [--uri neo4j+s://... --username neo4j --password ... --database neo4j]
// Falls back to env vars: NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD, NEO4J_DATABASE

import neo4j from 'neo4j-driver';

function arg(name, def = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return process.env[`NEO4J_${name.toUpperCase()}`] ?? def;
}

const uri = arg('uri');
const username = arg('username', 'neo4j');
const password = arg('password');
const database = arg('database', 'neo4j');

if (!uri || !username || !password) {
  console.error('[neo4j-check] Missing required params. Provide --uri, --username, --password or set env NEO4J_URI/USERNAME/PASSWORD');
  process.exit(2);
}

const timeoutMs = Number(process.env.NEO4J_CHECK_TIMEOUT_MS || 15000);

async function main() {
  const driver = neo4j.driver(uri, neo4j.auth.basic(username, password), {
    // connectionTimeout sets initial handshake timeout
    connectionTimeout: timeoutMs,
  });
  try {
    const info = await driver.verifyConnectivity({ database });
    const addr = info?.address?.toString?.() || info?.address || 'unknown';
    console.log(`[neo4j-check] Connectivity OK to ${addr} (db=${database})`);

    const session = driver.session({ database });
    try {
      const res = await session.run('RETURN 1 AS ok');
      const ok = res.records?.[0]?.get('ok');
      console.log(`[neo4j-check] Test query ok=${ok}`);
    } finally {
      await session.close();
    }

    // Optional: try to get version (best effort)
    try {
      const s2 = driver.session({ database });
      const r2 = await s2.run('CALL dbms.components() YIELD name, versions RETURN name, versions LIMIT 1');
      await s2.close();
      const name = r2.records?.[0]?.get('name');
      const versions = r2.records?.[0]?.get('versions');
      console.log(`[neo4j-check] Server: ${name || 'neo4j'} ${Array.isArray(versions) ? versions.join(',') : versions}`);
    } catch {}

    await driver.close();
    process.exit(0);
  } catch (e) {
    console.error('[neo4j-check] Connectivity FAILED:', e?.message || String(e));
    try { await driver.close(); } catch {}
    process.exit(1);
  }
}

main();

