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
  frameFor: async () => ({ buffer: Buffer.alloc(48000, 0), etag: 'c'.repeat(32), renderedAt: '2026-08-10T21:00:00.000Z' }),
  enrolmentFrame: async () => ({ buffer: Buffer.alloc(48000, 0), etag: 'd'.repeat(32), renderedAt: '2026-08-10T21:00:00.000Z' }),
  previewHtml: async () => '<html></html>',
  renderNow: async () => ({ buffer: Buffer.alloc(48000, 0), etag: 'e'.repeat(32), renderedAt: '2026-08-10T21:00:00.000Z' }),
  sourceIssues: () => [],
  renderedDeviceCount: () => 0,
  warmUp: async () => {},
} as unknown as FrameService;

async function withServer(fn: (base: string, store: DeviceStore) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-octopus-http-'));
  const store = new DeviceStore(join(dir, 'config.json'));
  await store.getOrCreate('esp32-abc123');
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

const sections = (tariffCode: string) => [
  { type: 'octopus', version: 1, config: { tariffCode } },
  { type: 'weather', version: 1, config: {} },
  { type: 'empty', version: 1, config: {} },
  { type: 'empty', version: 1, config: {} },
];

test('management API normalises and persists an Octopus Agile tariff code', async () => {
  await withServer(async (base, store) => {
    const response = await fetch(`${base}/api/devices/esp32-abc123`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dashboardSections: sections('  e-1r-agile-flex-22-11-25-c  ') }),
    });
    assert.equal(response.status, 200);
    const saved = await store.get('esp32-abc123');
    assert.deepEqual(saved?.dashboardSections[0], {
      type: 'octopus', version: 1, config: { tariffCode: 'E-1R-AGILE-FLEX-22-11-25-C' },
    });
  });
});

test('management API rejects a non-Agile electricity tariff', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/devices/esp32-abc123`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dashboardSections: sections('E-1R-GO-VAR-22-10-14-C') }),
    });
    assert.equal(response.status, 400);
    assert.match(await response.text(), /Octopus Agile tariff code/);
  });
});
