import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { createApp, directWebFlashUrl } from '../../src/http/app.ts';
import { DeviceStore } from '../../src/devices/store.ts';
import type { FrameService } from '../../src/render/frameService.ts';
import { HomeAssistantClient } from '../../src/homeAssistant/client.ts';
import { createRuntimeState } from '../../src/runtimeConfig.ts';

const frames = {
  warmUp: async () => {}, sourceIssues: () => [], renderedDeviceCount: () => 0,
} as unknown as FrameService;

function app(access: 'lan' | 'trusted-ingress' | 'real-ingress', activeHttps: number | null = null) {
  const runtimeState = createRuntimeState();
  runtimeState.httpsPort = activeHttps;
  const homeAssistantClient = new HomeAssistantClient({
    enabled: true,
    token: 'server-only-supervisor-token',
    fetchImpl: async (url) => String(url).endsWith('/calendars')
      ? Response.json([{ entity_id: 'calendar.family', name: 'Family', attributes: { secret: 'server-only-supervisor-token' } }])
      : Response.json({
      version: '2026.8.1', location_name: 'Home', time_zone: 'Europe/London',
    }),
  });
  return createApp({
    store: new DeviceStore(join('unused', 'config.json')),
    frames,
    publicBaseUrl: 'http://192.168.1.20:8080',
    runtimeState,
    dataDir: 'unused',
    firmwareDir: 'unused',
    auth: { password: 'lan-password', secret: randomBytes(32) },
    updateMode: 'home-assistant',
    homeAssistantClient,
    access: access === 'lan'
      ? { mode: 'lan' }
      : { mode: 'home-assistant-ingress', ...(access === 'trusted-ingress' ? { isTrustedRequest: () => true } : {}) },
  });
}

async function requestJson(application: ReturnType<typeof createApp>, path: string, init?: RequestInit) {
  const server = application.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, init);
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('LAN APIs retain InkPanel authentication while trusted Ingress bypasses only that login', async () => {
  assert.equal((await requestJson(app('lan'), '/api/home-assistant/status')).status, 401);
  const trusted = await requestJson(app('trusted-ingress'), '/api/home-assistant/status');
  assert.equal(trusted.status, 200);
  assert.equal(trusted.body.available, true);
  assert.equal(trusted.body.locationName, 'Home');
  assert.doesNotMatch(JSON.stringify(trusted.body), /server-only-supervisor-token/);
});

test('the production Ingress boundary rejects direct non-Supervisor connections', async () => {
  const response = await requestJson(app('real-ingress'), '/api/home-assistant/status', {
    headers: {
      'x-ingress-path': '/api/hassio_ingress/forged-token',
      'x-forwarded-for': '172.30.32.2',
    },
  });
  assert.equal(response.status, 403);
  assert.match(String(response.body.error), /Ingress proxy required/);
});

test('calendar discovery uses the existing authentication boundary and returns only safe metadata', async () => {
  assert.equal((await requestJson(app('lan'), '/api/home-assistant/calendars')).status, 401);
  assert.equal((await requestJson(app('real-ingress'), '/api/home-assistant/calendars')).status, 403);
  const result = await requestJson(app('trusted-ingress'), '/api/home-assistant/calendars');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { supported: true, available: true, calendars: [{ entityId: 'calendar.family', name: 'Family' }], error: null });
  assert.doesNotMatch(JSON.stringify(result.body), /supervisor|authorization|attributes|http:/i);
});

test('HA runtime config exposes only the active direct HTTPS root for WebFlash', async () => {
  assert.deepEqual((await requestJson(app('trusted-ingress'), '/api/runtime-config')).body, {
    httpsPort: null, updateMode: 'home-assistant',
    accessMode: 'home-assistant-ingress', webFlashUrl: null,
  });
  assert.deepEqual((await requestJson(app('trusted-ingress', 8443), '/api/runtime-config')).body, {
    httpsPort: 8443, updateMode: 'home-assistant', accessMode: 'home-assistant-ingress',
    webFlashUrl: 'https://192.168.1.20:8443/#flash',
  });
  assert.deepEqual((await requestJson(app('lan', 8443), '/api/runtime-config')).body, {
    httpsPort: 8443, updateMode: 'home-assistant',
    accessMode: 'lan', webFlashUrl: 'https://192.168.1.20:8443/#flash',
  });
  assert.equal(directWebFlashUrl('http://panel.local:8080/path', 8443), 'https://panel.local:8443/#flash');
  assert.equal(directWebFlashUrl('http://user:pass@panel.local:8080/', 8443), null);
});
