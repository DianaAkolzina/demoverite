# Building Scopes by Tenant

Auto-generated from `data/graph_snapshot.*.json` plus CSV headers under `CSVex_s3/`. Device IDs double as room identifiers for telemetry tools (fetch_timeseries, compare_series_cross_room, etc.).

## Arne

### Arne Retail - Liverpool

**Floors:** Ground Floor

| Zone | Floor | Device | Metrics (CSV headers) |
|------|-------|--------|-----------------------|
| Main Entrance | Ground Floor | `64e52540-8c95-11f0-a19e-8f874a1c01d3` — People Counter (Left Entrance)_L6obJwJXK3yz | line_total_data, line_periodic_data, raw, heatmap, dwell |
| Side Entrance | Ground Floor | `71908fe0-8d68-11f0-a19e-8f874a1c01d3` — Side Entrance_RMgwn2Q7zLeu | line_total_data, line_periodic_data, raw, heatmap, dwell |

## Avm Solutions

### Bolton

**Floors:** First Floor, Ground Floor

| Zone | Floor | Device | Metrics (CSV headers) |
|------|-------|--------|-----------------------|
| Booths | First Floor | `c27807e0-4799-11f0-bf13-bf19a72566f6` — IAQ Sensor_FCBFWLgFwj7k | temperature, humidity, co2, lux, pm25, pressure, pir, o3, pm10, tvoc, raw_data |
| Brainstorm | First Floor | `6ef94be0-479b-11f0-bf13-bf19a72566f6` — Occupancy_MLcfNY8PE5WL | battery, daylight, pir, raw_data, is_used |
|  |  | `f22ffa70-47a2-11f0-bf13-bf19a72566f6` — Temperature_AvYwOcSkqEZb | temperature, humidity, units, raw_data |
| Cafe | First Floor | `abc73b80-4797-11f0-bf13-bf19a72566f6` — IAQ Sensor_P9Zf6DwmbcVQ | temperature, humidity, airExchangeRate, battery, co2, lux, pm1, pm25, pressure, rssi, sla, time |
|  |  | `ab5fb660-872d-11f0-a19e-8f874a1c01d3` — People Counter_xNrPaURS4r6p | line_total_data, line_periodic_data, raw, heatmap, dwell |
| Comms | First Floor | `8e00d400-479a-11f0-bf13-bf19a72566f6` — Energy_BGi4Bzh1KWkJ | value, powerFailure, unit, raw_data, total_kwh |
|  |  | `4a829030-58b9-11f0-a19e-8f874a1c01d3` — Water Meter_AmRUN3AzIrJd | temperature, humidity, battery, raw_data, water_total, cubic_value |
| Huddle | First Floor | `29436890-4798-11f0-bf13-bf19a72566f6` — People Counter_eTcrozehAwoZ | people_count, raw_data |
| Lounge | First Floor | `7318f830-4799-11f0-bf13-bf19a72566f6` — People Counter_BcLWOpRh4Byz | people_count, raw_data |
| Sitdown | First Floor | `b19aae20-479c-11f0-bf13-bf19a72566f6` — Occupancy_lzDbZpSWkLkT | value, units, occupancy, supplyVoltage, raw_data, is_used |
| Standup | First Floor | `64214e60-479c-11f0-bf13-bf19a72566f6` — Temperature_UPLJJkzTgF4v | temperature, humidity, concentration, units, raw_data |
| Toilet | First Floor | `2e857e60-58b9-11f0-a19e-8f874a1c01d3` — Odor _hjtgm3AUNSdO | temperature, humidity, battery, h2s, nh3, raw_data |
|  |  | `002f9dc0-58b9-11f0-a19e-8f874a1c01d3` — Water Leak_MdGf5j3Ae9Zs | battery, raw_data, leakage_status |
| Entrance | Ground Floor | `d9b00270-4797-11f0-bf13-bf19a72566f6` — People Flow_waTDvSKxFbK4 | flow, raw_data |

## Bruntwood

### 111 Piccadilly

**Floors:** Ground Floor

