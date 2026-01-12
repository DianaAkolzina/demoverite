const fs = require('fs');
const path = require('path');

const OUT_SNAPSHOT = path.join(__dirname, '..', 'data', 'graph_snapshot.json');
const OUT_TELEMETRY = path.join(__dirname, '..', 'data', 'local_telemetry');

const OWNERS = [
  { id: 'northwind_group', name: 'Northwind Retail Group' },
  { id: 'brightline_collective', name: 'Brightline Collective' },
  { id: 'harbor_commerce', name: 'Harbor Commerce Co.' }
];

const SHOPS = [
  { id: 'aurora_outfitters', name: 'Aurora Outfitters', ownerId: 'northwind_group', categories: ['apparel', 'outdoor'] },
  { id: 'harbor_house', name: 'Harbor House', ownerId: 'harbor_commerce', categories: ['home_goods', 'furniture'] },
  { id: 'metro_supply', name: 'Metro Supply', ownerId: 'brightline_collective', categories: ['electronics'] },
  { id: 'lumen_home', name: 'Lumen Home', ownerId: 'brightline_collective', categories: ['home_goods', 'beauty'] },
  { id: 'cedar_and_pine', name: 'Cedar & Pine', ownerId: 'harbor_commerce', categories: ['furniture', 'outdoor'] }
];

const PAGES = [
  { id: 'home', name: 'Home' },
  { id: 'search', name: 'Search' },
  { id: 'category', name: 'Category' },
  { id: 'product_detail', name: 'Product Detail' },
  { id: 'cart', name: 'Cart' },
  { id: 'checkout', name: 'Checkout' },
  { id: 'support', name: 'Support' },
  { id: 'market_signals', name: 'Market Signals' }
];

const PRODUCT_CATALOG = [
  { id: 'bomber_jacket', name: 'Midnight Bomber Jacket', category: 'apparel' },
  { id: 'linen_shirt', name: 'Evergreen Linen Shirt', category: 'apparel' },
  { id: 'trail_sneaker', name: 'Caldera Runner Sneaker', category: 'apparel' },
  { id: 'canvas_tote', name: 'Harbor Canvas Tote', category: 'apparel' },
  { id: 'ceramic_set', name: 'Solstice Ceramic Set', category: 'home_goods' },
  { id: 'glassware', name: 'Lumen Glassware', category: 'home_goods' },
  { id: 'scented_candle', name: 'Velvet Bay Candle', category: 'home_goods' },
  { id: 'wireless_earbuds', name: 'Pulse Wireless Earbuds', category: 'electronics' },
  { id: 'smart_speaker', name: 'Nimbus Smart Speaker', category: 'electronics' },
  { id: 'portable_charger', name: 'Atlas Power Bank', category: 'electronics' },
  { id: 'skin_serum', name: 'Lumen Glow Serum', category: 'beauty' },
  { id: 'hydrating_mask', name: 'Juniper Hydrating Mask', category: 'beauty' },
  { id: 'barstool', name: 'Driftwood Barstool', category: 'furniture' },
  { id: 'accent_chair', name: 'Cedar Accent Chair', category: 'furniture' },
  { id: 'outdoor_blanket', name: 'Juniper Throw Blanket', category: 'outdoor' },
  { id: 'trail_backpack', name: 'Nimbus Trail Backpack', category: 'outdoor' }
];

const EXTERNAL_PRODUCTS = [
  { id: 'weather_feed', name: 'Weather & Seasonality', category: 'external_signals' },
  { id: 'macro_feed', name: 'Macro Indicators', category: 'external_signals' }
];

const COMMERCE_METRICS = [
  'visits', 'sessions', 'add_to_cart_rate', 'conversion_rate', 'bounce_rate',
  'order_count', 'sales_amount', 'avg_order_value', 'items_sold', 'top_item',
  'sale_date', 'ad_spend', 'paid_clicks', 'cpc', 'roas'
];

const EXTERNAL_METRICS = [
  'temp_c', 'precip_mm', 'consumer_confidence', 'cpi',
  'unemployment_rate', 'usd_index', 'retail_sales_index'
];

