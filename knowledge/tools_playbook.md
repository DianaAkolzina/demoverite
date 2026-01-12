# Commerce Tools Playbook

Preferred tools
- Trendline or KPI summary: fetch_timeseries + stats.
- Compare pages or shops: compare_rooms_on_metric or compare_series_cross_room.
- Spikes and anomalies: detect_spikes + data_gaps.
- Forecast demand or sales: forecast_hourly_linear or forecast_from_profile.
- External impact: correlate or timeseries_regression_join (sales vs temp/cpi/confidence).

Chart guidance
- Always use dataRef in series.
- For forecasts, chart historical + forecast together.

Scope guidance
- Product questions: use the product device ID as the tool scope.
- Page questions: aggregate across products on that page (selectionRooms list).
- Shop/Owner questions: aggregate across all products in scope.

Metric pairing tips
- Sales vs marketing: sales_amount vs ad_spend or roas.
- Traffic vs funnel: visits vs conversion_rate.
- External impact: sales_amount vs consumer_confidence or retail_sales_index.
