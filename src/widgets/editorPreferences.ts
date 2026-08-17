import { rename } from 'node:fs/promises';
import { z } from 'zod';
import { readOptionalSecretFile, writeSecretFile } from '../sources/credentialFile.ts';
import {
  dashboardWidgetSchema,
  type DashboardWidget,
  widgetRegistry,
} from './registry.ts';

const MAX_WIDGET_TYPES = Object.keys(widgetRegistry).length;

export const dashboardEditorSlotSchema = z.array(dashboardWidgetSchema)
  .max(MAX_WIDGET_TYPES)
  .superRefine((widgets, ctx) => {
    const seen = new Set<string>();
    widgets.forEach((widget, index) => {
      if (seen.has(widget.type)) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'type'],
          message: `duplicate remembered widget type: ${widget.type}`,
        });
      }
      seen.add(widget.type);
    });
  });

export const dashboardEditorSlotsSchema = z.tuple([
  dashboardEditorSlotSchema,
  dashboardEditorSlotSchema,
  dashboardEditorSlotSchema,
  dashboardEditorSlotSchema,
]);

const dashboardEditorPreferencesFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  shared: dashboardEditorSlotSchema,
  devices: z.record(z.string().min(1), dashboardEditorSlotsSchema),
});

export type DashboardEditorSlots = z.infer<typeof dashboardEditorSlotsSchema>;

interface DashboardEditorPreferencesFile {
  schemaVersion: 1;
  shared: DashboardWidget[];
  devices: Record<string, DashboardEditorSlots>;
}

export function emptyDashboardEditorSlots(): DashboardEditorSlots {
  return [[], [], [], []];
}

function emptyFile(): DashboardEditorPreferencesFile {
  return { schemaVersion: 1, shared: [], devices: {} };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Only complete/useful configs become the shared fallback for other panels. */
function meaningful(widget: DashboardWidget): boolean {
  switch (widget.type) {
    case 'calendar': return widget.config.calendarUrls.length > 0;
    case 'trains': return Boolean(widget.config.originCrs && widget.config.destinationCrs);
    case 'bus': return Boolean(widget.config.stopCode);
    case 'traffic': return Boolean(widget.config.origin.trim() && widget.config.destination.trim());
    case 'octopus': return Boolean(widget.config.tariffCode);
    case 'todo': return Boolean(widget.config.listId);
    case 'printers': return widget.config.printerIds.length > 0;
    case 'bins': return Boolean(widget.config.uprn);
    case 'weather':
    case 'empty':
      return false;
  }
}

function mergeShared(current: DashboardWidget[], slots: DashboardEditorSlots): DashboardWidget[] {
  const byType = new Map(current.map((widget) => [widget.type, clone(widget)]));
  for (const slot of slots) {
    for (const widget of slot) {
      if (meaningful(widget)) byType.set(widget.type, clone(widget));
    }
  }
  return [...byType.values()];
}

/**
 * Persistent admin-UI state, deliberately separate from DeviceStore.
 *
 * DeviceStore continues to describe only what a panel is actively rendering.
 * This owner-only file remembers inactive widget drafts for each panel/slot and
 * one last-useful config per type as a fallback for other panels. Calendar URLs
 * and route addresses can be sensitive, so it uses the same 0600 atomic file
 * helper as managed provider credentials.
 *
 * The persisted V1 format always keeps four draft buckets. Mini uses bucket 0;
 * its HTTP route pads the remaining buckets so existing preference files stay
 * backwards compatible and shared fallback settings work across both sizes.
 */
export class DashboardEditorPreferencesStore {
  private state: DashboardEditorPreferencesFile = emptyFile();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    const raw = await readOptionalSecretFile(this.path);
    if (raw === null) return;

    try {
      this.state = dashboardEditorPreferencesFileSchema.parse(JSON.parse(raw));
    } catch (err) {
      // This is convenience state, not the authoritative device config. Preserve
      // a broken copy for diagnosis but keep InkPanel bootable with empty drafts.
      const backup = `${this.path}.corrupt-${Date.now()}`;
      await rename(this.path, backup).catch(() => undefined);
      this.state = emptyFile();
      console.error('dashboard editor preferences were corrupt; preserved a backup and reset remembered settings:', err);
    }
  }

  get(deviceId: string): { shared: DashboardWidget[]; slots: DashboardEditorSlots } {
    return {
      shared: clone(this.state.shared),
      slots: clone(this.state.devices[deviceId] ?? emptyDashboardEditorSlots()),
    };
  }

  async set(deviceId: string, slots: DashboardEditorSlots): Promise<void> {
    const parsed = dashboardEditorSlotsSchema.parse(slots);
    const next = this.writeChain.catch(() => undefined).then(async () => {
      this.state.devices[deviceId] = clone(parsed);
      this.state.shared = mergeShared(this.state.shared, parsed);
      await writeSecretFile(this.path, `${JSON.stringify(this.state, null, 2)}\n`);
    });
    this.writeChain = next;
    await next;
  }
}
