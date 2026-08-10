import { defaultDeviceV2, type DeviceRecordV2 } from './schema.ts';

/** Runtime model alias. Advance this with the current persisted schema. */
export type DeviceRecord = DeviceRecordV2;

export function defaultDevice(id: string): DeviceRecord {
  return defaultDeviceV2(id);
}
