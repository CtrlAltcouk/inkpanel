import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadOrCreateSecret, signSession, verifySession, parseCookies,
} from '../../src/http/auth.ts';

const SECRET = Buffer.from('a'.repeat(64), 'hex');
const NOW = 1_785_000_000_000;

test('a freshly signed session verifies', () => {
  const token = signSession(SECRET, NOW + 1000);
  assert.equal(verifySession(SECRET, token, NOW), true);
});

test('an expired session does not verify', () => {
  const token = signSession(SECRET, NOW - 1);
  assert.equal(verifySession(SECRET, token, NOW), false);
});

test('a tampered payload does not verify', () => {
  const token = signSession(SECRET, NOW + 1000);
  const [payload, sig] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ exp: NOW + 999_999_999 })).toString('base64url');
  assert.notEqual(forged, payload);
  assert.equal(verifySession(SECRET, `${forged}.${sig}`, NOW), false);
});

test('a different secret does not verify', () => {
  const token = signSession(SECRET, NOW + 1000);
  assert.equal(verifySession(Buffer.from('b'.repeat(64), 'hex'), token, NOW), false);
});

test('malformed tokens are rejected rather than throwing', () => {
  for (const bad of ['', 'nodot', 'a.b.c', '.', 'x.y']) {
    assert.equal(verifySession(SECRET, bad, NOW), false, `"${bad}" must not throw or pass`);
  }
});

test('parses cookies, tolerating spaces and missing headers', () => {
  assert.deepEqual(parseCookies('a=1; b=2'), { a: '1', b: '2' });
  assert.deepEqual(parseCookies('only=one'), { only: 'one' });
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies(''), {});
  assert.equal(parseCookies('v=a%3Db').v, 'a=b', 'values are URI-decoded');
});

test('the secret persists and is not world-readable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-secret-'));
  try {
    const path = join(dir, '.session-secret');
    const first = await loadOrCreateSecret(path);
    const second = await loadOrCreateSecret(path);
    assert.equal(first.length, 32);
    assert.deepEqual(first, second, 'must reuse, not regenerate — sessions survive restarts');

    if (process.platform !== 'win32') {
      const mode = (await stat(path)).mode & 0o777;
      assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

import { createApp } from '../../src/http/app.ts';
import { DeviceStore } from '../../src/devices/store.ts';
import type { FrameService } from '../../src/render/frameService.ts';

const frames = {
  frameFor: async () => ({ buffer: Buffer.alloc(48000, 0), etag: 'e'.repeat(32), renderedAt: '2026-08-04T00:00:00.000Z' }),
  enrolmentFrame: async () => ({ buffer: Buffer.alloc(48000, 0), etag: 'f'.repeat(32), renderedAt: '2026-08-04T00:00:00.000Z' }),
  previewHtml: async () => '<html></html>',
  renderNow: async () => ({ buffer: Buffer.alloc(48000, 0), etag: 'e'.repeat(32), renderedAt: '2026-08-04T00:00:00.000Z' }),
} as unknown as FrameService;

async function withApp(password: string | null, fn: (base: string, store: DeviceStore) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-auth-'));
  const store = new DeviceStore(join(dir, 'config.json'));
  const app = createApp({
    store, frames, publicBaseUrl: 'http://test:8080',
    auth: { password, secret: SECRET },
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await fn(`http://127.0.0.1:${port}`, store);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('no password means nothing is gated', async () => {
  await withApp(null, async (base) => {
    assert.equal((await fetch(`${base}/api/devices`)).status, 200);
  });
});

test('a password gates the management API', async () => {
  await withApp('hunter2', async (base) => {
    assert.equal((await fetch(`${base}/api/devices`)).status, 401);
  });
});

test('the frame endpoint stays open even with a password set', async () => {
  await withApp('hunter2', async (base) => {
    const res = await fetch(`${base}/api/devices/esp32-1/frame`);
    assert.equal(res.status, 200, 'firmware cannot log in');
    assert.equal((await res.arrayBuffer()).byteLength, 48000);
  });
});

test('health stays open even with a password set', async () => {
  await withApp('hunter2', async (base) => {
    assert.equal((await fetch(`${base}/health`)).status, 200);
  });
});

test('logging in yields a cookie that unlocks the API', async () => {
  await withApp('hunter2', async (base) => {
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'hunter2' }),
    });
    assert.equal(login.status, 200);

    const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
    assert.match(cookie, /^inkpanel_session=/);

    const res = await fetch(`${base}/api/devices`, { headers: { cookie } });
    assert.equal(res.status, 200);
  });
});

test('a wrong password is rejected', async () => {
  await withApp('hunter2', async (base) => {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'wrong' }),
    });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('set-cookie'), null, 'no cookie on failure');
  });
});

test('repeated wrong passwords are rate-limited', async () => {
  await withApp('hunter2', async (base) => {
    const attempt = () => fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'wrong' }),
    });
    for (let i = 0; i < 5; i++) assert.equal((await attempt()).status, 401);
    assert.equal((await attempt()).status, 429, 'sixth attempt is throttled');
  });
});
