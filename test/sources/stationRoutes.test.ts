import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/http/app.ts';
import { DeviceStore } from '../../src/devices/store.ts';
import type { FrameService } from '../../src/render/frameService.ts';

const frames = {
  frameFor: async () => ({ buffer: Buffer.alloc(48000, 0), etag: 'c'.repeat(32), renderedAt: '2026-08-03T07:42:00.000Z' }),
  enrolmentFrame: async () => ({ buffer: Buffer.alloc(48000, 0), etag: 'd'.repeat(32), renderedAt: '2026-08-03T07:42:00.000Z' }),
  previewHtml: async () => '<html><body>preview</body></html>',
  renderNow: async () => ({ buffer: Buffer.alloc(48000, 0), etag: 'e'.repeat(32), renderedAt: '2026-08-03T07:42:00.000Z' }),
  sourceIssues: () => [],
  renderedDeviceCount: () => 0,
  warmUp: async () => {},
} as unknown as FrameService;

async function withServer(fn: (base: string, store: DeviceStore) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-stations-'));
  const store = new DeviceStore(join(dir, 'config.json'));
  const server = createApp({
    store, frames, publicBaseUrl: 'http://test.local:8080', runtimeState: { httpsPort: null },
    dataDir: dir, firmwareDir: dir,
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

test('searches stations over HTTP', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/stations?q=milton%20keynes`);
    assert.equal(res.status, 200);
    const { results } = await res.json();
    assert.ok(results.some((s: { crs: string }) => s.crs === 'MKC'));
  });
});

test('an empty query returns an empty list rather than 2,500 stations', async () => {
  await withServer(async (base) => {
    const { results } = await (await fetch(`${base}/api/stations?q=`)).json();
    assert.deepEqual(results, []);
  });
});
