import 'dotenv/config';
import { hostname, networkInterfaces } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp, type AppDeps } from './http/app.ts';
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
import {
  createManagedNationalRailTrainSource,
  NationalRailCredentialStore,
} from './sources/nationalRailCredentials.ts';
import { TransportApiCredentialStore } from './sources/transportApiCredentials.ts';
import { createManagedTransportApiBusSource } from './sources/transportApiBus.ts';
import { GoogleMapsCredentialStore } from './sources/googleMapsCredentials.ts';
import { createManagedGoogleTrafficSource } from './sources/googleTraffic.ts';
import { createRuntimeState, resolveHttpsPort } from './runtimeConfig.ts';
import { TodoStore } from './todo/store.ts';
import { PrinterConnectionStore } from './printers/store.ts';
import { MoonrakerClient } from './printers/moonraker.ts';
import { HomeAssistantClient, isHomeAssistantMode } from './homeAssistant/client.ts';
import { updateModeForDeployment } from './system/updateOwnership.ts';

export const version = '0.1.0';

export function resolveHomeAssistantIngressPort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 8099;
  if (!/^\d+$/.test(raw.trim())) throw new Error('HOME_ASSISTANT_INGRESS_PORT must be an integer');
  const port = Number(raw);
  if (port < 1 || port > 65535) throw new Error('HOME_ASSISTANT_INGRESS_PORT must be between 1 and 65535');
  return port;
}

async function waitUntilListening(server: ReturnType<ReturnType<typeof createApp>['listen']>): Promise<void> {
  await new Promise<void>((resolveListening, rejectListening) => {
    if (server.listening) return resolveListening();
    const onError = (err: Error) => rejectListening(err);
    server.once('error', onError);
    server.once('listening', () => {
      server.off('error', onError);
      resolveListening();
    });
  });
}

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
  NATIONAL_RAIL_LDB_API_KEY?: string;
  /** Optional emergency/future gateway override; normally omitted. */
  NATIONAL_RAIL_LDB_BASE_URL?: string;
}

