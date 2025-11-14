// Vector adapter for Chroma (HTTP API). Falls back to null if CHROMA_URL not set.

export function createVectorClient({ chromaUrl, defaultCollection = process.env.CHROMA_COLLECTION || 'knowledge' } = {}) {
  const base = (chromaUrl || '').replace(/\/$/, '');
  if (!base) {
    return {
      searchDocs: async () => null,
      searchProfiles: async () => null,
      ping: async () => false
    };
  }

  async function jsonFetch(url, opts) {
    const controller = new AbortController();
    const timeoutMs = opts?.timeoutMs ?? 5000;
    const to = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...opts, signal: controller.signal, headers: { 'Content-Type': 'application/json', ...(opts?.headers || {}) } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(to);
    }
  }

  // Try v2 endpoints first; fallback to v1 for older servers
  function apiPath(p) { return `${base}${p}`; }
  async function preferV2(pathV2, pathV1, opts) {
    try {
      return await jsonFetch(apiPath(pathV2), opts);
    } catch (e) {
      // If v2 not available, try v1
      return await jsonFetch(apiPath(pathV1), opts);
    }
  }

  let heartbeatChecked = false;
  let heartbeatOk = false;
  async function checkHeartbeat() {
    if (heartbeatChecked) return heartbeatOk;
    heartbeatChecked = true;
    try {
      try {
        await jsonFetch(apiPath('/api/v2/heartbeat'), { timeoutMs: 3000 });
        heartbeatOk = true;
      } catch {
        await jsonFetch(apiPath('/api/v1/heartbeat'), { timeoutMs: 3000 });
        heartbeatOk = true;
      }
    } catch (e) {
      heartbeatOk = false;
      // Log once to stderr but do not throw repeatedly during queries
      console.warn('[vector] Chroma heartbeat failed at', base, String(e));
    }
    return heartbeatOk;
  }

  async function getOrCreateCollection(name) {
    const ok = await checkHeartbeat();
    if (!ok) return null;
    // Create-first to support servers with no list endpoint on v2
    try {
      const created = await preferV2('/api/v2/collections', '/api/v1/collections', {
        method: 'POST',
        body: JSON.stringify({ name })
      });
      if (created) return created;
    } catch {}
    // Fallback: list and match by name (if supported)
    try {
      let list = null;
      try {
        list = await jsonFetch(apiPath('/api/v2/collections'));
      } catch {
        list = await jsonFetch(apiPath('/api/v1/collections'));
      }
      const found = (list?.collections || []).find((c) => c?.name === name);
      if (found) return found;
    } catch {}
    return null;
  }

  async function searchDocs({ query, k = 6, collection = defaultCollection, where = null }) {
    try {
      const coll = await getOrCreateCollection(collection);
      const cid = coll?.id;
      if (!cid) return null;
      let out = null;
      try {
        out = await jsonFetch(`${base}/api/v2/collections/${encodeURIComponent(cid)}/query`, {
          method: 'POST',
          body: JSON.stringify({ query_texts: [String(query || '')], n_results: k, where: where || undefined })
        });
      } catch (e) {
        out = await jsonFetch(`${base}/api/v1/collections/${encodeURIComponent(cid)}/query`, {
          method: 'POST',
          body: JSON.stringify({ query_texts: [String(query || '')], n_results: k, where: where || undefined })
        });
      }
      // Normalize results
      const docs = (out?.documents?.[0] || []).map((text, i) => ({
        text,
        distance: out?.distances?.[0]?.[i] ?? null,
        id: out?.ids?.[0]?.[i] ?? null,
        metadata: out?.metadatas?.[0]?.[i] ?? null
      }));
      return { hits: docs };
    } catch (e) {
      return { error: String(e) };
    }
  }

  async function searchProfiles({ room, metric, horizon = '7d', k = 6, collection = (process.env.CHROMA_COLLECTION_PROFILES || 'profiles') }) {
    // Query by textual description; real deployments should add proper filter params when available
    const q = `room:${room} metric:${metric} horizon:${horizon}`;
    return searchDocs({ query: q, k, collection });
  }

  async function ping() {
    try {
      return await checkHeartbeat();
    } catch {
      return false;
    }
  }

  return { searchDocs, searchProfiles, ping };
}
