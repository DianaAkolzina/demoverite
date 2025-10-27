Entities (Nodes):

Device

Tenant

Building

Floor

Zone

User

Role

DeviceProfile

TelemetryKey

Relationships:
From Device

Device → Tenant: BELONGS_TO_TENANT
Each device is associated with a specific tenant.

Device → Floor: LOCATED_ON_FLOOR
The device is physically located on a particular floor.

Device → Zone: LOCATED_IN_ZONE
The device is located in a particular zone within a building.

Device → Building: IN_BUILDING
The device resides inside a specific building.

Device → DeviceProfile: HAS_DEVICE_PROFILE
The device has a corresponding profile that defines its configuration or type.

Device → TelemetryKey: HAS_TELEMETRY_KEY
The device produces telemetry data associated with specific telemetry keys.

From Tenant

Tenant → Device: BELONGS_TO_TENANT
Devices are linked back to their tenant.

Tenant → Building: BELONGS_TO_TENANT
Each building belongs to a tenant.

Tenant → Zone: BELONGS_TO_TENANT
Each zone belongs to a tenant.

Tenant → Floor: BELONGS_TO_TENANT
Each floor belongs to a tenant.

Tenant → User: BELONGS_TO_TENANT
Users are associated with a tenant.

Tenant → Role: HAS_ROLE
A tenant defines or possesses specific user roles.

From User

User → Role: HAS_ROLE
A user is assigned one or more roles under the tenant.

User → Building: ASSOCIATED_WITH_BUILDING
A user has an association with one or more buildings, likely representing access or management permissions.

User → Tenant: BELONGS_TO_TENANT
The user belongs to a particular tenant.

From Zone

Zone → Building: LOCATED_IN_BUILDING
Each zone is contained within a specific building.

Zone → Tenant: BELONGS_TO_TENANT
Each zone belongs to a tenant.

From Floor

Floor → Building: LOCATED_IN_BUILDING
Each floor is part of a specific building.

Floor → Tenant: BELONGS_TO_TENANT
Each floor belongs to a tenant.

From Building

Building → Tenant: BELONGS_TO_TENANT
Each building is managed or owned by a tenant.

Summary View
Source	Relationship Type	Target	Meaning
Device	BELONGS_TO_TENANT	Tenant	Device is owned by a tenant
Device	LOCATED_ON_FLOOR	Floor	Device is located on a specific floor
Device	LOCATED_IN_ZONE	Zone	Device is in a particular zone
Device	IN_BUILDING	Building	Device is physically inside a building
Device	HAS_DEVICE_PROFILE	DeviceProfile	Device has a defined device profile
Device	HAS_TELEMETRY_KEY	TelemetryKey	Device emits telemetry data with specific telemetry keys
Tenant	BELONGS_TO_TENANT	Building, Zone, Floor, User, Device	Tenant owns or manages these entities
Tenant	HAS_ROLE	Role	Tenant defines user roles
User	HAS_ROLE	Role	User is assigned a role
User	ASSOCIATED_WITH_BUILDING	Building	User has access or responsibility for a building
User	BELONGS_TO_TENANT	Tenant	User belongs to a specific tenant
Zone	LOCATED_IN_BUILDING	Building	Zone is part of a building
Zone	BELONGS_TO_TENANT	Tenant	Zone belongs to a tenant
Floor	LOCATED_IN_BUILDING	Building	Floor is part of a building
Floor	BELONGS_TO_TENANT	Tenant	Floor belongs to a tenant
Building	BELONGS_TO_TENANT	Tenant	Building belongs to a tenant