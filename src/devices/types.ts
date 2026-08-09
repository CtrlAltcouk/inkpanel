import { defaultDeviceV1, type DeviceRecordV1 } from './schema.ts';

/** Runtime model alias. Advance this with the current persisted schema. */
export type DeviceRecord = DeviceRecordV1;

export function defaultDevice(id: string): DeviceRecord {
  return defaultDeviceV1(id);
}
