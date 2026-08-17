import { defaultDeviceV3, type DeviceRecordV3 } from './schema.ts';
import type { DashboardWidget } from '../widgets/registry.ts';

export type PanelProfileId = DeviceRecordV3['panelProfileId'];

type DeviceCommon = Omit<DeviceRecordV3, 'panelProfileId' | 'dashboardSections'>;

/** Existing 7.5-inch runtime shape. Keep its four widget slots strongly typed. */
export type LargeDeviceRecord = DeviceCommon & {
  panelProfileId: 'wft0583-800x480-mono';
  dashboardSections: [DashboardWidget, DashboardWidget, DashboardWidget, DashboardWidget];
};

/** 1.54-inch Mini runtime shape: exactly one visible widget. */
export type MiniDeviceRecord = DeviceCommon & {
  panelProfileId: 'ssd1681-200x200-mono';
  dashboardSections: [DashboardWidget];
};

/** Runtime device model mirrors the V3 cross-field schema as a discriminated union. */
export type DeviceRecord = LargeDeviceRecord | MiniDeviceRecord;

export function defaultDevice(id: string): LargeDeviceRecord;
export function defaultDevice(id: string, panelProfileId: 'wft0583-800x480-mono'): LargeDeviceRecord;
export function defaultDevice(id: string, panelProfileId: 'ssd1681-200x200-mono'): MiniDeviceRecord;
export function defaultDevice(id: string, panelProfileId: PanelProfileId): DeviceRecord;
export function defaultDevice(
  id: string,
  panelProfileId: PanelProfileId = 'wft0583-800x480-mono',
): DeviceRecord {
  // defaultDeviceV3 performs the runtime schema validation; the discriminant
  // and tuple length are therefore guaranteed together at this boundary.
  return defaultDeviceV3(id, panelProfileId) as DeviceRecord;
}
