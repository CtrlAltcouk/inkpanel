import { Router } from 'express';
import { join } from 'node:path';
import { z } from 'zod';
import type { DeviceStore } from '../devices/store.ts';
import {
  DashboardEditorPreferencesStore,
  dashboardEditorSlotsSchema,
} from '../widgets/editorPreferences.ts';

const putSchema = z.strictObject({ slots: dashboardEditorSlotsSchema });

/**
 * Admin-only remembered widget drafts. These routes live behind the normal
 * /api authentication gate and never affect the device frame protocol.
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
    await preferences.set(req.params.id, parsed.data.slots);
    res.set('cache-control', 'no-store');
    res.json(preferences.get(req.params.id));
  });

  return router;
}
