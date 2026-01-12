const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const KNOWLEDGE_DIR = path.join(ROOT, 'knowledge');

const contentByFile = {
  'general.md': `# E-commerce Demo Knowledge

Overview: This demo models e-commerce performance across shop owners, storefronts, pages, categories, and products with synthetic KPIs plus simulated external signals.

Shop owners
- Northwind Retail Group
- Brightline Collective
- Harbor Commerce Co.

Storefront sectors
- Aurora Outfitters: apparel and outdoor
- Harbor House: home goods and furniture
- Metro Supply: consumer electronics
- Lumen Home: home goods and beauty
- Cedar & Pine: furniture and outdoor

Pages
Home, Search, Category, Product Detail, Cart, Checkout, Support, Market Signals.

Notes
- Categories live on product metadata (e.g., apparel, electronics, furniture).
- Market Signals page holds external indicators (weather + macro).
- Timestamps (ts) represent the sale date/time for commerce KPIs.
`,
  'graph_knowledge.md': `# Commerce Topology

The topology follows the commerce hierarchy:
- Shop Owner (building) -> Shop (floor) -> Page (zone) -> Product (device).

Categories
- Categories are stored on the product device metadata.
- Use category filtering to compare product performance within a page.

External indicators
- Market Signals page exposes weather + macro metrics.
`,
  'column_map.md': `# Commerce CSV Column Map

All telemetry CSVs share a \`ts\` column (milliseconds since epoch) plus product-specific metrics.

## Commerce KPIs
visits, sessions, add_to_cart_rate (%), conversion_rate (%), bounce_rate (%)
order_count, sales_amount ($), avg_order_value ($), items_sold
ad_spend ($), paid_clicks, cpc ($), roas
top_item (string), sale_date (YYYY-MM-DD)

## External Signals
temp_c, precip_mm, consumer_confidence, cpi, unemployment_rate (%), usd_index, retail_sales_index
`,
  'telemetry_keys.md': `# Commerce Telemetry Keys

Numeric metrics
- visits, sessions, add_to_cart_rate, conversion_rate, bounce_rate
- order_count, sales_amount, avg_order_value, items_sold
- ad_spend, paid_clicks, cpc, roas
- temp_c, precip_mm, consumer_confidence, cpi, unemployment_rate, usd_index, retail_sales_index

Text metrics
- top_item
- sale_date
`,
  'tools_playbook.md': `# Commerce Tools Playbook

Preferred tools
- Trendline or KPI summary: fetch_timeseries + stats.
- Compare pages or shops: compare_rooms_on_metric or compare_series_cross_room.
- Spikes and anomalies: detect_spikes + data_gaps.
- Forecast demand or sales: forecast_hourly_linear or forecast_from_profile.
- External impact: correlate or timeseries_regression_join (sales vs temp/cpi/confidence).

Chart guidance
- Always use dataRef in series.
- For forecasts, chart historical + forecast together.
`,
  'performance_trends_queries.md': `# Performance Trend Queries

Examples
- How are conversions trending for Checkout in Aurora Outfitters?
- Compare sales_amount across all shops this week.
- Which page has the highest bounce_rate?
- Show ROAS vs ad_spend trend for Harbor House.
`,
  'predictive_planning_queries.md': `# Predictive Planning Queries

Examples
- Forecast sales_amount for Metro Supply over the next 7 days.
- Predict conversion_rate for Cart page next week.
- Estimate visits given the latest market signals.
- Forecast orders when consumer_confidence rises by 5 points.
`,
  'rag_best_practices.md': `# RAG Best Practices (Commerce)

- Respect the selected owner/shop/page/category/product scope and time window.
- Use tool outputs for evidence; do not invent KPIs.
- If data is missing, call fetch_table_meta and explain adaptation.
- Tie insights to concrete actions (pricing, promotion, funnel fixes).
`,
  'roles.md': `# Commerce Roles

- Growth: traffic, conversion, CAC, ROAS.
- Merchandising: top items, AOV, category performance.
- Operations: fulfillment, returns, customer support load.
- Finance: revenue, margin proxies, macro sensitivity.
`,
  'reasoning.md': `# Commerce Reasoning Guide

1) Identify scope (owner, shop, page, category, product).
2) Pull KPI series and summarize baseline stats.
3) Look for changes, spikes, or drops.
4) Attribute drivers (page, spend, market signals).
5) Provide recommendations tied to KPIs.
`,
  'norms.md': `# Commerce KPI Norms (Typical Ranges)

- Conversion rate: 1% to 6%
- Add-to-cart rate: 5% to 15%
- Bounce rate: 30% to 60%
- ROAS: 2x to 6x
- AOV: varies by sector; compare shop-to-shop
`,
  'regressions.md': `# Commerce Regression Notes

Use correlate or timeseries_regression_join to link KPIs:
- sales_amount vs ad_spend
- conversion_rate vs temp_c or consumer_confidence
- visits vs retail_sales_index
`,
  'weather_data.md': `# External Signals Data

External signals simulate typical API feeds:
- Weather: temp_c, precip_mm
- Macro: consumer_confidence, cpi, unemployment_rate, usd_index, retail_sales_index

These are generated daily/hourly and align with shop timestamps.
`,
  'weather_impact.md': `# External Impact Guidance

Weather and macro indicators can shift demand:
- Cold or rainy periods can lift indoor categories.
- Confidence and retail_sales_index trend with discretionary spend.
- Rising unemployment can soften conversion and AOV.
`,
  'weather_queries.md': `# External Signals Queries

Examples
- Correlate sales_amount with consumer_confidence for Aurora Outfitters.
- Does precip_mm change visits for Harbor House?
- Compare conversion_rate during high vs low CPI windows.
`,
  'air_quality_queries.md': `# Acquisition Quality Queries

Examples
- Which shop has the healthiest bounce_rate this week?
- Show visits and sessions trend for the Search page.
`,
  'bolton_scope.md': `# Shop Scope Notes

Use shop names as the primary scope for analysis.
Market Signals page contains external indicators.
`,
  'building_scopes.md': `# Commerce Scopes

Shop Owner -> Shop -> Page -> Product is the hierarchy.
Categories are stored on product metadata.
Compare shops for sector-level benchmarking.
`,
  'co2.md': `# Traffic Quality Notes

Use bounce_rate and session depth as proxies for traffic quality.
`,
  'comfort_env_queries.md': `# Customer Experience Queries

Examples
- Which page shows conversion drop-offs after a campaign?
- Compare add_to_cart_rate before and after a price change.
`,
  'energy.md': `# Revenue Concepts

Use sales_amount, order_count, and AOV for revenue health.
`,
  'energy_optimizations.md': `# Pricing & Promo Optimizations

Optimize ROAS and AOV by testing offers and timing.
`,
  'energy_queries.md': `# Revenue Queries

Examples
- Trend sales_amount for each shop.
- Which shop has the highest AOV this month?
`,
  'hvac_scheduling.md': `# Campaign Scheduling

Align marketing bursts with forecasted demand windows.
`,
  'iaq_guidelines.md': `# Site Performance Guidelines

Aim for stable conversion_rate and low bounce_rate during peak traffic.
`,
  'lighting_queries.md': `# Merchandising Queries

Examples
- Which top_item is leading sales for Lumen Home?
- Compare items_sold by page for Cedar & Pine.
`,
  'occupancy_best_practices.md': `# Traffic Best Practices

Monitor visits and sessions; watch for sudden declines.
`,
  'occupancy_queries.md': `# Traffic Queries

Examples
- Peak visits by hour for Metro Supply.
- Weekday vs weekend sessions for Aurora Outfitters.
`,
  'performance_trends_queries.md': `# Performance Trend Queries

Examples
- How are conversions trending for Checkout in Aurora Outfitters?
- Compare sales_amount across all shops this week.
`,
  'predictive_planning_queries.md': `# Predictive Planning Queries

Examples
- Forecast sales_amount for Metro Supply over the next 7 days.
- Predict conversion_rate for Cart page next week.
`,
  'safety_ops_queries.md': `# Fraud & Ops Queries

Examples
- Identify spikes in order_count without matching visits.
- Flag sudden ROAS drops after spend increases.
`,
  'temperature.md': `# Conversion Rate Notes

Track conversion_rate by page and compare across shops.
`,
  'water_queries.md': `# Returns Queries

Examples
- Identify days with high return signals (proxy via top_item shifts).
`,
  'tools_reference.md': null
};

function writeKnowledge() {
  for (const entry of fs.readdirSync(KNOWLEDGE_DIR)) {
    if (!entry.endsWith('.md')) continue;
    const content = contentByFile[entry];
    if (content === null) continue;
    if (typeof content !== 'string') continue;
    fs.writeFileSync(path.join(KNOWLEDGE_DIR, entry), content);
  }
}

writeKnowledge();
console.log('E-commerce knowledge refreshed.');