/** Build the RDM train source only when a Consumer key has been configured. */
export function createTrainSourceFromEnv(env: TrainEnvironment) {
  const apiKey = env.NATIONAL_RAIL_LDB_API_KEY?.trim() ?? '';
  const baseUrl = env.NATIONAL_RAIL_LDB_BASE_URL?.trim() ?? '';
  if (!apiKey && !baseUrl) return undefined;
  if (!apiKey) {
    throw new Error('National Rail live departures require NATIONAL_RAIL_LDB_API_KEY');
  }
  return createNationalRailTrainSource({ apiKey, ...(baseUrl ? { baseUrl } : {}) });
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
  const homeAssistantMode = isHomeAssistantMode(process.env.HOME_ASSISTANT_MODE);
  const updateMode = updateModeForDeployment(homeAssistantMode);
  const allowPrivateCalendarNetworks = parseCalendarAllowPrivateNetworks(
    process.env.CALENDAR_ALLOW_PRIVATE_NETWORKS,
  );

  const store = new DeviceStore(join(dataDir, 'config.json'));
  const todoStore = new TodoStore(join(dataDir, '.todo-lists.json'));
  const printerStore = new PrinterConnectionStore(join(dataDir, '.printer-connections.json'));
  const moonrakerClient = new MoonrakerClient();
  const renderer = new Renderer();
  const calendarSource = createIcalFeedSource(createCalendarTextFetcher({
    allowPrivateNetworks: allowPrivateCalendarNetworks,
  }));

  const trainCredentials = new NationalRailCredentialStore(
    join(dataDir, '.national-rail-api-key'),
    process.env.NATIONAL_RAIL_LDB_API_KEY,
  );
  await trainCredentials.load();
  const trainBaseUrl = process.env.NATIONAL_RAIL_LDB_BASE_URL?.trim() || undefined;
  if (trainBaseUrl && !trainCredentials.status().configured) {
    throw new Error('National Rail live departures require NATIONAL_RAIL_LDB_API_KEY');
  }
  const trainSource = createManagedNationalRailTrainSource(
    trainCredentials,
    trainBaseUrl ? { baseUrl: trainBaseUrl } : {},
  );

  const busCredentials = new TransportApiCredentialStore(
    join(dataDir, '.transportapi-credentials.json'),
    process.env.TRANSPORTAPI_APP_ID,
    process.env.TRANSPORTAPI_APP_KEY,
  );
  await busCredentials.load();
  const transportApiBaseUrl = process.env.TRANSPORTAPI_BASE_URL?.trim() || undefined;
  const busSource = createManagedTransportApiBusSource(
    busCredentials,
    transportApiBaseUrl ? { baseUrl: transportApiBaseUrl } : {},
  );

  const googleMapsCredentials = new GoogleMapsCredentialStore(
    join(dataDir, '.google-maps-api-key'),
    process.env.GOOGLE_MAPS_ROUTES_API_KEY,
  );
  await googleMapsCredentials.load();
  const googleRoutesEndpoint = process.env.GOOGLE_ROUTES_URL?.trim() || undefined;
  const trafficSource = createManagedGoogleTrafficSource(
    googleMapsCredentials,
    googleRoutesEndpoint ? { endpoint: googleRoutesEndpoint } : {},
  );

  const frames = new FrameService({
    renderer,
    cache: new SourceCache(join(dataDir, 'cache')),
    calendarSource,
    trainSource,
    busSource,
    trafficSource,
    todoStore,
    printerStore,
    moonrakerClient,
  });

  const password = process.env.INKPANEL_PASSWORD?.trim() || null;
  const secret = await loadOrCreateSecret(join(dataDir, '.session-secret'));
  const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
  const homeAssistantClient = new HomeAssistantClient({
    enabled: homeAssistantMode,
    baseUrl: process.env.HOME_ASSISTANT_BASE_URL,
    token: process.env.SUPERVISOR_TOKEN,
  });

  const sharedDeps: AppDeps = {
    store, frames, publicBaseUrl, runtimeState,
    dataDir, firmwareDir, auth: { password, secret }, trustProxy,
    trainCredentials,
    busCredentials,
    googleMapsCredentials,
    transportApiBaseUrl,
    todoStore,
    printerStore,
    moonrakerClient,
    homeAssistantClient,
    updateMode,
  };
  const app = createApp({ ...sharedDeps, access: { mode: 'lan' } });
  const server = app.listen(port);
  await waitUntilListening(server);

  let ingressServer: ReturnType<typeof app.listen> | null = null;
  if (homeAssistantMode) {
    const ingressPort = resolveHomeAssistantIngressPort(process.env.HOME_ASSISTANT_INGRESS_PORT);
    if (ingressPort === port) {
      server.close();
      throw new Error('HOME_ASSISTANT_INGRESS_PORT must differ from PORT');
    }
    const ingressApp = createApp({
      ...sharedDeps,
      access: { mode: 'home-assistant-ingress' },
    });
    ingressServer = ingressApp.listen(ingressPort);
    try {
      await waitUntilListening(ingressServer);
    } catch (err) {
      server.close();
      throw err;
    }
    console.log(`Home Assistant Ingress listening internally on port ${ingressPort}`);
  }
  console.log(`inkpanel ${version} listening on ${publicBaseUrl}`);
  console.log(`data directory: ${dataDir}`);
  console.log(password ? 'authentication: enabled' : 'authentication: disabled (no INKPANEL_PASSWORD)');
  console.log(`private calendar networks: ${allowPrivateCalendarNetworks ? 'enabled' : 'blocked'}`);
  console.log(`National Rail live departures: ${trainCredentials.status().configured ? 'configured' : 'not configured'}`);
  console.log(`TransportAPI bus departures: ${busCredentials.status().configured ? 'configured' : 'not configured'}`);
  console.log(`Google traffic routes: ${googleMapsCredentials.status().configured ? 'configured' : 'not configured'}`);
  console.log(`Home Assistant mode: ${homeAssistantMode ? 'enabled' : 'standalone'}`);

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

  const warmStarted = Date.now();
  frames
    .warmUp()
    .then(() => console.log(`chromium ready in ${Date.now() - warmStarted}ms`))
    .catch((err) => console.error('chromium warm-up failed:', err));

  const shutdown = async () => {
    server.close();
    ingressServer?.close();
    httpsServer?.close();
    await renderer.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
