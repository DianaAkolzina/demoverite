# Commerce CSV Column Map

All telemetry CSVs share a `ts` column (milliseconds since epoch) plus product-specific metrics.

## Commerce KPIs
visits, sessions, add_to_cart_rate (%), conversion_rate (%), bounce_rate (%)
order_count, sales_amount ($), avg_order_value ($), items_sold
ad_spend ($), paid_clicks, cpc ($), roas
top_item (string), sale_date (YYYY-MM-DD)

## External Signals
temp_c, precip_mm, consumer_confidence, cpi, unemployment_rate (%), usd_index, retail_sales_index

## Usage notes
- `sales_amount` and `avg_order_value` are dollar amounts.
- `conversion_rate` and `add_to_cart_rate` are percentages.
- `top_item` is a text field; avoid numeric stats for it.
- `sale_date` is a text date; use for labeling or grouping only.