function mulberry32(seed) {
  let t = seed;
  return function rand() {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function seriesValue(base, amp, dayFactor, weekFactor, noise) {
  return base * (1 + amp * dayFactor) * (1 + 0.12 * weekFactor) + noise;
}

function shopForOwner(ownerId) {
  return SHOPS.filter((shop) => shop.ownerId === ownerId);
}

function productsForShop(shop) {
  return PRODUCT_CATALOG.filter((prod) => shop.categories.includes(prod.category));
}

function buildSnapshot() {
  const now = Date.now();
  const buildings = OWNERS.map((owner, ownerIdx) => {
    const floors = shopForOwner(owner.id).map((shop, shopIdx) => {
      const zones = PAGES.map((page, pageIdx) => {
        const products = page.id === 'market_signals'
          ? EXTERNAL_PRODUCTS
          : productsForShop(shop);
        const devices = products.map((product, productIdx) => {
          const cloudId = `own-${owner.id}-shop-${shop.id}-page-${page.id}-prod-${product.id}`;
          return {
            id: `Device:${cloudId}`,
            name: product.name,
            label: 'Device',
            properties: {
              name: product.name,
              label: 'Product',
              id: `Device:${cloudId}`,
              isActive: true,
              cloudId,
              category: product.category,
              page: page.name,
              shop: shop.name,
              owner: owner.name
            },
            type: 'Commerce',
            cloudId,
            zone: page.name
          };
        });
        return {
          id: `Zone:${shop.id}:${page.id}`,
          name: page.name,
          label: 'Zone',
          roomId: String(pageIdx + 1),
          properties: {
            deviceCount: devices.length,
            name: page.name,
            id: pageIdx + 1,
            originalId: pageIdx + 100,
            isActive: true
          },
          devices
        };
      });
      return {
        id: `Floor:${shop.id}:digital`,
        name: shop.name,
        label: 'Floor',
        properties: {
          name: shop.name,
          id: shopIdx + 1,
          originalId: shopIdx + 1000,
          isActive: true
        },
        zones
      };
    });
    return {
      id: `Owner:${owner.id}`,
      name: owner.name,
      label: 'Building',
      properties: {
        floorCount: floors.length,
        name: owner.name,
        id: ownerIdx + 1,
        originalId: ownerIdx + 10,
        isActive: true,
        lat: 40.7 + ownerIdx * 0.2,
        long: -73.9 - ownerIdx * 0.15
      },
      devices: [],
      floors
    };
  });
  const { nodes, links } = buildGraphFromHierarchy(buildings);
  return { tenant: null, generatedAt: now, buildings, nodes, links };
}

function buildGraphFromHierarchy(buildings) {
  const nodes = [];
  const links = [];
  const seen = new Set();
  const pushNode = (node) => {
    if (!node || !node.id) return;
    if (seen.has(node.id)) return;
    seen.add(node.id);
    nodes.push(node);
  };
  const pushLink = (source, target, rel) => {
    if (!source || !target || !rel) return;
    links.push({ source, target, rel });
  };

  buildings.forEach((building) => {
    pushNode({
      id: building.id,
      label: 'Building',
      nodeType: 'Building',
      name: building.name || null,
      properties: building.properties || {}
    });
    (building.floors || []).forEach((floor) => {
      pushNode({
        id: floor.id,
        label: 'Floor',
        nodeType: 'Floor',
        name: floor.name || null,
        properties: floor.properties || {}
      });
      pushLink(floor.id, building.id, 'LOCATED_IN_BUILDING');
      (floor.zones || []).forEach((zone) => {
        pushNode({
          id: zone.id,
          label: 'Zone',
          nodeType: 'Zone',
          name: zone.name || null,
          roomId: zone.roomId != null ? String(zone.roomId) : null,
          properties: zone.properties || {}
        });
        pushLink(zone.id, floor.id, 'BELONGS_TO_FLOOR');
        (zone.devices || []).forEach((device) => {
          pushNode({
            id: device.id,
            label: 'Device',
            nodeType: 'Device',
            name: device.name || null,
            deviceType: device.type || null,
            cloudId: device.cloudId || device.properties?.cloudId || null,
            properties: device.properties || {}
          });
          pushLink(device.id, zone.id, 'LOCATED_IN_ZONE');
        });
      });
    });
  });

  return { nodes, links };
}

function generateTelemetry() {
  fs.mkdirSync(OUT_TELEMETRY, { recursive: true });
  for (const entry of fs.readdirSync(OUT_TELEMETRY)) {
    if (entry.endsWith('.csv')) {
      fs.unlinkSync(path.join(OUT_TELEMETRY, entry));
    }
  }
  const now = Date.now();
  const stepMs = 60 * 60 * 1000;
  const totalPoints = 24 * 30;

  OWNERS.forEach((owner, ownerIdx) => {
    shopForOwner(owner.id).forEach((shop, shopIdx) => {
      const shopProducts = productsForShop(shop);
      PAGES.forEach((page, pageIdx) => {
        const products = page.id === 'market_signals' ? EXTERNAL_PRODUCTS : shopProducts;
        products.forEach((product, productIdx) => {
          const cloudId = `own-${owner.id}-shop-${shop.id}-page-${page.id}-prod-${product.id}`;
          const filePath = path.join(OUT_TELEMETRY, `${cloudId}.csv`);
          const rng = mulberry32(ownerIdx * 2000 + shopIdx * 400 + pageIdx * 70 + productIdx * 13 + 42);
          const lines = [];
          const metrics = page.id === 'market_signals' ? EXTERNAL_METRICS : COMMERCE_METRICS;
          lines.push(['ts', ...metrics].join(','));

          for (let i = 0; i < totalPoints; i += 1) {
            const ts = now - (totalPoints - 1 - i) * stepMs;
            const hour = new Date(ts).getUTCHours();
            const day = Math.floor(i / 24);
            const dayFactor = Math.sin((Math.PI * 2 * hour) / 24);
            const weekFactor = Math.sin((Math.PI * 2 * day) / 7);
            const baseTraffic = 750 + ownerIdx * 120 + shopIdx * 160 + pageIdx * 90 + productIdx * 15;
            const visits = Math.round(seriesValue(baseTraffic, 0.35, dayFactor, weekFactor, rng() * 40));
            const sessions = Math.round(visits * (0.8 + rng() * 0.15));
            const addToCartRate = clamp(5 + pageIdx * 1.1 + rng() * 3 + dayFactor * 2, 2, 24);
            const conversionRate = clamp(1.8 + pageIdx * 0.6 + rng() * 1.8 + dayFactor * 0.6, 0.7, 9);
            const orders = Math.max(1, Math.round(visits * (conversionRate / 100)));
            const avgOrderValue = clamp(62 + shopIdx * 7 + productIdx * 3 + rng() * 18, 40, 210);
            const salesAmount = orders * avgOrderValue;
            const itemsSold = Math.round(orders * (1.2 + rng() * 0.7));
            const bounceRate = clamp(35 + rng() * 16 - pageIdx * 2 + dayFactor * 2, 16, 72);
            const adSpend = clamp(380 + shopIdx * 80 + rng() * 120 + dayFactor * 25, 100, 1300);
            const paidClicks = Math.round((adSpend / 1.8) * (0.6 + rng() * 0.4));
            const cpc = adSpend / Math.max(paidClicks, 1);
            const roas = salesAmount / Math.max(adSpend, 1);
            const topItem = product.name;
            const saleDate = new Date(ts).toISOString().slice(0, 10);
            const tempC = 8 + 14 * (0.5 + 0.5 * Math.sin((Math.PI * 2 * (day % 365)) / 365)) + rng() * 2;
            const precip = clamp(2 + rng() * 6 + (Math.cos((Math.PI * 2 * day) / 7) * 1.5), 0, 20);
            const consumerConfidence = clamp(92 + Math.sin((Math.PI * 2 * day) / 90) * 6 + rng() * 2, 70, 115);
            const cpi = clamp(297 + Math.sin((Math.PI * 2 * day) / 180) * 2 + rng() * 0.8, 285, 320);
            const unemployment = clamp(4.2 + Math.sin((Math.PI * 2 * day) / 210) * 0.4 + rng() * 0.2, 3.2, 6.2);
            const usdIndex = clamp(99 + Math.sin((Math.PI * 2 * day) / 60) * 3 + rng() * 1.2, 92, 112);
            const retailSales = clamp(112 + Math.sin((Math.PI * 2 * day) / 75) * 4 + rng() * 1.5, 95, 128);

            const row = {
              ts,
              visits,
              sessions,
              add_to_cart_rate: addToCartRate.toFixed(2),
              conversion_rate: conversionRate.toFixed(2),
              bounce_rate: bounceRate.toFixed(2),
              order_count: orders,
              sales_amount: salesAmount.toFixed(2),
              avg_order_value: avgOrderValue.toFixed(2),
              items_sold: itemsSold,
              top_item: topItem,
              sale_date: saleDate,
              ad_spend: adSpend.toFixed(2),
              paid_clicks: paidClicks,
              cpc: cpc.toFixed(2),
              roas: roas.toFixed(2),
              temp_c: tempC.toFixed(2),
              precip_mm: precip.toFixed(2),
              consumer_confidence: consumerConfidence.toFixed(2),
              cpi: cpi.toFixed(2),
              unemployment_rate: unemployment.toFixed(2),
              usd_index: usdIndex.toFixed(2),
              retail_sales_index: retailSales.toFixed(2)
            };

            const values = metrics.map((metric) => row[metric]);
            lines.push([ts, ...values].join(','));
          }

          fs.writeFileSync(filePath, lines.join('\n'));
        });
      });
    });
  });
}

function main() {
  const snapshot = buildSnapshot();
  fs.writeFileSync(OUT_SNAPSHOT, JSON.stringify(snapshot, null, 2));
  generateTelemetry();
  console.log('E-commerce demo data generated.');
}

main();
