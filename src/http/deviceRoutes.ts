import { Router } from 'express';
import type { DeviceStore } from '../devices/store.ts';
import type { FrameService } from '../render/frameService.ts';
import { nextWakeSeconds } from '../schedule/nextWake.ts';
import { deviceIdSchema } from '../devices/schema.ts';
import {
  DeviceEnrolmentLimiter,
  firmwareAutoEnrolmentIdSchema,
} from './deviceEnrolment.ts';

const ERROR_RETRY_SECONDS = 300;

function parseVolts(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function deviceRoutes(
  store: DeviceStore,
  frames: FrameService,
  publicBaseUrl: string,
  enrolmentLimiter = new DeviceEnrolmentLimiter(),
): Router {
  const router = Router();

  router.get('/devices/:id/frame', async (req, res) => {
    const id = req.params.id;
    if (!deviceIdSchema.safeParse(id).success) {
      res.status(400).json({ error: 'invalid device id' });
      return;
    }

    let device = await store.get(id);
    if (!device) {
      // Express serves HEAD through GET routes. Preserve HEAD for known panels,
      // but never let a probe create persistent state.
      if (req.method !== 'GET' || !firmwareAutoEnrolmentIdSchema.safeParse(id).success) {
        res.status(404).json({ error: 'unknown device' });
        return;
      }

      const reserved = enrolmentLimiter.reserve(req.ip ?? 'unknown');
      if (!reserved.allowed) {
        res.set('Retry-After', String(reserved.retryAfterSeconds));
        res.status(429).json({ error: 'device enrolment rate limit exceeded' });
        return;
      }

      try {
        const result = await store.getOrCreateWithStatus(id);
        reserved.reservation.complete(result.created);
        device = result.device;
      } catch (err) {
        reserved.reservation.complete(false);
        throw err;
      }
    }
    const batteryVolts = parseVolts(req.get('x-battery-voltage'));

    const wake = nextWakeSeconds({ now: new Date(), device, batteryVolts });

    // Record telemetry before rendering, so a render failure still logs the
    // visit. lastWakeSeconds is stored alongside so Push can say when the panel
    // will next collect a frame.
    await store.update(id, {
      lastSeenAt: new Date().toISOString(),
      lastBatteryVolts: batteryVolts ?? device.lastBatteryVolts,
      lastFirmwareVersion: req.get('x-firmware-version') ?? device.lastFirmwareVersion,
      lastWakeSeconds: wake,
    });
    res.set('X-Next-Wake-Seconds', String(wake));
    res.set('Cache-Control', 'no-store');

    try {
      const frame = device.claimed
        ? await frames.frameFor(device, batteryVolts)
        : await frames.enrolmentFrame(device, publicBaseUrl);

      const etag = `"${frame.etag}"`;
      if (req.get('if-none-match') === etag) {
        res.set('ETag', etag);
        res.status(304).end();
        return;
      }

      await store.update(id, { lastEtag: frame.etag });
      res.set('ETag', etag);
      res.set('Content-Type', 'application/octet-stream');
      res.set('Content-Length', String(frame.buffer.length));
      res.status(200).end(frame.buffer);
    } catch (err) {
      // Never send a broken frame. The device keeps its last good image.
      console.error(`[frame] ${id} render failed:`, err);
      res.set('X-Next-Wake-Seconds', String(ERROR_RETRY_SECONDS));
      // The header just promised a shorter retry than the earlier lastWakeSeconds
      // write above — keep the store in sync with what the device was actually told.
      await store.update(id, { lastWakeSeconds: ERROR_RETRY_SECONDS });
      res.status(503).json({ error: 'render failed' });
    }
  });

  return router;
}
