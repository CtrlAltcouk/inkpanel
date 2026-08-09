import { z } from 'zod';

export const CURRENT_DEVICE_STORE_SCHEMA_VERSION = 1 as const;

/** Device IDs come from firmware; keep them to the existing safe alphabet. */
const deviceIdV1Schema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{1,63}$/i, 'invalid device id');

export function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

/** A timezone that the running ICU data can actually use. */
const timezoneV1Schema = z
  .string()
  .min(1)
  .max(255)
  .refine(isValidTimezone, 'invalid IANA timezone');

const wakeIntervalV1Schema = z.number().int().min(60).max(86_400);
const nullableStringV1Schema = z.string().nullable();
const crsV1Schema = z
  .string()
  .regex(/^(?:|[A-Z]{3})$/, 'CRS must be empty or three uppercase letters');
const panelProfileIdV1Schema = z
  .string()
  .refine((id): boolean => id === 'wft0583-800x480-mono', 'unknown panel profile');

/** The exact persisted DeviceRecord shape introduced by store schema V1. */
export const deviceRecordV1Schema = z.strictObject({
  id: deviceIdV1Schema,
  name: z.string().min(1).max(64),
  claimed: z.boolean(),
  timezone: timezoneV1Schema,
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  calendarUrls: z.array(z.string().url()).max(10),
  panelProfileId: panelProfileIdV1Schema,
  quietHoursStart: z.number().int().min(0).max(23),
  quietHoursEnd: z.number().int().min(0).max(23),
  activeIntervalSeconds: wakeIntervalV1Schema,
  lowBatteryIntervalSeconds: wakeIntervalV1Schema,
  lowBatteryVolts: z.number().min(2.5).max(4.2),
  unclaimedIntervalSeconds: wakeIntervalV1Schema,
  lastSeenAt: nullableStringV1Schema,
  lastBatteryVolts: z.number().nullable(),
  lastEtag: nullableStringV1Schema,
  lastFirmwareVersion: nullableStringV1Schema,
  locationLabel: z.string().max(120),
  binsUprn: z.string().regex(/^\d{0,12}$/, 'UPRN must be up to 12 digits'),
  trainOriginCrs: crsV1Schema,
  trainDestinationCrs: crsV1Schema,
  lastWakeSeconds: z.number().int().min(60).max(86_400).nullable(),
});

export type DeviceRecordV1 = z.infer<typeof deviceRecordV1Schema>;

/**
 * Frozen defaults for the V0 -> V1 migration.
 *
 * Do not replace this with defaultDevice(): future runtime defaults may contain
 * fields that do not belong in V1 persistence.
 */
export function defaultDeviceV1(id: string): DeviceRecordV1 {
  return {
    id,
    name: 'Unnamed panel',
    claimed: false,
    timezone: 'Europe/London',
    latitude: 52.04,
    longitude: -0.76,
    calendarUrls: [],
    panelProfileId: 'wft0583-800x480-mono',
    quietHoursStart: 23,
    quietHoursEnd: 6,
    activeIntervalSeconds: 900,
    lowBatteryIntervalSeconds: 21_600,
    lowBatteryVolts: 3.5,
    unclaimedIntervalSeconds: 60,
    lastSeenAt: null,
    lastBatteryVolts: null,
    lastEtag: null,
    lastFirmwareVersion: null,
    locationLabel: '',
    binsUprn: '',
    trainOriginCrs: '',
    trainDestinationCrs: '',
    lastWakeSeconds: null,
  };
}

function rejectDuplicateDeviceIds(
  file: { devices: Array<{ id: string }> },
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const [index, device] of file.devices.entries()) {
    if (seen.has(device.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['devices', index, 'id'],
        message: `duplicate device id: ${device.id}`,
      });
    }
    seen.add(device.id);
  }
}

/** The exact persisted store shape introduced by schema version 1. */
export const deviceStoreV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    devices: z.array(deviceRecordV1Schema),
  })
  .superRefine(rejectDuplicateDeviceIds);

export type DeviceStoreV1 = z.infer<typeof deviceStoreV1Schema>;

/**
 * Frozen unversioned V0 input. Fields accumulated over V0's lifetime, so all
 * except id are optional, but every explicitly present value must satisfy the
 * V1 constraint it will be migrated into.
 */
