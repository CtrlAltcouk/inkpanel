import { Router } from 'express';
import { z } from 'zod';
import type { DeviceStore } from '../devices/store.ts';
import type { FrameService } from '../render/frameService.ts';
import { bufferToPng } from '../panel/quantise.ts';
import { PROFILES, WFT0583 } from '../panel/profile.ts';
import { geocode } from '../sources/geocode.ts';
import { findStation, searchStations } from '../sources/stations.ts';
import type { NationalRailCredentialStore } from '../sources/nationalRailCredentials.ts';
import { validateNationalRailApiKey } from '../sources/nationalRailCredentials.ts';
import type { TransportApiCredentialStore } from '../sources/transportApiCredentials.ts';
import { validateTransportApiCredentials } from '../sources/transportApiCredentials.ts';
import type { GoogleMapsCredentialStore } from '../sources/googleMapsCredentials.ts';
import { validateGoogleMapsApiKey } from '../sources/googleMapsCredentials.ts';
import { searchTransportApiBusStops } from '../sources/transportApiBus.ts';
import { nextCheckIn } from '../devices/nextCheckIn.ts';
import { timezoneSchema } from '../devices/schema.ts';
import { calendarUrlInputSchema } from '../sources/calendarUrl.ts';

const stationCodeInputSchema = z
  .string()
  .transform((value) => value.trim().toUpperCase())
  .refine((value) => value === '' || findStation(value) !== null, 'unknown station code');

const busStopCodeInputSchema = z
  .string()
  .transform((value) => value.trim())
  .refine(
    (value) => value === '' || /^\d{3}0[A-Za-z0-9]{1,8}$/.test(value),
    'invalid NaPTAN ATCO stop code',
  );

const octopusTariffCodeInputSchema = z
  .string()
  .transform((value) => value.trim().toUpperCase())
  .refine(
    (value) => value === '' || /^E-1R-AGILE-[A-Z0-9-]+-[A-Z]$/.test(value),
    'Octopus Agile tariff code must look like E-1R-AGILE-24-10-01-C',
  );

const dashboardSectionInputSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('calendar'), version: z.literal(1),
    config: z.strictObject({ calendarUrls: z.array(calendarUrlInputSchema).max(10) }),
  }),
  z.strictObject({ type: z.literal('weather'), version: z.literal(1), config: z.strictObject({}) }),
  z.strictObject({
    type: z.literal('trains'), version: z.literal(1),
    config: z.strictObject({ originCrs: stationCodeInputSchema, destinationCrs: stationCodeInputSchema }),
  }),
  z.strictObject({
    type: z.literal('bus'), version: z.literal(1),
    config: z.strictObject({
      stopCode: busStopCodeInputSchema,
      stopLabel: z.string().trim().max(80),
      routeFilter: z.string().trim().max(32),
    }),
  }),
  z.strictObject({
    type: z.literal('traffic'), version: z.literal(1),
    config: z.strictObject({
      origin: z.string().trim().max(200),
      destination: z.string().trim().max(200),
    }),
  }),
  z.strictObject({
    type: z.literal('octopus'), version: z.literal(1),
    config: z.strictObject({ tariffCode: octopusTariffCodeInputSchema }),
  }),
  z.strictObject({
    type: z.literal('bins'), version: z.literal(1),
    config: z.strictObject({ uprn: z.string().regex(/^\d{0,12}$/, 'UPRN must be up to 12 digits') }),
  }),
  z.strictObject({ type: z.literal('empty'), version: z.literal(1), config: z.strictObject({}) }),
]);

const patchSchema = z
  .object({
    name: z.string().min(1).max(64).optional(),
    claimed: z.boolean().optional(),
    timezone: timezoneSchema.optional(),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    locationLabel: z.string().max(120).optional(),
    dashboardSections: z.tuple([
      dashboardSectionInputSchema,
      dashboardSectionInputSchema,
      dashboardSectionInputSchema,
      dashboardSectionInputSchema,
    ]).optional(),
    panelProfileId: z.string().refine((id) => id in PROFILES, 'unknown panel profile').optional(),
    quietHoursStart: z.number().int().min(0).max(23).optional(),
    quietHoursEnd: z.number().int().min(0).max(23).optional(),
    activeIntervalSeconds: z.number().int().min(60).max(86400).optional(),
    lowBatteryIntervalSeconds: z.number().int().min(60).max(86400).optional(),
    lowBatteryVolts: z.number().min(2.5).max(4.2).optional(),
  })
  .strict();

