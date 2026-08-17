import { defaultDeviceV3, type DeviceRecordV3 } from './schema.ts';
import type { DashboardWidget } from '../widgets/registry.ts';

export type PanelProfileId = DeviceRecordV3['panelProfileId'];

type DeviceCommon = Omit<DeviceRecordV3, 'panelProfileId' | 'dashboardSections'>;

/** Profile-specific views for code that needs exact slot counts. */
export type LargeDeviceRecord = DeviceCommon & {
  panelProfileId: 'wft0583-800x480-mono';
  dashboardSections: [DashboardWidget, DashboardWidget, DashboardWidget, DashboardWidget];
};

export type MiniDeviceRecord = DeviceCommon & {
  panelProfileId: 'ssd1681-200x200-mono';
  dashboardSections: [DashboardWidget];
};

/**
 * Generic store/API record. Cross-field profile/slot validation is enforced by
 * the V3 schema; callers that require an exact tuple can use the profile views
 * above. Keeping the generic alias avoids forcing unrelated store/update code
 * to distribute Partial<> across a physical-device union.
 */
export type DeviceRecord = DeviceRecordV3;

export function defaultDevice(id: string): LargeDeviceRecord;
export function defaultDevice(id: string, panelProfileId: 'wft0583-800x480-mono'): LargeDeviceRecord;
export function defaultDevice(id: string, panelProfileId: 'ssd1681-200x200-mono'): MiniDeviceRecord;
export function defaultDevice(id: string, panelProfileId: PanelProfileId): DeviceRecord;
export function defaultDevice(
  id: string,
  panelProfileId: PanelProfileId = 'wft0583-800x480-mono',
): DeviceRecord {
  // defaultDeviceV3 validates the profile/slot relation at runtime. These
  // casts expose the corresponding exact tuple for callers that requested a
  // concrete profile, while the general store model stays schema-shaped.
  return defaultDeviceV3(id, panelProfileId) as DeviceRecord;
}