| Zone | Floor | Device | Metrics (CSV headers) |
|------|-------|--------|-----------------------|
| Comms | Ground Floor | `7ae1dc20-6c93-11f0-a19e-8f874a1c01d3` — Mechanical_6GLhDh3LhfoA | value, powerFailure, unit, raw_data, total_kwh |
|  |  | `9e0a8fd0-6c93-11f0-a19e-8f874a1c01d3` — Lighting_AZ8sHHCcBlzW | value, powerFailure, unit, raw_data, total_kwh |
|  |  | `47911c50-6c93-11f0-a19e-8f874a1c01d3` — SmallPower_cOApV9qH6UMo | value, powerFailure, unit, raw_data, total_kwh |
| Coworking | Ground Floor | `45c9aa20-6c90-11f0-a19e-8f874a1c01d3` — IAQ_snIQf0ZRGHAv | temperature, humidity, airExchangeRate, battery, co2, lux, pm1, pm25, pressure, rssi, sla, time |
| Gem | Ground Floor | `91399360-6c92-11f0-a19e-8f874a1c01d3` — IAQ_h9zKxsIn3YYV | temperature, humidity, airExchangeRate, battery, co2, lux, pm1, pm25, pressure, rssi, sla, time |
| Lounge | Ground Floor | `59a22a30-6c87-11f0-a19e-8f874a1c01d3` — IAQ_QhyE1TAlqL4E | temperature, humidity, airExchangeRate, battery, co2, lux, pm1, pm25, pressure, rssi, sla, time |
| Room 1 | Ground Floor | `3966b5f0-6c88-11f0-a19e-8f874a1c01d3` — IAQ_LANa7c0nlzIi | temperature, humidity, airExchangeRate, battery, co2, lux, pressure, rssi, time, virusRisk, voc, occupants |
| Room 2 | Ground Floor | `ad692080-6c8a-11f0-a19e-8f874a1c01d3` — IAQ_y2mcNuuXcDTr | temperature, humidity, airExchangeRate, battery, co2, lux, pressure, rssi, time, virusRisk, voc, occupants |
| Room 3 | Ground Floor | `6a401050-6c8c-11f0-a19e-8f874a1c01d3` — IAQ_KcWGBiSXBgiH | temperature, humidity, airExchangeRate, battery, co2, lux, pressure, rssi, time, virusRisk, voc, occupants |
| Room 4 | Ground Floor | `b6f4f220-6c8d-11f0-a19e-8f874a1c01d3` — IAQ_wUXUUolFJYK9 | temperature, humidity, airExchangeRate, battery, co2, lux, pm1, pm25, pressure, rssi, sla, time |
| Room 5 | Ground Floor | `7ce20b30-6c8e-11f0-a19e-8f874a1c01d3` — IAQ_jb6WMm7pPFHV | temperature, humidity, airExchangeRate, battery, co2, lux, pressure, rssi, time, virusRisk, voc, occupants |
| Room 6 | Ground Floor | `45140b30-6c8f-11f0-a19e-8f874a1c01d3` — IAQ_2Mx02nIKVGL4 | temperature, humidity, airExchangeRate, battery, co2, lux, pressure, rssi, time, virusRisk, voc, occupants |
| Room 7 | Ground Floor | `7800d910-6c8f-11f0-a19e-8f874a1c01d3` — IAQ_tkhi6FivR9TG | temperature, humidity, airExchangeRate, battery, co2, lux, pressure, rssi, time, virusRisk, voc, occupants |
| Room 8 | Ground Floor | `f8816c80-6c8f-11f0-a19e-8f874a1c01d3` — IAQ_BbanNjLRjJEK | temperature, humidity, airExchangeRate, battery, co2, lux, pressure, rssi, time, virusRisk, voc, occupants |

### Alderly Park - Glasshouse

**Floors:** Ground Floor, Lower Ground Floor 

