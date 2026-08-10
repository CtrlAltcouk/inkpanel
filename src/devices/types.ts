import { defaultDeviceV1, deviceRecordV2Schema, migrateV1ToV2, type DeviceRecordV2 } from './schema.ts';

/** Runtime model alias. Advance this with the current persisted schema. */
export type DeviceRecord = DeviceRecordV2;

export function defaultDevice(id: string): DeviceRecord {
  const migrated = migrateV1ToV2({ schemaVersion: 1, devices: [defaultDeviceV1(id)] });
  return deviceRecordV2Schema.parse(migrated.devices[0]);
}
