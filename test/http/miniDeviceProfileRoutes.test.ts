import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/http/app.ts';
import { DeviceStore } from '../../src/devices/store.ts';
import type { DeviceRecord } from '../../src/devices/types.ts';
import type { FrameService } from '../../src/render/frameService.ts';

function bytesFor(device: DeviceRecord): number {
  return device.panelProfileId === 'ssd1681-200x200-mono' ? 5000 : 48000;
}

const frames = {
  frameFor: async (device: DeviceRecord) => ({
    buffer: Buffer.alloc(bytesFor(device), 0), etag: 'a'.repeat(32), renderedAt: new Date().toISOString(),
  }),
  enrolmentFrame: async (device: DeviceRecord) => ({
    buffer: Buffer.alloc(bytesFor(device), 0), etag: 'b'.repeat(32), renderedAt: new Date().toISOString(),
  }),
  previewHtml: async () => '<html></html>',
  sourceIssues: () => [], renderedDeviceCount: () => 0, warmUp: async () => {},
} as unknown as FrameService;

async function withServer(fn: (base: string, store: DeviceStore) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-mini-profile-'));
  const store = new DeviceStore(join(dir, 'config.json'));
  const server = createApp({
    store,
    frames,
    publicBaseUrl: 'http://test.local:8080',
    runtimeState: { httpsPort: null },
    dataDir: dir,
    firmwareDir: dir,
    auth: { password: null, secret: randomBytes(32) },
  }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await fn(`http://127.0.0.1:${port}`, store);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('legacy firmware without a profile header still enrols as the existing 7.5-inch profile', async () => {
  await withServer(async (base, store) => {
    const res = await fetch(`${base}/api/devices/esp32-a1b2c3/frame`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-inkpanel-profile'), 'wft0583-800x480-mono');
    assert.equal((await res.arrayBuffer()).byteLength, 48000);
    const device = await store.get('esp32-a1b2c3');
    assert.equal(device?.panelProfileId, 'wft0583-800x480-mono');
    assert.equal(device?.dashboardSections.length, 4);
  });
});

test('Mini firmware header enrols a one-widget 200x200 device', async () => {
  await withServer(async (base, store) => {
    const res = await fetch(`${base}/api/devices/esp32-a1b2c3/frame`, {
      headers: { 'x-inkpanel-profile': 'ssd1681-200x200-mono' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-inkpanel-profile'), 'ssd1681-200x200-mono');
    assert.equal((await res.arrayBuffer()).byteLength, 5000);
    const device = await store.get('esp32-a1b2c3');
    assert.equal(device?.panelProfileId, 'ssd1681-200x200-mono');
    assert.equal(device?.dashboardSections.length, 1);
    assert.equal(device?.dashboardSections[0]?.type, 'weather');
  });
});

test('an unknown advertised profile fails closed and creates no device', async () => {
  await withServer(async (base, store) => {
    const res = await fetch(`${base}/api/devices/esp32-a1b2c3/frame`, {
      headers: { 'x-inkpanel-profile': 'future-screen-123' },
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'unknown panel profile' });
    assert.equal(await store.get('esp32-a1b2c3'), null);
  });
});

test('an existing device rejects firmware for a different physical profile', async () => {
  await withServer(async (base, store) => {
    await store.getOrCreate('esp32-a1b2c3');
    const res = await fetch(`${base}/api/devices/esp32-a1b2c3/frame`, {
      headers: { 'x-inkpanel-profile': 'ssd1681-200x200-mono' },
    });
    assert.equal(res.status, 409);
    assert.equal(res.headers.get('x-inkpanel-profile'), 'wft0583-800x480-mono');
    assert.deepEqual(await res.json(), {
      error: 'panel profile mismatch',
      expected: 'wft0583-800x480-mono',
      advertised: 'ssd1681-200x200-mono',
    });
    assert.equal((await store.get('esp32-a1b2c3'))?.panelProfileId, 'wft0583-800x480-mono');
  });
});
