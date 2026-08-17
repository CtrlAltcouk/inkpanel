import { defaultDeviceV3, type DeviceRecordV3 } from './schema.ts';

/** Runtime model alias. Advance this with the current persisted schema. */
export type DeviceRecord = DeviceRecordV3;
export type PanelProfileId = DeviceRecord['panelProfileId'];

export function defaultDevice(
  id: string,
  panelProfileId: PanelProfileId = 'wft0583-800x480-mono',
): DeviceRecord {
  return defaultDeviceV3(id, panelProfileId);
}
