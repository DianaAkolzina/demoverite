# Commerce Reasoning Guide

1) Identify scope (owner, shop, page, category, product).
2) Pull KPI series and summarize baseline stats.
3) Look for changes, spikes, or drops.
4) Attribute drivers (page, spend, market signals).
5) Provide recommendations tied to KPIs.

Diagnostic checklist
- Is the scope correct (owner/shop/page/product)?
- Are we looking at a numeric KPI vs text field?
- Is the time window aligned with available telemetry?
- If results are empty, call fetch_table_meta and adapt.

Actionable framing
- Traffic issue: focus on visits, sessions, bounce_rate.
- Funnel issue: focus on add_to_cart_rate and conversion_rate.
- Revenue issue: focus on sales_amount, avg_order_value, order_count.
- Marketing issue: focus on ad_spend, cpc, roas.
