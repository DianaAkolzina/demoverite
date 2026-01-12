const $ = (id) => document.getElementById(id);

const fmt = new Intl.DateTimeFormat('en-GB', {
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false
});

const METRIC_LABELS = {
  visits: 'Visits',
  sessions: 'Sessions',
  add_to_cart_rate: 'Add-to-Cart Rate (%)',
  conversion_rate: 'Conversion Rate (%)',
  bounce_rate: 'Bounce Rate (%)',
  order_count: 'Orders',
  sales_amount: 'Sales Amount ($)',
  avg_order_value: 'Avg Order Value ($)',
  items_sold: 'Items Sold',
  top_item: 'Top Item',
  sale_date: 'Sale Date',
  ad_spend: 'Ad Spend ($)',
  paid_clicks: 'Paid Clicks',
  cpc: 'Cost per Click ($)',
  roas: 'ROAS',
  temp_c: 'Temperature (C)',
  precip_mm: 'Precipitation (mm)',
  consumer_confidence: 'Consumer Confidence',
  cpi: 'CPI Index',
  unemployment_rate: 'Unemployment Rate (%)',
  usd_index: 'USD Index',
  retail_sales_index: 'Retail Sales Index'
};
const TEXT_METRICS = new Set(['top_item', 'sale_date']);
const SUM_METRICS = new Set([
  'visits', 'sessions', 'order_count', 'sales_amount', 'items_sold',
  'ad_spend', 'paid_clicks'
]);
const AVG_METRICS = new Set([
  'add_to_cart_rate', 'conversion_rate', 'bounce_rate', 'avg_order_value',
  'cpc', 'roas', 'temp_c', 'precip_mm', 'consumer_confidence', 'cpi',
  'unemployment_rate', 'usd_index', 'retail_sales_index'
]);

function metricLabel(field) {
  return METRIC_LABELS[field] || field;
}

function formatTs(ts) {
  if (!Number.isFinite(ts)) return '—';
  try { return fmt.format(new Date(ts)); } catch { return '—'; }
}

function deviceId(dev) {
  return dev?.cloudId || dev?.properties?.cloudId || dev?.id || dev?.name || null;
}

async function loadSnapshot() {
  const res = await fetch('/data/graph_snapshot.json');
  if (!res.ok) throw new Error('Snapshot load failed');
  return res.json();
}

function buildTopology(snap) {
  const buildings = Array.isArray(snap.buildings) ? snap.buildings : [];
  return buildings.map((b) => {
    const floors = Array.isArray(b.floors) ? b.floors : [];
    const ownerKey = b.name || b.id;
    const shops = floors.map((f, shopIdx) => {
      const zones = Array.isArray(f.zones) ? f.zones : [];
      const pages = zones.map((z, pageIdx) => {
        const pageKey = z.name || z.id || `page-${pageIdx}`;
        const devices = Array.isArray(z.devices)
          ? z.devices.map((d) => ({
            ...d,
            displayName: d.name || d.id || deviceId(d) || 'product',
            category: d.properties?.category || 'Uncategorized'
          }))
          : [];
        return {
          ...z,
          key: pageKey,
          displayName: z.name || pageKey,
          devices
        };
      });
      const products = pages.flatMap((p) => p.devices || []);
      return {
        ...f,
        key: f.name || f.id || `shop-${shopIdx}`,
        displayName: f.name || f.id || `Shop ${shopIdx + 1}`,
        pages,
        products
      };
    });
    const products = shops.flatMap((s) => s.products || []);
    return {
      key: ownerKey,
      name: b.name || b.id || ownerKey,
      shops,
      products
    };
  });
}

function summarize(topology) {
  const owners = topology.length;
  const shops = topology.reduce((n, o) => n + o.shops.length, 0);
  const pages = topology.reduce((n, o) => n + o.shops.reduce((m, s) => m + s.pages.length, 0), 0);
  const products = topology.reduce((n, o) => n + o.products.length, 0);
  return { owners, shops, pages, products };
}

