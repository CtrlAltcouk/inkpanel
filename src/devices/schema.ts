import { z } from 'zod';
import { DEFAULT_DASHBOARD_SECTIONS, dashboardSectionsSchema } from '../widgets/registry.ts';

export const CURRENT_DEVICE_STORE_SCHEMA_VERSION = 2 as const;

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
 * Frozen V2 widget persistence envelope. Its config is intentionally opaque:
 * runtime validation belongs to the widget registry, so adding widgets does
 * not require a device-store schema bump.
 */
export const dashboardWidgetEnvelopeV2Schema = z.strictObject({
  type: z.string().min(1),
  version: z.number().int().positive(),
  config: z.unknown(),
});

export const dashboardSectionsV2Schema = z.tuple([
  dashboardWidgetEnvelopeV2Schema,
  dashboardWidgetEnvelopeV2Schema,
  dashboardWidgetEnvelopeV2Schema,
  dashboardWidgetEnvelopeV2Schema,
]);

const deviceRecordV2BaseSchema = z.strictObject({
  id: deviceIdV1Schema,
  name: z.string().min(1).max(64),
  claimed: z.boolean(),
  timezone: timezoneV1Schema,
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  dashboardSections: dashboardSectionsV2Schema,
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
  lastWakeSeconds: z.number().int().min(60).max(86_400).nullable(),
});

/** Exact outer persistence shape introduced by store schema V2. */
export const deviceRecordV2PersistenceSchema = deviceRecordV2BaseSchema;
export type DeviceRecordV2Persistence = z.infer<typeof deviceRecordV2PersistenceSchema>;

export const deviceStoreV2PersistenceSchema = z
  .strictObject({
    schemaVersion: z.literal(2),
    devices: z.array(deviceRecordV2PersistenceSchema),
  })
  .superRefine(rejectDuplicateDeviceIds);
export type DeviceStoreV2Persistence = z.infer<typeof deviceStoreV2PersistenceSchema>;

/** Current V2 runtime schema: frozen envelope plus the installed widget registry. */
export const deviceRecordV2Schema = deviceRecordV2PersistenceSchema.extend({
  dashboardSections: dashboardSectionsSchema,
});
export type DeviceRecordV2 = z.infer<typeof deviceRecordV2Schema>;

export const deviceStoreV2Schema = z
  .strictObject({ schemaVersion: z.literal(2), devices: z.array(deviceRecordV2Schema) })
  .superRefine(rejectDuplicateDeviceIds);
export type DeviceStoreV2 = z.infer<typeof deviceStoreV2Schema>;

/** Current runtime defaults. Historical migrations never call this. */
export function defaultDeviceV2(id: string): DeviceRecordV2 {
  return {
    id,
    name: 'Unnamed panel',
    claimed: false,
    timezone: 'Europe/London',
    latitude: 52.04,
    longitude: -0.76,
    dashboardSections: structuredClone(DEFAULT_DASHBOARD_SECTIONS),
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
    lastWakeSeconds: null,
  };
}

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

/** A permanently frozen V1 -> V2 migration. */
export function migrateV1ToV2(parsed: unknown): DeviceStoreV2Persistence {
  const v1 = deviceStoreV1Schema.parse(parsed);
  return deviceStoreV2PersistenceSchema.parse({
    schemaVersion: 2,
    devices: v1.devices.map((device) => {
      const {
        calendarUrls,
        binsUprn,
        trainOriginCrs,
        trainDestinationCrs,
        ...unchanged
      } = device;
      return {
        ...unchanged,
        dashboardSections: [
          { type: 'calendar', version: 1, config: { calendarUrls } },
          { type: 'weather', version: 1, config: {} },
          {
            type: 'trains',
            version: 1,
            config: { originCrs: trainOriginCrs, destinationCrs: trainDestinationCrs },
          },
          { type: 'bins', version: 1, config: { uprn: binsUprn } },
        ],
      };
    }),
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
  1: migrateV1ToV2,
};

// Runtime aliases point only at the latest schema. Migrations never use them.
export const currentDeviceRecordSchema = deviceRecordV2Schema;
export const currentDeviceStoreSchema = deviceStoreV2Schema;
export type CurrentDeviceStoreFile = DeviceStoreV2;
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
