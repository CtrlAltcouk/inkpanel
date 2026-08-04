import { Router } from 'express';
import { z } from 'zod';
import type { DeviceStore } from '../devices/store.ts';
import type { FrameService } from '../render/frameService.ts';
import { bufferToPng } from '../panel/quantise.ts';
import { PROFILES, WFT0583 } from '../panel/profile.ts';
import { geocode } from '../sources/geocode.ts';
import { nextCheckIn } from '../devices/nextCheckIn.ts';

const patchSchema = z
  .object({
    name: z.string().min(1).max(64).optional(),
    claimed: z.boolean().optional(),
    timezone: z.string().min(1).optional(),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    locationLabel: z.string().max(120).optional(),
    calendarUrls: z.array(z.string().url()).max(10).optional(),
    panelProfileId: z.string().refine((id) => id in PROFILES, 'unknown panel profile').optional(),
    quietHoursStart: z.number().int().min(0).max(23).optional(),
    quietHoursEnd: z.number().int().min(0).max(23).optional(),
    activeIntervalSeconds: z.number().int().min(60).max(86400).optional(),
    lowBatteryIntervalSeconds: z.number().int().min(60).max(86400).optional(),
    lowBatteryVolts: z.number().min(2.5).max(4.2).optional(),
  })
  .strict();

export function manageRoutes(
  store: DeviceStore,
  frames: FrameService,
  publicBaseUrl: string,
): Router {
  const router = Router();

  router.get('/devices', async (_req, res) => {
    res.json({ devices: await store.list() });
  });

  router.get('/devices/:id', async (req, res) => {
    const device = await store.get(req.params.id);
    if (!device) {
      res.status(404).json({ error: 'unknown device' });
      return;
    }
    res.json(device);
  });

  router.put('/devices/:id', async (req, res) => {
    if (!(await store.get(req.params.id))) {
      res.status(404).json({ error: 'unknown device' });
      return;
    }
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid config', issues: parsed.error.issues });
      return;
    }
    res.json(await store.update(req.params.id, parsed.data));
  });

  router.get('/devices/:id/preview', async (req, res) => {
    const device = await store.get(req.params.id);
    if (!device) {
      res.status(404).json({ error: 'unknown device' });
      return;
    }
    res.type('html').send(await frames.previewHtml(device));
  });

  router.get('/devices/:id/render.png', async (req, res) => {
    const device = await store.get(req.params.id);
    if (!device) {
      res.status(404).json({ error: 'unknown device' });
      return;
    }
    const profile = PROFILES[device.panelProfileId] ?? WFT0583;
    // An unclaimed device previews its enrolment screen, which must show the
    // same address the panel will display — not a placeholder.
    const frame = device.claimed
      ? await frames.frameFor(device, device.lastBatteryVolts)
      : await frames.enrolmentFrame(device, publicBaseUrl);
    res.type('png').set('Cache-Control', 'no-store').send(await bufferToPng(frame.buffer, profile));
  });

  router.get('/geocode', async (req, res) => {
    const query = String(req.query.q ?? '').trim();
    if (query.length < 2) {
      res.status(400).json({ error: 'query must be at least 2 characters' });
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      res.json({ results: await geocode(query, controller.signal) });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'geocoding failed' });
    } finally {
      clearTimeout(timer);
    }
  });

  router.post('/devices/:id/push', async (req, res) => {
    const device = await store.get(req.params.id);
    if (!device) {
      res.status(404).json({ error: 'unknown device' });
      return;
    }

    try {
      const frame = await frames.renderNow(device, device.lastBatteryVolts);
      res.json({
        etag: frame.etag,
        renderedAt: frame.renderedAt,
        ...nextCheckIn(device, new Date()),
      });
    } catch (err) {
      res.status(503).json({ error: err instanceof Error ? err.message : 'render failed' });
    }
  });

  return router;
}
