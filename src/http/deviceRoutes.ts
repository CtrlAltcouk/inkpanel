import { Router } from 'express';
import type { DeviceStore } from '../devices/store.ts';
import type { FrameService } from '../render/frameService.ts';
import { nextWakeSeconds } from '../schedule/nextWake.ts';
import { deviceIdSchema } from '../devices/schema.ts';
import type { PanelProfileId } from '../devices/types.ts';
import { panelProfile, WFT0583 } from '../panel/profile.ts';
import {
  DeviceEnrolmentLimiter,
  firmwareAutoEnrolmentIdSchema,
  type DeviceEnrolmentDefaultsProvider,
} from './deviceEnrolment.ts';

const ERROR_RETRY_SECONDS = 300;
const PROFILE_HEADER = 'x-inkpanel-profile';

function parseVolts(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function requestedProfileId(raw: string | undefined): PanelProfileId | null | 'invalid' {
  if (!raw) return null;
  const profile = panelProfile(raw.trim());
  return profile ? profile.id as PanelProfileId : 'invalid';
}

export function deviceRoutes(
  store: DeviceStore,
  frames: FrameService,
  publicBaseUrl: string,
  enrolmentLimiter = new DeviceEnrolmentLimiter(),
  enrolmentDefaults?: DeviceEnrolmentDefaultsProvider,
): Router {
  const router = Router();

  router.get('/devices/:id/frame', async (req, res) => {
    const id = req.params.id;
    if (!deviceIdSchema.safeParse(id).success) {
      res.status(400).json({ error: 'invalid device id' });
      return;
    }

    const advertisedProfile = requestedProfileId(req.get(PROFILE_HEADER));
    if (advertisedProfile === 'invalid') {
      res.status(400).json({ error: 'unknown panel profile' });
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
        const initialLocation = enrolmentDefaults ? await enrolmentDefaults() : undefined;
        if (initialLocation === null) {
          reserved.reservation.complete(false);
          res.set('Retry-After', String(ERROR_RETRY_SECONDS));
          res.set('X-Next-Wake-Seconds', String(ERROR_RETRY_SECONDS));
          res.status(503).json({ error: 'device enrolment defaults temporarily unavailable' });
          return;
        }
        // Firmware 0.1.4 predates the profile header. Missing therefore means
        // the existing 7.5-inch profile, preserving old-board auto-enrolment.
        const result = await store.getOrCreateWithStatus(
          id,
          advertisedProfile ?? WFT0583.id as PanelProfileId,
          initialLocation,
        );
        reserved.reservation.complete(result.created);
        device = result.device;
      } catch (err) {
        reserved.reservation.complete(false);
        throw err;
      }
    } else if (advertisedProfile && advertisedProfile !== device.panelProfileId) {
      // Never silently switch an existing physical device to a different wire
      // framebuffer. A mismatch is almost certainly the wrong firmware build.
      res.set('X-InkPanel-Profile', device.panelProfileId);
      res.status(409).json({
        error: 'panel profile mismatch',
        expected: device.panelProfileId,
        advertised: advertisedProfile,
      });
      return;
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
    res.set('X-InkPanel-Profile', device.panelProfileId);
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
