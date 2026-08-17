import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../../src/http/app.ts';
import { DeviceStore } from '../../src/devices/store.ts';
import type { FrameService } from '../../src/render/frameService.ts';

const frames = {
  frameFor: async () => ({ buffer: Buffer.alloc(48000), etag: 'a'.repeat(32), renderedAt: new Date().toISOString() }),
  enrolmentFrame: async () => ({ buffer: Buffer.alloc(48000), etag: 'b'.repeat(32), renderedAt: new Date().toISOString() }),
  previewHtml: async () => '<html></html>',
  renderNow: async () => ({ buffer: Buffer.alloc(48000), etag: 'c'.repeat(32), renderedAt: new Date().toISOString() }),
  sourceIssues: () => [],
  renderedDeviceCount: () => 0,
  warmUp: async () => {},
} as unknown as FrameService;

async function withServer(fn: (base: string, firmwareDir: string) => Promise<void>) {
  const dataDir = await mkdtemp(join(tmpdir(), 'inkpanel-target-data-'));
  const firmwareDir = await mkdtemp(join(tmpdir(), 'inkpanel-target-fw-'));
  const store = new DeviceStore(join(dataDir, 'config.json'));
  const server = createApp({
    store,
    frames,
    publicBaseUrl: 'http://test.local:8080',
    runtimeState: { httpsPort: null },
    dataDir,
    firmwareDir,
    auth: { password: null, secret: randomBytes(32) },
  }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await fn(`http://127.0.0.1:${port}`, firmwareDir);
  } finally {
    server.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(firmwareDir, { recursive: true, force: true });
  }
}

async function writeManifest(dir: string, target: string, version: string, path: string) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({
    target,
    version,
    builtAt: '2026-08-17T12:00:00.000Z',
    parts: [{ path, offset: 0 }],
    updateParts: [{ path, offset: 65536 }],
    provisioning: { offset: target === 'mini' ? 0x7ff000 : 0xfff000, size: 4096, format: 1 },
  }));
  await writeFile(join(dir, path), Buffer.from(target === 'mini' ? [5, 0, 0, 0] : [48, 0, 0, 0]));
}

test('firmware catalog exposes full-size as default plus the Mini package', async () => {
  await withServer(async (base, firmwareDir) => {
    await writeManifest(firmwareDir, 'full', '0.1.4', 'full.bin');
    await writeManifest(join(firmwareDir, 'mini'), 'mini', '0.2.0-mini.1', 'mini.bin');

    const res = await fetch(`${base}/api/firmware/targets`);
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.defaultTarget, 'full');
    assert.deepEqual(body.targets.map((target: any) => target.id), ['full', 'mini']);
    assert.equal(body.targets[0].manifest.version, '0.1.4');
    assert.equal(body.targets[1].manifest.version, '0.2.0-mini.1');
    assert.match(body.targets[1].hardware, /ePaper Driver Board/);
  });
});

test('legacy manifest endpoint still means the full-size package', async () => {
  await withServer(async (base, firmwareDir) => {
    await writeManifest(firmwareDir, 'full', '0.1.4', 'full.bin');
    await writeManifest(join(firmwareDir, 'mini'), 'mini', '0.2.0-mini.1', 'mini.bin');

    const body = await (await fetch(`${base}/api/firmware/manifest`)).json() as any;
    assert.equal(body.target, 'full');
    assert.equal(body.version, '0.1.4');
  });
});

test('Mini binary route can only read from firmware/dist/mini', async () => {
  await withServer(async (base, firmwareDir) => {
    await writeManifest(firmwareDir, 'full', '0.1.4', 'same.bin');
    await writeManifest(join(firmwareDir, 'mini'), 'mini', '0.2.0-mini.1', 'same.bin');

    await writeFile(join(firmwareDir, 'same.bin'), Buffer.from([48, 48]));
    await writeFile(join(firmwareDir, 'mini', 'same.bin'), Buffer.from([5, 5, 5]));

    const full = new Uint8Array(await (await fetch(`${base}/api/firmware/bin/same.bin`)).arrayBuffer());
    const mini = new Uint8Array(await (await fetch(`${base}/api/firmware/targets/mini/bin/same.bin`)).arrayBuffer());
    assert.deepEqual([...full], [48, 48]);
    assert.deepEqual([...mini], [5, 5, 5]);
  });
});

test('unknown firmware target is rejected rather than falling back to full-size', async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/api/firmware/targets/not-a-panel/manifest`)).status, 404);
    assert.equal((await fetch(`${base}/api/firmware/targets/not-a-panel/bin/app.bin`)).status, 404);
  });
});
