import EventEmitter from 'events';

const DEFAULT_TTL_MS = 30_000;

export class Connector extends EventEmitter {
  constructor({ id, label, description = '', check }) {
    super();
    if (!id) throw new Error('connector id required');
    this.id = id;
    this.label = label || id;
    this.description = description;
    this._check = typeof check === 'function' ? check : async () => ({ status: 'unknown' });
    this._snapshot = { status: 'unknown', checkedAt: 0 };
  }

  async check() {
    const started = Date.now();
    try {
      const detail = await this._check();
      const latencyMs = Date.now() - started;
      this._snapshot = {
        status: detail?.status || 'unknown',
        detail: detail?.detail || null,
        metadata: detail?.metadata || null,
        latencyMs,
        checkedAt: Date.now()
      };
      this.emit('snapshot', this._snapshot);
      return this._snapshot;
    } catch (err) {
      const latencyMs = Date.now() - started;
      this._snapshot = {
        status: 'error',
        detail: err?.message || String(err),
        metadata: null,
        latencyMs,
        checkedAt: Date.now()
      };
      this.emit('snapshot', this._snapshot);
      return this._snapshot;
    }
  }

  snapshot() {
    return { ...this._snapshot, id: this.id, label: this.label, description: this.description };
  }
}

export class ConnectorRegistry {
  constructor({ ttlMs = DEFAULT_TTL_MS } = {}) {
    this.ttlMs = ttlMs;
    this.connectors = new Map();
  }

  register(connector) {
    if (!(connector instanceof Connector)) throw new Error('Invalid connector');
    this.connectors.set(connector.id, connector);
    return connector;
  }

  get(id) {
    return this.connectors.get(id) || null;
  }

  list() {
    return Array.from(this.connectors.values());
  }

  async refresh({ force = false } = {}) {
    const now = Date.now();
    const tasks = [];
    for (const connector of this.connectors.values()) {
      const snapshot = connector.snapshot();
      const expired = !snapshot.checkedAt || (now - snapshot.checkedAt > this.ttlMs);
      if (force || expired || snapshot.status === 'error') {
        tasks.push(connector.check());
      } else {
        tasks.push(Promise.resolve(snapshot));
      }
    }
    return Promise.all(tasks);
  }

  async summary(options = {}) {
    await this.refresh(options);
    return this.list().map((c) => c.snapshot());
  }
}

export function statusReducer(summaries = []) {
  const reducer = { ok: 0, degraded: 0, error: 0, unknown: 0 };
  for (const snapshot of summaries) {
    if (!snapshot) continue;
    const status = (snapshot.status || 'unknown').toLowerCase();
    if (status === 'ok' || status === 'healthy') reducer.ok += 1;
    else if (status === 'degraded' || status === 'warn') reducer.degraded += 1;
    else if (status === 'error') reducer.error += 1;
    else reducer.unknown += 1;
  }
  return reducer;
}
