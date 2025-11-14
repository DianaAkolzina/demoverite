async function fetchJSON(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function isoToLocalInput(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

let msgId = 0;
function nextId() { return 'm' + (++msgId); }
let chartCounter = 0;
const UI_LOCALE = 'en-GB';
const UI_TIMEZONE = 'Europe/London';
const tsFormatter = new Intl.DateTimeFormat(UI_LOCALE, {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
  timeZone: UI_TIMEZONE
});

const CONVERSATION_STORAGE_KEY = 'avm.conversation-id';
const randomConversationId = () =>
  (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
    ? crypto.randomUUID()
    : `conv-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;

function readStoredConversationId() {
  try {
    return sessionStorage.getItem(CONVERSATION_STORAGE_KEY);
  } catch {
    return null;
  }
}

function persistConversationId(id) {
  if (!id) return;
  try {
    sessionStorage.setItem(CONVERSATION_STORAGE_KEY, id);
  } catch {}
}

let conversationId = readStoredConversationId() || randomConversationId();
persistConversationId(conversationId);

function setConversationId(nextId) {
  if (!nextId || nextId === conversationId) return;
  conversationId = nextId;
  persistConversationId(conversationId);
}

function resetConversationMemory() {
  conversationId = randomConversationId();
  persistConversationId(conversationId);
}

try {
  window.AVMConversation = {
    getId: () => conversationId,
    reset: resetConversationMemory
  };
} catch {}

function formatTs(ts) {
  if (ts == null) return '—';
  const num = Number(ts);
  if (!Number.isFinite(num)) return '—';
  try {
    return tsFormatter.format(new Date(num));
  } catch {
    return new Date(num).toLocaleString('en-GB', { hour12: false });
  }
}

function readInputTs(input) {
  if (!input || !input.value) return null;
  const parsed = Date.parse(input.value);
  return Number.isNaN(parsed) ? null : parsed;
}

function normalizeTimestamp(ts) {
  return Number.isFinite(ts) ? ts : null;
}

function formatDateLocal(ts) { return formatTs(ts); }

function formatDateUTC(ts) {
  if (ts == null) return 'n/a';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return 'n/a';
  return d.toISOString().replace('T', ' ').slice(0, 16);
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Very small Markdown renderer with nested list support
function markdownToHtml(md) {
  let s = escapeHtml(md || '');
  // code blocks ```
  s = s.replace(/```([\s\S]*?)```/g, (m, code) => `<pre><code>${code.replace(/\n/g,'<br>')}</code></pre>`);
  // headings #, ## (limit to start of line)
  s = s.replace(/^###\s+(.*)$/gm, '<h3>$1</h3>')
       .replace(/^##\s+(.*)$/gm, '<h2>$1</h2>')
       .replace(/^#\s+(.*)$/gm, '<h1>$1</h1>');
  // nested unordered lists via indentation (2 spaces per level)
  s = (function convertNestedLists(text) {
    const lines = text.split('\n');
    const out = [];
    let level = 0;
    const open = (n) => { for (let i=0;i<n;i++){ out.push('<ul>'); level++; } };
    const close = (n) => { for (let i=0;i<n;i++){ out.push('</ul>'); level--; } };
    for (const raw of lines) {
      const m = raw.match(/^(\s*)([-*])\s+(.*)$/);
      if (m) {
        const indent = m[1] || '';
        const content = m[3] || '';
        const newLevel = Math.floor(indent.replace(/\t/g,'  ').length / 2);
        if (newLevel > level) open(newLevel - level);
        else if (newLevel < level) close(level - newLevel);
        out.push(`<li>${content}</li>`);
      } else {
        if (level > 0) close(level);
        out.push(raw);
      }
    }
    if (level > 0) close(level);
    return out.join('\n');
  })(s);
  // inline code `code`
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  // bold **text**
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // italics *text*
  s = s.replace(/(^|\s)\*([^*]+)\*/g, '$1<em>$2</em>');
  // line breaks
  s = s.replace(/\n/g, '<br>');
  return s;
}

function appendMessage(container, role, text, chartOptions) {
  const wrap = document.createElement('div');
  wrap.className = 'message ' + (role === 'user' ? 'user' : 'bot');
  if (role === 'assistant' || role === 'bot') {
    wrap.innerHTML = markdownToHtml(text || '');
  } else {
    wrap.textContent = text || '';
  }
  container.appendChild(wrap);
  if (chartOptions) {
    try {
      renderChartSidebar(chartOptions, { title: null });
    } catch (e) {
      console.error('sidebar chart failed', e);
    }
  }
  container.scrollTop = container.scrollHeight;
  return wrap;
}

function renderChartSidebar(chartOptions, opts = {}) {
  try {
    const chartsSidebar = document.getElementById('chart-sidebar');
    if (!chartsSidebar) return;
    chartsSidebar.classList.remove('hidden');

    const wrap = document.createElement('div');
    wrap.className = 'chart-container agent-chart';
    const holder = document.createElement('div');
    const chartId = `agent-chart-${++chartCounter}`;
    holder.id = chartId;
    holder.style.width = '100%';
    holder.style.height = opts.height || '100%';
    wrap.appendChild(holder);
    chartsSidebar.appendChild(wrap);

    const maxCharts = opts.maxCharts || 6;
    const charts = chartsSidebar.querySelectorAll('.chart-container.agent-chart');
    if (charts.length > maxCharts) {
      const excess = charts.length - maxCharts;
      for (let i = 0; i < excess; i++) {
        charts[i].remove();
      }
    }

    requestAnimationFrame(() => {
      try {
        const cfg = {
          credits: { enabled: false },
          accessibility: { enabled: false, ...(chartOptions.accessibility || {}) },
          chart: {
            backgroundColor: 'transparent',
            height: (chartOptions.chart && chartOptions.chart.height) || holder.clientHeight || 320,
            ...(chartOptions.chart || {})
          },
          ...chartOptions
        };
        Highcharts.chart(chartId, cfg);
      } catch (err) {
        console.error('Highcharts render failed', err, chartOptions);
      }
    });

    chartsSidebar.scrollTop = chartsSidebar.scrollHeight;
  } catch (err) {
    console.error(err);
  }
}

function clearAgentCharts() {
  try {
    const chartsSidebar = document.getElementById('chart-sidebar');
    if (!chartsSidebar) return;
    chartsSidebar.querySelectorAll('.chart-container.agent-chart').forEach((node) => node.remove());
    chartsSidebar.classList.add('hidden');
    chartCounter = 0;
  } catch (err) {
    console.error('clearAgentCharts failed', err);
  }
}

async function init() {
  const startEl = document.getElementById('start');
  const endEl = document.getElementById('end');
  const chatEl = document.getElementById('chat');
  const inputEl = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const metricsEl = document.getElementById('metrics');
  const sidebar = document.querySelector('.sidebar');
  const statusEl = document.getElementById('status-card');
  const queryLevelEl = document.getElementById('query-level');
  const graphViewTitle = document.getElementById('graph-view-title');
  const graphViewChartId = 'graph-view-chart';
  const buildingSelect = document.getElementById('building-select');
  const floorSelect = document.getElementById('floor-select');
  const zoneSelect = document.getElementById('zone-select');
  const deviceSelect = document.getElementById('device-select');
  const rangeDiv = document.getElementById('selected-range');
  const scopePillEl = document.getElementById('scope-pill');
  const confirmBtn = document.getElementById('confirm-scope');
  const clearBtn = document.getElementById('clear-scope');
  const selection = {
    tenant: null,
    building: null,
    floor: null,
    room: null,
    roomLabel: null,
    roomId: null,
    devices: [],
    zonesList: [],
    floorsList: [],
    deviceZoneMap: {}
  };
  window.selection = selection;
  let selectionConfirmed = false;
  let graphLevel = 'buildings';
  let showTelemetryKeys = false;
  let lastGraphNodes = [];
  let sending = false;
  let currentScopeDevices = [];
  let currentScopeZones = [];
  let currentScopeFloors = [];

  function ensureSelectOption(select, value, label) {
    if (!select || value == null || value === '') return;
    const exists = Array.from(select.options).some(opt => opt.value === value);
    if (!exists) {
      const opt = new Option(label ?? value, value);
      select.appendChild(opt);
    }
  }

  function syncDropdownsFromSelection() {
    if (buildingSelect) {
      if (selection.building) ensureSelectOption(buildingSelect, selection.building, selection.building);
      buildingSelect.value = selection.building || '';
    }
    if (floorSelect) {
      if (selection.floor) ensureSelectOption(floorSelect, selection.floor, selection.floor);
      floorSelect.value = selection.floor || '';
    }
    if (zoneSelect) {
      if (selection.room) ensureSelectOption(zoneSelect, selection.room, selection.roomLabel || selection.room);
      zoneSelect.value = selection.room || '';
    }
  }

  function hasScopeSelection() {
    return !!(selection.building || selection.floor || selection.room);
  }

  function updateScopeControls() {
    const hasSelection = hasScopeSelection();
    if (confirmBtn) confirmBtn.disabled = !hasSelection;
    if (clearBtn) clearBtn.disabled = !hasSelection;
  }

  function updateSendButtonState() {
    if (!sendBtn) return;
    const hasText = (inputEl.value || '').trim().length > 0;
    sendBtn.disabled = sending || !hasText;
  }

  function updateSelectedRangeDisplay() {
    if (!rangeDiv) return;
    const start = readInputTs(startEl);
    const end = readInputTs(endEl);
    const sel = selection || { building: null, floor: null, room: null };
    rangeDiv.innerHTML = `
      <b>Scope:</b> ${sel.building ? 'Building '+sel.building : '—'}${sel.floor ? ' · Floor '+sel.floor : ''}${sel.room ? ' · Room '+(sel.roomLabel || sel.room) : ''}<br>
      <b>Start:</b> ${formatDateLocal(start)} <span style="color:#3b82f6;">(UTC: ${formatDateUTC(start)})</span><br>
      <b>End:</b> ${formatDateLocal(end)} <span style="color:#3b82f6;">(UTC: ${formatDateUTC(end)})</span>
    `;
  }

  renderScopePill();
  updateSendButtonState();

  const graphView = document.getElementById('graph-view');
  const chartsSidebar = document.getElementById('chart-sidebar');
  try {
    if (deviceSelect) deviceSelect.style.display = 'none';
  } catch {}

  const _reqCache = new Map();
  const _snapshotStatus = new Map();
  function _cacheKey(url) { return url; }
  async function cachedFetchJSON(url, { ttlMs = 15000, controller = null } = {}) {
    const k = _cacheKey(url);
    const now = Date.now();
    const ent = _reqCache.get(k);
    if (ent && (now - ent.t) < ttlMs) return ent.v;
    const opts = controller ? { signal: controller.signal } : undefined;
    const v = await fetchJSON(url, opts);
    _reqCache.set(k, { t: now, v });
    return v;
  }
  let abortBuildings = null, abortFloors = null, abortZones = null, abortDevices = null;
  async function fetchSnapshot(tenantName) {
    const slug = (s) => String(s||'').trim().toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'');
    const path1 = tenantName ? `/data/graph_snapshot.${slug(tenantName)}.json` : '/data/graph_snapshot.json';
    const key = tenantName || '__default__';
    if (_snapshotStatus.get(key) === 'missing') return null;
    try {
      const data = await cachedFetchJSON(path1, { ttlMs: 20000 });
      _snapshotStatus.set(key, 'ok');
      return data;
    } catch {
      _snapshotStatus.set(key, 'missing');
    }
    try {
      const data = await cachedFetchJSON('/data/graph_snapshot.json', { ttlMs: 20000 });
      _snapshotStatus.set(key, 'ok');
      return data;
    } catch {
      _snapshotStatus.set(key, 'missing');
    }
    return null;
  }
  function invalidateScopeCache() {
    try { _reqCache.clear(); } catch {}
    try { if (abortBuildings) abortBuildings.abort(); } catch {}
    try { if (abortFloors) abortFloors.abort(); } catch {}
    try { if (abortZones) abortZones.abort(); } catch {}
    try { if (abortDevices) abortDevices.abort(); } catch {}
    abortBuildings = abortFloors = abortZones = abortDevices = null;
  }

  async function populateBuildings() {
    try {

      let arr = [];
      try {
      
        let nodes = [], links = [];
        const snap = await fetchSnapshot(selection.tenant);
        if (snap && Array.isArray(snap.nodes) && Array.isArray(snap.links)) {
          nodes = snap.nodes; links = snap.links;
        } else {
          if (abortBuildings) { try { abortBuildings.abort(); } catch {} }
          abortBuildings = new AbortController();
          const g = await cachedFetchJSON(`/api/graph/full${selection.tenant ? ('?tenant='+encodeURIComponent(selection.tenant)) : ''}`, { ttlMs: 20000, controller: abortBuildings });
          nodes = g.nodes || []; links = g.links || [];
        }
        const buildings = nodes.filter(n => (n.nodeType||n.label)==='Building');
        const zoneToBuilding = new Map();
        for (const l of links) if (l.rel==='LOCATED_IN_BUILDING') zoneToBuilding.set(l.source, l.target);
        const buildingHasDevice = new Set();
        for (const l of links) {
          if (l.rel==='IN_BUILDING') { buildingHasDevice.add(l.target); }
          if (l.rel==='LOCATED_IN_ZONE') {
            const zB = zoneToBuilding.get(l.target);
            if (zB) buildingHasDevice.add(zB);
          }
        }
        const names = buildings.filter(b => buildingHasDevice.has(b.id)).map(b => b.name).filter(Boolean);
        arr = Array.from(new Set(names));
      } catch {}
    
      if (!arr.length) {
        if (selection.tenant) {
          try {
            if (abortBuildings) { try { abortBuildings.abort(); } catch {} }
            abortBuildings = new AbortController();
            const sm = await cachedFetchJSON(`/api/scope/metrics?tenant=${encodeURIComponent(selection.tenant)}`, { ttlMs: 10000, controller: abortBuildings });
            const groups = Array.isArray(sm.groups) ? sm.groups : [];
            const builds = groups.map(g => {
              const total = (g.floors||[]).reduce((acc,F)=> acc + (F.zones||[]).reduce((a,z)=> a + ((z.devices||[]).length||0), 0), 0);
              return { name: g.building, devices: total };
            }).filter(b => b.name && b.devices > 0);
            arr = Array.from(new Set(builds.map(b => b.name)));
          } catch {}
          if (!arr.length) {
            const res = await cachedFetchJSON(`/api/buildings?tenant=${encodeURIComponent(selection.tenant)}`, { ttlMs: 30000 });
            arr = (res.buildings || []).filter(b => (b.devices||0) > 0).map(b => b.name).filter(Boolean);
          }
        } else {
          const res = await cachedFetchJSON(`/api/buildings`, { ttlMs: 30000 });
          arr = (res.buildings || []).filter(b => (b.devices||0) > 0).map(b => b.name).filter(Boolean);
        }
      }
      buildingSelect.innerHTML = '<option value="">Select building…</option>' + arr.map(n => `<option value="${n}">${n}</option>`).join('');
      if (selection.building) { buildingSelect.value = selection.building; }
    } catch { buildingSelect.innerHTML = '<option value="">Select building…</option>'; }
  }
  async function populateFloors(building) {
    floorSelect.innerHTML = '<option value="">Select floor…</option>';
    zoneSelect.innerHTML = '<option value="">Select zone…</option>';
    deviceSelect.innerHTML = '<option value="">Select device…</option>';
    if (!building) return;
    try {
     
      let floors = [];
      try {
      
        const snap = await fetchSnapshot(selection.tenant);
        if (snap && Array.isArray(snap.nodes) && Array.isArray(snap.links)) {
          const nodes = snap.nodes, links = snap.links;
          const b = nodes.find(n => (n.nodeType||n.label)==='Building' && n.name===building);
          if (b) {
            const floorNodes = nodes.filter(n => (n.nodeType||n.label)==='Floor' && links.some(l => l.source===n.id && l.rel==='LOCATED_IN_BUILDING' && l.target===b.id));
            const floorIds = new Set(floorNodes.map(n=>n.id));
            const zoneNodes = nodes.filter(n => (n.nodeType||n.label)==='Zone' && links.some(l => l.source===n.id && l.rel==='BELONGS_TO_FLOOR' && floorIds.has(l.target)));
            const zoneIds = new Set(zoneNodes.map(n=>n.id));
            const hasDeviceFloorIds = new Set(links.filter(l => l.rel==='LOCATED_IN_ZONE' && zoneIds.has(l.target)).map(l => {
              const zId = l.target;
              const zToF = links.find(x => x.source===zId && x.rel==='BELONGS_TO_FLOOR');
              return zToF ? zToF.target : null;
            }).filter(Boolean));
            floors = floorNodes.filter(n => hasDeviceFloorIds.has(n.id)).map(n => n.name).filter(Boolean);
          }
        }
      
        if (!floors.length) {
          if (abortFloors) { try { abortFloors.abort(); } catch {} }
          abortFloors = new AbortController();
          const qp = [`building=${encodeURIComponent(building)}`];
          if (selection.tenant) qp.push(`tenant=${encodeURIComponent(selection.tenant)}`);
          const sm = await cachedFetchJSON(`/api/scope/metrics?${qp.join('&')}`, { ttlMs: 15000, controller: abortFloors });
          const groups = Array.isArray(sm.groups) ? sm.groups : [];
          const g = groups.find(x => x.building === building);
          if (g) {
            floors = (g.floors||[]).filter(F => (F.zones||[]).some(z => (z.devices||[]).length > 0)).map(F => F.floor).filter(Boolean);
          }
        }
      } catch {}
    
      if (!floors.length) {
        try {
          const topo = await cachedFetchJSON(`/api/topology${selection.tenant ? ('?tenant='+encodeURIComponent(selection.tenant)) : ''}`, { ttlMs: 20000, controller: abortFloors });
          const b = (topo.buildings||[]).find(B => B.name===building);
          if (b) floors = (b.floors||[]).filter(F => (F.zones||[]).some(z => (z.devices||[]).length>0)).map(F => F.name).filter(Boolean);
        } catch {}
      }
      if (!floors.length) {
        try {
          const g = await cachedFetchJSON(`/api/graph/full${selection.tenant ? ('?tenant='+encodeURIComponent(selection.tenant)) : ''}`, { ttlMs: 20000, controller: abortFloors });
          const nodes = g.nodes || []; const links = g.links || [];
          const b = nodes.find(n => (n.nodeType||n.label)==='Building' && n.name===building);
          if (b) {
            const floorNodes = nodes.filter(n => (n.nodeType||n.label)==='Floor' && links.some(l => l.source===n.id && l.rel==='LOCATED_IN_BUILDING' && l.target===b.id));
            const floorIds = new Set(floorNodes.map(n=>n.id));
            const zones = nodes.filter(n => (n.nodeType||n.label)==='Zone' && links.some(l => l.source===n.id && l.rel==='BELONGS_TO_FLOOR' && floorIds.has(l.target)));
            const zoneIds = new Set(zones.map(n=>n.id));
            const hasDeviceFloorIds = new Set(links.filter(l => l.rel==='LOCATED_IN_ZONE' && zoneIds.has(l.target)).map(l => {
              const zId = l.target;
              const zToF = links.find(x => x.source===zId && x.rel==='BELONGS_TO_FLOOR');
              return zToF ? zToF.target : null;
            }).filter(Boolean));
            floors = floorNodes.filter(n => hasDeviceFloorIds.has(n.id)).map(n => n.name || String(n.id||'').split(':')[1] || '').filter(Boolean);
          }
        } catch {}
      }
      floors = Array.from(new Set(floors));
      floorSelect.innerHTML = '<option value="">Select floor…</option>' + floors.map(n=>`<option value="${n}">${n}</option>`).join('');
      if (selection.floor) floorSelect.value = selection.floor;
    } catch {}
  }
  async function populateZones(building, floor) {
    zoneSelect.innerHTML = '<option value="">Select zone…</option>';
    deviceSelect.innerHTML = '<option value="">Select device…</option>';
    if (!building || !floor) return;
    try {
      
      let zones = [];
      try {
       
        const snap = await fetchSnapshot(selection.tenant);
        if (snap && Array.isArray(snap.nodes) && Array.isArray(snap.links)) {
          const nodes = snap.nodes, links = snap.links;
          const b = nodes.find(n => (n.nodeType||n.label)==='Building' && n.name===building);
          const f = b ? nodes.find(n => (n.nodeType||n.label)==='Floor' && n.name===floor && links.some(l => l.source===n.id && l.rel==='LOCATED_IN_BUILDING' && l.target===b.id)) : null;
          if (b && f) {
            const zoneNodes = nodes.filter(n => (n.nodeType||n.label)==='Zone' && links.some(l => l.source===n.id && l.rel==='BELONGS_TO_FLOOR' && l.target===f.id));
            const zIds = new Set(zoneNodes.map(n=>n.id));
            const devZoneIds = new Set(links.filter(l => l.rel==='LOCATED_IN_ZONE' && zIds.has(l.target)).map(l => l.target));
            zones = zoneNodes.filter(n => devZoneIds.has(n.id)).map(n => n.name).filter(Boolean);
          }
        }
        
        if (!zones.length) {
          if (abortZones) { try { abortZones.abort(); } catch {} }
          abortZones = new AbortController();
          const qp = [`building=${encodeURIComponent(building)}`, `floor=${encodeURIComponent(floor)}`];
          if (selection.tenant) qp.push(`tenant=${encodeURIComponent(selection.tenant)}`);
          const sm = await cachedFetchJSON(`/api/scope/metrics?${qp.join('&')}`, { ttlMs: 15000, controller: abortZones });
          const groups = Array.isArray(sm.groups) ? sm.groups : [];
          const g = groups.find(x => x.building === building);
          if (g) {
            const F = (g.floors||[]).find(ff => ff.floor === floor);
            if (F) zones = (F.zones||[]).filter(z => (z.devices||[]).length>0).map(z => z.zone).filter(Boolean);
          }
        }
      } catch {}
      
      if (!zones.length) {
        try {
          const topo = await cachedFetchJSON(`/api/topology${selection.tenant ? ('?tenant='+encodeURIComponent(selection.tenant)) : ''}`, { ttlMs: 20000, controller: abortZones });
          for (const B of (topo.buildings||[])) if (B.name===building) {
            const F = (B.floors||[]).find(ff => ff.name===floor);
            if (F) zones.push(...(F.zones||[]).filter(z => (z.devices||[]).length>0).map(z => z.name));
          }
        } catch {}
      }
      
      if (!zones.length) {
        try {
          const g = await cachedFetchJSON(`/api/graph/full${selection.tenant ? ('?tenant='+encodeURIComponent(selection.tenant)) : ''}`, { ttlMs: 20000, controller: abortZones });
          const nodes = g.nodes || []; const links = g.links || [];
          const b = nodes.find(n => (n.nodeType||n.label)==='Building' && n.name===building);
          if (b) {
            const floors = nodes.filter(n => (n.nodeType||n.label)==='Floor' && (n.name===floor) && links.some(l => l.source===n.id && l.rel==='LOCATED_IN_BUILDING' && l.target===b.id));
            const floorIds = new Set(floors.map(n=>n.id));
            const zoneNodes = nodes.filter(n => (n.nodeType||n.label)==='Zone' && links.some(l => l.source===n.id && l.rel==='BELONGS_TO_FLOOR' && floorIds.has(l.target)));
            const zoneIds = new Set(zoneNodes.map(n=>n.id));
            const devZoneIds = new Set(links.filter(l => l.rel==='LOCATED_IN_ZONE' && zoneIds.has(l.target)).map(l => l.target));
            zones = zoneNodes.filter(n => devZoneIds.has(n.id)).map(n => n.name).filter(Boolean);
          }
        } catch {}
      }
      const uniq = Array.from(new Set(zones)).filter(Boolean);
      zoneSelect.innerHTML = '<option value="">Select zone…</option>' + uniq.map(n=>`<option value="${n}">${n}</option>`).join('');
      if (selection.room) zoneSelect.value = selection.room;
    } catch {}
  }
  async function populateDevices(building, floor, zone) {
    deviceSelect.innerHTML = '<option value="">Select device…</option>';
    if (!building) return;
    try {
      const prm = [];
      const qp = [`building=${encodeURIComponent(building)}`];
      if (selection.tenant) qp.push(`tenant=${encodeURIComponent(selection.tenant)}`);
      if (floor) qp.push(`floor=${encodeURIComponent(floor)}`);
      if (zone) qp.push(`zone=${encodeURIComponent(zone)}`);
      if (abortDevices) { try { abortDevices.abort(); } catch {} }
      abortDevices = new AbortController();
      const sm = await cachedFetchJSON(`/api/scope/metrics?${qp.join('&')}`, { ttlMs: 15000, controller: abortDevices });
      let devs = Array.isArray(sm.deviceIndex) ? sm.deviceIndex : [];
     
      if ((!devs || !devs.length) && zone) {
        try {
          const g = await cachedFetchJSON(`/api/graph/full${selection.tenant ? ('?tenant='+encodeURIComponent(selection.tenant)) : ''}`, { ttlMs: 20000 });
          const nodes = g.nodes || []; const links = g.links || [];
          const byId = new Map(nodes.map(n => [n.id, n]));
          const bNode = nodes.find(n => (n.nodeType||n.label)==='Building' && n.name===building);
         
          const fNodes = floor && bNode ? nodes.filter(n => (n.nodeType||n.label)==='Floor' && n.name===floor && links.some(l => l.source===n.id && l.rel==='LOCATED_IN_BUILDING' && l.target===bNode.id)) : [];
          const zNodes = nodes.filter(n => (n.nodeType||n.label)==='Zone' && n.name===zone && ( (!floor && bNode && links.some(l => l.source===n.id && l.rel==='LOCATED_IN_BUILDING' && l.target===bNode.id)) || (fNodes.length && links.some(l => l.source===n.id && l.rel==='BELONGS_TO_FLOOR' && fNodes.some(f=>f.id===l.target))) ));
          const zIds = new Set(zNodes.map(z => z.id));
          const devIds = links.filter(l => l.rel==='LOCATED_IN_ZONE' && zIds.has(l.target)).map(l => l.source);
          const uniqDevIds = Array.from(new Set(devIds));
          devs = uniqDevIds.map(id => {
            const d = byId.get(id);
            const keys = links.filter(x => (x.rel==='HAS_TELEMETRY_KEY' || x.rel==='MEASURES') && x.target===id).map(x => byId.get(x.source)?.name).filter(Boolean);
            return { id, name: d?.name || id, type: d?.deviceType || d?.type || 'Device', metrics: Array.from(new Set(keys)) };
          });
        } catch {}
      }
    
      const byType = new Map();
      for (const d of devs) {
        const t = d.type || 'Device';
        if (!byType.has(t)) byType.set(t, []);
        byType.get(t).push(d);
      }
      const parts = ['<option value="">Select device…</option>'];
      for (const [t, arr] of byType.entries()) {
        parts.push(`<optgroup label="${escapeHtml(t)}">`);
        arr.sort((a,b)=> String(a.name||a.id).localeCompare(String(b.name||b.id)));
        for (const d of arr) {
          const keys = Array.isArray(d.metrics) ? d.metrics.slice(0,6).join(', ') : '';
          const label = `${escapeHtml(d.name || d.id)}${keys ? ' — '+escapeHtml(keys) : ''}`;
          parts.push(`<option value="${d.id}">${label}</option>`);
        }
        parts.push('</optgroup>');
      }
      deviceSelect.innerHTML = parts.join('');
    
      deviceSelect.style.display = devs.length ? '' : 'none';
    } catch {}
  }

  buildingSelect?.addEventListener('change', async () => {
    selection.building = buildingSelect.value || null;
    selection.floor = null; selection.room = null; selection.roomLabel = null; selection.roomId = null; selectionConfirmed = false; graphLevel='floors';
    selection.devices = [];
    selection.zonesList = [];
    selection.floorsList = [];
    selection.deviceZoneMap = {};
    currentScopeDevices = [];
    currentScopeZones = [];
    currentScopeFloors = [];
    syncDropdownsFromSelection();
    renderScopePill();
    await populateFloors(selection.building);
    syncDropdownsFromSelection();
    refreshMetrics();
    await refreshGraphView();
  });
  floorSelect?.addEventListener('change', async () => {
    selection.floor = floorSelect.value || null;
    selection.room = null; selection.roomLabel = null; selection.roomId = null; selectionConfirmed = false; graphLevel='rooms';
    selection.devices = [];
    selection.zonesList = [];
    currentScopeDevices = [];
    currentScopeZones = [];
    selection.deviceZoneMap = {};
    syncDropdownsFromSelection();
    renderScopePill();
    await populateZones(selection.building, selection.floor);
    syncDropdownsFromSelection();
    refreshMetrics();
    await refreshGraphView();
  });
  zoneSelect?.addEventListener('change', async () => {
    selection.room = zoneSelect.value || null;
    selection.roomLabel = zoneSelect.selectedIndex >= 0 ? zoneSelect.options[zoneSelect.selectedIndex]?.text || selection.room : selection.room;
    selection.roomId = null;
    if (selection.room) {
      try {
        const z = lastGraphNodes.find(n => n.nodeType === 'Zone' && (String(n.name) === String(selection.room) || String(n.roomId) === String(selection.room)));
        if (z && z.roomId != null) selection.roomId = String(z.roomId);
      } catch {}
    }
    selectionConfirmed = false; graphLevel='devices';
    selection.devices = [];
    selection.deviceZoneMap = {};
    currentScopeDevices = [];
    syncDropdownsFromSelection();
    renderScopePill();
    await populateDevices(selection.building, selection.floor, selection.room);
    syncDropdownsFromSelection();
    refreshMetrics();
    await refreshGraphView();
  });
  deviceSelect?.addEventListener('change', async () => {
  
    refreshMetrics();
  });


  let tenantSelect = document.getElementById('tenant-select');
  if (!tenantSelect) {
    tenantSelect = document.createElement('select');
    tenantSelect.id = 'tenant-select';
    tenantSelect.style.width = '100%';
    tenantSelect.style.margin = '0 0 8px 0';
    tenantSelect.innerHTML = '<option value="">All tenants…</option>';
    if (sidebar) sidebar.insertBefore(tenantSelect, sidebar.firstChild);
  }
 
  try {
    const t = await fetchJSON('/api/tenants');
    const tenants = (t.tenants || []).sort();
    tenantSelect.innerHTML = '<option value="">All tenants…</option>' + tenants.map(name => `<option value="${name}">${name}</option>`).join('');
  } catch {}
  tenantSelect.addEventListener('change', async () => {
    selection.tenant = tenantSelect.value || null;

    selection.building = null; selection.floor = null; selection.room = null; selection.roomLabel = null; selection.roomId = null; graphLevel = 'buildings'; selectionConfirmed = false;
    if (buildingSelect) buildingSelect.innerHTML = '<option value="">Select building…</option>';
    if (floorSelect) floorSelect.innerHTML = '<option value="">Select floor…</option>';
    if (zoneSelect) zoneSelect.innerHTML = '<option value="">Select zone…</option>';
    if (deviceSelect) deviceSelect.innerHTML = '<option value="">Select device…</option>';
    selection.devices = [];
    selection.zonesList = [];
    selection.floorsList = [];
    selection.deviceZoneMap = {};
    currentScopeDevices = [];
    currentScopeZones = [];
    currentScopeFloors = [];
    invalidateScopeCache();
    renderScopePill();
    await populateBuildings();
    refreshMetrics();
    await refreshGraphView();
  });

  function renderScopePill() {
    const parts = [];
    if (selection.tenant) parts.push(`Tenant: ${selection.tenant}`);
    if (selection.building) parts.push(`Building: ${selection.building}`);
    if (selection.floor) parts.push(`Floor: ${selection.floor}`);
    if (selection.room) {
      let rlabel = selection.room;
      try {
        const z = lastGraphNodes.find(n => n.nodeType==='Zone' && (String(n.name)===String(selection.room) || String(n.roomId)===String(selection.room)));
        if (z && z.name) rlabel = z.name;
        if (z && z.roomId != null) selection.roomId = String(z.roomId);
      } catch {}
      selection.roomLabel = rlabel;
      parts.push(`Room: ${rlabel}`);
    } else {
      selection.roomLabel = null;
      selection.roomId = null;
    }
    if (scopePillEl) scopePillEl.textContent = parts.length ? (selectionConfirmed ? '✔ ' : '') + parts.join(' · ') : 'No scope selected';
    updateScopeControls();
  }

  function ensureMetricsDropdown() {
    let dd = document.getElementById('metrics-dropdown');
    if (!dd) {
      dd = document.createElement('select');
      dd.id = 'metrics-dropdown';
      dd.style.width = '100%';
      dd.style.margin = '0 0 8px 0';
      dd.innerHTML = '<option value="">Select a metric…</option>';
      sidebar.insertBefore(dd, metricsEl);
      dd.addEventListener('change', async () => {
        const v = dd.value;
        if (!v) return;
        inputEl.value = v;
        metricsEl.style.display = '';
        const room = selection.room || '';
        const isScope = (room === 'ALL') || !!selection.building || !!selection.floor || (!!selection.room && !room);
        const startTs = readInputTs(startEl);
        const endTs = readInputTs(endEl);
        const startParam = normalizeTimestamp(startTs);
        const endParam = normalizeTimestamp(endTs);
        try {
          if (!room || room === 'ALL' || selection.building || selection.floor || selection.tenant) {
           
            const params = [
              selection.tenant ? `tenant=${encodeURIComponent(selection.tenant)}` : '',
              selection.building ? `building=${encodeURIComponent(selection.building)}` : '',
              selection.floor ? `floor=${encodeURIComponent(selection.floor)}` : '',
              selection.room && room !== 'ALL' ? `zone=${encodeURIComponent(selection.room)}` : '',
              `field=${encodeURIComponent(v)}`,
              startParam != null ? `start=${encodeURIComponent(startParam)}` : '',
              endParam != null ? `end=${encodeURIComponent(endParam)}` : '',
              `limit=0`
            ].filter(Boolean).join('&');
            const resp = await fetchJSON(`/api/scope/series?${params}`);
            const rows = Array.isArray(resp.rows) ? resp.rows : [];
            const header = `<div class=\"series-header\"><strong>${escapeHtml(v)}</strong> in scope ${resp.scope && resp.scope.building ? `(Building ${escapeHtml(resp.scope.building)})` : ''} (${rows.length} rows)</div>`;
            const table = ['<table class=\"series-table\">','<thead><tr><th>ts</th><th>device</th><th>',escapeHtml(v),'</th></tr></thead><tbody>',rows.map(r => `<tr><td>${formatTs(r.ts)}</td><td>${escapeHtml(r.device||'')}</td><td>${r.value}</td></tr>`).join(''),'</tbody></table>'].join('');
            metricsEl.innerHTML = `<div class=\"series-container\">${header}${table}</div>`;
          } else {
            const qs = [
              `room=${encodeURIComponent(room)}`,
              `field=${encodeURIComponent(v)}`,
              startParam != null ? `start=${encodeURIComponent(startParam)}` : '',
              endParam != null ? `end=${encodeURIComponent(endParam)}` : ''
            ].filter(Boolean).join('&');
            const res = await fetchJSON(`/api/series?${qs}`);
            const rows = res.data || [];
            const header = `<div class=\"series-header\"><strong>${escapeHtml(res.field)}</strong> from <em>${escapeHtml(res.table)}</em> (${rows.length} rows)</div>`;
            const table = ['<table class=\"series-table\">','<thead><tr><th>ts</th><th>',escapeHtml(res.field),'</th></tr></thead><tbody>',rows.map(p => `<tr><td>${formatTs(p[0])}</td><td>${p[1]}</td></tr>`).join(''),'</tbody></table>'].join('');
            metricsEl.innerHTML = `<div class=\"series-container\">${header}${table}</div>`;
          }
        } catch (e) { console.error(e); }
      });
    }
    return dd;
  }



  const now = new Date();
  const startInit = new Date(now);
  startInit.setHours(0, 0, 0, 0);
  startEl.value = isoToLocalInput(startInit.toISOString());
  endEl.value = isoToLocalInput(now.toISOString());

 

  function fmtDate(ts) { return formatTs(ts); }

  async function refreshMetrics() {
    metricsEl.innerHTML = 'Loading…';
    const room = selection.room || 'ALL';
    if (!room) { metricsEl.textContent = 'Select a room'; return; }
    const deviceSet = new Set();
    const deviceDisplay = new Map();
    const deviceZoneMapObj = {};
    const zoneSet = new Set();
    const floorSet = new Set();
    try {
      const startMs = readInputTs(startEl);
      const endMs = readInputTs(endEl);
      const s = normalizeTimestamp(startMs);
      const e = normalizeTimestamp(endMs);
      let meta = null;
      const scopeParams = [
        selection.tenant ? `tenant=${encodeURIComponent(selection.tenant)}` : '',
        selection.building ? `building=${encodeURIComponent(selection.building)}` : '',
        selection.floor ? `floor=${encodeURIComponent(selection.floor)}` : '',
        selection.room && room !== 'ALL' ? `zone=${encodeURIComponent(selection.room)}` : '',
        s != null ? `start=${encodeURIComponent(s)}` : '',
        e != null ? `end=${encodeURIComponent(e)}` : ''
      ].filter(Boolean);
      const hasScopeFilters = scopeParams.some((p) => /^tenant=|^building=|^floor=|^zone=/.test(p));
      if (hasScopeFilters) {
        try {
          meta = await fetchJSON(`/api/scope/metrics?${scopeParams.join('&')}`);
        } catch (err) {
          console.warn('[metrics] scope fetch failed, falling back to room meta', err);
        }
      }
      if (!meta) {
        const queryParts = [
          `room=${encodeURIComponent(room)}`,
          s != null ? `start=${encodeURIComponent(s)}` : '',
          e != null ? `end=${encodeURIComponent(e)}` : '',
          selection.building ? 'building='+encodeURIComponent(selection.building) : '',
          selection.floor ? 'floor='+encodeURIComponent(selection.floor) : ''
        ].filter(Boolean);
        meta = await fetchJSON(`/api/meta?${queryParts.join('&')}`);
      }
      metricsEl.innerHTML = '';


      const dd = ensureMetricsDropdown();
  const fieldSet = new Set();
  const cov = meta && meta.coverage ? meta.coverage : {};
      currentScopeDevices = [];
      currentScopeZones = [];
      currentScopeFloors = [];

      const captureDevice = (d, zoneName = null) => {
        if (!d) return;
        const id = typeof d === 'string' ? d : (d.id || d.deviceId || d.name);
        if (!id) return;
        const key = String(id);
        deviceSet.add(key);
        if (typeof d === 'string') {
          deviceDisplay.set(key, d);
        } else {
          const label = d.name || d.displayName || key;
          deviceDisplay.set(key, label);
        }
        if (zoneName && !deviceZoneMapObj[key]) {
          deviceZoneMapObj[key] = String(zoneName);
        } else if (!deviceZoneMapObj[key]) {
          deviceZoneMapObj[key] = null;
        }
      };

      if (Array.isArray(meta?.deviceIndex)) meta.deviceIndex.forEach(captureDevice);
      else if (Array.isArray(meta?.devices)) meta.devices.forEach(captureDevice);
      if (Array.isArray(meta?.metrics) && meta.metrics.length) {
        meta.metrics.forEach(f => { if (f !== 'ts') fieldSet.add(f); });
      }
    
      if (!fieldSet.size && meta && meta.byZone) {
        Object.values(meta.byZone).forEach(arr => (arr||[]).forEach(f => { if (f !== 'ts') fieldSet.add(f); }));
      }
      if (!fieldSet.size && meta && meta.byFloor) {
        Object.values(meta.byFloor).forEach(arr => (arr||[]).forEach(f => { if (f !== 'ts') fieldSet.add(f); }));
      }
     
      if (!fieldSet.size) {
        Object.values(meta.tables || {}).forEach(info => { (info.fields || []).forEach(f => { if (f !== 'ts') fieldSet.add(f); }); });
      }
      const opts = [''].concat(Array.from(fieldSet).sort());
      dd.innerHTML = opts.map(v => {
        if (!v) return '<option value="">Select a metric…</option>';
        const z = Array.isArray(cov[v]?.zones) ? cov[v].zones.length : 0;
        const f = Array.isArray(cov[v]?.floors) ? cov[v].floors.length : 0;
        const label = (z||f) ? `${v} (${z} zones, ${f} floors)` : v;
        return `<option value="${v}">${label}</option>`;
      }).join('');
   
      if (!window._metricsInit) {
        window._metricsInit = true;
    
        dd.style.display = '';
      }

      try {
        const groups = Array.isArray(meta?.groups) ? meta.groups : [];
        const title = document.createElement('div');
        const count = Array.isArray(meta?.devices) ? meta.devices.length : (meta?.deviceIndex?.length || 0);
        title.className = 'series-header';
        title.innerHTML = `<strong>Scope extract</strong> ${count ? `(${count} devices)` : ''}`;
        metricsEl.appendChild(title);
        if (groups.length) {
          const wrap = document.createElement('div');
          wrap.className = 'series-container';
          const ulB = document.createElement('ul');
          ulB.style.margin = '0'; ulB.style.paddingLeft = '16px';
          for (const g of groups) {
            const liB = document.createElement('li');
            liB.textContent = String(g.building || '(Unknown Building)');
            const ulF = document.createElement('ul'); ulF.style.paddingLeft = '16px';
            for (const f of (g.floors || [])) {
              const liF = document.createElement('li');
              liF.textContent = String(f.floor || '(Unknown Floor)');
              if (f.floor) floorSet.add(String(f.floor));
              const ulZ = document.createElement('ul'); ulZ.style.paddingLeft = '16px';
              for (const z of (f.zones || [])) {
                const zoneLabel = String(z.zone || '(Unknown Zone)');
                const liZ = document.createElement('li');
                liZ.textContent = zoneLabel;
                if (z.zone) zoneSet.add(zoneLabel);
                const ulD = document.createElement('ul'); ulD.style.paddingLeft = '16px';
                for (const d of (z.devices || [])) {
                  const liD = document.createElement('li');
                  const devName = d.name || d.id || '';
                  const type = d.type ? ` (${d.type})` : '';
                  const metrics = Array.isArray(d.metrics) && d.metrics.length ? ` — metrics: ${d.metrics.slice(0, 20).join(', ')}` : '';
                  liD.textContent = `${devName}${type}${metrics}`;
                  captureDevice(d, zoneLabel);
                  ulD.appendChild(liD);
                }
                if (ulD.childElementCount) liZ.appendChild(ulD);
                ulZ.appendChild(liZ);
              }
              if (ulZ.childElementCount) liF.appendChild(ulZ);
              ulF.appendChild(liF);
            }
            if (ulF.childElementCount) liB.appendChild(ulF);
            ulB.appendChild(liB);
          }
          wrap.appendChild(ulB);
          metricsEl.appendChild(wrap);
        } else {
          if (deviceSet.size) {
            const wrap = document.createElement('div');
            wrap.className = 'series-container';
            const ul = document.createElement('ul');
            ul.style.margin = '0'; ul.style.paddingLeft = '16px';
            Array.from(deviceSet).slice(0, 50).forEach((d) => {
              const li = document.createElement('li');
              const label = deviceDisplay.get(d) || d;
              li.textContent = label;
              ul.appendChild(li);
            });
            wrap.appendChild(ul);
            metricsEl.appendChild(wrap);
          } else {
            const note = document.createElement('div');
            note.style.color = '#94a3b8';
            note.textContent = 'No scope grouping available';
            metricsEl.appendChild(note);
          }
        }
      } catch (e) { console.error('render scope extract failed', e); }

      currentScopeDevices = Array.from(deviceSet);
      currentScopeZones = Array.from(zoneSet);
      currentScopeFloors = Array.from(floorSet);
      selection.devices = currentScopeDevices.slice();
      selection.zonesList = currentScopeZones.slice();
      selection.floorsList = currentScopeFloors.slice();
      if (!selection.zonesList.length && selection.roomLabel) selection.zonesList = [selection.roomLabel];
      if (!selection.floorsList.length && selection.floor) selection.floorsList = [selection.floor];
      selection.deviceZoneMap = deviceZoneMapObj;
      syncDropdownsFromSelection();
    } catch {
      metricsEl.textContent = 'Failed to load metrics';
      currentScopeDevices = [];
      currentScopeZones = [];
      currentScopeFloors = [];
      selection.devices = [];
      selection.zonesList = [];
      selection.floorsList = [];
      selection.deviceZoneMap = {};
      syncDropdownsFromSelection();
    }
  }

  async function send() {
    if (sending) return;
    const content = (inputEl.value || '').trim();
    if (!content) {
      updateSendButtonState();
      return;
    }

    const room = selection.room || '';
    const startMs = readInputTs(startEl);
    const endMs = readInputTs(endEl);

    sending = true;
    inputEl.value = '';
    updateSendButtonState();

    messages.push({ role: 'user', content });
    appendMessage(chatEl, 'user', content);

    const thinkingEl = appendMessage(chatEl, 'assistant', 'Thinking…');

    const payload = { conversationId, messages, room, range: { start: startMs ?? null, end: endMs ?? null } };
    if (selection.tenant || selection.building || selection.floor || selection.room) {
      const scopeSelection = {
        tenant: selection.tenant || null,
        building: selection.building || null,
        floor: selection.floor || null,
        room: selection.roomLabel || selection.room || null,
        roomId: selection.roomId || null,
        device: (typeof deviceSelect !== 'undefined' && deviceSelect) ? (deviceSelect.value || null) : null,
        devices: selection.devices.slice(),
        zones: selection.zonesList.slice(),
        floors: selection.floorsList.slice(),
        deviceZones: selection.deviceZoneMap,
        labels: {
          tenant: selection.tenant || null,
          building: selection.building || null,
          floor: selection.floor || null,
          room: selection.roomLabel || selection.room || null
        }
      };
      payload.selection = scopeSelection;
      payload.scope = scopeSelection;
    }

    let res;
    try {
      res = await fetchJSON('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch (err) {
      res = { error: err?.message || String(err) };
    } finally {
      if (thinkingEl && thinkingEl.parentNode) thinkingEl.parentNode.removeChild(thinkingEl);
    }

    if (res && res.conversationId) {
      setConversationId(res.conversationId);
    }

    if (!res || res.error) {
      const errorMsg = 'Error: ' + (res?.error || 'unknown');
      messages.push({ role: 'assistant', content: errorMsg });
      appendMessage(chatEl, 'assistant', errorMsg);
      sending = false;
      updateSendButtonState();
      return;
    }

    messages.push(res.message);

    const answer = res.message?.content || '';
    const chart = res.chart || null; 
    appendMessage(chatEl, 'assistant', answer, chart);

    if (Array.isArray(res.extras)) {
      for (const ex of res.extras) {
        const exMsg = ex?.message?.content || null;
        const exChart = ex?.chart || null;
        if (exMsg || exChart) appendMessage(chatEl, 'assistant', exMsg, exChart);
      }
    }

    if (Array.isArray(res.extras) && queryLevelEl) {
      const lvl = extractQueryLevel(res.extras);
      setQueryLevel(lvl);
    }

    sending = false;
    updateSendButtonState();
  }


  const messages = [];

  function extractQueryLevel(extras) {
    try {
      for (const ex of extras) {
        const txt = ex && ex.message && ex.message.content;
        if (!txt) continue;
        const m = String(txt).match(/\bQuery\s+(L[1-4])\b/i);
        if (m) return m[1].toUpperCase();
      }
    } catch {}
    return null;
  }

  function setQueryLevel(lvl) {
    if (!queryLevelEl) return;
    queryLevelEl.textContent = lvl ? `Query: ${lvl}` : 'Query: —';
    queryLevelEl.classList.remove('level-l1','level-l2','level-l3','level-l4');
    if (!lvl) return;
    const c = lvl.toLowerCase();
    if (c === 'l1') queryLevelEl.classList.add('level-l1');
    else if (c === 'l2') queryLevelEl.classList.add('level-l2');
    else if (c === 'l3') queryLevelEl.classList.add('level-l3');
    else if (c === 'l4') queryLevelEl.classList.add('level-l4');
  }

  async function refreshStatus() {
    try {
      const st = await fetchJSON('/api/status');
      const neo = st.neo4j || {}; const vec = st.chroma || {};
      const neoOk = !!neo.connected;
      const chromaOk = !!vec.configured;
      const neoColor = neoOk ? '#22c55e' : '#ef4444';
      const chromaColor = chromaOk ? '#22c55e' : '#ef4444';
      statusEl.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <span><span style="color:${neoColor}; font-weight:600;">${neoOk ? '✔' : '✘'}</span> Neo4j</span>
          <span style="font-size: 12px; color: #94a3b8;">nodes: ${neo.nodes ?? '—'} · rels: ${neo.relationships ?? '—'} · tenants: ${neo.tenants ?? '—'} · zones: ${neo.zones ?? '—'} · devices: ${neo.devices ?? '—'}</span>
        </div>
        <div style="margin-top:6px; display:flex; justify-content:space-between; align-items:center;">
          <span><span style="color:${chromaColor}; font-weight:600;">${chromaOk ? '✔' : '✘'}</span> Chroma</span>
          <span style="font-size: 12px; color: #94a3b8;">${vec.collections ?? '—'} collections</span>
        </div>
      `;
    } catch (e) {
      statusEl.textContent = 'Status unavailable';
    }
  }


  async function refreshGraphView() {
    const target = document.getElementById(graphViewChartId);
    if (!target) {
      console.warn('[graph] container missing');
      return;
    }

    try {
      const g = await fetchJSON(`/api/graph/full${selection.tenant ? ('?tenant='+encodeURIComponent(selection.tenant)) : ''}`);
      const allLinks = (g.links || []).map(e => [e.source, e.target, e.rel]);
      const colorMap = { Building: '#3b82f6', Floor: '#f59e0b', Zone: '#22c55e', Device: '#8b5cf6', TelemetryKey: '#14b8a6', MetricType: '#14b8a6' };
      const allNodes = (g.nodes || []).map(n => ({
        id: n.id,
        name: n.name,
        roomId: n.roomId || null,
        nodeType: n.nodeType || n.label,
        x: n.x,
        y: n.y,
        color: colorMap[n.nodeType || n.label],
        cloudId: n.cloudId || null,
        hasData: !!n.hasData,
        dataDevices: n.dataDevices || 0
      }));
      const nodeByIdAll = new Map(allNodes.map(n => [n.id, n]));

      function filterView() {
        const nodes = [];
        const links = [];
        const addNode = (id) => { if (!nodes.find(n => n.id === id)) { const nn = allNodes.find(n => n.id === id); if (nn) nodes.push({ ...nn }); } };
        const addLink = (a, b, rel) => { if (a && b) links.push([a, b, rel]); };
        const buildings = allNodes.filter(n => n.nodeType === 'Building');
        const floors = allNodes.filter(n => n.nodeType === 'Floor');
        const zones = allNodes.filter(n => n.nodeType === 'Zone');
        if (graphLevel === 'buildings') {
          buildings.forEach(n => addNode(n.id));
        } else if (graphLevel === 'floors' && selection.building) {
          const b = buildings.find(n => n.name === selection.building);
          if (b) addNode(b.id);
          allLinks.filter(l => l[2] === 'LOCATED_IN_BUILDING').forEach(([from, to, rel]) => {
            if (!(b && to === b.id)) return;
            const fromNode = allNodes.find(n => n.id === from);
            if (fromNode && fromNode.nodeType === 'Floor') { addNode(from); addLink(from, to, rel); }
          });
        } else if (graphLevel === 'rooms' && selection.building && selection.floor) {
          const b = buildings.find(n => n.name === selection.building);
          const f = floors.find(n => n.name === selection.floor);
          if (b) addNode(b.id);
          if (f) { addNode(f.id); addLink(f.id, b ? b.id : null, 'LOCATED_IN_BUILDING'); }
          allLinks.filter(l => l[2] === 'BELONGS_TO_FLOOR').forEach(([from, to, rel]) => { if (f && to === f.id) { addNode(from); addLink(from, to, rel); } });
        } else if (graphLevel === 'devices' && selection.room) {
          let z = null;
          if (selection.roomId != null) {
            z = zones.find(n => String(n.roomId || '') === String(selection.roomId));
          }
          if (!z) {
            z = zones.find(n => String(n.name || '') === String(selection.room));
          }
          if (!z) {
            z = zones.find(n => String(n.roomId || '') === String(selection.room));
          }
          if (!z) {
            const candidateZones = zones.filter(n => String(n.name || '') === String(selection.room));
            if (candidateZones.length === 1) z = candidateZones[0];
            else if (candidateZones.length > 1 && selection.floor) {
              const floorNode = floors.find(fn => String(fn.name || '') === String(selection.floor));
              if (floorNode) {
                const fId = floorNode.id;
                z = candidateZones.find(zn => allLinks.some(l => l[0] === zn.id && l[1] === fId && l[2] === 'BELONGS_TO_FLOOR')) || candidateZones[0];
              } else {
                z = candidateZones[0];
              }
            }
          }
          if (z) {
            addNode(z.id);
            const zToFloor = allLinks.find(l => l[0] === z.id && l[2] === 'BELONGS_TO_FLOOR');
            if (zToFloor) { addNode(zToFloor[1]); addLink(zToFloor[0], zToFloor[1], zToFloor[2]); }
            const floorId = zToFloor ? zToFloor[1] : null;
            if (floorId) {
              const fToB = allLinks.find(l => l[0] === floorId && l[2] === 'LOCATED_IN_BUILDING');
              if (fToB) { addNode(fToB[1]); addLink(fToB[0], fToB[1], fToB[2]); }
            } else {
              const zToB = allLinks.find(l => l[0] === z.id && l[2] === 'LOCATED_IN_BUILDING');
              if (zToB) { addNode(zToB[1]); addLink(zToB[0], zToB[1], zToB[2]); }
            }
            allLinks.filter(l => l[2] === 'LOCATED_IN_ZONE').forEach(([from, to, rel]) => { if (to === z.id) { addNode(from); addLink(from, to, rel); } });
          }
        } else {
          allNodes.forEach(n => { if (n.nodeType !== 'Device' || (n.cloudId && n.cloudId.length)) addNode(n.id); });
          allLinks.forEach(([a, b, rel]) => addLink(a, b, rel));
        }
        let outNodes = nodes;
        let outLinks = links;
        if (!showTelemetryKeys) {
          const hidden = new Set(nodes.filter(n => n.nodeType === 'TelemetryKey').map(n => n.id));
          outNodes = nodes.filter(n => !hidden.has(n.id));
          outLinks = links.filter(([a, b]) => !hidden.has(a) && !hidden.has(b));
        }
        return { nodes: outNodes, links: outLinks };
      }

      const { nodes, links } = filterView();
      lastGraphNodes = nodes.slice();

      const buildingNode = selection.building ? nodes.find(n => n.nodeType === 'Building' && n.name === selection.building) : nodes.find(n => n.nodeType === 'Building');
      const dx = buildingNode && typeof buildingNode.x === 'number' ? -buildingNode.x : 0;
      const dy = buildingNode && typeof buildingNode.y === 'number' ? -buildingNode.y : 0;
      const positioned = nodes.map(n => ({ ...n, x: (typeof n.x === 'number' ? n.x : 0) + dx, y: (typeof n.y === 'number' ? n.y : 0) + dy }));

      const nodePoints = positioned.map(n => ({
        x: n.x || 0,
        y: n.y || 0,
        id: n.id,
        name: n.name,
        nodeType: n.nodeType,
        roomId: n.roomId,
        color: n.color,
        marker: n.nodeType === 'Building'
          ? (n.hasData ? { radius: 11, lineWidth: 3, lineColor: '#22c55e' } : { radius: 10 })
          : (n.nodeType === 'Zone' ? { radius: 7 } : { radius: 5 })
      }));
      const nodeById = new Map(nodePoints.map(p => [p.id, p]));
      const linkSeg = [];
      for (const [a, b] of links) {
        const A = nodeById.get(a); const B = nodeById.get(b);
        if (!A || !B) continue;
        linkSeg.push([A.x, A.y]);
        linkSeg.push([B.x, B.y]);
        linkSeg.push([null, null]);
      }

      const xs = nodePoints.map(p => p.x).filter(Number.isFinite);
      const ys = nodePoints.map(p => p.y).filter(Number.isFinite);
      const minX = Math.min(...xs, -100);
      const maxX = Math.max(...xs, 100);
      const minY = Math.min(...ys, -100);
      const maxY = Math.max(...ys, 100);

      const handleGraphPointClick = async (point) => {
        try {
          if (point.nodeType === 'Building') {
            selection.building = String(point.name || '');
            selection.floor = null;
            selection.room = null;
            selection.roomLabel = null;
            selection.roomId = null;
            selectionConfirmed = false;
            selection.deviceZoneMap = {};
            graphLevel = 'floors';
            syncDropdownsFromSelection();
            await populateFloors(selection.building);
            syncDropdownsFromSelection();
          } else if (point.nodeType === 'Floor') {
            const floorName = String(point.name || '');
            if (!selection.building) {
              const link = allLinks.find(l => l[0] === point.id && l[2] === 'LOCATED_IN_BUILDING');
              if (link) {
                const buildingNode = nodeByIdAll.get(link[1]);
                if (buildingNode?.name) selection.building = buildingNode.name;
              }
            }
            selection.floor = floorName;
            selection.room = null;
            selection.roomLabel = null;
            selection.roomId = null;
            selectionConfirmed = false;
            selection.deviceZoneMap = {};
            graphLevel = 'rooms';
            syncDropdownsFromSelection();
            if (selection.building) {
              await populateFloors(selection.building);
              syncDropdownsFromSelection();
            }
            await populateZones(selection.building, selection.floor);
            syncDropdownsFromSelection();
          } else if (point.nodeType === 'Zone') {
            const zoneName = String(point.name || point.roomId || '').trim();
            const zoneRoomId = point.roomId != null ? String(point.roomId) : (zoneName || null);
            const floorLink = allLinks.find(l => l[0] === point.id && l[2] === 'BELONGS_TO_FLOOR');
            if (floorLink) {
              const floorNode = nodeByIdAll.get(floorLink[1]);
              if (floorNode?.name) selection.floor = floorNode.name;
              const buildingLink = allLinks.find(l => l[0] === floorLink[1] && l[2] === 'LOCATED_IN_BUILDING');
              if (buildingLink) {
                const buildingNode = nodeByIdAll.get(buildingLink[1]);
                if (buildingNode?.name) selection.building = buildingNode.name;
              }
            }
            selection.room = zoneName;
            selection.roomLabel = zoneName;
            selection.roomId = zoneRoomId;
            selectionConfirmed = false;
            graphLevel = 'devices';
            syncDropdownsFromSelection();
            if (selection.building) {
              await populateFloors(selection.building);
              syncDropdownsFromSelection();
            }
            if (selection.floor) {
              await populateZones(selection.building, selection.floor);
              syncDropdownsFromSelection();
            }
            await populateDevices(selection.building, selection.floor, selection.room);
            syncDropdownsFromSelection();
          } else if (point.nodeType === 'Device') {
            const rel = allLinks.find(l => l[0] === point.id && l[2] === 'LOCATED_IN_ZONE');
            const zoneNode = rel ? nodeByIdAll.get(rel[1]) : null;
            if (zoneNode) {
              await handleGraphPointClick({ ...zoneNode, nodeType: zoneNode.nodeType, roomId: zoneNode.roomId });
              return;
            }
          }

          syncDropdownsFromSelection();
          renderScopePill();
          updateSelectedRangeDisplay();
          await refreshMetrics();
          setTimeout(() => { refreshGraphView(); }, 0);
        } catch (err) {
          console.error('[graph] selection sync failed', err);
        }
      };

      target.innerHTML = '';
      Highcharts.chart(target, {
        chart: { backgroundColor: 'transparent', animation: false },
        title: { text: null },
        xAxis: { min: minX - 60, max: maxX + 60, visible: false },
        yAxis: { min: minY - 60, max: maxY + 60, visible: false },
        accessibility: { enabled: false },
        tooltip: { formatter() { return this.point && this.point.nodeType ? `${this.point.nodeType}: ${this.point.name}` : null; } },
        series: [
          { type: 'line', data: linkSeg, color: '#64748b', enableMouseTracking: false, lineWidth: 1, marker: { enabled: false } },
          {
            type: 'scatter',
            data: nodePoints,
            dataLabels: {
              enabled: true,
              formatter() {
                const point = this.point || {};
                return point.name || point.roomId || '';
              },
              style: { color: '#cbd5e1', textOutline: 'none' }
            },
            cursor: 'pointer',
            point: {
              events: {
                click: function () {
                  Promise.resolve(handleGraphPointClick(this)).catch(err => console.error('[graph] click handler error', err));
                }
              }
            }
          }
        ],
        credits: { enabled: false }
      });
    } catch (e) {
      console.error('[graph] render failed', e);
      target.innerHTML = '<div style="color:#94a3b8">Graph view unavailable</div>';
      lastGraphNodes = [];
    }
  }

  if (sendBtn) sendBtn.addEventListener('click', send);
  inputEl.addEventListener('input', updateSendButtonState);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      send();
    }
  });
 
  startEl.addEventListener('change', () => { updateSelectedRangeDisplay(); refreshMetrics(); });
  endEl.addEventListener('change', () => { updateSelectedRangeDisplay(); refreshMetrics(); });

  updateSelectedRangeDisplay();
  await populateBuildings();
  syncDropdownsFromSelection();
  await refreshGraphView();
  refreshMetrics();
  refreshStatus();
  setInterval(refreshStatus, 30000);

  if (confirmBtn) confirmBtn.addEventListener('click', () => {
    selectionConfirmed = !!(selection.building || selection.floor || selection.room);
    renderScopePill();
    refreshMetrics();
  });
  if (clearBtn) clearBtn.addEventListener('click', async () => {
    selection.building=null; selection.floor=null; selection.room=null; selectionConfirmed=false; graphLevel='buildings';
    if (buildingSelect) buildingSelect.value = '';
    if (floorSelect) floorSelect.innerHTML = '<option value="">Select floor…</option>';
    if (zoneSelect) zoneSelect.innerHTML = '<option value="">Select zone…</option>';
    if (deviceSelect) deviceSelect.innerHTML = '<option value="">Select device…</option>';
    invalidateScopeCache();
    selection.devices = [];
    selection.zonesList = [];
    selection.floorsList = [];
    selection.roomLabel = null;
    selection.roomId = null;
    selection.deviceZoneMap = {};
    currentScopeDevices = [];
    currentScopeZones = [];
    currentScopeFloors = [];
    clearAgentCharts();
    syncDropdownsFromSelection();
    renderScopePill();
    await populateBuildings();
    refreshMetrics();
    await refreshGraphView();
  });
}

async function loadRoomMetrics(room) {

  let url = `/data/room/${room}.json`;
  let data;
  try {
    const res = await fetch(url);
    data = await res.json();
  } catch {

    try {
      const res = await fetch(`/data/${room}.json`);
      data = await res.json();
    } catch {
      const res = await fetch('/data.json');
      data = await res.json();
    }
  }

  const metrics = new Set();
  for (const table of Object.values(data)) {
    if (Array.isArray(table) && table.length > 0) {
      Object.keys(table[0]).forEach(key => {
        if (key !== 'ts') metrics.add(key);
      });
    }
  }
  return Array.from(metrics);
}


init();