async function loadTelemetry(id) {
  const res = await fetch(`/data/local_telemetry/${encodeURIComponent(id)}.csv`);
  if (!res.ok) throw new Error('Telemetry not found');
  const text = await res.text();
  const lines = text.trim().split(/\r?\n/);
  if (!lines.length) return { headers: [], rows: [] };
  const headers = lines[0].split(',');
  const rows = lines.slice(1).map((ln) => {
    const parts = ln.split(',');
    const obj = {};
    headers.forEach((h, i) => { obj[h] = parts[i]; });
    return obj;
  });
  return { headers, rows };
}

function computeStats(rows, field) {
  const nums = rows.map((r) => Number(r[field])).filter((n) => Number.isFinite(n));
  if (nums.length) {
    const latest = nums[nums.length - 1];
    const min = Math.min(...nums);
    const max = Math.max(...nums);
    const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
    return { mode: 'numeric', latest, min, max, avg };
  }
  const textValues = rows.map((r) => String(r[field] ?? '').trim()).filter((v) => v.length);
  if (!textValues.length) return null;
  return { mode: 'text', latest: textValues[textValues.length - 1] };
}

function renderStats(stats) {
  const kpis = $('kpis');
  kpis.innerHTML = '';
  if (!stats) {
    kpis.innerHTML = '<span class="muted">No data for this metric.</span>';
    return;
  }
  if (stats.mode === 'text') {
    const div = document.createElement('div');
    div.className = 'kpi';
    div.innerHTML = `<div class="label">Latest</div><div class="value">${stats.latest}</div>`;
    kpis.appendChild(div);
    return;
  }
  const tpl = [
    ['Latest', stats.latest],
    ['Average', stats.avg],
    ['Min', stats.min],
    ['Max', stats.max]
  ];
  tpl.forEach(([label, val]) => {
    const div = document.createElement('div');
    div.className = 'kpi';
    div.innerHTML = `<div class="label">${label}</div><div class="value">${Number(val).toFixed(2)}</div>`;
    kpis.appendChild(div);
  });
}

