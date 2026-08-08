import { z } from 'zod';
import { PROFILES } from '../panel/profile.ts';
import { defaultDevice, type DeviceRecord } from './types.ts';

export const CURRENT_DEVICE_STORE_SCHEMA_VERSION = 1 as const;

/** Device IDs come from firmware; keep them to the existing safe alphabet. */
export const deviceIdSchema = z
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
export const timezoneSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(isValidTimezone, 'invalid IANA timezone');

const wakeIntervalSchema = z.number().int().min(60).max(86_400);
const nullableStringSchema = z.string().nullable();
const crsSchema = z.string().regex(/^(?:|[A-Z]{3})$/, 'CRS must be empty or three uppercase letters');

export const deviceRecordSchema = z.strictObject({
  id: deviceIdSchema,
  name: z.string().min(1).max(64),
  claimed: z.boolean(),
  timezone: timezoneSchema,
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  calendarUrls: z.array(z.string().url()).max(10),
  panelProfileId: z.string().refine((id) => id in PROFILES, 'unknown panel profile'),
  quietHoursStart: z.number().int().min(0).max(23),
  quietHoursEnd: z.number().int().min(0).max(23),
  activeIntervalSeconds: wakeIntervalSchema,
  lowBatteryIntervalSeconds: wakeIntervalSchema,
  lowBatteryVolts: z.number().min(2.5).max(4.2),
  unclaimedIntervalSeconds: wakeIntervalSchema,
  lastSeenAt: nullableStringSchema,
  lastBatteryVolts: z.number().nullable(),
  lastEtag: nullableStringSchema,
  lastFirmwareVersion: nullableStringSchema,
  locationLabel: z.string().max(120),
  binsUprn: z.string().regex(/^\d{0,12}$/, 'UPRN must be up to 12 digits'),
  trainOriginCrs: crsSchema,
  trainDestinationCrs: crsSchema,
  lastWakeSeconds: z.number().int().min(60).max(86_400).nullable(),
}) satisfies z.ZodType<DeviceRecord>;

export interface CurrentDeviceStoreFile {
  schemaVersion: typeof CURRENT_DEVICE_STORE_SCHEMA_VERSION;
  devices: DeviceRecord[];
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

export const currentDeviceStoreSchema = z
  .strictObject({
    schemaVersion: z.literal(CURRENT_DEVICE_STORE_SCHEMA_VERSION),
    devices: z.array(deviceRecordSchema),
  })
  .superRefine(rejectDuplicateDeviceIds) satisfies z.ZodType<CurrentDeviceStoreFile>;

// V0 was unversioned and records accumulated fields over time. Present fields
// must already be valid; only absent fields are supplied by the migration.
const legacyDeviceRecordSchema = deviceRecordSchema.partial().required({ id: true });
const legacyDeviceStoreSchema = z
  .strictObject({ devices: z.array(legacyDeviceRecordSchema) })
  .superRefine(rejectDuplicateDeviceIds);

export class UnsupportedDeviceStoreVersionError extends Error {
  readonly name = 'UnsupportedDeviceStoreVersionError';

  constructor(readonly version: number) {
    super(`unsupported device configuration schema version ${version}`);
  }
}

function migrateV0ToV1(parsed: unknown): CurrentDeviceStoreFile {
  const legacy = legacyDeviceStoreSchema.parse(parsed);
  return currentDeviceStoreSchema.parse({
    schemaVersion: CURRENT_DEVICE_STORE_SCHEMA_VERSION,
    devices: legacy.devices.map((device) =>
      deviceRecordSchema.parse({ ...defaultDevice(device.id), ...device }),
    ),
  });
}

type Migration = (file: unknown) => unknown;

// Keyed by the input version. Add V1 -> V2 at key 1, V2 -> V3 at key 2, and
// so on; parseDeviceStoreFile always applies each intermediate step in order.
const MIGRATIONS: Readonly<Record<number, Migration>> = {
  0: migrateV0ToV1,
};

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

  let migrated = parsed;
  for (let fromVersion = version; fromVersion < CURRENT_DEVICE_STORE_SCHEMA_VERSION; fromVersion += 1) {
    const migrate = MIGRATIONS[fromVersion];
    if (!migrate) throw new Error(`missing device-store migration from V${fromVersion}`);
    migrated = migrate(migrated);
  }

  return currentDeviceStoreSchema.parse(migrated);
}
