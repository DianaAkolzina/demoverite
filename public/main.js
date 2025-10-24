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
  const tenantSelect = document.getElementById('tenant-select');
  const roleSelect = document.getElementById('role-select');
  const scopeRoomsBtn = document.getElementById('scope-rooms-btn');
  const scopeRoomsList = document.getElementById('scope-rooms-list');
  const selection = { building: null, floor: null, room: null, deviceType: null, tenant: '', role: 'Guest' };
  window.selection = selection;
  let selectionConfirmed = false;
  let graphLevel = 'buildings';
  const graphCache = new Map(); // key: JSON.stringify({tenant, role}) -> { nodes, links }
  let graphChart = null;
  function debounce(fn, ms) { let t=null; return (...args)=>{ clearTimeout(t); t=setTimeout(()=>fn(...args), ms); }; }

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
    if (selection.tenant) parts.push(`Tenant: ${selection.tenant}`);
    if (selection.role) parts.push(`Role: ${selection.role}`);
    if (selection.building) parts.push(`Building: ${selection.building}`);
    if (selection.floor) parts.push(`Floor: ${selection.floor}`);
    if (selection.room) parts.push(`Room: ${selection.room}`);
    if (selection.deviceType) parts.push(`Device: ${selection.deviceType}`);
    if (scopePillEl) scopePillEl.textContent = parts.length ? (selectionConfirmed ? '✔ ' : '') + parts.join(' · ') : 'No scope selected';
  }

  async function refreshScopeRoomsList() {
    if (!scopeRoomsList) return;
    scopeRoomsList.textContent = 'Loading…';
    try {
      const qs = `?tenant=${encodeURIComponent(selection.tenant||'')}&building=${encodeURIComponent(selection.building||'')}&floor=${encodeURIComponent(selection.floor||'')}`;
      const [res, dev] = await Promise.all([
        fetchJSON(`/api/scope/csv-rooms${qs}`),
        fetchJSON(`/api/graph/floor-devices?building=${encodeURIComponent(selection.building||'')}&floor=${encodeURIComponent(selection.floor||'')}&tenant=${encodeURIComponent(selection.tenant||'')}&role=${encodeURIComponent(selection.role||'')}`)
      ]);
      const rooms = Array.isArray(res.rooms) ? res.rooms : [];
      const scopeRoomsCount = document.getElementById('scope-rooms-count');
      if (scopeRoomsCount) scopeRoomsCount.textContent = rooms.length;
      if (!rooms.length) {
        scopeRoomsList.innerHTML = '<span style="color:#94a3b8">No mapped rooms</span>';
        return;
      }
      const counts = new Map();
      if (dev && Array.isArray(dev.byCsvRoom)) dev.byCsvRoom.forEach(p => { if (p && p.csvRoom) counts.set(p.csvRoom, p.count || 0); });
      const html = ['<ul style="list-style:none; padding-left:0; margin:0;">']
        .concat(rooms.map(r => {
          const c = counts.get(r) || 0;
          return `<li style="padding:2px 0;" data-room="${r}">
            <label style="cursor:pointer; display:flex; justify-content:space-between; gap:8px; align-items:center;">
              <span><input type="checkbox" data-room-check="${r}" style="margin-right:6px;"> ${r}</span>
              <span class="badge">${c}</span>
            </label>
          </li>`;
        }))
        .concat(['</ul>'])
        .join('');
      scopeRoomsList.innerHTML = html;
      // Click label to single-select quickly
      scopeRoomsList.querySelectorAll('li[data-room] label span:first-child').forEach(el => {
        el.addEventListener('click', (e) => {
          const li = e.currentTarget.closest('li[data-room]');
          if (!li) return; const room = li.getAttribute('data-room');
          selection.room = room; selection.rooms = [];
          selectionConfirmed = false; renderScopePill(); updateSelectedRangeDisplay(); refreshMetrics();
        });
      });
    } catch (e) {
      scopeRoomsList.textContent = 'Failed to load';
    }
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
          const res = await fetchJSON(`/api/series?room=${encodeURIComponent(room)}&field=${encodeURIComponent(v)}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&role=${encodeURIComponent(selection.role||'')}`);
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
      const meta = await fetchJSON(`/api/meta?room=${encodeURIComponent(room)}&start=${encodeURIComponent(s)}&end=${encodeURIComponent(e)}&role=${encodeURIComponent(selection.role||'')}`);
      metricsEl.innerHTML = ''


      const dd = ensureMetricsDropdown();
      const fieldSet = new Set();
      Object.values(meta.tables || {}).forEach(info => {
        (info.fields || []).forEach(f => { if (f !== 'ts') fieldSet.add(f); });
      });
      let fields = Array.from(fieldSet).sort();
      const dt = (selection.deviceType || '').toLowerCase();
      if (dt) {
        const pref = new Set();
        if (dt.includes('energy')) ['value','total_kwh'].forEach(x => pref.add(x));
        else if (dt.includes('people') || dt.includes('occup')) ['people_count'].forEach(x => pref.add(x));
        else if (dt.includes('iaq') || dt.includes('air') || dt.includes('sensor')) ['temperature','humidity','co2','pm25','pm10','lux'].forEach(x => pref.add(x));
        const preferred = fields.filter(f => pref.has(f));
        const rest = fields.filter(f => !pref.has(f));
        if (preferred.length) fields = preferred.concat(rest);
      }
      const opts = [''].concat(fields);
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

  const refreshGraphView = debounce(async function () {
    // Title stays static with buttons
    try {
      const key = JSON.stringify({ tenant: selection.tenant||'', role: selection.role||'' });
      let g = graphCache.get(key);
      if (!g) {
        const qs = `?tenant=${encodeURIComponent(selection.tenant||'')}&role=${encodeURIComponent(selection.role||'')}`;
        g = await fetchJSON(`/api/graph/full${qs}`);
        graphCache.set(key, g);
      }
      // If no tenant selected, show an instructional message and do not render buildings
      if (!selection.tenant) {
        const el = document.getElementById(graphViewChartId);
        if (el) el.innerHTML = '<div style="padding:16px; color:#94a3b8">Select a tenant and role to view buildings.</div>';
        return;
      }
      const allLinks = (g.links || []).map(e => [e.source, e.target, e.rel]);
      const colorMap = { Building: '#3b82f6', Floor: '#f59e0b', Zone: '#22c55e', Device: '#8b5cf6', MetricType: '#14b8a6' };
      const allNodes = (g.nodes || []).map(n => ({ id: n.id, name: n.name, roomId: n.roomId || null, csvRoom: n.csvRoom || null, nodeType: n.nodeType || n.label, deviceType: n.deviceType || null, x: typeof n.x === 'number' ? n.x : undefined, y: typeof n.y === 'number' ? n.y : undefined, marker: { radius: n.nodeType==='Building' ? 12 : (n.nodeType==='Zone' ? 9 : 6) }, color: colorMap[n.nodeType || n.label] || undefined }));

      function filterView() {
        const nodes = [];
        const links = [];
        const addNode = (id) => { if (!nodes.find(n => n.id===id)) { const nn = allNodes.find(n=>n.id===id); if (nn) nodes.push(nn);} };
        const addLink = (a,b) => { if (a && b) links.push([a,b]); };
        const buildings = allNodes.filter(n=>n.nodeType==='Building');
        const floors = allNodes.filter(n=>n.nodeType==='Floor');
        const zones = allNodes.filter(n=>n.nodeType==='Zone');
        if (graphLevel==='buildings') {
          // Only show buildings when a tenant is selected (enforced above); rely on server-side tenant pruning
          buildings.forEach(n=>addNode(n.id));
        } else if (graphLevel==='floors' && selection.building) {
          const b = buildings.find(n=>n.name===selection.building);
          if (b) addNode(b.id);
          const before = nodes.length;
          const isFB = (l)=> l[2]==='IN_BUILDING' || l[2]==='BELONGS_TO_BUILDING' || l[2]==='LOCATED_IN_BUILDING';
          const isZF = (l)=> l[2]==='LOCATED_ON_FLOOR' || l[2]==='BELONGS_TO_FLOOR';
          allLinks.filter(isFB).forEach(([from,to])=>{ if (b && to===b.id) { const nFrom = allNodes.find(n=>n.id===from); if (nFrom && nFrom.nodeType==='Floor') { addNode(from); addLink(from,to);} }});
          if (nodes.length === before && b) {
            allLinks.filter(isFB).forEach(([from,to])=>{ if (to===b.id) { const nFrom = allNodes.find(n=>n.id===from); if (nFrom && nFrom.nodeType==='Zone') { addNode(from); addLink(from,to);} }});
          }
        } else if (graphLevel==='rooms' && selection.building && selection.floor) {
          const b = buildings.find(n=>n.name===selection.building);
          const f = floors.find(n=> (n.name===selection.floor) || (n.id===selection.floor));
          if (b) addNode(b.id);
          if (f) { addNode(f.id); addLink(f.id, b?b.id:null); }
          allLinks.filter(l=> (l[2]==='LOCATED_ON_FLOOR' || l[2]==='BELONGS_TO_FLOOR')).forEach(([from,to])=>{ if (f && to===f.id) { addNode(from); addLink(from,to);} });
        } else if (graphLevel==='devices' && selection.room) {
          const z = zones.find(n=>n.roomId===selection.room);
          if (z) addNode(z.id);
          allLinks.filter(l=>l[2]==='LOCATED_IN_ZONE').forEach(([from,to])=>{ if (z && to===z.id) { addNode(from); addLink(from,to);} });
          allLinks.filter(l=> (l[2]==='LOCATED_ON_FLOOR' || l[2]==='BELONGS_TO_FLOOR')).forEach(([from,to])=>{ if (z && from===z.id) { addNode(to); addLink(from,to);} });
          if (!z) {
            const b = buildings.find(n=>n.name===selection.building);
            if (b) {
              allLinks.filter(l=>l[2]==='LOCATED_IN_BUILDING').forEach(([from,to])=>{ if (to===b.id) { const nFrom = allNodes.find(n=>n.id===from); if (nFrom && nFrom.nodeType==='Device') { addNode(from); addLink(from,to);} }});
            }
          }
          const floorId = nodes.find(n=>n.nodeType==='Floor')?.id;
          if (floorId) allLinks.filter(l=> (l[2]==='IN_BUILDING' || l[2]==='BELONGS_TO_BUILDING' || l[2]==='LOCATED_IN_BUILDING')).forEach(([from,to])=>{ if (from===floorId) { addNode(to); addLink(from,to);} });
        } else {
          allNodes.forEach(n=>addNode(n.id));
          allLinks.forEach(([a,b])=>addLink(a,b));
        }
        return { nodes, links };
      }
      const view = filterView();
      const nodes = view.nodes;
      const links = view.links;

      // Arrange building nodes in neat rows to avoid hugging the borders
      try {
        if (graphLevel === 'buildings') {
          const bnodes = nodes.filter(n => n.nodeType === 'Building');
          const perRow = Math.max(1, Math.min(6, Math.ceil(Math.sqrt(bnodes.length || 1)) * 2));
          const xStep = 220, yStep = 180;
          bnodes.forEach((n, i) => {
            const col = i % perRow;
            const row = Math.floor(i / perRow);
            const x0 = -((perRow - 1) / 2) * xStep;
            n.x = x0 + col * xStep;
            n.y = row * yStep;
          });
        }
      } catch {}
      const options = {
        chart: { type: 'networkgraph', backgroundColor: 'transparent' },
        title: { text: null },
        tooltip: { formatter() { return `${this.point.nodeType||''}: ${this.point.name||this.point.id}`; } },
        plotOptions: {
          networkgraph: {
            keys: ['from', 'to'],
            layoutAlgorithm: { enableSimulation: false, linkLength: 80 }
          },
          series: {
            cursor: 'pointer',
            point: {
              events: {
                click: function () {
                  const p = this;
                  if (p.nodeType === 'Building') {
                    selection.building = p.name; selection.floor = null; selection.room = null; selection.deviceType = null; selectionConfirmed = false; graphLevel='floors';
                  } else if (p.nodeType === 'Floor') {
                    selection.floor = p.name || p.id; selection.deviceType = null; selectionConfirmed = false; graphLevel='rooms';
          } else if (p.nodeType === 'Zone') {
                    if (Array.isArray(p.deviceIds) && p.deviceIds.length) {
                      selection.rooms = p.deviceIds.slice(0, 200);
                      selection.room = '';
                    } else {
                      const rid = p.csvRoom || p.roomId || (p.name ? String(p.name).trim().toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'') : 'zone');
                      selection.room = rid;
                      selection.rooms = [];
                    }
                    selection.deviceType = null; selectionConfirmed = false; graphLevel='devices';
                  } else if (p.nodeType === 'Device') {
                    const rel = links.find(l => l[0]===p.id || l[1]===p.id);
                    const other = rel ? (rel[0]===p.id ? rel[1] : rel[0]) : null;
                    const zone = nodes.find(n => n.id === other && n.nodeType==='Zone');
                    if (zone && zone.roomId) { selection.room = zone.roomId; selectionConfirmed = false; }
                    selection.deviceType = p.deviceType || p.name || null;
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
      };

      if (graphChart) {
        try {
          const s = graphChart.series[0];
          s.update({ nodes }, false);
          s.setData(links, true);
        } catch (e) {
          graphChart.destroy();
          graphChart = Highcharts.chart(graphViewChartId, options);
        }
      } else {
        graphChart = Highcharts.chart(graphViewChartId, options);
      }
    } catch (e) {
      document.getElementById(graphViewChartId).innerHTML = '<div style="color:#94a3b8">Graph view unavailable</div>';
    }
  }, 80);

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

  // Load tenants/roles and bind selectors
  function loadSelectionFromStorage() {
    try {
      const raw = localStorage.getItem('selection');
      if (!raw) return;
      const s = JSON.parse(raw);
      if (s && typeof s === 'object') {
        selection.tenant = s.tenant || selection.tenant;
        selection.role = s.role || selection.role;
        selection.building = s.building || selection.building;
        selection.floor = s.floor || selection.floor;
        selection.room = s.room || selection.room;
      }
    } catch {}
  }
  function saveSelectionToStorage() {
    try { localStorage.setItem('selection', JSON.stringify({ tenant: selection.tenant, role: selection.role, building: selection.building, floor: selection.floor, room: selection.room })); } catch {}
  }

  async function loadAuthOptions() {
    try {
      const o = await fetchJSON('/api/auth/options');
      // tenants
      if (tenantSelect) {
        const tenants = o.tenants || [];
        const opts = ['<option value="">All</option>'].concat(tenants.map(t => `<option value="${t}">${t}</option>`));
        tenantSelect.innerHTML = opts.join('');
        // Default to first tenant if none selected
        if (!selection.tenant && tenants.length) {
          selection.tenant = tenants[0];
          tenantSelect.value = tenants[0];
        } else if (selection.tenant) {
          tenantSelect.value = selection.tenant;
        }
      }
      if (roleSelect && (o.roles||[]).length) {
        roleSelect.innerHTML = (o.roles||[]).map(r => `<option value="${r}">${r}</option>`).join('');
        if (selection.role) roleSelect.value = selection.role;
      }
      renderScopePill();
      refreshGraphView();
      refreshMetrics();
    } catch (e) {
      // ignore
    }
  }
  if (tenantSelect) tenantSelect.addEventListener('change', () => { selection.tenant = tenantSelect.value || ''; saveSelectionToStorage(); renderScopePill(); refreshGraphView(); refreshMetrics(); });
  if (roleSelect) roleSelect.addEventListener('change', () => { selection.role = roleSelect.value || 'Guest'; saveSelectionToStorage(); renderScopePill(); refreshGraphView(); refreshMetrics(); });
  if (scopeRoomsBtn) scopeRoomsBtn.addEventListener('click', () => { refreshScopeRoomsList(); });
  const scopeRoomsApply = document.getElementById('scope-rooms-apply');
  if (scopeRoomsApply) scopeRoomsApply.addEventListener('click', () => {
    if (!scopeRoomsList) return;
    const checks = scopeRoomsList.querySelectorAll('input[type="checkbox"][data-room-check]');
    const sel = [];
    checks.forEach(ch => { if (ch.checked) sel.push(ch.getAttribute('data-room-check')); });
    selection.rooms = sel;
    selection.room = sel.length === 1 ? sel[0] : '';
    selectionConfirmed = false;
    renderScopePill(); updateSelectedRangeDisplay(); refreshMetrics();
  });
  loadSelectionFromStorage();
  loadAuthOptions();
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