export const deviceRecordV0Schema = z.strictObject({
  id: deviceIdV1Schema,
  name: z.string().min(1).max(64).optional(),
  claimed: z.boolean().optional(),
  timezone: timezoneV1Schema.optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  calendarUrls: z.array(z.string().url()).max(10).optional(),
  panelProfileId: panelProfileIdV1Schema.optional(),
  quietHoursStart: z.number().int().min(0).max(23).optional(),
  quietHoursEnd: z.number().int().min(0).max(23).optional(),
  activeIntervalSeconds: wakeIntervalV1Schema.optional(),
  lowBatteryIntervalSeconds: wakeIntervalV1Schema.optional(),
  lowBatteryVolts: z.number().min(2.5).max(4.2).optional(),
  unclaimedIntervalSeconds: wakeIntervalV1Schema.optional(),
  lastSeenAt: nullableStringV1Schema.optional(),
  lastBatteryVolts: z.number().nullable().optional(),
  lastEtag: nullableStringV1Schema.optional(),
  lastFirmwareVersion: nullableStringV1Schema.optional(),
  locationLabel: z.string().max(120).optional(),
  binsUprn: z.string().regex(/^\d{0,12}$/, 'UPRN must be up to 12 digits').optional(),
  trainOriginCrs: crsV1Schema.optional(),
  trainDestinationCrs: crsV1Schema.optional(),
  lastWakeSeconds: z.number().int().min(60).max(86_400).nullable().optional(),
});

export const deviceStoreV0Schema = z
  .strictObject({ devices: z.array(deviceRecordV0Schema) })
  .superRefine(rejectDuplicateDeviceIds);

export class UnsupportedDeviceStoreVersionError extends Error {
  readonly name = 'UnsupportedDeviceStoreVersionError';

  constructor(readonly version: number) {
    super(`unsupported device configuration schema version ${version}`);
  }
}

/** A permanently frozen V0 -> V1 migration. */
export function migrateV0ToV1(parsed: unknown): DeviceStoreV1 {
  const legacy = deviceStoreV0Schema.parse(parsed);
  return deviceStoreV1Schema.parse({
    schemaVersion: 1,
    devices: legacy.devices.map((device) => ({ ...defaultDeviceV1(device.id), ...device })),
  });
}

export type DeviceStoreMigration = (file: unknown) => unknown;
export type DeviceStoreMigrations = Readonly<Partial<Record<number, DeviceStoreMigration>>>;

/** Apply every migration in order without allowing an old version to skip a step. */
export function runDeviceStoreMigrations(
  file: unknown,
  fromVersion: number,
  toVersion: number,
  migrations: DeviceStoreMigrations,
): unknown {
  let migrated = file;
  for (let version = fromVersion; version < toVersion; version += 1) {
    const migrate = migrations[version];
    if (!migrate) throw new Error(`missing device-store migration from V${version}`);
    migrated = migrate(migrated);
  }
  return migrated;
}

// Keyed by the input version. Add V1 -> V2 at key 1, V2 -> V3 at key 2, and
// advance the current aliases below. Historical schemas and migrations stay put.
const MIGRATIONS: DeviceStoreMigrations = {
  0: migrateV0ToV1,
};

// Runtime aliases point only at the latest schema. Migrations never use them.
export const currentDeviceRecordSchema = deviceRecordV1Schema;
export const currentDeviceStoreSchema = deviceStoreV1Schema;
export type CurrentDeviceStoreFile = DeviceStoreV1;
export const deviceIdSchema = deviceIdV1Schema;
export const timezoneSchema = timezoneV1Schema;

function persistedSchemaVersion(parsed: unknown): number {
  if (typeof parsed !== 'object' || parsed === null || !('schemaVersion' in parsed)) return 0;
  return z.number().int().nonnegative().parse(
    (parsed as { schemaVersion?: unknown }).schemaVersion,
  );
}

/** Parse persisted JSON and run the ordered migration chain to the current version. */
export function parseDeviceStoreFile(parsed: unknown): CurrentDeviceStoreFile {
  const version = persistedSchemaVersion(parsed);
  if (version > CURRENT_DEVICE_STORE_SCHEMA_VERSION) {
    throw new UnsupportedDeviceStoreVersionError(version);
  }

  const migrated = runDeviceStoreMigrations(
    parsed,
    version,
    CURRENT_DEVICE_STORE_SCHEMA_VERSION,
    MIGRATIONS,
  );
  return currentDeviceStoreSchema.parse(migrated);
}
