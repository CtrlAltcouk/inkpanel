import { statfs } from 'node:fs/promises';
import { Router } from 'express';
import type { DeviceStore } from '../devices/store.ts';
import type { FrameService } from '../render/frameService.ts';
import { readVersion } from '../system/version.ts';
import { checkForUpdate } from '../system/updateCheck.ts';
import { readUpdateStatus, requestUpdate } from '../system/updateStatus.ts';
import {
  HOME_ASSISTANT_UPDATE_ERROR,
  managedUpdateInfo,
  type UpdateMode,
} from '../system/updateOwnership.ts';

export interface SystemRouteOptions {
  updateMode?: UpdateMode;
  /** Injectable so ownership tests can prove managed deployments never invoke Git. */
  updateChecker?: typeof checkForUpdate;
}

export function systemRoutes(
  store: DeviceStore,
  frames: FrameService,
  dataDir: string,
  options: SystemRouteOptions = {},
): Router {
  const router = Router();
  const updateMode = options.updateMode ?? 'self';
  const updateChecker = options.updateChecker ?? checkForUpdate;

  router.get('/system/info', async (req, res) => {
    const [version, update, devices] = await Promise.all([
      readVersion(),
      updateMode === 'self'
        ? updateChecker(req.query.refresh === '1')
        : Promise.resolve(managedUpdateInfo()),
      store.list(),
    ]);

    let freeBytes: number | null = null;
    try {
      const fs = await statfs(dataDir);
      freeBytes = fs.bavail * fs.bsize;
    } catch {
      // Not fatal; the panel does not stop working because we cannot stat a disk.
    }

    res.json({
      version: version.version,
      commit: version.commit,
      uptimeSeconds: Math.round(process.uptime()),
      deviceCount: devices.length,
      dataDir,
      freeBytes,
      update,
      // issues/renderedDevices come from FrameService's in-memory memo — only
      // devices actually rendered since the last restart; totalDevices comes
      // from the store. Assembled here, where both are already in hand, so a
      // caller can tell "no issues across N of M panels" apart from "nothing
      // rendered since restart" instead of reading an unqualified all-clear.
      sources: {
        issues: frames.sourceIssues(),
        renderedDevices: frames.renderedDeviceCount(),
        totalDevices: devices.length,
      },
    });
  });

  router.post('/system/update', async (_req, res) => {
    if (updateMode === 'home-assistant') {
      res.status(409).json({ error: HOME_ASSISTANT_UPDATE_ERROR });
      return;
    }

    const running = await readUpdateStatus(dataDir);
    if (running.state === 'running') {
      res.status(409).json({ error: 'an update is already running' });
      return;
    }

    try {
      await requestUpdate(dataDir);
      res.status(202).json({ requestedAt: new Date().toISOString() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'could not request update' });
    }
  });

  router.get('/system/update/status', async (_req, res) => {
    res.set('Cache-Control', 'no-store').json(
      updateMode === 'home-assistant'
        ? managedUpdateInfo()
        : await readUpdateStatus(dataDir),
    );
  });

  return router;
}