function renderTable(rows, field, devName) {
  const body = $('table-body');
  body.innerHTML = '';
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="4" class="muted">No rows for this selection.</td></tr>';
    return;
  }
  rows.slice(-15).reverse().forEach((r) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${formatTs(Number(r.ts))}</td><td>${r[field]}</td><td>${devName}</td><td>${metricLabel(field)}</td>`;
    body.appendChild(tr);
  });
}

function renderChart(rows, field, title, forecastSeries = null, mode = 'numeric') {
  const series = rows.map((r) => [Number(r.ts), Number(r[field])]).filter((p) => Number.isFinite(p[1]));
  const chartSeries = [{
    type: 'line',
    name: metricLabel(field),
    data: series,
    color: '#5ef0ff',
    lineWidth: 2,
    marker: { enabled: false }
  }];
  if (forecastSeries?.length) {
    chartSeries.push({
      type: 'line',
      name: `${metricLabel(field)} forecast`,
      data: forecastSeries,
      color: '#8b5cf6',
      dashStyle: 'ShortDash',
      lineWidth: 2,
      marker: { enabled: false }
    });
  }
  const chartTitle = mode === 'numeric' ? title : `${title} · non-numeric metric`;
  Highcharts.chart('chart', {
    chart: { backgroundColor: 'transparent' },
    title: { text: chartTitle, style: { color: '#e5ecff', fontSize: '16px' } },
    xAxis: { type: 'datetime', labels: { style: { color: '#9db1d1' } }, gridLineColor: 'rgba(255,255,255,0.05)' },
    yAxis: { title: { text: null }, labels: { style: { color: '#9db1d1' } }, gridLineColor: 'rgba(255,255,255,0.05)' },
    legend: { enabled: false },
    accessibility: { enabled: false },
    credits: { enabled: false },
    series: mode === 'numeric' ? chartSeries : [],
    tooltip: {
      shared: true,
      backgroundColor: '#111a2f',
      borderColor: 'rgba(255,255,255,0.1)',
      style: { color: '#e5ecff' },
      formatter() {
        return `<strong>${formatTs(this.x)}</strong><br>${metricLabel(field)}: <strong>${this.y}</strong>`;
      }
    }
  });
  if (!series.length) {
    $('range-label').textContent = '—';
    return;
  }
  const endTs = forecastSeries?.length ? forecastSeries[forecastSeries.length - 1][0] : series[series.length - 1][0];
  $('range-label').textContent = `${formatTs(series[0][0])} → ${formatTs(endTs)}`;
}

function populateSelect(el, items, placeholder) {
  el.innerHTML = '';
  const frag = document.createDocumentFragment();
  const opt0 = document.createElement('option');
  opt0.value = '';
  opt0.textContent = placeholder;
  frag.appendChild(opt0);
  items.forEach((item) => {
    const opt = document.createElement('option');
    opt.value = item.value;
    opt.textContent = item.label;
    frag.appendChild(opt);
  });
  el.appendChild(frag);
}

function aggregateMetricRows(products, metric) {
  const rowsByTs = new Map();
  const addPoint = (ts, value) => {
    if (!Number.isFinite(ts) || !Number.isFinite(value)) return;
    const entry = rowsByTs.get(ts) || { ts, sum: 0, count: 0 };
    entry.sum += value;
    entry.count += 1;
    rowsByTs.set(ts, entry);
  };
  const aggValue = (sum, count) => {
    if (SUM_METRICS.has(metric)) return sum;
    const denom = count || 1;
    return sum / denom;
  };

  return Promise.all(products.map((p) => loadTelemetry(deviceId(p))))
    .then((results) => {
      results.forEach((tel) => {
        (tel.rows || []).forEach((r) => {
          const ts = Number(r.ts);
          const value = Number(r[metric]);
          addPoint(ts, value);
        });
      });
      return Array.from(rowsByTs.values())
        .sort((a, b) => a.ts - b.ts)
        .map((entry) => ({ ts: entry.ts, [metric]: aggValue(entry.sum, entry.count) }));
    });
}

function renderGraphTree(topology) {
  const container = $('graph-tree');
  if (!container) return;
  container.innerHTML = '';
  const frag = document.createDocumentFragment();

  const makeNode = (label, level, data) => {
    const row = document.createElement('div');
    row.className = `tree-item level-${level}`;
    row.dataset.owner = data.owner || '';
    row.dataset.shop = data.shop || '';
    row.dataset.page = data.page || '';
    row.dataset.category = data.category || '';
    row.dataset.product = data.product || '';
    const dot = document.createElement('span');
    dot.className = 'tree-dot';
    const text = document.createElement('span');
    text.textContent = label;
    row.appendChild(dot);
    row.appendChild(text);
    return row;
  };

  topology.forEach((owner) => {
    frag.appendChild(makeNode(owner.name, 0, { owner: owner.key }));
    owner.shops.forEach((shop) => {
      frag.appendChild(makeNode(shop.displayName || shop.key, 1, { owner: owner.key, shop: shop.key }));
      shop.pages.forEach((page) => {
        frag.appendChild(makeNode(page.displayName || page.key, 2, { owner: owner.key, shop: shop.key, page: page.key }));
        const categories = Array.from(new Set((page.devices || []).map((d) => d.category || 'Uncategorized')));
        categories.forEach((category) => {
          frag.appendChild(makeNode(category, 3, { owner: owner.key, shop: shop.key, page: page.key, category }));
          (page.devices || [])
            .filter((d) => (d.category || 'Uncategorized') === category)
            .forEach((product) => {
              frag.appendChild(makeNode(product.displayName || product.name || product.id, 4, {
                owner: owner.key,
                shop: shop.key,
                page: page.key,
                category,
                product: deviceId(product)
              }));
            });
        });
      });
    });
  });

  container.appendChild(frag);
}

async function init() {
  const snap = await loadSnapshot();
  const topology = buildTopology(snap);
  const summary = summarize(topology);

  // Stat cards
  const statCards = $('stat-cards');
  statCards.innerHTML = '';
  const cardData = [
    ['Shop owners', summary.owners],
    ['Shops', summary.shops],
    ['Pages', summary.pages],
    ['Products', summary.products]
  ];
  cardData.forEach(([label, value], idx) => {
    const card = document.createElement('div');
    card.className = 'card';
    const accent = idx % 2 === 0 ? 'var(--accent)' : 'var(--accent-2)';
    card.innerHTML = `<h3>${label}</h3><div class="stat-value" style="color:${accent}">${value}</div>`;
    statCards.appendChild(card);
  });
  $('snapshot-info').textContent = `Snapshot: ${snap.generatedAt ? formatTs(snap.generatedAt) : '—'}`;
  renderGraphTree(topology);

  const ownerSel = $('owner');
  const shopSel = $('shop');
  const pageSel = $('page');
  const categorySel = $('category');
  const productSel = $('product');
  const metricSel = $('metric');

  let currentOwner = null;
  let currentShop = null;
  let currentPage = null;
  let currentCategory = null;
  let currentProduct = null;
  let currentScopeProducts = [];
  let currentRows = [];
  let currentMetric = null;
  let currentMetricMode = 'numeric';

  function updateScopePill() {
    const parts = [];
    const allShops = topology.flatMap((o) => o.shops.map((s) => ({ ...s, ownerKey: o.key, ownerName: o.name })));
    const owner = currentOwner ? topology.find((o) => o.key === currentOwner) : null;
    const shop = currentShop ? allShops.find((s) => s.key === currentShop) : null;
    const page = shop?.pages?.find((p) => p.key === currentPage);
    if (owner) parts.push(owner.name);
    if (!owner && shop?.ownerName) parts.push(shop.ownerName);
    if (shop) parts.push(shop.displayName);
    if (page) parts.push(page.displayName);
    if (currentCategory) parts.push(currentCategory);
    if (currentProduct) parts.push(currentProduct.displayName || currentProduct.name || currentProduct.id);
    if (!currentProduct && (currentOwner || currentShop || currentPage || currentCategory)) parts.push('All products');
    $('scope-pill').textContent = parts.length ? parts.join(' · ') : 'Nothing selected';
  }

  function shopList(ownerKey) {
    if (ownerKey) {
      const owner = topology.find((o) => o.key === ownerKey);
      if (!owner) return [];
      return owner.shops.map((s) => ({ value: s.key, label: s.displayName || s.key }));
    }
    return topology.flatMap((o) => o.shops.map((s) => ({
      value: s.key,
      label: `${s.displayName || s.key} · ${o.name}`
    })));
  }

  function pageList(ownerKey, shopKey) {
    const shops = ownerKey
      ? (topology.find((o) => o.key === ownerKey)?.shops || [])
      : topology.flatMap((o) => o.shops);
    if (shopKey) {
      const shop = shops.find((s) => s.key === shopKey);
      if (!shop) return [];
      return shop.pages.map((p) => ({ value: p.key, label: p.displayName || p.key }));
    }
    const pages = new Map();
    shops.forEach((s) => {
      s.pages.forEach((p) => {
        if (!pages.has(p.key)) pages.set(p.key, p.displayName || p.key);
      });
    });
    return Array.from(pages.entries()).map(([value, label]) => ({ value, label }));
  }

  function categoryList(ownerKey, shopKey, pageKey) {
    const shops = ownerKey
      ? (topology.find((o) => o.key === ownerKey)?.shops || [])
      : topology.flatMap((o) => o.shops);
    const pages = shopKey
      ? (shops.find((s) => s.key === shopKey)?.pages || [])
      : shops.flatMap((s) => s.pages);
    const scopedPages = pageKey ? pages.filter((p) => p.key === pageKey) : pages;
    const categories = new Set();
    scopedPages.forEach((page) => {
      (page.devices || []).forEach((d) => categories.add(d.category || 'Uncategorized'));
    });
    return Array.from(categories).map((c) => ({ value: c, label: c }));
  }

  function productList(ownerKey, shopKey, pageKey, category) {
    const shops = ownerKey
      ? (topology.find((o) => o.key === ownerKey)?.shops || [])
      : topology.flatMap((o) => o.shops);
    const pages = shopKey
      ? (shops.find((s) => s.key === shopKey)?.pages || [])
      : shops.flatMap((s) => s.pages);
    const scopedPages = pageKey ? pages.filter((p) => p.key === pageKey) : pages;
    const products = scopedPages.flatMap((page) => (page.devices || []));
    return products
      .filter((d) => !category || (d.category || 'Uncategorized') === category)
      .map((d) => ({ value: deviceId(d), label: d.displayName || d.name || deviceId(d), raw: d }));
  }

  populateSelect(ownerSel, topology.map((o) => ({ value: o.key, label: o.name })), 'All owners');
  if (topology.length) ownerSel.value = topology[0].key;
  currentOwner = ownerSel.value || null;
  updateScopePill();

  const analysisOutput = $('analysis-output');
  const analysisButtons = document.querySelectorAll('[data-action]');

  async function refreshProducts() {
    currentProduct = null;
    currentScopeProducts = [];
    currentRows = [];
    currentMetric = null;
    updateAnalysisOutput('Select a KPI to unlock shortcuts.');
    populateSelect(metricSel, [], 'Select KPI…');
    populateSelect(productSel, [], 'All products');
    const list = productList(currentOwner, currentShop, currentPage, currentCategory);
    currentScopeProducts = list.map((entry) => entry.raw);
    populateSelect(productSel, list, 'All products');
    productSel.value = '';
    updateScopePill();
    if (currentScopeProducts.length) await refreshMetrics();
  }

  async function refreshMetrics() {
    try {
      const baseProduct = currentProduct || currentScopeProducts[0];
      const id = deviceId(baseProduct);
      if (!id) throw new Error('No device id');
      const tel = await loadTelemetry(id);
      let headers = tel.headers.filter((h) => h !== 'ts');
      if (!currentProduct) {
        headers = headers.filter((h) => !TEXT_METRICS.has(h));
      }
      populateSelect(metricSel, headers.map((h) => ({ value: h, label: metricLabel(h) })), 'Select KPI…');
      if (headers.length) {
        metricSel.value = headers[0];
        if (currentProduct) {
          await renderMetric(headers[0], tel, currentProduct);
        } else {
          await renderAggregateMetric(headers[0]);
        }
      } else {
        renderStats(null);
        $('table-body').innerHTML = '<tr><td colspan="4" class="muted">No KPIs for this selection.</td></tr>';
        Highcharts.chart('chart', { title: { text: 'No data' }, series: [] });
      }
    } catch (e) {
      console.error(e);
      renderStats(null);
      $('table-body').innerHTML = '<tr><td colspan="4" class="muted">Telemetry unavailable for this selection.</td></tr>';
      Highcharts.chart('chart', { title: { text: 'No data' }, series: [] });
    }
  }

  async function renderMetric(metric, tel, dev) {
    const rows = (tel?.rows || []).map((r) => ({
      ts: Number(r.ts),
      ...r
    })).filter((r) => Number.isFinite(r.ts) && r[metric] != null);
    const stats = computeStats(rows, metric);
    renderStats(stats);
    currentRows = rows;
    currentMetric = metric;
    currentMetricMode = stats?.mode || 'numeric';
    renderTable(rows, metric, dev.displayName || dev.name || deviceId(dev));
    renderChart(rows, metric, `${dev.displayName || dev.name || deviceId(dev)} · ${metricLabel(metric)}`, null, currentMetricMode);
    updateAnalysisOutput('Pick a shortcut to generate an instant commerce insight.');
  }

  function scopeLabel() {
    const parts = [];
    const allShops = topology.flatMap((o) => o.shops.map((s) => ({ ...s, ownerKey: o.key, ownerName: o.name })));
    const owner = currentOwner ? topology.find((o) => o.key === currentOwner) : null;
    const shop = currentShop ? allShops.find((s) => s.key === currentShop) : null;
    const page = shop?.pages?.find((p) => p.key === currentPage);
    if (owner) parts.push(owner.name);
    if (!owner && shop?.ownerName) parts.push(shop.ownerName);
    if (shop) parts.push(shop.displayName);
    if (page) parts.push(page.displayName);
    if (currentCategory) parts.push(currentCategory);
    return parts.length ? `${parts.join(' · ')} · All products` : 'All products';
  }

  async function renderAggregateMetric(metric) {
    const rows = await aggregateMetricRows(currentScopeProducts, metric);
    const stats = computeStats(rows, metric);
    renderStats(stats);
    currentRows = rows;
    currentMetric = metric;
    currentMetricMode = stats?.mode || 'numeric';
    renderTable(rows, metric, scopeLabel());
    renderChart(rows, metric, `${scopeLabel()} · ${metricLabel(metric)}`, null, currentMetricMode);
    updateAnalysisOutput('Pick a shortcut to generate an instant commerce insight.');
  }

  async function handleOwnerChange() {
    currentOwner = ownerSel.value || null;
    populateSelect(shopSel, shopList(currentOwner), 'All shops');
    currentShop = shopSel.value || null;
    populateSelect(pageSel, pageList(currentOwner, currentShop), 'All pages');
    currentPage = pageSel.value || null;
    populateSelect(categorySel, currentPage ? categoryList(currentOwner, currentShop, currentPage) : [], 'All categories');
    currentCategory = categorySel.value || null;
    updateScopePill();
    await refreshProducts();
  }

  async function handleShopChange() {
    currentShop = shopSel.value || null;
    populateSelect(pageSel, pageList(currentOwner, currentShop), 'All pages');
    currentPage = pageSel.value || null;
    populateSelect(categorySel, currentPage ? categoryList(currentOwner, currentShop, currentPage) : [], 'All categories');
    currentCategory = categorySel.value || null;
    updateScopePill();
    await refreshProducts();
  }

  async function handlePageChange() {
    currentPage = pageSel.value || null;
    populateSelect(categorySel, currentPage ? categoryList(currentOwner, currentShop, currentPage) : [], 'All categories');
    currentCategory = categorySel.value || null;
    updateScopePill();
    await refreshProducts();
  }

  async function handleCategoryChange() {
    currentCategory = categorySel.value || null;
    updateScopePill();
    await refreshProducts();
  }

  async function handleProductChange() {
    const list = productList(currentOwner, currentShop, currentPage, currentCategory);
    const match = list.find((d) => d.value === productSel.value);
    currentProduct = match ? match.raw : null;
    updateScopePill();
    await refreshMetrics();
  }

  const graphTree = $('graph-tree');
  if (graphTree) {
    graphTree.addEventListener('click', async (event) => {
      const item = event.target.closest('.tree-item');
      if (!item) return;
      const { owner, shop, page, category, product } = item.dataset;
      if (owner) {
        ownerSel.value = owner;
        await handleOwnerChange();
      }
      if (shop) {
        shopSel.value = shop;
        await handleShopChange();
      }
      if (page) {
        pageSel.value = page;
        await handlePageChange();
      }
      if (category) {
        categorySel.value = category;
        await handleCategoryChange();
      }
      if (product) {
        productSel.value = product;
        await handleProductChange();
      }
    });
  }

  ownerSel.addEventListener('change', handleOwnerChange);
  shopSel.addEventListener('change', handleShopChange);
  pageSel.addEventListener('change', handlePageChange);
  categorySel.addEventListener('change', handleCategoryChange);
  productSel.addEventListener('change', handleProductChange);

  metricSel.addEventListener('change', async () => {
    if (!metricSel.value) return;
    if (currentProduct) {
      const id = deviceId(currentProduct);
      const tel = await loadTelemetry(id);
      await renderMetric(metricSel.value, tel, currentProduct);
    } else {
      await renderAggregateMetric(metricSel.value);
    }
  });

  // initialize shops/pages/products/metric
  populateSelect(shopSel, shopList(currentOwner), 'All shops');
  currentShop = shopSel.value || null;
  populateSelect(pageSel, pageList(currentOwner, currentShop), 'All pages');
  currentPage = pageSel.value || null;
  populateSelect(categorySel, currentPage ? categoryList(currentOwner, currentShop, currentPage) : [], 'All categories');
  currentCategory = categorySel.value || null;
  await refreshProducts();

  function updateAnalysisOutput(text) {
    if (analysisOutput) analysisOutput.textContent = text;
  }

  function median(values) {
    if (!values.length) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function linearForecast(rows, field, horizonHours = 168) {
    const samples = rows.slice(-240).map((r) => [Number(r.ts), Number(r[field])])
      .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (samples.length < 2) return null;
    const baseTs = samples[0][0];
    const xs = samples.map((p) => (p[0] - baseTs) / 3600000);
    const ys = samples.map((p) => p[1]);
    const n = xs.length;
    const sumX = xs.reduce((a, b) => a + b, 0);
    const sumY = ys.reduce((a, b) => a + b, 0);
    const sumXY = xs.reduce((a, b, i) => a + b * ys[i], 0);
    const sumXX = xs.reduce((a, b) => a + b * b, 0);
    const denom = (n * sumXX - sumX * sumX) || 1;
    const slope = (n * sumXY - sumX * sumY) / denom;
    const intercept = (sumY - slope * sumX) / n;
    const step = median(samples.slice(1).map((p, i) => p[0] - samples[i][0])) || 3600000;
    const lastTs = samples[samples.length - 1][0];
    const points = [];
    const totalSteps = Math.min(horizonHours, 240);
    for (let i = 1; i <= totalSteps; i += 1) {
      const ts = lastTs + step * i;
      const hours = (ts - baseTs) / 3600000;
      points.push([ts, Number((intercept + slope * hours).toFixed(2))]);
    }
    return { points, slope };
  }

  function spikeSummary(rows, field) {
    const values = rows.map((r) => Number(r[field])).filter((v) => Number.isFinite(v));
    if (values.length < 8) return null;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
    const stdev = Math.sqrt(variance) || 1;
    const spikes = rows.filter((r) => Number.isFinite(r[field]) && Math.abs((r[field] - mean) / stdev) >= 2.5);
    return { count: spikes.length, sample: spikes.slice(-3).map((s) => ({ ts: s.ts, value: s[field] })) };
  }

  function weekOverWeek(rows, field) {
    if (!rows.length) return null;
    const endTs = rows[rows.length - 1].ts;
    const weekMs = 7 * 24 * 3600000;
    const current = rows.filter((r) => r.ts >= endTs - weekMs);
    const prior = rows.filter((r) => r.ts >= endTs - 2 * weekMs && r.ts < endTs - weekMs);
    if (current.length < 5 || prior.length < 5) return null;
    const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
    const currAvg = avg(current.map((r) => Number(r[field])).filter((v) => Number.isFinite(v)));
    const priorAvg = avg(prior.map((r) => Number(r[field])).filter((v) => Number.isFinite(v)));
    if (!Number.isFinite(currAvg) || !Number.isFinite(priorAvg)) return null;
    const delta = priorAvg === 0 ? 0 : ((currAvg - priorAvg) / Math.abs(priorAvg)) * 100;
    return { currAvg, priorAvg, delta };
  }

  analysisButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!currentRows.length || !currentMetric) {
    updateAnalysisOutput('Select a KPI before running a shortcut.');
        return;
      }
      if (currentMetricMode !== 'numeric') {
        updateAnalysisOutput('Shortcuts only run on numeric KPIs. Pick a numeric KPI.');
        return;
      }
      const field = currentMetric;
      if (btn.dataset.action === 'forecast') {
        const forecast = linearForecast(currentRows, field);
        if (!forecast) {
          updateAnalysisOutput('Not enough data to forecast this KPI.');
          return;
        }
        const label = currentProduct
          ? (currentProduct.displayName || currentProduct.name || deviceId(currentProduct))
          : scopeLabel();
        renderChart(currentRows, field, `${label} · ${metricLabel(field)}`, forecast.points, currentMetricMode);
        const dailySlope = forecast.slope * 24;
        updateAnalysisOutput(`Forecast generated for the next 7 days. Trend: ${dailySlope >= 0 ? '+' : ''}${dailySlope.toFixed(2)} per day.`);
      } else if (btn.dataset.action === 'spikes') {
        const spikes = spikeSummary(currentRows, field);
        if (!spikes) {
          updateAnalysisOutput('Not enough data to detect spikes.');
          return;
        }
        if (!spikes.count) {
          updateAnalysisOutput('No unusual spikes detected in the current window.');
          return;
        }
        const last = spikes.sample[spikes.sample.length - 1];
        updateAnalysisOutput(`Detected ${spikes.count} spikes. Latest spike: ${formatTs(Number(last.ts))} at ${Number(last.value).toFixed(2)}.`);
      } else if (btn.dataset.action === 'wow') {
        const wow = weekOverWeek(currentRows, field);
        if (!wow) {
          updateAnalysisOutput('Need at least 14 days of data for week-over-week change.');
          return;
        }
        updateAnalysisOutput(`Week-over-week change: ${wow.delta >= 0 ? '+' : ''}${wow.delta.toFixed(1)}%. Current avg ${wow.currAvg.toFixed(2)} vs prior ${wow.priorAvg.toFixed(2)}.`);
      }
    });
  });

  const chatLog = $('chat-log');
  const chatInput = $('chat-input');
  const chatSend = $('chat-send');
  let conversationId = localStorage.getItem('demoConversationId') || '';

  function pushChatBubble(text, type = 'assistant') {
    if (!chatLog) return;
    const bubble = document.createElement('div');
    bubble.className = `chat-bubble ${type === 'user' ? 'user' : ''}`.trim();
    bubble.textContent = text;
    chatLog.appendChild(bubble);
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  async function sendChatMessage() {
    const text = (chatInput?.value || '').trim();
    if (!text) return;
    pushChatBubble(text, 'user');
    if (chatInput) chatInput.value = '';

    const pageLabel = currentPage || currentProduct?.properties?.page || null;
    const scopeDevices = currentProduct
      ? [deviceId(currentProduct)].filter(Boolean)
      : productList(currentOwner, currentShop, currentPage, currentCategory)
        .map((d) => d.value)
        .filter(Boolean);
    const scopeDeviceZones = {};
    if (pageLabel) {
      scopeDevices.forEach((id) => { scopeDeviceZones[id] = pageLabel; });
    }
    const selection = {
      owner: currentOwner || null,
      shop: currentShop || null,
      page: currentProduct ? null : (currentPage || null),
      products: scopeDevices,
      pages: pageLabel ? [pageLabel] : [],
      shops: currentShop ? [currentShop] : [],
      productPages: scopeDeviceZones,
      labels: {
        owner: currentOwner || null,
        shop: currentShop || null,
        page: pageLabel,
        product: currentProduct ? (currentProduct.displayName || currentProduct.name || deviceId(currentProduct)) : null,
        category: currentCategory || null
      }
    };
    const payload = {
      conversationId: conversationId || undefined,
      messages: [{ role: 'user', content: text }],
      product: currentProduct ? deviceId(currentProduct) : null,
      range: null,
      selection
    };

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error('Chat request failed');
      const data = await res.json();
      if (!conversationId && data.conversationId) {
        conversationId = data.conversationId;
        localStorage.setItem('demoConversationId', conversationId);
      }
      const reply = data?.message?.content || data?.answer || 'No response returned.';
      pushChatBubble(reply, 'assistant');
    } catch (e) {
      pushChatBubble('Unable to reach the assistant. Check the server logs.', 'assistant');
      console.error(e);
    }
  }

  if (chatSend) chatSend.addEventListener('click', sendChatMessage);
  if (chatInput) {
    chatInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') sendChatMessage();
    });
  }
}

init().catch((e) => {
  console.error(e);
  document.body.innerHTML = '<div style="color:white;padding:20px;font-family:system-ui">Failed to load demo data.</div>';
});
