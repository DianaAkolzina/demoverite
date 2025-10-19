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

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Very small, safe-ish Markdown renderer for basic formatting
function markdownToHtml(md) {
  let s = escapeHtml(md || '');
  // code blocks ```
  s = s.replace(/```([\s\S]*?)```/g, (m, code) => `<pre><code>${code.replace(/\n/g,'<br>')}</code></pre>`);
  // inline code `code`
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  // bold **text**
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // italics *text*
  s = s.replace(/(^|\s)\*([^*]+)\*/g, '$1<em>$2</em>');
  // headings #, ## (limit to start of line)
  s = s.replace(/^###\s+(.*)$/gm, '<h3>$1</h3>')
       .replace(/^##\s+(.*)$/gm, '<h2>$1</h2>')
       .replace(/^#\s+(.*)$/gm, '<h1>$1</h1>');
  // unordered lists - or * at line start
  // Convert blocks of list items to <ul>
  s = s.replace(/(?:^|\n)([-*] .*(?:\n[-*] .*)*)/g, (m, block) => {
    if (!/^[-*] /.test(block)) return m;
    const items = block.split(/\n/).map(l => l.replace(/^[-*]\s+/, '').trim()).filter(Boolean);
    if (!items.length) return m;
    return '\n<ul>' + items.map(it => `<li>${it}</li>`).join('') + '</ul>';
  });
  // line breaks
  s = s.replace(/\n/g, '<br>');
  return s;
}

function appendMessage(container, role, text, chartOptions) {
  const wrap = document.createElement('div');
  // Align with CSS in index.html which styles .message.bot and .message.user
  wrap.className = 'message ' + (role === 'user' ? 'user' : 'bot');
  // Render markdown to HTML for prettier assistant messages
  if (role === 'assistant' || role === 'bot') {
    wrap.innerHTML = markdownToHtml(text || '');
  } else {
    wrap.textContent = text || '';
  }
  container.appendChild(wrap);
  if (chartOptions) {
    const chartWrap = document.createElement('div');
    const id = nextId();
    chartWrap.id = 'chart-' + id;
    chartWrap.className = 'chart-msg';
    container.appendChild(chartWrap);
    setTimeout(() => {
      try { Highcharts.chart(chartWrap.id, chartOptions); } catch {}
    }, 0);
  }
  container.scrollTop = container.scrollHeight;
}

async function init() {
  // Room selection is now driven by graph (no dropdown)
  const startEl = document.getElementById('start');
  const endEl = document.getElementById('end');
  const chatEl = document.getElementById('chat');
  const inputEl = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const metricsEl = document.getElementById('metrics');
  const sidebar = document.querySelector('.sidebar');
  const statusEl = document.getElementById('status-card');
  const queryLevelEl = document.getElementById('query-level');
  const toggleGraphBtn = document.getElementById('toggle-graph');
  const toggleChartsBtn = document.getElementById('toggle-charts');
  // graphSummaryEl removed (no sidebar graph summary)
  const graphViewTitle = document.getElementById('graph-view-title');
  const graphViewChartId = 'graph-view-chart';
  const scopePillEl = document.getElementById('scope-pill');
  const confirmBtn = document.getElementById('confirm-scope');
  const clearBtn = document.getElementById('clear-scope');
  const selection = { building: null, floor: null, room: null };
  window.selection = selection;
  let selectionConfirmed = false;
  let graphLevel = 'buildings';

  // Toggle handlers for visibility
  const graphView = document.getElementById('graph-view');
  const chartsSidebar = document.getElementById('chart-sidebar');
  if (toggleGraphBtn) toggleGraphBtn.addEventListener('click', () => {
    if (!graphView) return;
    const shown = graphView.style.display !== 'none';
    graphView.style.display = shown ? 'none' : 'flex';
    if (!shown) refreshGraphView();
  });
  if (toggleChartsBtn) toggleChartsBtn.addEventListener('click', () => {
    if (!chartsSidebar) return;
    chartsSidebar.classList.toggle('hidden');
  });

  function renderScopePill() {
    const parts = [];
    if (selection.building) parts.push(`Building: ${selection.building}`);
    if (selection.floor) parts.push(`Floor: ${selection.floor}`);
    if (selection.room) parts.push(`Room: ${selection.room}`);
    if (scopePillEl) scopePillEl.textContent = parts.length ? (selectionConfirmed ? '✔ ' : '') + parts.join(' · ') : 'No scope selected';
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
        if (!room) { metricsEl.textContent = 'Select a room from the graph to load metrics.'; return; }
        const start = startEl.value ? new Date(startEl.value).getTime() : '';
        const end = endEl.value ? new Date(endEl.value).getTime() : '';
        try {
          const res = await fetchJSON(`/api/series?room=${encodeURIComponent(room)}&field=${encodeURIComponent(v)}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
          // Keep existing charts intact in the right sidebar
          const rows = res.data || [];
          const maxRows = 2000;
          const shown = rows.slice(-maxRows);
          const header = `<div class=\"series-header\"><strong>${res.field}</strong> from <em>${res.table}</em> (${shown.length} rows)</div>`;
          const table = ['<table class=\"series-table\">','<thead><tr><th>ts</th><th>',res.field,'</th></tr></thead><tbody>',shown.map(p => `<tr><td>${new Date(p[0]).toLocaleString()}</td><td>${p[1]}</td></tr>`).join(''),'</tbody></table>'].join('');
          metricsEl.innerHTML = `<div class=\"series-container\">${header}${table}</div>`;
        } catch (e) {
          console.error(e);
        }
      });
    }
    return dd;
  }

  // No room dropdown to populate

  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  startEl.value = isoToLocalInput(start.toISOString());
  endEl.value = isoToLocalInput(now.toISOString());

  const messages = [];

  function fmtDate(ts) {
    if (ts == null) return '—';
    const d = new Date(ts);
    const y = d.getFullYear();
    const m = String(d.getMonth()+1).padStart(2,'0');
    const day = String(d.getDate()).padStart(2,'0');
    return `${y}/${m}/${day}`;
  }

  async function refreshMetrics() {
    metricsEl.innerHTML = 'Loading…';
    const room = selection.room || 'ALL';
    if (!room) { metricsEl.textContent = 'Select a room'; return; }
    try {
      const s = startEl.value ? new Date(startEl.value).getTime() : '';
      const e = endEl.value ? new Date(endEl.value).getTime() : '';
      const meta = await fetchJSON(`/api/meta?room=${encodeURIComponent(room)}&start=${encodeURIComponent(s)}&end=${encodeURIComponent(e)}`);
      metricsEl.innerHTML = ''


      const dd = ensureMetricsDropdown();
      const fieldSet = new Set();
      Object.values(meta.tables || {}).forEach(info => {
        (info.fields || []).forEach(f => { if (f !== 'ts') fieldSet.add(f); });
      });
      const opts = [''].concat(Array.from(fieldSet).sort());
      dd.innerHTML = opts.map(v => v ? `<option value="${v}">${v}</option>` : '<option value="">Select a metric…</option>').join('');
    } catch {
      metricsEl.textContent = 'Failed to load metrics';
    }
  }

  async function send() {
    const room = selection.room || '';
    const start = startEl.value ? new Date(startEl.value).getTime() : null;
    const end = endEl.value ? new Date(endEl.value).getTime() : null;
    const content = inputEl.value.trim();
    if (!content) return;
    inputEl.value = '';
    messages.push({ role: 'user', content });
    appendMessage(chatEl, 'user', content);

    appendMessage(chatEl, 'assistant', 'Thinking…');

    const payload = { messages, room, range: { start, end } };
    if (selection.building || selection.floor || selection.room) payload.selection = selection;
    const res = await fetchJSON('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).catch(e => ({ error: String(e) }));

    // Remove the placeholder last assistant message
    chatEl.removeChild(chatEl.lastChild);

    if (!res || res.error) {
      messages.push({ role: 'assistant', content: 'Error: ' + (res?.error || 'unknown') });
      appendMessage(chatEl, 'assistant', 'Error: ' + (res?.error || 'unknown'));
      return;
    }
    messages.push(res.message);
    if (res.message && res.message.content) {
      // Filter out system prompt/hint text if present
      const answer = res.message.content;
      if (
        !answer.startsWith('MANDATORY:') &&
        !answer.startsWith('CRITICAL ERROR:') &&
        !answer.startsWith('ERROR:') &&
        !answer.includes('You MUST respond') &&
        !answer.includes('Respond ONLY with a valid JSON object')
      ) {
        appendMessage(chatEl, 'assistant', answer, null); // Don't pass chart here
      }
    }

    // Update query level indicator from extras if present
    if (Array.isArray(res.extras) && queryLevelEl) {
      const lvl = extractQueryLevel(res.extras);
      setQueryLevel(lvl);
    }

    // Render chart in sidebar instead of chat
    const { chart } = res;
    if (chart) {
      const chartSidebar = document.getElementById('chart-sidebar');
      const chartWrap = document.createElement('div');
      const id = nextId();
      chartWrap.id = 'chart-' + id;
      chartWrap.className = 'chart-msg';
      chartSidebar.appendChild(chartWrap);
      setTimeout(() => {
        try { Highcharts.chart(chartWrap.id, chart); } catch (e) { console.error(e); }
      }, 0);
      chartSidebar.scrollTop = chartSidebar.scrollHeight;
    }

    // Render any extras (background tool fetches)
    if (Array.isArray(res.extras)) {
      for (const ex of res.extras) {
        if (ex && ex.message && ex.message.content) {
          appendMessage(chatEl, 'assistant', ex.message.content, null);
        }
        if (ex && ex.chart) {
          const chartSidebar = document.getElementById('chart-sidebar');
          const chartWrap = document.createElement('div');
          const id = nextId();
          chartWrap.id = 'chart-' + id;
          chartWrap.className = 'chart-msg';
          chartSidebar.appendChild(chartWrap);
          setTimeout(() => { try { Highcharts.chart(chartWrap.id, ex.chart); } catch (e) { console.error(e); } }, 0);
          chartSidebar.scrollTop = chartSidebar.scrollHeight;
        }
      }
    }
  }

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
      statusEl.innerHTML = `
        <div><b>Neo4j:</b> ${neo.connected ? 'Connected' : 'Not connected'}</div>
        <div style="font-size: 12px; color: ${neo.connected ? '#9ca3af' : '#ef4444'};">nodes: ${neo.nodes ?? '—'}, rels: ${neo.relationships ?? '—'}, tenants: ${neo.tenants ?? '—'}, zones: ${neo.zones ?? '—'}, devices: ${neo.devices ?? '—'}</div>
        <div style="margin-top:6px;"><b>Chroma:</b> ${vec.configured ? 'Configured' : 'Not configured'}</div>
      `;
    } catch (e) {
      statusEl.textContent = 'Status unavailable';
    }
  }

  // Removed small graph summary in sidebar

  // roomToZoneType removed (no longer needed in UI)

  async function refreshGraphView() {
    // Title stays static with buttons
    try {
      const g = await fetchJSON(`/api/graph/full`);
      const allLinks = (g.links || []).map(e => [e.source, e.target, e.rel]);
      const colorMap = { Building: '#3b82f6', Floor: '#f59e0b', Zone: '#22c55e', Device: '#8b5cf6', MetricType: '#14b8a6' };
      const allNodes = (g.nodes || []).map(n => ({ id: n.id, name: n.name, roomId: n.roomId || null, nodeType: n.nodeType || n.label, marker: { radius: n.nodeType==='Building' ? 12 : (n.nodeType==='Zone' ? 9 : 6) }, color: colorMap[n.nodeType || n.label] || undefined }));

      function filterView() {
        const nodes = [];
        const links = [];
        const addNode = (id) => { if (!nodes.find(n => n.id===id)) { const nn = allNodes.find(n=>n.id===id); if (nn) nodes.push(nn);} };
        const addLink = (a,b) => { if (a && b) links.push([a,b]); };
        const buildings = allNodes.filter(n=>n.nodeType==='Building');
        const floors = allNodes.filter(n=>n.nodeType==='Floor');
        const zones = allNodes.filter(n=>n.nodeType==='Zone');
        if (graphLevel==='buildings') {
          buildings.forEach(n=>addNode(n.id));
        } else if (graphLevel==='floors' && selection.building) {
          const b = buildings.find(n=>n.name===selection.building);
          if (b) addNode(b.id);
          allLinks.filter(l=>l[2]==='BELONGS_TO_BUILDING').forEach(([from,to])=>{ if (b && to===b.id) { addNode(from); addLink(from,to);} });
        } else if (graphLevel==='rooms' && selection.building && selection.floor) {
          const b = buildings.find(n=>n.name===selection.building);
          const f = floors.find(n=>n.name===selection.floor);
          if (b) addNode(b.id);
          if (f) { addNode(f.id); addLink(f.id, b?b.id:null); }
          allLinks.filter(l=>l[2]==='BELONGS_TO_FLOOR').forEach(([from,to])=>{ if (f && to===f.id) { addNode(from); addLink(from,to);} });
        } else if (graphLevel==='devices' && selection.room) {
          const z = zones.find(n=>n.roomId===selection.room);
          if (z) addNode(z.id);
          allLinks.filter(l=>l[2]==='LOCATED_IN_ZONE').forEach(([from,to])=>{ if (z && to===z.id) { addNode(from); addLink(from,to);} });
          allLinks.filter(l=>l[2]==='BELONGS_TO_FLOOR').forEach(([from,to])=>{ if (z && from===z.id) { addNode(to); addLink(from,to);} });
          const floorId = nodes.find(n=>n.nodeType==='Floor')?.id;
          if (floorId) allLinks.filter(l=>l[2]==='BELONGS_TO_BUILDING').forEach(([from,to])=>{ if (from===floorId) { addNode(to); addLink(from,to);} });
        } else {
          allNodes.forEach(n=>addNode(n.id));
          allLinks.forEach(([a,b])=>addLink(a,b));
        }
        return { nodes, links };
      }
      const view = filterView();
      const nodes = view.nodes;
      const links = view.links;
      Highcharts.chart(graphViewChartId, {
        chart: { type: 'networkgraph', backgroundColor: 'transparent' },
        title: { text: null },
        tooltip: { formatter() { return `${this.point.nodeType||''}: ${this.point.name||this.point.id}`; } },
        plotOptions: {
          networkgraph: {
            keys: ['from', 'to'],
            layoutAlgorithm: { enableSimulation: true, friction: -0.9, linkLength: 100 }
          },
          series: {
            point: {
              events: {
                click: function () {
                  const p = this;
                  if (p.nodeType === 'Building') {
                    selection.building = p.name; selection.floor = null; selection.room = null; selectionConfirmed = false; graphLevel='floors';
                  } else if (p.nodeType === 'Floor') {
                    selection.floor = p.name; selectionConfirmed = false; graphLevel='rooms';
                  } else if (p.nodeType === 'Zone' && p.roomId) {
                    selection.room = p.roomId; selectionConfirmed = false; graphLevel='devices';
                  } else if (p.nodeType === 'Device') {
                    const rel = links.find(l => l[0]===p.id || l[1]===p.id);
                    const other = rel ? (rel[0]===p.id ? rel[1] : rel[0]) : null;
                    const zone = nodes.find(n => n.id === other && n.nodeType==='Zone');
                    if (zone && zone.roomId) { selection.room = zone.roomId; selectionConfirmed = false; }
                  }
                  renderScopePill();
                  updateSelectedRangeDisplay();
                  refreshMetrics();
                  refreshGraphView();
                }
              }
            }
          }
        },
        series: [{
          dataLabels: { enabled: true, linkFormat: '', style: { color: '#cbd5e1', textOutline: 'none' } },
          data: links,
          nodes
        }],
        credits: { enabled: false }
      });
    } catch (e) {
      document.getElementById(graphViewChartId).innerHTML = '<div style="color:#94a3b8">Graph view unavailable</div>';
    }
  }

  sendBtn.addEventListener('click', send);
  inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  // No room dropdown; graph interactions drive selection
  startEl.addEventListener('change', () => { updateSelectedRangeDisplay(); refreshMetrics(); });
  endEl.addEventListener('change', () => { updateSelectedRangeDisplay(); refreshMetrics(); });

  // initial metrics load
  updateSelectedRangeDisplay();
  refreshMetrics();
  refreshStatus();
  // Removed graph summary
  refreshGraphView();
  setInterval(refreshStatus, 30000);
  // Confirm/Clear scope controls
  if (confirmBtn) confirmBtn.addEventListener('click', () => { selectionConfirmed = !!(selection.building || selection.floor || selection.room); renderScopePill(); });
  if (clearBtn) clearBtn.addEventListener('click', () => { selection.building=null; selection.floor=null; selection.room=null; selectionConfirmed=false; graphLevel='buildings'; renderScopePill(); refreshGraphView(); });
}

