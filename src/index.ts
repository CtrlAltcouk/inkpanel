import 'dotenv/config';
import { networkInterfaces } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from './http/app.ts';
import { loadOrCreateSecret } from './http/auth.ts';
import { DeviceStore } from './devices/store.ts';
import { FrameService } from './render/frameService.ts';
import { Renderer } from './render/browser.ts';
import { SourceCache } from './sources/cache.ts';

export const version = '0.1.0';

function lanAddress(): string {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return 'localhost';
}

export async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 8080);
  const dataDir = resolve(process.env.DATA_DIR ?? './data');
  const publicBaseUrl = process.env.PUBLIC_BASE_URL || `http://${lanAddress()}:${port}`;

  const store = new DeviceStore(join(dataDir, 'config.json'));
  const renderer = new Renderer();
  const frames = new FrameService({ renderer, cache: new SourceCache(join(dataDir, 'cache')) });

  const password = process.env.INKPANEL_PASSWORD?.trim() || null;
  const secret = await loadOrCreateSecret(join(dataDir, '.session-secret'));

  const server = createApp({ store, frames, publicBaseUrl, auth: { password, secret } }).listen(port, () => {
    console.log(`inkpanel ${version} listening on ${publicBaseUrl}`);
    console.log(`data directory: ${dataDir}`);
    console.log(password ? 'authentication: enabled' : 'authentication: disabled (no INKPANEL_PASSWORD)');
  });

  // Launch Chromium now rather than making the first device wait for it. A cold
  // launch on a modest container can exceed a panel's HTTP read timeout.
  const warmStarted = Date.now();
  frames
    .warmUp()
    .then(() => console.log(`chromium ready in ${Date.now() - warmStarted}ms`))
    .catch((err) => console.error('chromium warm-up failed:', err));

  const shutdown = async () => {
    server.close();
    await renderer.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// Only start when run directly, so tests can import this module.
// pathToFileURL rather than string comparison: on Windows argv[1] is a
// backslash path that never matches an import.meta.url suffix.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
