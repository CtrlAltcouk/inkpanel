import 'dotenv/config';
import { hostname, networkInterfaces } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from './http/app.ts';
import { loadOrCreateSecret } from './http/auth.ts';
import { activateHttpsListener } from './https.ts';
import { DeviceStore } from './devices/store.ts';
import { FrameService } from './render/frameService.ts';
import { Renderer } from './render/browser.ts';
import { SourceCache } from './sources/cache.ts';
import {
  createCalendarTextFetcher,
  parseCalendarAllowPrivateNetworks,
} from './sources/calendarHttp.ts';
import { createIcalFeedSource } from './sources/ical.ts';
import { createNationalRailTrainSource } from './sources/nationalRailTrain.ts';
import { createRuntimeState, resolveHttpsPort } from './runtimeConfig.ts';

export const version = '0.1.0';

/**
 * Parse `TRUST_PROXY` into whatever Express's `app.set('trust proxy', ...)`
 * expects: a hop count, `true`/`false`, or a string Express parses itself
 * (a single token like "loopback", or a comma-separated list of addresses/
 * subnets — Express's own `proxyaddr` compiler handles the splitting, so it
 * is passed through unchanged rather than split here).
 */
export function parseTrustProxy(raw: string | undefined): boolean | number | string | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (value === '') return undefined;
  if (/^\d+$/.test(value)) return Number(value);
  if (value.toLowerCase() === 'true') return true;
  if (value.toLowerCase() === 'false') return false;
  return value;
}

export interface TrainEnvironment {
  NATIONAL_RAIL_LDB_BASE_URL?: string;
  NATIONAL_RAIL_LDB_AUTH_HEADER?: string;
  NATIONAL_RAIL_LDB_AUTH_VALUE?: string;
}

/**
 * Build the credentialled train source only when the server has been given a
 * complete RDM product configuration. The auth value is never persisted or
 * handed to FrameService as source config, so it cannot enter cache keys.
 */
export function createTrainSourceFromEnv(env: TrainEnvironment) {
  const baseUrl = env.NATIONAL_RAIL_LDB_BASE_URL?.trim() ?? '';
  const authHeaderName = env.NATIONAL_RAIL_LDB_AUTH_HEADER?.trim() || 'Authorization';
  const authHeaderValue = env.NATIONAL_RAIL_LDB_AUTH_VALUE?.trim() ?? '';
  if (!baseUrl && !authHeaderValue && !env.NATIONAL_RAIL_LDB_AUTH_HEADER?.trim()) return undefined;
  if (!baseUrl || !authHeaderValue) {
    throw new Error(
      'National Rail live departures require both NATIONAL_RAIL_LDB_BASE_URL and NATIONAL_RAIL_LDB_AUTH_VALUE',
    );
  }
  return createNationalRailTrainSource({ baseUrl, authHeaderName, authHeaderValue });
}

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
  const firmwareDir = resolve(process.env.FIRMWARE_DIR ?? './firmware/dist');
  const detectedLanAddress = lanAddress();
  const publicBaseUrl = process.env.PUBLIC_BASE_URL || `http://${detectedLanAddress}:${port}`;
  const resolvedHttps = resolveHttpsPort(process.env.HTTPS_PORT);
  const runtimeState = createRuntimeState();
  const allowPrivateCalendarNetworks = parseCalendarAllowPrivateNetworks(
    process.env.CALENDAR_ALLOW_PRIVATE_NETWORKS,
  );

  const store = new DeviceStore(join(dataDir, 'config.json'));
  const renderer = new Renderer();
  const calendarSource = createIcalFeedSource(createCalendarTextFetcher({
    allowPrivateNetworks: allowPrivateCalendarNetworks,
  }));
  const trainSource = createTrainSourceFromEnv(process.env);
  const frames = new FrameService({
    renderer,
    cache: new SourceCache(join(dataDir, 'cache')),
    calendarSource,
    trainSource,
  });

  const password = process.env.INKPANEL_PASSWORD?.trim() || null;
  const secret = await loadOrCreateSecret(join(dataDir, '.session-secret'));
  const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);

  const app = createApp({
    store, frames, publicBaseUrl, runtimeState,
    dataDir, firmwareDir, auth: { password, secret }, trustProxy,
  });
  const server = app.listen(port);
  await new Promise<void>((resolveListening, rejectListening) => {
    if (server.listening) {
      resolveListening();
      return;
    }
    const onError = (err: Error) => rejectListening(err);
    server.once('error', onError);
    server.once('listening', () => {
      server.off('error', onError);
      resolveListening();
    });
  });
  console.log(`inkpanel ${version} listening on ${publicBaseUrl}`);
  console.log(`data directory: ${dataDir}`);
  console.log(password ? 'authentication: enabled' : 'authentication: disabled (no INKPANEL_PASSWORD)');
  console.log(`private calendar networks: ${allowPrivateCalendarNetworks ? 'enabled' : 'blocked'}`);
  console.log(`National Rail live departures: ${trainSource ? 'configured' : 'not configured'}`);

  // Additive: :8080 keeps serving firmware check-ins over plain HTTP, which
  // an ESP32 cannot do over a self-signed cert anyway. This second listener
  // exists so the browser will expose WebSerial, which requires a secure
  // context — see docs/superpowers/specs/2026-08-06-inkpanel-web-flash-design.md.
  const httpsServer = resolvedHttps.httpsPort === null
    ? null
    : await activateHttpsListener(app, {
      dataDir,
      port: resolvedHttps.httpsPort,
      identities: { lanAddress: detectedLanAddress, publicBaseUrl, hostname: hostname() },
    }, runtimeState);
  if (resolvedHttps.error) {
    console.error(`https disabled: ${resolvedHttps.error}; plain HTTP remains available`);
  } else {
    console.log(
      httpsServer
        ? `https listening on https://${detectedLanAddress}:${resolvedHttps.httpsPort} (self-signed; needed for the Flash tab)`
        : 'https disabled: could not generate a certificate (openssl missing?) — flashing will be unavailable',
    );
  }

  // Launch Chromium now rather than making the first device wait for it. A cold
  // launch on a modest container can exceed a panel's HTTP read timeout.
  const warmStarted = Date.now();
  frames
    .warmUp()
    .then(() => console.log(`chromium ready in ${Date.now() - warmStarted}ms`))
    .catch((err) => console.error('chromium warm-up failed:', err));

  const shutdown = async () => {
    server.close();
    httpsServer?.close();
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