| Zone | Floor | Device | Metrics (CSV headers) |
|------|-------|--------|-----------------------|
| Atrium | Lower Ground Floor  | `a0c62560-5e45-11f0-a19e-8f874a1c01d3` — Air Quality_q9SEzQ03vuNT | temperature, humidity, airExchangeRate, battery, co2, lux, pressure, rssi, time, virusRisk, voc, occupants |
| Nest Communal Area  | Lower Ground Floor  | `f9b436a0-609b-11f0-a19e-8f874a1c01d3` — AirQuality_CzdYrSlKckxh | temperature, humidity, airExchangeRate, battery, co2, lux, pressure, rssi, time, virusRisk, voc, occupants |
| Nest Room 2 | Lower Ground Floor  | `23bd71f0-5110-11f0-a19e-8f874a1c01d3` — Occupancy_i1ymDmZag5ZU | raw, motion |
|  |  | `57e509c0-5110-11f0-a19e-8f874a1c01d3` — AirQuality_HfliLr0LatGk | temperature, humidity, airExchangeRate, battery, co2, lux, pressure, rssi, time, virusRisk, voc, occupants |
| Nest Room 3 | Lower Ground Floor  | `2a8a87d0-510a-11f0-a19e-8f874a1c01d3` — Occupancy_UrRGGx1yVrVx | raw, motion |
|  |  | `cc2bfec0-510f-11f0-a19e-8f874a1c01d3` — Air Quality Sensor_9nSx5N2jVJHw | temperature, humidity, airExchangeRate, battery, co2, lux, pressure, rssi, time, virusRisk, voc, occupants |
| Nest Room 4 | Lower Ground Floor  | `54f3cc50-5107-11f0-a19e-8f874a1c01d3` — Occupancy_dd6YYksRCt7R | raw, motion |
|  |  | `89b46fd0-5107-11f0-a19e-8f874a1c01d3` — AirQuality_G9i2CHgM8TzP | temperature, humidity, airExchangeRate, battery, co2, lux, pressure, rssi, time, virusRisk, voc, occupants |

### Circle Square No 1

**Floors:** 1st Floor, Basement, Ground Floor

| Zone | Floor | Device | Metrics (CSV headers) |
|------|-------|--------|-----------------------|
| Reception | Ground Floor | `99012c60-50e1-11f0-a19e-8f874a1c01d3` — People Counter_6R0wXsPfzuXM | line_total_data, line_periodic_data, raw |

### The Plaza - Unlimited

**Floors:** Ground Floor

| Zone | Floor | Device | Metrics (CSV headers) |
|------|-------|--------|-----------------------|
| Retail | Ground Floor | `45f598f0-6c8c-11f0-a19e-8f874a1c01d3` — Main Entrance_OW1VbG6SsBif | line_total_data, line_periodic_data, raw |

### Union

**Floors:** 2nd Floor, 3rd Floor, Basement, Ground Floor

| Zone | Floor | Device | Metrics (CSV headers) |
|------|-------|--------|-----------------------|
| Gym Entrance | Basement | `77fc2b70-5e68-11f0-a19e-8f874a1c01d3` — People Counter_uoOiB9182DzV | line_total_data, line_periodic_data, raw |
| Main Entrance | Ground Floor | `57755650-5e69-11f0-a19e-8f874a1c01d3` — People Counter_0iohextObDjz | line_total_data, line_periodic_data, raw |

## Cbre

## Emerson Group

### 55 King Street

**Floors:** 3rd Floor, 4th Floor, 6th Floor, Basement, Ground Floor

| Zone | Floor | Device | Metrics (CSV headers) |
|------|-------|--------|-----------------------|
| Orbit Suit | 6th Floor | `fa5d8730-6647-11f0-a19e-8f874a1c01d3` — Energy_6Dg3CB7CR8iy | raw_data, total_kwh |
| Suite 6.1 | 6th Floor | `44e34970-6648-11f0-a19e-8f874a1c01d3` — CO2_ErFIKXsDjzLn | co2, raw_data |
|  |  | `60470170-6648-11f0-a19e-8f874a1c01d3` — Humidity_0CCXiSsa35UF | humidity, raw_data |
|  |  | `89ad2670-6648-11f0-a19e-8f874a1c01d3` — Temperature_n2HWkemA5Ps9 | temperature, raw_data |
|  |  | `cf271990-6648-11f0-a19e-8f874a1c01d3` — Energy_JIYQV161Yotw | raw_data, total_kwh |
| Suite 6.2 | 6th Floor | `600552a0-664a-11f0-a19e-8f874a1c01d3` — Energy_3Z99vDWK76va | raw_data, total_kwh |
| Suite 6.3 | 6th Floor | `8bd8ce20-664a-11f0-a19e-8f874a1c01d3` — Energy_vDBYNqYhdDm5 | raw_data, total_kwh |
| Suite 6.4 | 6th Floor | `ae728840-664a-11f0-a19e-8f874a1c01d3` — Energy_vACnx5Y8XoGG | time, raw_data, total_kwh |
| Suite 6.5 | 6th Floor | `072b8b80-664b-11f0-a19e-8f874a1c01d3` — CO2_qafxEt2K6qLZ | co2, raw_data |
|  |  | `183915a0-664b-11f0-a19e-8f874a1c01d3` — Humidity_GmHKeXkhhER5 | humidity, raw_data |
|  |  | `31831560-664b-11f0-a19e-8f874a1c01d3` — Temperature_n86EEaC4v1YC | temperature, raw_data |
|  |  | `21072930-66d5-11f0-a19e-8f874a1c01d3` — Energy 1_AhSbBfdzW11o | raw_data, total_kwh |
|  |  | `548e6250-66d5-11f0-a19e-8f874a1c01d3` — Energy 2_lyx4NPLa9vaH | raw_data, total_kwh |

