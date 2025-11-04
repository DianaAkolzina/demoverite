# Graph Generation and Attributes (Fast Scope Awareness)

This knowledge pack documents how the building graph is generated, what attributes each node carries, and the shortest-path strategies to resolve scope fast (UI and agent).

## Node Types
- Tenant:
  - Represents an organisation or customer.
  - Attributes include `id`, `name`, `domain_name`, `is_active`, `reseller_id`.
- Building:
  - Physical site owned by a tenant.
  - Attributes: `id`, `name`, `tenantID`, `lat`, `long`, `is_active`, `floor_count`.
- Floor:
  - Represents a level within a building.
  - Attributes: `id`, `name`, `buildingID`, `tenantID`, `is_active`, `zone_count`.
- Zone (aka Room):
  - Spatial subdivision for devices.
  - Attributes: `id`, `name`, `floorID`, `buildingID`, `tenantID`, `is_active`, `device_count`.
- Device:
  - IoT endpoint deployed in a zone/floor/building.
  - Attributes: `id`, `name`, `type`/`deviceType`, `cloudId`, `tenantID`, `buildingID`, `floorID`, `zoneID`, `deviceProfileID`, `is_active`, `licence_status`.
- Device Profile:
  - Template/metadata describing a class of devices.
- Telemetry Key:
  - Data point definition emitted by a device (e.g. `temperature`, `powerFailure`).
- User:
  - Person interacting with the system (engineer, operator, etc.).
- Role:
  - Permission bundle assigned to a user.

## Relationships
- `BELONGS_TO_TENANT` (Building / Floor / Zone / Device / User → Tenant)
- `PART_OF_BUILDING` (Floor / Zone → Building)
- `PART_OF_FLOOR` (Zone → Floor)
- `LOCATED_IN_BUILDING` (Device → Building)
- `LOCATED_ON_FLOOR` (Device → Floor)
- `LOCATED_IN_ZONE` (Device → Zone)
- `HAS_PROFILE` (Device → Device Profile)
- `HAS_TELEMETRY_KEY` / `MEASURES` (Device ↔ Telemetry Key)
- `ASSOCIATED_WITH_BUILDING` (User → Building)
- `HAS_ROLE` (User → Role)

## Shortest Paths for Scope Resolution
- Always resolve UI selections with the following order for best latency:
  1) Local snapshot JSON under `/data/graph_snapshot.<tenant>.json` (or `/data/graph_snapshot.json`) → parse nodes/links in-memory.
  2) Cached server endpoints `/api/scope/metrics` → 12s TTL.
  3) Cached `/api/topology` → 15s TTL.
  4) Cached `/api/graph/full` → 20s TTL (serves snapshot file if present).
- Floors for a building:
  - From snapshot: Floors with `PART_OF_BUILDING` to the selected building AND at least one device reachable via Zone (`PART_OF_FLOOR` → Zone and `LOCATED_IN_ZONE` → Device).
- Zones for a floor:
  - From snapshot: Zones with `PART_OF_FLOOR` to the selected floor AND at least one device via `LOCATED_IN_ZONE`.
- Devices for a zone/floor/building:
  - Prefer devices reachable via:
    - Zone: `LOCATED_IN_ZONE`.
    - Floor: `LOCATED_ON_FLOOR` plus devices via Zones under that floor.
    - Building: `IN_BUILDING` plus devices via Floors/Zones.
  - Filter to devices with local S3 data: CSV exists in `CSVex_s3/<cloud_id>.csv`.

## Metrics (Telemetry Keys)
- Preferred source: Graph `HAS_TELEMETRY_KEY`/`MEASURES` to gather TelemetryKey names for each device.
- Fallback: CSV headers (first row) from `CSVex_s3/<cloud_id>.csv` excluding `ts`.
- Typical IAQ keys: `temperature`, `humidity`, `co2`, `pm25`, `pm10`, `lux`, `airexchangerate`.
- People counters: `people_count`, `line_total_data`, `line_periodic_data`, `raw`.

## Agent Guidance
- For scope questions (“what scope is selected”, “what scope do you see”):
  - Use the snapshot-first path to enumerate devices and metrics quickly.
  - Return a nested list: Building → Floor → Zone → Device: metrics (keys).
- For analysis:
  - First query data (tools like `fetch_timeseries`, `stats`, `hour_of_day_stats`).
  - Then consult knowledge. Choose charts with `dataRef`. Avoid embedding arrays.

## Example Devices (from provided headers)
- Buildings: 74 Pall Mall (floors=4), 54 Cornerblock (floors=4), 29 Booths Park 1 (floors=1), 71 Mclaren Building (floors=2), 68 Landmark House (floors=1), 4 Centurion House (floors=2), 34 Cotton House - Manchester (floors=1)
- Device Profiles: Digispace Gateway, People Counter, Occupancy Sensors, Control Devices, Energy Clamps, Air Quality Sensors, Leak Detector, Water Management
- Telemetry Keys example for People Counter: `['line_total_data','line_periodic_data','raw']`

## Notes
- When building/floor/zone names are ambiguous, prefer link-based disambiguation: resolve zone under floor, then floor under building via the declared relationships.
- If the tenant is set in UI, always restrict scope resolution to that tenant’s subgraph.
