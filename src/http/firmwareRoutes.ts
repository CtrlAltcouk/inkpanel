import { Router } from 'express';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';

/** Only ever a plain filename produced by the build: no separators, no dots. */
const BIN_NAME = /^[A-Za-z0-9._-]+\.bin$/;

export function firmwareRoutes(firmwareDir: string, publicBaseUrl = ''): Router {
  const router = Router();

  router.get('/firmware/manifest', async (_req, res) => {
    try {
      const parsed = JSON.parse(await readFile(join(firmwareDir, 'manifest.json'), 'utf8'));
      res.json({
        available: true,
        version: String(parsed.version ?? 'unknown'),
        builtAt: String(parsed.builtAt ?? ''),
        // The browser uses this for fresh installs so a user never has to know
        // or type the LXC address. It is the same URL firmware check-ins use.
        serverUrl: publicBaseUrl,
        // `parts` is the fresh-install/recovery set (normally merged.bin).
        parts: Array.isArray(parsed.parts) ? parsed.parts : [],
        // Routine updates use only these regions so NVS/Wi-Fi is untouched.
        updateParts: Array.isArray(parsed.updateParts) ? parsed.updateParts : [],
      });
    } catch {
      // No build yet, or a half-written one. Both mean "nothing to flash",
      // which the tab reports plainly — it is not a server error.
      res.json({ available: false });
    }
  });

  router.get('/firmware/bin/:name', async (req, res) => {
    const name = req.params.name;
    // basename() alone is not the check — it is belt and braces behind the
    // pattern. This route reads files by a client-supplied name, and the data
    // directory beside it holds the session secret. Express decodes route
    // params before handing them to the route (`..%2F..%2Fx` arrives here as
    // `../../x`), so the traversal has to be caught after decoding, not
    // before. The allowlist regex rejects any `/` or `\` outright — decoded
    // or not — and basename() is a second, independent check against the
    // same class of bug so a future loosening of the regex doesn't silently
    // reopen this.
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

    // stat() above narrows this to a TOCTOU window, not a certainty: the
    // file can vanish or become unreadable between stat() and the actual
    // open (concurrent cleanup, a permission change, antivirus locking, a
    // storage hiccup). Without this listener, createReadStream's 'error'
    // event goes unhandled and takes down the whole process — every panel
    // served by it, not just this request. The listener must be attached
    // before pipe() starts pulling data.
    const stream = createReadStream(path);
    stream.on('error', () => {
      // Once the body has started, the status line is already gone, so the
      // only honest signal left is to break the connection rather than let a
      // truncated binary look like a complete one.
      if (res.headersSent) res.destroy();
      else res.status(500).json({ error: 'firmware file could not be read' });
    });
    res.type('application/octet-stream').set('Cache-Control', 'no-store');
    stream.pipe(res);
  });

  return router;
}
