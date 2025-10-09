Reasoning Guide for Queries and Math Mapping

- Time windows:
  - Always use the exact Start and End dates provided by the user.
  - Do not predict values for dates that are already in the past.
  - If a user asks for the “best day/time” without a historical qualifier, interpret it as future planning and use forecasting or seasonality.

- Word → Math mapping:
  - best, most, highest, peak → max
  - worst, least, lowest, minimum → min
  - total, sum → sum
  - average, avg, mean → avg
  - trend, over time → time series
  - relationship, influence → scatter/correlation
  - distribution → histogram
  - share, composition → pie/stacked

- Tool selection hints:
  - max/min/sum/avg over period → stat
  - compare floors/rooms → stacked or pie; table grouped by floor/sensor
  - busiest day of week → seasonality(period=week) and/or forecast occupancy
  - best cleaning window → occupancy minima by hour/day, seasonality(period=week)
  - most energy and why → forecast(energy_kwh) + scatter(weather, occupancy) for drivers
  - anomalies → night baseload vs occupancy, water use outside occupancy

