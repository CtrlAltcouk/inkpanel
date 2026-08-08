import express from 'express';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DeviceStore } from '../devices/store.ts';
import type { FrameService } from '../render/frameService.ts';
import { createAuth, type AuthOptions } from './auth.ts';
import { deviceRoutes } from './deviceRoutes.ts';
import { firmwareRoutes } from './firmwareRoutes.ts';
import { manageRoutes } from './manageRoutes.ts';
import { systemRoutes } from './systemRoutes.ts';

const require = createRequire(import.meta.url);
const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');

/** Directory holding a @fontsource package's font files. */
function fontDir(pkg: string): string {
  return join(dirname(require.resolve(`${pkg}/package.json`)), 'files');
}

export interface AppDeps {
  store: DeviceStore;
  frames: FrameService;
  publicBaseUrl: string;
  /** Where device config and caches live; used to report free disk space. */
  dataDir: string;
  /** Where build-firmware.sh wrote its output. */
  firmwareDir: string;
  /**
   * Required, not optional. A default would mean inventing a fallback HMAC key
   * that is never used — the kind of line every future reader has to re-derive
   * as safe. Callers already have a real one; make them pass it.
   */
  auth: AuthOptions;
  /**
   * Forwarded to Express's `trust proxy` setting. Undefined leaves Express's
   * default (`false`) in place. Required behind any reverse proxy: without
   * it, `req.ip` is the proxy's own address for every client, so the login
   * rate limiter buckets all clients into one shared counter — five bad
   * attempts from anyone locks out everyone.
   */
  trustProxy?: boolean | number | string;
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  if (deps.trustProxy !== undefined) app.set('trust proxy', deps.trustProxy);
  app.use(express.json());

  app.get('/health', async (_req, res) => {
    res.json({
      status: 'ok',
      devices: (await deps.store.list()).length,
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  const auth = createAuth(deps.auth);

  // Login must be reachable before the gate. auth.ts's isExempt() does NOT
  // match it — only the device frame route is exempt — so this reachability
  // depends entirely on auth.router being mounted before auth.middleware
  // here. This ordering is load-bearing: reverse it and login starts
  // requiring a session to reach the endpoint that creates one.
  app.use('/api', auth.router);
  app.use('/api', auth.middleware);

  // Device routes first: both mount under /api and :id/frame must win.
  app.use('/api', deviceRoutes(deps.store, deps.frames, deps.publicBaseUrl));
  app.use('/api', manageRoutes(deps.store, deps.frames, deps.publicBaseUrl));
  app.use('/api', systemRoutes(deps.store, deps.frames, deps.dataDir));
  app.use('/api', firmwareRoutes(deps.firmwareDir, deps.publicBaseUrl));

  // Serve the latin-subset woff2 straight from @fontsource rather than
  // committing a 2.7 MB TTF for one heading in the admin UI.
  const fontOptions = { immutable: true, maxAge: '30d' };
  app.use('/vendor/fonts', express.static(fontDir('@fontsource/dela-gothic-one'), fontOptions));
  app.use('/vendor/fonts', express.static(fontDir('@fontsource/inter'), fontOptions));

  app.use(express.static(publicDir));

  return app;
}
