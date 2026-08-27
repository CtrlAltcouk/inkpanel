import express, { type NextFunction, type Request, type Response } from 'express';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeviceStoreError, type DeviceStore } from '../devices/store.ts';
import type { FrameService } from '../render/frameService.ts';
import type { NationalRailCredentialStore } from '../sources/nationalRailCredentials.ts';
import type { TransportApiCredentialStore } from '../sources/transportApiCredentials.ts';
import type { GoogleMapsCredentialStore } from '../sources/googleMapsCredentials.ts';
import type { RuntimeState } from '../runtimeConfig.ts';
import { createAuth, type AuthOptions } from './auth.ts';
import { deviceRoutes } from './deviceRoutes.ts';
import type { DeviceEnrolmentLimiter, DeviceEnrolmentDefaultsProvider } from './deviceEnrolment.ts';
import { editorPreferencesRoutes } from './editorPreferencesRoutes.ts';
import { firmwareRoutes } from './firmwareRoutes.ts';
import { manageRoutes } from './manageRoutes.ts';
import { systemRoutes } from './systemRoutes.ts';
import { todoRoutes } from './todoRoutes.ts';
import { TodoStore, TodoStoreError } from '../todo/store.ts';
import { printerRoutes } from './printerRoutes.ts';
import { MoonrakerClient } from '../printers/moonraker.ts';
import { PrinterConnectionStore, PrinterStoreError } from '../printers/store.ts';
import { HomeAssistantClient } from '../homeAssistant/client.ts';
import { homeAssistantRoutes } from './homeAssistantRoutes.ts';
import type { UpdateMode } from '../system/updateOwnership.ts';

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
  /** Shared live state; HTTPS remains null until its listener has started. */
  runtimeState: RuntimeState;
  /** Where device config and caches live; used to report free disk space. */
  dataDir: string;
  /** Where build-firmware.sh wrote its output. */
  firmwareDir: string;
  /** Optional only for tests/embedders; production supplies managed secret stores. */
  trainCredentials?: NationalRailCredentialStore;
  busCredentials?: TransportApiCredentialStore;
  googleMapsCredentials?: GoogleMapsCredentialStore;
  /** Optional TransportAPI endpoint override used by production/test wiring. */
  transportApiBaseUrl?: string;
  /** Shared with FrameService in production; optional for existing test embedders. */
  todoStore?: TodoStore;
  /** Shared with FrameService in production; optional for existing test embedders. */
  printerStore?: PrinterConnectionStore;
  moonrakerClient?: MoonrakerClient;
  /** Shared Supervisor API client. Standalone tests/embedders may omit it. */
  homeAssistantClient?: HomeAssistantClient;
  /** First-enrolment defaults supplied by the deployment, never used for known panels. */
  enrolmentDefaults?: DeviceEnrolmentDefaultsProvider;
  /** Deployment capability shared by runtime UI and mutation routes. Defaults to standalone. */
  updateMode?: UpdateMode;
  /** Non-secret image BUILD_VERSION, shared by LAN and Ingress diagnostics. */
  homeAssistantRelease?: string;
  /** Selects the request trust boundary without duplicating application routes. */
  access?: {
    mode: 'lan' | 'home-assistant-ingress';
    isTrustedRequest?: (req: Request) => boolean;
  };
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
  /** Process-local anti-abuse state for unauthenticated device creation. */
  enrolmentLimiter?: DeviceEnrolmentLimiter;
}

export function isSupervisorIngressRequest(req: Request): boolean {
  const remote = req.socket.remoteAddress ?? '';
  return remote === '172.30.32.2' || remote === '::ffff:172.30.32.2';
}

