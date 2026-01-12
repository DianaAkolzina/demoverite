const DEFAULT_TTL_MS = Number(process.env.CONVERSATION_TTL_MS || 1000 * 60 * 60 * 4); // 4h default memory
const DEFAULT_MAX_ENTRIES = Number(process.env.CONVERSATION_MAX_ENTRIES || 300);

function normalizeToken(value) {
  if (value == null) return '';
  return String(value).trim().toLowerCase();
}

function dedupeStrings(list = [], limit = 32) {
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const token = normalizeToken(raw);
    if (!token || seen.has(token)) continue;
    seen.add(token);
    out.push(raw);
    if (out.length >= limit) break;
  }
  return out;
}

function snapshotRange(range = {}) {
  if (!range || (range.start == null && range.end == null)) return null;
  return {
    start: Number.isFinite(range.start) ? Number(range.start) : null,
    end: Number.isFinite(range.end) ? Number(range.end) : null
  };
}

function formatRange(range) {
  if (!range) return '';
  const start = Number(range.start);
  const end = Number(range.end);
  if (!Number.isFinite(start) && !Number.isFinite(end)) return '';
  const formatter = new Intl.DateTimeFormat('en-GB', {
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
  const startStr = Number.isFinite(start) ? formatter.format(new Date(start)) : 'unknown';
  const endStr = Number.isFinite(end) ? formatter.format(new Date(end)) : 'unknown';
  return `Time window memory: ${startStr} → ${endStr}.`;
}

function summarizeState(state) {
  if (!state) return '';
  const parts = [];
  const scope = state.scope || {};
  const scopeBits = [];
  if (scope.tenant) scopeBits.push(`owner group ${scope.tenant}`);
  if (scope.building) scopeBits.push(`owner ${scope.building}`);
  if (scope.floor) scopeBits.push(`shop ${scope.floor}`);
  if (scope.zone || scope.room) scopeBits.push(`page ${scope.zone || scope.room}`);
  if (Array.isArray(scope.devices) && scope.devices.length) scopeBits.push(`${scope.devices.length} scoped devices`);
  if (scopeBits.length) parts.push(`Scope memory: ${scopeBits.join(', ')}.`);
  const rangeLine = formatRange(state.lastRange);
  if (rangeLine) parts.push(rangeLine);
  if (Array.isArray(state.metrics) && state.metrics.length) {
    const metricList = state.metrics.slice(0, 5).map((m) => m.name).filter(Boolean).join(', ');
    if (metricList) parts.push(`Recently analyzed KPIs: ${metricList}.`);
  }
  if (state.preferences?.granularity) {
    parts.push(`User prefers ${state.preferences.granularity} granularity when possible.`);
  }
  if (Array.isArray(state.insights) && state.insights.length) {
    const highlights = state.insights
      .slice(0, 2)
      .map((item) => item.summary)
      .filter(Boolean)
      .join(' | ');
    if (highlights) parts.push(`Recent insights: ${highlights}`);
  }
  if (!parts.length) return 'Conversation memory: no prior facts stored.';
  return parts.join('\n');
}

function sanitizeScope(scope = {}) {
  const clean = { ...scope };
  if (clean.devices) clean.devices = dedupeStrings(Array.isArray(clean.devices) ? clean.devices : [clean.devices], 32);
  if (clean.zones) clean.zones = dedupeStrings(Array.isArray(clean.zones) ? clean.zones : [clean.zones], 32);
  if (clean.floors) clean.floors = dedupeStrings(Array.isArray(clean.floors) ? clean.floors : [clean.floors], 32);
  if (clean.range) clean.range = snapshotRange(clean.range);
  return clean;
}

function mergeMetricHistory(existing = [], metrics = []) {
  if (!Array.isArray(metrics) || !metrics.length) return existing || [];
  const now = Date.now();
  const map = new Map((existing || []).map((entry) => [entry.name, entry]));
  for (const metric of metrics) {
    const name = normalizeToken(metric);
    if (!name) continue;
    map.set(name, { name, lastAskedAt: now });
  }
  return Array.from(map.values())
    .sort((a, b) => (b.lastAskedAt || 0) - (a.lastAskedAt || 0))
    .slice(0, 8);
}

export class ConversationStore {
  constructor({ ttlMs = DEFAULT_TTL_MS, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this._items = new Map(); // id -> state
  }

  _now() {
    return Date.now();
  }

  _expired(entry) {
    if (!entry) return true;
    if (!this.ttlMs || this.ttlMs <= 0) return false;
    return this._now() - entry.updatedAt > this.ttlMs;
  }

  _prune() {
    for (const [id, entry] of this._items.entries()) {
      if (this._expired(entry)) this._items.delete(id);
    }
    if (this._items.size <= this.maxEntries) return;
    const entries = Array.from(this._items.values()).sort((a, b) => a.updatedAt - b.updatedAt);
    while (entries.length && this._items.size > this.maxEntries) {
      const oldest = entries.shift();
      if (oldest) this._items.delete(oldest.id);
    }
  }

  get(id) {
    if (!id) return null;
    const entry = this._items.get(id);
    if (!entry) return null;
    if (this._expired(entry)) {
      this._items.delete(id);
      return null;
    }
    return entry;
  }

  ensure(id) {
    if (!id) throw new Error('conversation id required');
    let entry = this.get(id);
    if (!entry) {
      entry = {
        id,
        createdAt: this._now(),
        updatedAt: this._now(),
        scope: {},
        preferences: {},
        metrics: [],
        insights: [],
        intentFlags: {},
        lastQuestion: null,
        lastRange: null
      };
      this._items.set(id, entry);
    }
    entry.updatedAt = this._now();
    this._prune();
    return entry;
  }

  update(id, mutator) {
    const entry = this.ensure(id);
    if (typeof mutator === 'function') {
      mutator(entry);
    }
    entry.updatedAt = this._now();
    return entry;
  }

  recordScope(id, scope = {}) {
    return this.update(id, (entry) => {
      const clean = sanitizeScope(scope);
      entry.scope = { ...entry.scope, ...clean };
      if (clean.range) entry.lastRange = clean.range;
    });
  }

  recordPreferences(id, prefs = {}) {
    const filtered = Object.fromEntries(
      Object.entries(prefs || {}).filter(([, value]) => value != null && value !== '')
    );
    if (!Object.keys(filtered).length) return this.get(id);
    return this.update(id, (entry) => {
      entry.preferences = { ...entry.preferences, ...filtered };
    });
  }

  recordQuestion(id, question = '', meta = {}) {
    const { metrics = [], intents = {}, timeHints = {} } = meta || {};
    return this.update(id, (entry) => {
      entry.lastQuestion = { text: question, ts: this._now() };
      entry.metrics = mergeMetricHistory(entry.metrics, metrics);
      if (timeHints?.granularity) {
        entry.preferences = { ...entry.preferences, granularity: timeHints.granularity };
      }
      if (intents && typeof intents === 'object') {
        entry.intentFlags = entry.intentFlags || {};
        for (const [key, value] of Object.entries(intents)) {
          if (value) entry.intentFlags[key] = true;
        }
      }
    });
  }

  recordInsight(id, insight = {}) {
    const summary = String(insight.summary || '').trim();
    if (!summary) return this.get(id);
    return this.update(id, (entry) => {
      const list = Array.isArray(entry.insights) ? entry.insights : [];
      list.unshift({
        summary: summary.slice(0, 280),
        ts: this._now(),
        metrics: Array.isArray(insight.metrics) ? insight.metrics.slice(0, 4) : []
      });
      entry.insights = list.slice(0, 5);
    });
  }

  summarize(target) {
    if (!target) return '';
    const state = typeof target === 'string' ? this.get(target) : target;
    return summarizeState(state);
  }
}

export function summarizeConversationState(state) {
  return summarizeState(state);
}
