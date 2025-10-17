#!/usr/bin/env node
// Reset Neo4j (delete all nodes) and Chroma (drop all collections)

import neo4j from 'neo4j-driver';

async function resetNeo4j() {
  const uri = process.env.NEO4J_URI;
  const user = process.env.NEO4J_USERNAME;
  const pass = process.env.NEO4J_PASSWORD;
  const database = process.env.NEO4J_DATABASE || 'neo4j';
  if (!uri || !user || !pass) {
    console.error('[reset] Neo4j env missing');
    return;
  }
  const driver = neo4j.driver(uri, neo4j.auth.basic(user, pass));
  const session = driver.session({ database });
  try {
    console.log('[reset] Deleting all Neo4j nodes...');
    await session.run('MATCH (n) DETACH DELETE n');
    console.log('[reset] Neo4j cleared.');
  } catch (e) {
    console.error('[reset] Neo4j failed:', e.message || String(e));
  } finally {
    await session.close();
    await driver.close();
  }
}

async function resetChroma() {
  const base = (process.env.CHROMA_URL || '').replace(/\/$/, '');
  if (!base) { console.log('[reset] CHROMA_URL not set; skip Chroma'); return; }
  async function jsonFetch(path, opts) {
    const res = await fetch(base + path, { ...opts, headers: { 'Content-Type': 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }
  console.log('[reset] Dropping Chroma collections...');
  try {
    let cols = null;
    try { cols = await jsonFetch('/api/v2/collections'); } catch { cols = await jsonFetch('/api/v1/collections'); }
    const list = cols?.collections || [];
    for (const c of list) {
      const id = c?.id;
      if (!id) continue;
      try {
        await fetch(base + `/api/v2/collections/${encodeURIComponent(id)}`, { method: 'DELETE' })
          .then(r => r.ok ? null : Promise.reject());
      } catch {
        await fetch(base + `/api/v1/collections/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(()=>{});
      }
      console.log('[reset] Deleted collection', c?.name || id);
    }
  } catch (e) {
    console.error('[reset] Chroma reset failed:', e.message || String(e));
  }
}

async function main() {
  await resetNeo4j();
  await resetChroma();
}

main();

