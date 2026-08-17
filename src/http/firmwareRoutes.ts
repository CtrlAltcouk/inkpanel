import { Router } from 'express';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';

/** Only ever a plain filename produced by the build: no separators, no dots. */
const BIN_NAME = /^[A-Za-z0-9._-]+\.bin$/;

const FIRMWARE_TARGETS = [
  {
    id: 'full',
    label: 'InkPanel 7.5-inch',
    hardware: 'XIAO ESP32-S3 Plus + EE04',
    subdir: null,
  },
  {
    id: 'mini',
    label: 'InkPanel Mini 1.54-inch',
    hardware: 'XIAO ESP32-S3 + ePaper Driver Board + SSD1681',
    subdir: 'mini',
  },
] as const;

type FirmwareTargetId = typeof FIRMWARE_TARGETS[number]['id'];

function targetDefinition(raw: string) {
  return FIRMWARE_TARGETS.find((target) => target.id === raw) ?? null;
}

function targetDirectory(firmwareDir: string, target: FirmwareTargetId): string {
  const definition = targetDefinition(target)!;
  return definition.subdir ? join(firmwareDir, definition.subdir) : firmwareDir;
}

async function manifestBody(dir: string, publicBaseUrl: string) {
  try {
    const parsed = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
    return {
      available: true as const,
      target: String(parsed.target ?? 'full'),
      version: String(parsed.version ?? 'unknown'),
      builtAt: String(parsed.builtAt ?? ''),
      serverUrl: publicBaseUrl,
      parts: Array.isArray(parsed.parts) ? parsed.parts : [],
      updateParts: Array.isArray(parsed.updateParts) ? parsed.updateParts : [],
      provisioning: parsed.provisioning && typeof parsed.provisioning === 'object'
        ? parsed.provisioning
        : null,
    };
  } catch {
    return { available: false as const };
  }
}

function streamBinary(res: any, path: string) {
  const stream = createReadStream(path);
  stream.on('error', () => {
    if (res.headersSent) res.destroy();
    else res.status(500).json({ error: 'firmware file could not be read' });
  });
  res.type('application/octet-stream').set('Cache-Control', 'no-store');
  stream.pipe(res);
}

export function firmwareRoutes(firmwareDir: string, publicBaseUrl = ''): Router {
  const router = Router();

  // Legacy/default endpoint: intentionally remains the 7.5-inch package so
  // existing browser code and external tooling do not change meaning.
  router.get('/firmware/manifest', async (_req, res) => {
    res.json(await manifestBody(firmwareDir, publicBaseUrl));
  });

  // New WebFlash clients use this catalog to make hardware selection explicit.
  // A missing Mini build disables only that option; it never hides the existing
  // full-size package.
  router.get('/firmware/targets', async (_req, res) => {
    const targets = await Promise.all(FIRMWARE_TARGETS.map(async (definition) => ({
      id: definition.id,
      label: definition.label,
      hardware: definition.hardware,
      manifest: await manifestBody(targetDirectory(firmwareDir, definition.id), publicBaseUrl),
    })));
    res.json({ defaultTarget: 'full', targets });
  });

  router.get('/firmware/targets/:target/manifest', async (req, res) => {
    const definition = targetDefinition(req.params.target);
    if (!definition) {
      res.status(404).json({ error: 'unknown firmware target' });
      return;
    }
    res.json(await manifestBody(targetDirectory(firmwareDir, definition.id), publicBaseUrl));
  });

  router.get('/firmware/targets/:target/bin/:name', async (req, res) => {
    const definition = targetDefinition(req.params.target);
    if (!definition) {
      res.status(404).json({ error: 'unknown firmware target' });
      return;
    }
    const name = req.params.name;
    if (!BIN_NAME.test(name) || basename(name) !== name) {
      res.status(400).json({ error: 'invalid firmware name' });
      return;
    }

    const path = join(targetDirectory(firmwareDir, definition.id), name);
    try {
      await stat(path);
    } catch {
      res.status(404).json({ error: 'unknown firmware file' });
      return;
    }
    streamBinary(res, path);
  });

  // Legacy binary route serves only firmware/dist root. Mini binaries can only
  // be reached through an explicit target path, preventing name collisions.
  router.get('/firmware/bin/:name', async (req, res) => {
    const name = req.params.name;
    if (!BIN_NAME.test(name) || basename(name) !== name) {
      res.status(400).json({ error: 'invalid firmware name' });
      return;
    }

    const path = join(firmwareDir, name);
    try {
      await stat(path);
    } catch {
      res.status(404).json({ error: 'unknown firmware file' });
      return;
    }
    streamBinary(res, path);
  });

  return router;
}
