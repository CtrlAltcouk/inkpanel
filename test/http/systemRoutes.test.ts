import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/http/app.ts';
import express from 'express';
import { DeviceStore } from '../../src/devices/store.ts';
import type { FrameService } from '../../src/render/frameService.ts';
import { systemRoutes } from '../../src/http/systemRoutes.ts';
import type { UpdateMode } from '../../src/system/updateOwnership.ts';

const frames = {
  warmUp: async () => {}, sourceIssues: () => [], renderedDeviceCount: () => 0,
} as unknown as FrameService;

async function withServer(
  fn: (base: string, dataDir: string) => Promise<void>,
  updateMode: UpdateMode = 'self',
) {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-system-'));
  const store = new DeviceStore(join(dir, 'config.json'));
  const server = createApp({
    store, frames, publicBaseUrl: 'http://test.local:8080', runtimeState: { httpsPort: null },
    dataDir: dir, firmwareDir: dir,
    updateMode,
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

async function requestFromApp(application: express.Express, path: string, init?: RequestInit) {
  const server = application.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    return await fetch(`http://127.0.0.1:${port}${path}`, init);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
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

test('Home Assistant refuses update mutations without creating request state', async () => {
  await withServer(async (base, dataDir) => {
    const response = await fetch(`${base}/api/system/update`, { method: 'POST' });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'updates are managed by Home Assistant' });
    await assert.rejects(access(join(dataDir, '.update-requested')));
  }, 'home-assistant');
});

test('Home Assistant update status reports ownership instead of standalone activity', async () => {
  await withServer(async (base, dataDir) => {
    await writeFile(join(dataDir, 'update-status.json'), JSON.stringify({
      state: 'running', startedAt: '2026-08-04T09:00:00.000Z', finishedAt: null,
      log: ['standalone updater state must be ignored'], error: null,
    }), 'utf8');
    const response = await fetch(`${base}/api/system/update/status`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { state: 'managed', manager: 'home-assistant' });
  }, 'home-assistant');
});

test('Home Assistant system info skips standalone Git update checks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-system-managed-'));
  let updateChecks = 0;
  const app = express();
  app.use('/api', systemRoutes(
    new DeviceStore(join(dir, 'config.json')),
    frames,
    dir,
    {
      updateMode: 'home-assistant',
      updateChecker: async () => {
        updateChecks += 1;
        throw new Error('standalone Git check must not run');
      },
    },
  ));
  try {
    const response = await requestFromApp(app, '/api/system/info?refresh=1');
    assert.equal(response.status, 200);
    const body = await response.json() as { update: unknown };
    assert.deepEqual(body.update, { state: 'managed', manager: 'home-assistant' });
    assert.equal(updateChecks, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('standalone system info retains normal refreshable update checks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-system-self-'));
  const forcedChecks: boolean[] = [];
  const app = express();
  app.use('/api', systemRoutes(
    new DeviceStore(join(dir, 'config.json')),
    frames,
    dir,
    {
      updateMode: 'self',
      updateChecker: async (force) => {
        forcedChecks.push(force === true);
        return {
          state: 'current', local: 'abc1234', remote: 'abc1234',
          checkedAt: '2026-08-26T12:00:00.000Z',
        };
      },
    },
  ));
  try {
    const response = await requestFromApp(app, '/api/system/info?refresh=1');
    assert.equal(response.status, 200);
    const body = await response.json() as { update: { state: string } };
    assert.equal(body.update.state, 'current');
    assert.deepEqual(forcedChecks, [true]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
