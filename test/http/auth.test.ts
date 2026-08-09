import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp, rm, stat, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadOrCreateSecret, signSession, verifySession, parseCookies, pruneExpiredAttempts,
} from '../../src/http/auth.ts';

const SECRET = Buffer.from('a'.repeat(64), 'hex');
const NOW = 1_785_000_000_000;

/** A plain object with a null prototype, for comparing against parseCookies' output. */
function nullProto(obj: Record<string, string>): Record<string, string> {
  return Object.assign(Object.create(null), obj);
}

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
  assert.deepEqual(parseCookies('a=1; b=2'), nullProto({ a: '1', b: '2' }));
  assert.deepEqual(parseCookies('only=one'), nullProto({ only: 'one' }));
  assert.deepEqual(parseCookies(undefined), nullProto({}));
  assert.deepEqual(parseCookies(''), nullProto({}));
  assert.equal(parseCookies('v=a%3Db').v, 'a=b', 'values are URI-decoded');
});

test('parseCookies returns a null-prototype object', () => {
  // A cookie named "toString" or "__proto__" must land as an own property,
  // never resolve through Object.prototype instead.
  assert.equal(Object.getPrototypeOf(parseCookies('a=1')), null);
  assert.equal(Object.getPrototypeOf(parseCookies(undefined)), null);
});

test('duplicate cookie keys: the first one wins', () => {
  // Matches cookie-parser. Last-wins would let a later, less-specific-path
  // cookie shadow an earlier, more-specific one sent by the browser.
  assert.deepEqual(parseCookies('a=first; a=second'), nullProto({ a: 'first' }));
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

test('rewriting an existing loose-mode file tightens it to 0600', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-secret-'));
  try {
    const path = join(dir, '.session-secret');
    // Under 32 bytes: loadOrCreateSecret must treat this as "no valid
    // secret yet" and rewrite it, not reuse it.
    await writeFile(path, 'too-short', { mode: 0o644 });
    const modeBefore = (await stat(path)).mode & 0o777;
    assert.equal(modeBefore, 0o644, 'precondition: file starts world-readable');

    const secret = await loadOrCreateSecret(path);
    assert.equal(secret.length, 32);

    const modeAfter = (await stat(path)).mode & 0o777;
    assert.equal(modeAfter, 0o600, `expected 0600 after rewrite, got ${modeAfter.toString(8)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loading a valid secret with loose permissions warns to stderr', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-secret-'));
  try {
    const path = join(dir, '.session-secret');
    await writeFile(path, SECRET, { mode: 0o644 });

    const messages: unknown[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { messages.push(args.join(' ')); };
    try {
      await loadOrCreateSecret(path);
    } finally {
      console.error = originalError;
    }

    assert.ok(
      messages.some((m) => String(m).includes('0600')),
      `expected a warning mentioning 0600, got: ${JSON.stringify(messages)}`,
    );

    // The warning must not have silently tightened the mode itself — a
    // deployment that chmods the file loose stays loose until fixed by hand.
    const mode = (await stat(path)).mode & 0o777;
    assert.equal(mode, 0o644, 'load-time warning must not mutate permissions');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('pruneExpiredAttempts drops only entries whose window has passed', () => {
  const attempts = new Map([
    ['1.2.3.4', { count: 5, resetAt: NOW - 1 }],
    ['5.6.7.8', { count: 1, resetAt: NOW + 1000 }],
    ['9.9.9.9', { count: 3, resetAt: NOW }],
  ]);
  pruneExpiredAttempts(attempts, NOW);
  assert.deepEqual([...attempts.keys()], ['5.6.7.8'], 'entries at or before now expire');
});

import { createApp } from '../../src/http/app.ts';
import { DeviceStore } from '../../src/devices/store.ts';
import type { FrameService } from '../../src/render/frameService.ts';

const frames = {
  frameFor: async () => ({ buffer: Buffer.alloc(48000, 0), etag: 'e'.repeat(32), renderedAt: '2026-08-04T00:00:00.000Z' }),
  enrolmentFrame: async () => ({ buffer: Buffer.alloc(48000, 0), etag: 'f'.repeat(32), renderedAt: '2026-08-04T00:00:00.000Z' }),
  previewHtml: async () => '<html></html>',
  renderNow: async () => ({ buffer: Buffer.alloc(48000, 0), etag: 'e'.repeat(32), renderedAt: '2026-08-04T00:00:00.000Z' }),
  sourceIssues: () => [],
  renderedDeviceCount: () => 0,
  warmUp: async () => {},
} as unknown as FrameService;

async function withApp(password: string | null, fn: (base: string, store: DeviceStore) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-auth-'));
  const store = new DeviceStore(join(dir, 'config.json'));
  const app = createApp({
    store, frames, publicBaseUrl: 'http://test:8080', runtimeState: { httpsPort: null },
    dataDir: dir, firmwareDir: dir,
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

test('a password gates the system info endpoint', async () => {
  // systemRoutes is mounted after the auth middleware deliberately: it
  // exposes the data directory path and update-check state, neither of
  // which should be reachable by an unauthenticated caller once a password
  // is configured.
  await withApp('hunter2', async (base) => {
    assert.equal((await fetch(`${base}/api/system/info`)).status, 401);
  });
});

test('the frame endpoint stays open even with a password set', async () => {
  await withApp('hunter2', async (base) => {
    const res = await fetch(`${base}/api/devices/esp32-a1b2c3/frame`);
    assert.equal(res.status, 200, 'firmware cannot log in');
    assert.equal((await res.arrayBuffer()).byteLength, 48000);
  });
});

test('health stays open even with a password set', async () => {
  await withApp('hunter2', async (base) => {
    assert.equal((await fetch(`${base}/health`)).status, 200);
  });
});

// The exemption must be at least as lenient as Express's own router: a
// firmware/proxy quirk the router would happily serve (trailing slash,
// different case, a HEAD instead of a GET) must not turn into a silent 401
// with no picture on the panel and no visible error.
test('the frame endpoint stays open with a trailing slash', async () => {
  await withApp('hunter2', async (base) => {
    const res = await fetch(`${base}/api/devices/esp32-a1b2c3/frame/`);
    assert.equal(res.status, 200);
  });
});

test('the frame endpoint stays open regardless of case', async () => {
  await withApp('hunter2', async (base) => {
    const res = await fetch(`${base}/api/DEVICES/esp32-a1b2c3/FRAME`);
    assert.equal(res.status, 200);
  });
});

test('the frame endpoint stays open for HEAD requests', async () => {
  await withApp('hunter2', async (base, store) => {
    await store.getOrCreate('test-panel');
    const res = await fetch(`${base}/api/devices/test-panel/frame`, { method: 'HEAD' });
    assert.equal(res.status, 200);
  });
});

test('POST and PUT to the frame path remain behind the authentication gate', async () => {
  await withApp('hunter2', async (base) => {
    for (const method of ['POST', 'PUT']) {
      const res = await fetch(`${base}/api/devices/esp32-a1b2c3/frame`, { method });
      assert.equal(res.status, 401, method);
    }
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

test('a wrong password of a very different length does not throw and is rejected', async () => {
  // Comparison is done on fixed-width SHA-256 digests specifically so a
  // length mismatch can never hit a throwing code path (and never run
  // measurably faster, which is what leaked the real password's length).
  await withApp('hunter2', async (base) => {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'x' }),
    });
    assert.equal(res.status, 401);
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
