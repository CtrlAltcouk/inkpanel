import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/http/app.ts';
import { DeviceStore } from '../../src/devices/store.ts';
import type { FrameService } from '../../src/render/frameService.ts';
import { TransportApiCredentialStore } from '../../src/sources/transportApiCredentials.ts';
import { GoogleMapsCredentialStore } from '../../src/sources/googleMapsCredentials.ts';

const frames = {
  frameFor: async () => ({ buffer: Buffer.alloc(48000, 0), etag: 'c'.repeat(32), renderedAt: '2026-08-10T19:00:00.000Z' }),
  enrolmentFrame: async () => ({ buffer: Buffer.alloc(48000, 0), etag: 'd'.repeat(32), renderedAt: '2026-08-10T19:00:00.000Z' }),
  previewHtml: async () => '<html></html>',
  renderNow: async () => ({ buffer: Buffer.alloc(48000, 0), etag: 'e'.repeat(32), renderedAt: '2026-08-10T19:00:00.000Z' }),
  sourceIssues: () => [],
  renderedDeviceCount: () => 0,
  warmUp: async () => {},
} as unknown as FrameService;

async function withServer(fn: (base: string, bus: TransportApiCredentialStore, google: GoogleMapsCredentialStore) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-bus-traffic-http-'));
  const store = new DeviceStore(join(dir, 'config.json'));
  const bus = new TransportApiCredentialStore(join(dir, '.transportapi-credentials.json'));
  const google = new GoogleMapsCredentialStore(join(dir, '.google-maps-api-key'));
  await bus.load();
  await google.load();
  const server = createApp({
    store,
    frames,
    publicBaseUrl: 'http://test.local:8080',
    runtimeState: { httpsPort: null },
    dataDir: dir,
    firmwareDir: dir,
    auth: { password: null, secret: randomBytes(32) },
    busCredentials: bus,
    googleMapsCredentials: google,
    transportApiBaseUrl: 'https://transportapi.test/v3/uk/',
  }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await fn(`http://127.0.0.1:${port}`, bus, google);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const BUS = { appId: 'test-app-id', appKey: 'test-app-key-1234567890' };
const GOOGLE = 'AIza' + 'g'.repeat(35);

test('Bus and Google credential status endpoints never expose stored secret values', async () => {
  await withServer(async (base, bus, google) => {
    await bus.set(BUS);
    await google.set(GOOGLE);

    const busResponse = await fetch(`${base}/api/transportapi`);
    const googleResponse = await fetch(`${base}/api/google-maps`);
    assert.equal(busResponse.status, 200);
    assert.equal(googleResponse.status, 200);
    const busText = await busResponse.text();
    const googleText = await googleResponse.text();
    assert.deepEqual(JSON.parse(busText), { configured: true, managed: true });
    assert.deepEqual(JSON.parse(googleText), { configured: true, managed: true });
    assert.doesNotMatch(busText, new RegExp(BUS.appId));
    assert.doesNotMatch(busText, new RegExp(BUS.appKey));
    assert.doesNotMatch(googleText, new RegExp(GOOGLE));
  });
});

test('management PUTs accept complete provider credentials without echoing them', async () => {
  await withServer(async (base, bus, google) => {
    const busResponse = await fetch(`${base}/api/transportapi`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(BUS),
    });
    const googleResponse = await fetch(`${base}/api/google-maps`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiKey: GOOGLE }),
    });
    assert.equal(busResponse.status, 200);
    assert.equal(googleResponse.status, 200);
    const busText = await busResponse.text();
    const googleText = await googleResponse.text();
    assert.doesNotMatch(busText, new RegExp(BUS.appId));
    assert.doesNotMatch(busText, new RegExp(BUS.appKey));
    assert.doesNotMatch(googleText, new RegExp(GOOGLE));
    assert.deepEqual(bus.current(), BUS);
    assert.equal(google.current(), GOOGLE);
  });
});

test('Bus credential validation is all-or-nothing and does not reflect supplied secrets', async () => {
  await withServer(async (base, bus) => {
    const response = await fetch(`${base}/api/transportapi`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId: BUS.appId, appKey: '' }),
    });
    assert.equal(response.status, 400);
    const text = await response.text();
    assert.doesNotMatch(text, new RegExp(BUS.appId));
    assert.equal(bus.current(), null);
  });
});

test('Bus stop lookup sends TransportAPI credentials in headers, never its URL', async () => {
  await withServer(async (base, bus) => {
    await bus.set(BUS);
    const realFetch = globalThis.fetch;
    let upstreamUrl = '';
    let upstreamHeaders = new Headers();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith('https://transportapi.test/')) {
        upstreamUrl = String(input);
        upstreamHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({
          member: [{ name: 'Central Station', atcocode: '049000000001', locality: 'Milton Keynes' }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return realFetch(input, init);
    }) as typeof globalThis.fetch;
    try {
      const response = await fetch(`${base}/api/bus-stops?q=central`);
      assert.equal(response.status, 200);
      const body = await response.json() as { results: Array<{ stopCode: string }> };
      assert.equal(body.results[0]?.stopCode, '049000000001');
      assert.equal(upstreamHeaders.get('X-App-Id'), BUS.appId);
      assert.equal(upstreamHeaders.get('X-App-Key'), BUS.appKey);
      assert.doesNotMatch(upstreamUrl, new RegExp(BUS.appId));
      assert.doesNotMatch(upstreamUrl, new RegExp(BUS.appKey));
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
