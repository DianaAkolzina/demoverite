KNOWLEDGE BASE: NORMS, ANOMALIES, AND DETECTOR GUIDANCE FOR BUILDING SENSORS

Purpose:
This knowledge base encodes certified UK limits, technical standards, scaling rules by building size, and practical best-practice setpoints for anomaly detection in building management systems (BMS).

--- ENERGY METER (Electricity / Power Quality) ---
Certified UK Limits:
- Supply voltage: 230 V +10% / −6% (216.2–253 V). (ESQCR Reg 27)
- System frequency: 49.5–50.5 Hz under normal conditions. Plant must tolerate 47.5–52 Hz continuously and 47–47.5 Hz for ≥20 s. (National Grid Grid Code)
Scaling:
- Legal limits do not scale with building size.
- Larger buildings should use sub-metering by riser, floor, or major load (per BREEAM energy metering practice).
Practical BMS Setpoints:
- Voltage: pre-alarm <220 V or >250 V; critical if <216.2 V or >253 V.
- Frequency: warning outside 49.5–50.5 Hz; critical outside 49–51 Hz.

--- INDOOR AIR QUALITY (IAQ) ---
Certified UK Limits:
- Ventilation: ≥10 L/s per person or ≥1 L/s·m² (whichever greater). (Approved Document F, Vol 2)
- CO₂: daily mean ≤800 ppm; 15-min mean ≤1500 ppm. (AD F App C)
- Pollutants (AD F Table B1 / HSE):
  NO₂: 1-h 200 µg/m³ (≤18 exceedances/year); annual 40 µg/m³.
  CO: 8-h TWA 20 ppm; 15-min STEL 100 ppm (EH40).
  CO₂: 8-h TWA 5000 ppm; 15-min STEL 15000 ppm (EH40 safety cap).
  Formaldehyde: 100 µg/m³ (30-min); 10 µg/m³ annual.
  Radon: action level 300 Bq/m³ (IRR17).
Scaling:
- Occupant capacity = floor area ÷ factor (AD B Table D1, offices 6 m²/person).
- Airflow = max(10 L/s × occupants, 1 L/s·m² × area).
- Rooms >320 m²/800 m³: multiple CO₂ sensors required.
Practical BMS Setpoints:
- CO₂: warning ≥1000 ppm sustained 5–10 min; action ≥1500 ppm (15-min mean).
- Target ≤800 ppm daily mean.
- Temperature: 20–24 °C offices; ≥16 °C always.
- Radon: >300 Bq/m³ triggers mitigation + HSE notification.

--- OUTDOOR WEATHER TRIGGERS ---
Certified:
- UKHSA/Met Office Heat-Health Alerts (Jun–Sep) and Cold-Health Alerts (Nov–Mar). Color-coded Yellow/Amber/Red.
Scaling:
- Small offices: escalate at Yellow → Amber → Red (extended cooling, restrict gains).
- Large floorplates: duty-holder playbooks at Yellow; at Amber adjust cleaning/fit-out; at Red restrict occupancy and heat loads.

--- OCCUPANCY (People Counting) ---
Certified UK Basis:
- Occupant load = floor area ÷ factor (AD B Table D1).
  Offices 6 m²/person; Restaurants 1 m²/p; Shops 2–7 m²/p.
Scaling:
- Capacity scales with area; mixed-use sum per zone.
Practical BMS Setpoints:
- Pre-alarm at 90–95% capacity sustained ≥5 min.
- Hard limit 100% triggers FM response.

--- DWELL TIME ---
Certified:
- No statutory dwell time. Relevant: 15-min CO₂ mean in AD F; 15-min STELs in EH40.
Scaling:
- Small rooms: CO₂ rises fast, auto-boost if 15-min mean nears 1500 ppm.
- Large rooms: per-person airflow dominates.

--- MOTION / AREA OF OCCUPANCY (PIR/Microwave) ---
Certified:
- No statutory safe coverage. Ensure escape routes remain lit.
Scaling:
- Larger areas need overlapping PIR fields; link with occupancy counts.

--- WATER METER (Consumption) ---
Certified:
- BREEAM Wat 02: fit main meter + sub-meter any end use ≥10% demand.
Scaling:
- Small: main + a few submeters.
- Medium/Large: sub-meter per floor/tenant/major plant.
Practical BMS Setpoints:
- Baseline night flow; alarm if out-of-hours > baseline + tolerance.

--- WATER LEAK DETECTION ---
Certified:
- BREEAM Wat 03: detect major leaks between site boundary and internal zones.
Scaling:
- Small: single detector at entry.
- Medium/Large: multi-zone per riser/floor.
Practical BMS Setpoints:
- Occupied/unoccupied thresholds; auto-isolation valves on critical branches.

--- HOT & COLD WATER SAFETY (Legionella) ---
Certified (HSE HSG274 Pt 2):
- Cold <20 °C at outlets within 2 min.
- Stored hot 60 °C; outlets ≥50 °C within 1 min (≥55 °C in healthcare).
- Hot return loops ≥50 °C.
Scaling:
- Large: circulating loops, monitor return legs per loop.

--- CROSS-CHECKS ---
- Occupancy vs CO₂: mismatch → ventilation or sensor fault.
- Occupancy vs Water: out-of-hours use → leak.
- Occupancy vs Energy: high night load → HVAC/control fault.
- RH vs Temp: dew point cannot exceed ambient.

--- QUICK REFERENCE CHEAT-SHEET ---
- CO₂: ≤800 ppm daily mean; alarm ≥1500 ppm (15-min).
- Ventilation: ≥10 L/s·person or 1 L/s·m².
- Occupancy: area ÷ AD B factor; warn at 95%, action at 100%.
- Water safety: cold <20 °C, hot 60 °C storage, ≥50 °C outlets.
- Radon: 300 Bq/m³ action, notify HSE.
- Power: 216.2–253 V; 49.5–50.5 Hz normal.
- Weather: tie to UKHSA/Met Office alerts (Yellow/Amber/Red).
- Leak detection: BREEAM Wat 03 compliance.