function formatDateLocal(ts) {
  if (!ts) return 'n/a';
  const d = new Date(ts);
  return d.toLocaleString();
}
function formatDateUTC(ts) {
  if (!ts) return 'n/a';
  const d = new Date(ts);
  return d.toISOString().replace('T', ' ').slice(0, 16);
}
function updateSelectedRangeDisplay() {
  const startEl = document.getElementById('start');
  const endEl = document.getElementById('end');
  const rangeDiv = document.getElementById('selected-range');
  const start = startEl.value ? new Date(startEl.value).getTime() : null;
  const end = endEl.value ? new Date(endEl.value).getTime() : null;
  const sel = (window && window.selection) ? window.selection : { building: null, floor: null, room: null };
  rangeDiv.innerHTML = `
    <b>Scope:</b> ${sel.building ? 'Building '+sel.building : '—'} ${sel.floor ? ' · Floor '+sel.floor : ''} ${sel.room ? ' · Room '+sel.room : ''}<br>
    <b>Start:</b> ${formatDateLocal(start)} <span style="color:#3b82f6;">(UTC: ${formatDateUTC(start)})</span><br>
    <b>End:</b> ${formatDateLocal(end)} <span style="color:#3b82f6;">(UTC: ${formatDateUTC(end)})</span>
  `;
}
// Listeners are attached in init(); initial render is also triggered there

async function loadRoomMetrics(room) {
  // Try room-specific JSON first, fallback to global data
  let url = `/data/room/${room}.json`;
  let data;
  try {
    const res = await fetch(url);
    data = await res.json();
  } catch {
    // fallback to /data/${room}.json or /data.json
    try {
      const res = await fetch(`/data/${room}.json`);
      data = await res.json();
    } catch {
      const res = await fetch('/data.json');
      data = await res.json();
    }
  }
  // Collect all unique metric keys from all tables
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
