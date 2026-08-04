import { Router } from 'express';
import type { DeviceStore } from '../devices/store.ts';
import type { FrameService } from '../render/frameService.ts';
import { nextWakeSeconds } from '../schedule/nextWake.ts';

/** Device IDs come from firmware; keep them to a safe alphabet. */
const DEVICE_ID = /^[a-z0-9][a-z0-9_-]{1,63}$/i;

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
): Router {
  const router = Router();

  router.get('/devices/:id/frame', async (req, res) => {
    const id = req.params.id;
    if (!DEVICE_ID.test(id)) {
      res.status(400).json({ error: 'invalid device id' });
      return;
    }

    const device = await store.getOrCreate(id);
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
      res.status(503).json({ error: 'render failed' });
    }
  });

  return router;
}
