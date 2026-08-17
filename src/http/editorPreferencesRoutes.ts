import { Router } from 'express';
import { join } from 'node:path';
import { z } from 'zod';
import type { DeviceStore } from '../devices/store.ts';
import {
  DashboardEditorPreferencesStore,
  dashboardEditorSlotSchema,
  dashboardEditorSlotsSchema,
  emptyDashboardEditorSlots,
  type DashboardEditorSlots,
} from '../widgets/editorPreferences.ts';

const incomingSlotsSchema = z.array(dashboardEditorSlotSchema).min(1).max(4);
const putSchema = z.strictObject({ slots: incomingSlotsSchema });

function persistedSlots(slots: z.infer<typeof incomingSlotsSchema>): DashboardEditorSlots {
  const padded = emptyDashboardEditorSlots();
  slots.forEach((slot, index) => { padded[index] = slot; });
  return dashboardEditorSlotsSchema.parse(padded);
}

/**
 * Admin-only remembered widget drafts. These routes live behind the normal
 * /api authentication gate and never affect the device frame protocol.
 *
 * The HTTP boundary accepts the active display's one or four slot drafts. The
 * owner-only persistence file remains the original fixed four-bucket V1 shape;
 * Mini uses bucket zero and empty buckets are padded here.
 */
export function editorPreferencesRoutes(store: DeviceStore, dataDir: string): Router {
  const router = Router();
  const preferences = new DashboardEditorPreferencesStore(
    join(dataDir, '.dashboard-editor-preferences.json'),
  );
  const ready = preferences.load();

  router.get('/dashboard-editor/:id', async (req, res) => {
    if (!(await store.get(req.params.id))) {
      res.status(404).json({ error: 'unknown device' });
      return;
    }
    await ready;
    res.set('cache-control', 'no-store');
    res.json(preferences.get(req.params.id));
  });

  router.put('/dashboard-editor/:id', async (req, res) => {
    if (!(await store.get(req.params.id))) {
      res.status(404).json({ error: 'unknown device' });
      return;
    }
    const parsed = putSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid remembered widget settings', issues: parsed.error.issues });
      return;
    }
    await ready;
    await preferences.set(req.params.id, persistedSlots(parsed.data.slots));
    res.set('cache-control', 'no-store');
    res.json(preferences.get(req.params.id));
  });

  return router;
}