export function directWebFlashUrl(publicBaseUrl: string, httpsPort: number | null): string | null {
  if (httpsPort === null) return null;
  try {
    const url = new URL(publicBaseUrl);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null;
    url.protocol = 'https:';
    url.port = String(httpsPort);
    url.pathname = '/';
    url.search = '';
    url.hash = '#flash';
    return url.toString();
  } catch {
    return null;
  }
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  const updateMode = deps.updateMode ?? 'self';
  app.disable('x-powered-by');
  if (deps.trustProxy !== undefined) app.set('trust proxy', deps.trustProxy);
  if (deps.access?.mode === 'home-assistant-ingress') {
    const trusted = deps.access.isTrustedRequest ?? isSupervisorIngressRequest;
    app.use((req, res, next) => {
      if (trusted(req)) return next();
      res.status(403).json({ error: 'Home Assistant Ingress proxy required' });
    });
  }
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

  // The plain-HTTP Flash page needs this before WebSerial is available, so it
  // is intentionally public and mounted before the authenticated API gate.
  app.get('/api/runtime-config', (_req, res) => {
    res.set('cache-control', 'no-store');
    res.json({
      httpsPort: deps.runtimeState.httpsPort,
      updateMode,
      ...(updateMode === 'home-assistant'
        ? {
            release: deps.homeAssistantRelease ?? null,
            accessMode: deps.access?.mode === 'home-assistant-ingress'
              ? 'home-assistant-ingress'
              : 'lan',
            webFlashUrl: directWebFlashUrl(deps.publicBaseUrl, deps.runtimeState.httpsPort),
          }
        : {}),
    });
  });

  const todoStore = deps.todoStore ?? new TodoStore(join(deps.dataDir, '.todo-lists.json'));
  const printerStore = deps.printerStore ?? new PrinterConnectionStore(join(deps.dataDir, '.printer-connections.json'));
  const moonrakerClient = deps.moonrakerClient ?? new MoonrakerClient();
  const homeAssistantClient = deps.homeAssistantClient ?? new HomeAssistantClient({ enabled: false });

  // Login must be reachable before the gate. auth.ts's isExempt() does NOT
  // match it — only the device frame route is exempt — so this reachability
  // depends entirely on auth.router being mounted before auth.middleware
  // here. This ordering is load-bearing: reverse it and login starts
  // requiring a session to reach the endpoint that creates one.
  if (deps.access?.mode !== 'home-assistant-ingress') {
    const auth = createAuth(deps.auth);
    app.use('/api', auth.router);
    app.use('/api', auth.middleware);
  }

  // Device routes first: both mount under /api and :id/frame must win.
  app.use('/api', deviceRoutes(
    deps.store,
    deps.frames,
    deps.publicBaseUrl,
    deps.enrolmentLimiter,
    deps.enrolmentDefaults,
  ));
  app.use('/api', manageRoutes(
    deps.store,
    deps.frames,
    deps.publicBaseUrl,
    deps.trainCredentials,
    deps.busCredentials,
    deps.googleMapsCredentials,
    deps.transportApiBaseUrl,
    todoStore,
    printerStore,
  ));
  app.use('/api', editorPreferencesRoutes(deps.store, deps.dataDir));
  app.use('/api', todoRoutes(deps.store, todoStore));
  app.use('/api', printerRoutes(deps.store, printerStore, moonrakerClient));
  app.use('/api', homeAssistantRoutes(homeAssistantClient));
  app.use('/api', systemRoutes(deps.store, deps.frames, deps.dataDir, { updateMode }));
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
    if (err instanceof TodoStoreError) {
      res.status(503).json({
        status: 'error', component: 'todo-store', code: err.code, error: err.message,
        backup: err.backupPath ? basename(err.backupPath) : null,
      });
      return;
    }
    if (err instanceof PrinterStoreError) {
      res.status(503).json({
        status: 'error', component: 'printer-store', code: err.code, error: err.message,
        backup: err.backupPath ? basename(err.backupPath) : null,
      });
      return;
    }
    next(err);
  });

  // Serve the latin-subset woff2 straight from @fontsource rather than
  // committing a 2.7 MB TTF for one heading in the admin UI.
  const fontOptions = { immutable: true, maxAge: '30d' };
  app.use('/vendor/fonts', express.static(fontDir('@fontsource/dela-gothic-one'), fontOptions));
  app.use('/vendor/fonts', express.static(fontDir('@fontsource/inter'), fontOptions));

  // Studio modules keep stable URLs across App upgrades, including Ingress.
  // Do not let old HTML/JS/CSS (or their validators) survive a release change.
  app.use(express.static(publicDir, {
    etag: false,
    lastModified: false,
    setHeaders: (res) => { res.setHeader('Cache-Control', 'no-store'); },
  }));

  return app;
}
