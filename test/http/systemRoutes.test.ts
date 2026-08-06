import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/http/app.ts';
import { DeviceStore } from '../../src/devices/store.ts';
import type { FrameService } from '../../src/render/frameService.ts';

const frames = { sourceIssues: () => [], renderedDeviceCount: () => 0 } as unknown as FrameService;

async function withServer(fn: (base: string, dataDir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-system-'));
  const store = new DeviceStore(join(dir, 'config.json'));
  const server = createApp({
    store, frames, publicBaseUrl: 'http://test.local:8080', dataDir: dir, firmwareDir: dir,
    auth: { password: null, secret: randomBytes(32) },
  }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await fn(`http://127.0.0.1:${port}`, dir);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('POST /api/system/update returns 202 and creates the flag file the updater watches', async () => {
  await withServer(async (base, dataDir) => {
    const res = await fetch(`${base}/api/system/update`, { method: 'POST' });
    assert.equal(res.status, 202);
    const body = (await res.json()) as { requestedAt: string };
    assert.match(body.requestedAt, /^\d{4}-\d{2}-\d{2}T/);

    // Does not throw: the flag file exists.
    await access(join(dataDir, '.update-requested'));
  });
});

test('a second POST while an update is already running is rejected with 409', async () => {
  await withServer(async (base, dataDir) => {
    await writeFile(join(dataDir, 'update-status.json'), JSON.stringify({
      state: 'running', startedAt: '2026-08-04T09:00:00.000Z', finishedAt: null, log: [], error: null,
    }), 'utf8');

    const res = await fetch(`${base}/api/system/update`, { method: 'POST' });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /already running/);

    // Must not have created a fresh request on top of the running one.
    await assert.rejects(access(join(dataDir, '.update-requested')));
  });
});

test('GET /api/system/update/status is idle when no status file exists yet', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/system/update/status`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = (await res.json()) as { state: string };
    assert.equal(body.state, 'idle');
  });
});

test('GET /api/system/update/status reflects the status file on disk', async () => {
  await withServer(async (base, dataDir) => {
    await writeFile(join(dataDir, 'update-status.json'), JSON.stringify({
      state: 'failed', startedAt: '2026-08-04T09:00:00.000Z', finishedAt: '2026-08-04T09:00:09.000Z',
      log: ['== git pull =='], error: 'git pull failed',
    }), 'utf8');

    const res = await fetch(`${base}/api/system/update/status`);
    const body = (await res.json()) as { state: string; error: string | null; log: string[] };
    assert.equal(body.state, 'failed');
    assert.equal(body.error, 'git pull failed');
    assert.deepEqual(body.log, ['== git pull ==']);
  });
});
