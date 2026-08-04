import { statfs } from 'node:fs/promises';
import { Router } from 'express';
import type { DeviceStore } from '../devices/store.ts';
import type { FrameService } from '../render/frameService.ts';
import { readVersion } from '../system/version.ts';
import { checkForUpdate } from '../system/updateCheck.ts';

export function systemRoutes(store: DeviceStore, frames: FrameService, dataDir: string): Router {
  const router = Router();

  router.get('/system/info', async (req, res) => {
    const [version, update, devices] = await Promise.all([
      readVersion(),
      checkForUpdate(req.query.refresh === '1'),
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
      sourceIssues: frames.sourceIssues(),
    });
  });

  return router;
}
