import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/http/app.ts';
import { DeviceStore } from '../../src/devices/store.ts';
import type { FrameService } from '../../src/render/frameService.ts';

const frames = { sourceIssues: () => [], renderedDeviceCount: () => 0 } as unknown as FrameService;

function makeApp(
  trustProxy?: boolean | number | string,
  store: DeviceStore = new DeviceStore(join('unused', 'config.json')),
) {
  return createApp({
    store,
    frames,
    publicBaseUrl: 'http://test:8080',
    dataDir: 'unused',
    firmwareDir: 'unused',
    auth: { password: null, secret: randomBytes(32) },
    trustProxy,
  });
}

async function requestJson(app: ReturnType<typeof createApp>, path: string) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`);
    const body = await response.json() as Record<string, unknown>;
    return { status: response.status, body };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('trust proxy is left at the Express default when TRUST_PROXY is unset', () => {
  const app = makeApp(undefined);
  assert.equal(app.get('trust proxy'), false, 'Express default: do not trust any proxy');
});

// A reverse-proxy deployment (the one the README recommends for remote
// access) must be able to make req.ip reflect the real client rather than
// the proxy, or the login rate limiter buckets every client together.
test('a numeric TRUST_PROXY hop count is applied to the app', () => {
  const app = makeApp(1);
  assert.equal(app.get('trust proxy'), 1);
});

test('TRUST_PROXY "true" is applied to the app', () => {
  const app = makeApp(true);
  assert.equal(app.get('trust proxy'), true);
});

test('a comma-separated TRUST_PROXY subnet list is applied to the app', () => {
  const app = makeApp('10.0.0.0/8,172.16.0.0/12');
  assert.equal(app.get('trust proxy'), '10.0.0.0/8,172.16.0.0/12');
});

test('/health reports a corrupt device store as unhealthy without modifying it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-health-'));
  const configPath = join(dir, 'config.json');
  const corrupt = '{ definitely not json';
  try {
    await writeFile(configPath, corrupt, 'utf8');
    const app = makeApp(undefined, new DeviceStore(configPath));

    const response = await requestJson(app, '/health');
    assert.equal(response.status, 503);
    assert.equal(response.body.status, 'error');
    assert.equal(response.body.component, 'device-store');
    assert.equal(response.body.code, 'config_corrupt');
    assert.equal(response.body.devices, null);
    assert.equal(typeof response.body.backup, 'string');
    assert.equal(await readFile(configPath, 'utf8'), corrupt, 'health checks must be non-destructive');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('/health reports a future device-store version as unsupported without modifying it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-health-future-'));
  const configPath = join(dir, 'config.json');
  const future = '{"schemaVersion":99,"devices":[],"futureFeature":true}\n';
  try {
    await writeFile(configPath, future, 'utf8');
    const app = makeApp(undefined, new DeviceStore(configPath));

    const response = await requestJson(app, '/health');
    assert.equal(response.status, 503);
    assert.equal(response.body.status, 'error');
    assert.equal(response.body.code, 'config_unsupported_version');
    assert.match(String(response.body.error), /newer InkPanel version/i);
    assert.equal(response.body.backup, null);
    assert.equal(await readFile(configPath, 'utf8'), future);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
