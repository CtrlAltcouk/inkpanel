import express, { type NextFunction, type Request, type Response } from 'express';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeviceStoreError, type DeviceStore } from '../devices/store.ts';
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

function deviceStoreErrorBody(err: DeviceStoreError) {
  return {
    status: 'error' as const,
    component: 'device-store' as const,
    code: err.code,
    error: err.message,
    // Never expose the host data-directory path through an HTTP endpoint. The
    // basename is enough for an administrator to identify the preserved copy.
    backup: err.backupPath ? basename(err.backupPath) : null,
  };
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
    const uptimeSeconds = Math.round(process.uptime());
    let devices: number;
    try {
      devices = (await deps.store.list()).length;
    } catch (err) {
      if (err instanceof DeviceStoreError) {
        res.status(503).json({ ...deviceStoreErrorBody(err), devices: null, uptimeSeconds });
        return;
      }
      throw err;
    }

    try {
      await deps.frames.warmUp();
    } catch (err) {
      res.status(503).json({
        status: 'error',
        component: 'renderer',
        error: err instanceof Error ? err.message : String(err),
        devices,
        uptimeSeconds,
      });
      return;
    }

    res.json({ status: 'ok', devices, uptimeSeconds });
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

  // A corrupt/unreadable device store is a deliberate fail-closed condition,
  // not an internal-server mystery. Any API route that touches DeviceStore gets
  // the same machine-readable 503 response; device firmware will treat it as a
  // fetch failure and retain its existing e-paper image rather than enrolling
  // into a freshly invented empty configuration.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof DeviceStoreError) {
      res.status(503).json(deviceStoreErrorBody(err));
      return;
    }
    next(err);
  });

  // Serve the latin-subset woff2 straight from @fontsource rather than
  // committing a 2.7 MB TTF for one heading in the admin UI.
  const fontOptions = { immutable: true, maxAge: '30d' };
  app.use('/vendor/fonts', express.static(fontDir('@fontsource/dela-gothic-one'), fontOptions));
  app.use('/vendor/fonts', express.static(fontDir('@fontsource/inter'), fontOptions));

  app.use(express.static(publicDir));

  return app;
}