const nationalRailKeySchema = z.strictObject({
  apiKey: z.string().transform((value, ctx) => {
    try {
      return validateNationalRailApiKey(value);
    } catch (err) {
      ctx.addIssue({ code: 'custom', message: err instanceof Error ? err.message : 'invalid National Rail API key' });
      return z.NEVER;
    }
  }),
});

const transportApiCredentialSchema = z.strictObject({
  appId: z.string(),
  appKey: z.string(),
}).transform((value, ctx) => {
  try {
    return validateTransportApiCredentials(value);
  } catch (err) {
    ctx.addIssue({ code: 'custom', message: err instanceof Error ? err.message : 'invalid TransportAPI credentials' });
    return z.NEVER;
  }
});

const googleMapsKeySchema = z.strictObject({
  apiKey: z.string().transform((value, ctx) => {
    try {
      return validateGoogleMapsApiKey(value);
    } catch (err) {
      ctx.addIssue({ code: 'custom', message: err instanceof Error ? err.message : 'invalid Google Maps API key' });
      return z.NEVER;
    }
  }),
});

export function manageRoutes(
  store: DeviceStore,
  frames: FrameService,
  publicBaseUrl: string,
  trainCredentials?: NationalRailCredentialStore,
  busCredentials?: TransportApiCredentialStore,
  googleMapsCredentials?: GoogleMapsCredentialStore,
  transportApiBaseUrl?: string,
): Router {
  const router = Router();

  // Secrets are write-only from the browser. GET endpoints expose status only.
  router.get('/national-rail', (_req, res) => {
    res.set('cache-control', 'no-store');
    res.json(trainCredentials?.status() ?? { configured: false, managed: false });
  });

  router.put('/national-rail', async (req, res) => {
    if (!trainCredentials) {
      res.status(503).json({ error: 'National Rail credential storage is unavailable' });
      return;
    }
    const parsed = nationalRailKeySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid National Rail API key', issues: parsed.error.issues });
      return;
    }
    await trainCredentials.set(parsed.data.apiKey);
    res.set('cache-control', 'no-store');
    res.json(trainCredentials.status());
  });

  router.get('/transportapi', (_req, res) => {
    res.set('cache-control', 'no-store');
    res.json(busCredentials?.status() ?? { configured: false, managed: false });
  });

  router.put('/transportapi', async (req, res) => {
    if (!busCredentials) {
      res.status(503).json({ error: 'TransportAPI credential storage is unavailable' });
      return;
    }
    const parsed = transportApiCredentialSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid TransportAPI credentials', issues: parsed.error.issues });
      return;
    }
    await busCredentials.set(parsed.data);
    res.set('cache-control', 'no-store');
    res.json(busCredentials.status());
  });

  router.get('/google-maps', (_req, res) => {
    res.set('cache-control', 'no-store');
    res.json(googleMapsCredentials?.status() ?? { configured: false, managed: false });
  });

  router.put('/google-maps', async (req, res) => {
    if (!googleMapsCredentials) {
      res.status(503).json({ error: 'Google Maps credential storage is unavailable' });
      return;
    }
    const parsed = googleMapsKeySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid Google Maps API key', issues: parsed.error.issues });
      return;
    }
    await googleMapsCredentials.set(parsed.data.apiKey);
    res.set('cache-control', 'no-store');
    res.json(googleMapsCredentials.status());
  });

  router.get('/bus-stops', async (req, res) => {
    if (!busCredentials?.status().configured) {
      res.status(503).json({ error: 'TransportAPI credentials are not configured' });
      return;
    }
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (query.length < 2 || query.length > 80) {
      res.status(400).json({ error: 'query must be 2-80 characters' });
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const results = await searchTransportApiBusStops(
        busCredentials,
        query,
        controller.signal,
        transportApiBaseUrl ? { baseUrl: transportApiBaseUrl } : {},
      );
      res.json({ results });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'bus stop lookup failed' });
    } finally {
      clearTimeout(timer);
    }
  });

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

  router.get('/stations', (req, res) => {
    const query = typeof req.query.q === 'string' ? req.query.q : '';
    // No network, no quota, no failure mode — the list is bundled.
    res.json({ results: searchStations(query) });
  });

  router.post('/devices/:id/push', async (req, res) => {
    const device = await store.get(req.params.id);
    if (!device) {
      res.status(404).json({ error: 'unknown device' });
      return;
    }

    try {
      // An unclaimed device is still displaying its enrolment screen and will
      // keep doing so until claimed — pushing it must not render the
      // dashboard it can't show, exactly like GET /render.png above.
      const frame = device.claimed
        ? await frames.renderNow(device, device.lastBatteryVolts)
        : await frames.enrolmentFrame(device, publicBaseUrl);
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
