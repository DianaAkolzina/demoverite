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
  const roomSel = document.getElementById('room');
  const startEl = document.getElementById('start');
  const endEl = document.getElementById('end');
  const chatEl = document.getElementById('chat');
  const inputEl = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const metricsEl = document.getElementById('metrics');
  const sidebar = document.querySelector('.sidebar');

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
        const room = roomSel.value;
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

  try {
    const { rooms } = await fetchJSON('/api/rooms');
    roomSel.innerHTML = rooms.map(r => `<option>${r}</option>`).join('');
  } catch {
    roomSel.innerHTML = '';
  }

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
    const room = roomSel.value;
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
    const room = roomSel.value;
    const start = startEl.value ? new Date(startEl.value).getTime() : null;
    const end = endEl.value ? new Date(endEl.value).getTime() : null;
    const content = inputEl.value.trim();
    if (!content) return;
    inputEl.value = '';
    messages.push({ role: 'user', content });
    appendMessage(chatEl, 'user', content);

    appendMessage(chatEl, 'assistant', 'Thinking…');

    const res = await fetchJSON('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, room, range: { start, end } })
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

  sendBtn.addEventListener('click', send);
  inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  roomSel.addEventListener('change', refreshMetrics);
  startEl.addEventListener('change', refreshMetrics);
  endEl.addEventListener('change', refreshMetrics);

  // initial metrics load
  refreshMetrics();
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
  const roomSel = document.getElementById('room');
  const rangeDiv = document.getElementById('selected-range');
  const start = startEl.value ? new Date(startEl.value).getTime() : null;
  const end = endEl.value ? new Date(endEl.value).getTime() : null;
  rangeDiv.innerHTML = `
    <b>Room:</b> ${roomSel.value}<br>
    <b>Start:</b> ${formatDateLocal(start)} <span style="color:#3b82f6;">(UTC: ${formatDateUTC(start)})</span><br>
    <b>End:</b> ${formatDateLocal(end)} <span style="color:#3b82f6;">(UTC: ${formatDateUTC(end)})</span>
  `;
}
document.getElementById('room').addEventListener('change', updateSelectedRangeDisplay);
document.getElementById('start').addEventListener('change', updateSelectedRangeDisplay);
document.getElementById('end').addEventListener('change', updateSelectedRangeDisplay);
updateSelectedRangeDisplay();

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
