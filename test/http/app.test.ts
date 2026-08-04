import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createApp } from '../../src/http/app.ts';
import { DeviceStore } from '../../src/devices/store.ts';
import type { FrameService } from '../../src/render/frameService.ts';

const frames = { sourceIssues: () => [], renderedDeviceCount: () => 0 } as unknown as FrameService;

function makeApp(trustProxy?: boolean | number | string) {
  const store = new DeviceStore(join('unused', 'config.json'));
  return createApp({
    store,
    frames,
    publicBaseUrl: 'http://test:8080',
    dataDir: 'unused',
    auth: { password: null, secret: randomBytes(32) },
    trustProxy,
  });
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
