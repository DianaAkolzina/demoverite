# E-commerce Demo Knowledge

Overview
This demo models e-commerce performance across shop owners, storefronts, pages, categories, and products with synthetic KPIs plus simulated external signals. Use it to answer questions about revenue, conversion, traffic, marketing efficiency, and external drivers.

Shop owners (tenants)
- Northwind Retail Group
- Brightline Collective
- Harbor Commerce Co.

Storefront sectors (shops)
- Aurora Outfitters: apparel and outdoor
- Harbor House: home goods and furniture
- Metro Supply: consumer electronics
- Lumen Home: home goods and beauty
- Cedar & Pine: furniture and outdoor

Pages (journey stages)
Home, Search, Category, Product Detail, Cart, Checkout, Support, Market Signals.

Commerce hierarchy
- Shop Owner -> Shop -> Page -> Product

Core KPIs
- Traffic: visits, sessions, bounce_rate
- Funnel: add_to_cart_rate, conversion_rate
- Orders & revenue: order_count, items_sold, sales_amount, avg_order_value
- Marketing: ad_spend, paid_clicks, cpc, roas

External signals (Market Signals page)
- Weather: temp_c, precip_mm
- Macro: consumer_confidence, cpi, unemployment_rate, usd_index, retail_sales_index

Interpretation notes
- conversion_rate is a percentage of visits converting to orders.
- add_to_cart_rate is a percentage of visits that add at least one item.
- sales_amount is total revenue in dollars; avg_order_value is per-order average.
- roas = sales_amount / ad_spend (higher is better).

Data notes
- Timestamps (ts) are milliseconds since epoch.
- KPIs are hourly for ~30 days of synthetic data.
- Categories live on product metadata (e.g., apparel, electronics, furniture).