## Form Property

## Innov8

### SoapWorks

**Floors:** First Floor, Fourth Floor, Ground Floor, Second Floor, Third Floor

| Zone | Floor | Device | Metrics (CSV headers) |
|------|-------|--------|-----------------------|
| Comms | Ground Floor | `0c863990-662d-11f0-a19e-8f874a1c01d3` — Basement Mechanical_MRty02BgMoo3 | value |

## Sedulo

## Tsk

### Salford Office

**Floors:** 1st Floor, Ground Floor

| Zone | Floor | Device | Metrics (CSV headers) |
|------|-------|--------|-----------------------|
| Office Space | 1st Floor | `7dd934b0-5da1-11f0-a19e-8f874a1c01d3` — IAQ_UXqnXikCoxCo | temperature, humidity, co2, pressure, pir, pm10, tvoc, raw_data, hcho, light_level, pm2_5 |
| Entrance | Ground Floor | `940c81c0-5da5-11f0-a19e-8f874a1c01d3` — People Counter_aUjiPbTe0N41 | raw_data, period_in, period_out, total_in, total_out |
| Reception | Ground Floor | `6bf5e730-5da5-11f0-a19e-8f874a1c01d3` — IAQ_QTnlLHfN4fdi | temperature, humidity, co2, pressure, pir, pm10, tvoc, raw_data, hcho, light_level, pm2_5 |
| Utility Room | Ground Floor | `04e4dce0-5da5-11f0-a19e-8f874a1c01d3` — Energy_1_bU9Kpvhdb1ha | raw_data, channel_1, channel_total |
|  |  | `24085c00-5da5-11f0-a19e-8f874a1c01d3` — Energy_2_APK6EFUywGsZ | raw_data, channel_1, channel_total |
|  |  | `3dec03b0-5da5-11f0-a19e-8f874a1c01d3` — Energy_3_chWgZ8ejd6wv | raw_data, channel_1, channel_total |

### Site Monitoring Kit 1

**Floors:** Default

| Zone | Floor | Device | Metrics (CSV headers) |
|------|-------|--------|-----------------------|
| Portable | Default | `fd0fc870-5e50-11f0-a19e-8f874a1c01d3` — Water_JTTcwf8VtSgM | temperature, humidity, battery, raw_data, water, pulse_conv, water_conv |
|  |  | `382a8d00-5e51-11f0-a19e-8f874a1c01d3` — Energy_kN0RKEsJ3Ovx | unknown |
|  |  | `4edb6b50-5e51-11f0-a19e-8f874a1c01d3` — IAQ_d2UHqNNnIEif | unknown |

### Site Monitoring Kit 2

**Floors:** Default

| Zone | Floor | Device | Metrics (CSV headers) |
|------|-------|--------|-----------------------|
| Portable | Default | `c0267380-5e52-11f0-a19e-8f874a1c01d3` — IAQ2_s9YPaKXl0puP | temperature, humidity, co2, pressure, pir, pm10, tvoc, raw_data, hcho, light_level, pm2_5 |
|  |  | `d12a39a0-5e52-11f0-a19e-8f874a1c01d3` — IAQ3_Uf9G16GNKXXu | temperature, humidity, co2, pressure, pir, pm10, tvoc, raw_data, hcho, light_level, pm2_5 |
|  |  | `8e12c790-5e52-11f0-a19e-8f874a1c01d3` — Energy_CjZE7eOwq4wa | unknown |
|  |  | `a01a4210-5e52-11f0-a19e-8f874a1c01d3` — IAQ1_vYzYpoY7u1CN | temperature, humidity, co2, pressure, pir, pm10, tvoc, raw_data, hcho, light_level, pm2_5 |
|  |  | `2e0522a0-9866-11f0-a19e-8f874a1c01d3` — Water Meter_MbiKu6lQAq1Y | unknown |
