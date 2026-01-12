const fs = require('fs');
const path = require('path');

const DEFAULT_PORT = 3001;
const OUT_DIR = path.join(__dirname, '..', 'data', 'chat_traces');
const SNAPSHOT_PATH = path.join(__dirname, '..', 'data', 'graph_snapshot.json');

function loadSnapshot() {
  const raw = fs.readFileSync(SNAPSHOT_PATH, 'utf8');
  return JSON.parse(raw);
}

function pickScope(snapshot) {
  const owner = snapshot.buildings?.[0];
  const shop = owner?.floors?.[0];
  const page = shop?.zones?.find((z) => z.name && z.name !== 'Market Signals') || shop?.zones?.[0];
  const product = page?.devices?.[0];
  return { owner, shop, page, product };
}

async function postChat(port, payload) {
  const res = await fetch(`http://localhost:${port}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.body = text;
    throw err;
  }
  return json;
}

async function run() {
  const port = Number(process.argv[2] || DEFAULT_PORT);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const snapshot = loadSnapshot();
  const scope = pickScope(snapshot);
  if (!scope.owner || !scope.shop || !scope.page) {
    throw new Error('Unable to pick owner/shop/page from snapshot.');
  }

  const tests = [
    {
      name: 'Scope summary',
      question: 'What is the current scope?',
      selection: { building: scope.owner.name, floor: scope.shop.name, room: scope.page.name },
      room: null
    },
    {
      name: 'Sales trend',
      question: 'Summarize sales_amount and conversion_rate for this page.',
      selection: { building: scope.owner.name, floor: scope.shop.name, room: scope.page.name },
      room: null
    },
    {
      name: 'Forecast product sales',
      question: 'Forecast sales_amount for the selected product for the next 7 days.',
      selection: { building: scope.owner.name, floor: scope.shop.name, room: scope.page.name },
      room: scope.product?.cloudId || null
    }
  ];

  const results = [];
  let conversationId = '';

  for (const test of tests) {
    const payload = {
      conversationId: conversationId || undefined,
      messages: [{ role: 'user', content: test.question }],
      room: test.room,
      range: null,
      selection: test.selection
    };
    const started = Date.now();
    const response = await postChat(port, payload);
    const durationMs = Date.now() - started;
    conversationId = response.conversationId || conversationId;

    const record = {
      name: test.name,
      question: test.question,
      selection: test.selection,
      room: test.room,
      duration_ms: durationMs,
      answer: response?.message?.content || response?.message?.text || response?.answer || '',
      chart_plotted: !!response?.chart,
      trace: response?.trace || null,
      plan_status: response?.plan_status || null
    };
    results.push(record);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(OUT_DIR, `chat_trace_${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ results }, null, 2));
  console.log(`Chat traces saved to ${outPath}`);
}

run().catch((err) => {
  console.error('Chat test failed:', err?.message || err);
  if (err?.body) console.error(err.body);
  process.exit(1);
});
