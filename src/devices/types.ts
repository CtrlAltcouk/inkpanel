import {
  defaultDeviceV3,
  type DeviceRecordV3,
  type panelProfileIdV3Schema,
} from './schema.ts';
import type { z } from 'zod';

/** Runtime model alias. Advance this with the current persisted schema. */
export type DeviceRecord = DeviceRecordV3;
export type PanelProfileId = z.infer<typeof panelProfileIdV3Schema>;

export function defaultDevice(
  id: string,
  panelProfileId: PanelProfileId = 'wft0583-800x480-mono',
): DeviceRecord {
  return defaultDeviceV3(id, panelProfileId);
}
