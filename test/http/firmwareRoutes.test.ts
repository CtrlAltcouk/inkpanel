import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

async function withServer(
  fn: (base: string, store: DeviceStore, firmwareDir: string) => Promise<void>,
  options: { password?: string | null } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-mgmt-'));
  const firmwareDir = await mkdtemp(join(tmpdir(), 'inkpanel-fw-'));
  const store = new DeviceStore(join(dir, 'config.json'));
  const server = createApp({
    store, frames, publicBaseUrl: 'http://test.local:8080', dataDir: dir, firmwareDir,
    auth: { password: options.password ?? null, secret: randomBytes(32) },
  }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await fn(`http://127.0.0.1:${port}`, store, firmwareDir);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
    await rm(firmwareDir, { recursive: true, force: true });
  }
}

test('reports no firmware when no build has been run', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/firmware/manifest`);
    assert.equal(res.status, 200, 'a missing build is a normal state, not an error');
    assert.deepEqual(await res.json(), { available: false });
  });
});

test('reports the manifest when a build exists', async () => {
  await withServer(async (base, _store, dir) => {
    await writeFile(
      join(dir, 'manifest.json'),
      JSON.stringify({
        version: '0.1.0',
        builtAt: '2026-08-06T10:00:00.000Z',
        parts: [{ path: 'inkpanel.ino.bin', offset: 65536 }],
      }),
    );
    const body = await (await fetch(`${base}/api/firmware/manifest`)).json();
    assert.equal(body.available, true);
    assert.equal(body.version, '0.1.0');
    assert.deepEqual(body.parts, [{ path: 'inkpanel.ino.bin', offset: 65536 }]);
  });
});

test('a corrupt manifest reads as unavailable rather than crashing the tab', async () => {
  await withServer(async (base, _store, dir) => {
    await writeFile(join(dir, 'manifest.json'), 'not json at all');
    assert.deepEqual(await (await fetch(`${base}/api/firmware/manifest`)).json(), { available: false });
  });
});

test('serves a binary as octet-stream', async () => {
  await withServer(async (base, _store, dir) => {
    await writeFile(join(dir, 'app.bin'), Buffer.from([1, 2, 3, 4]));
    const res = await fetch(`${base}/api/firmware/bin/app.bin`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /octet-stream/);
    assert.equal((await res.arrayBuffer()).byteLength, 4);
  });
});

test('refuses to serve anything outside the firmware directory', async () => {
  await withServer(async (base) => {
    // Path traversal against a route that reads files by name. The server
    // holds the session secret and the device config; this must not be a way
    // to read them.
    for (const attack of ['../../.session-secret', '..%2F..%2Fpackage.json', 'sub/dir.bin']) {
      const res = await fetch(`${base}/api/firmware/bin/${attack}`);
      assert.ok(res.status === 400 || res.status === 404, `${attack} returned ${res.status}`);
    }
  });
});

test('a traversal that keeps a valid .bin extension still cannot escape the directory', async () => {
  // The brief's own traversal cases all fail on extension alone (they don't
  // end in .bin), which would pass even if the slash-rejection were broken.
  // This one decodes to a `../`-relative path that DOES end in .bin and
  // points at a real file one level above firmwareDir, so only a guard that
  // actually rejects separators — not just a guard that checks the
  // extension — can make this fail correctly.
  await withServer(async (base, _store, dir) => {
    const decoyName = `decoy-${randomBytes(4).toString('hex')}.bin`;
    const decoyPath = join(dirname(dir), decoyName);
    await writeFile(decoyPath, Buffer.from([9, 9, 9, 9]));
    try {
      const res = await fetch(`${base}/api/firmware/bin/..%2F${decoyName}`);
      assert.ok(res.status === 400 || res.status === 404, `expected rejection, got ${res.status}`);
    } finally {
      await rm(decoyPath, { force: true });
    }
  });
});

test('a missing binary is 404, not a hang', async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/api/firmware/bin/nope.bin`)).status, 404);
  });
});

test('a read failure after the stat pre-check fails the request without taking the server down', async () => {
  // stat() sees a real filesystem entry (so the 404 pre-check passes), but
  // it is a directory, not a file, so createReadStream(...).pipe(res) fails
  // asynchronously with EISDIR. This is a deterministic stand-in for the
  // real-world TOCTOU window (file removed/locked/permission-changed between
  // stat() and pipe()) without racing anything. Without an 'error' listener
  // on the stream, this unhandled 'error' event crashes the whole process.
  await withServer(async (base, _store, dir) => {
    await mkdir(join(dir, 'oops.bin'));

    let requestFailed = false;
    try {
      const res = await fetch(`${base}/api/firmware/bin/oops.bin`);
      if (res.status === 500) {
        requestFailed = true;
      } else {
        // The stream errored after headers were already sent: the connection
        // is destroyed instead, which surfaces here as a failed body read or
        // a rejected fetch, depending on timing.
        try {
          await res.arrayBuffer();
        } catch {
          requestFailed = true;
        }
      }
    } catch {
      requestFailed = true;
    }
    assert.ok(requestFailed, 'expected the bad read to fail the request one way or another');

    // The actual point of the test: the process must still be alive to
    // answer a completely unrelated request afterwards. Without the fix,
    // the stream's unhandled 'error' event brings down the whole process
    // and this request gets ECONNREFUSED instead of a response.
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200, 'server should still be alive and serving /health after the failed read');
  });
});

test('firmware routes require a session', async () => {
  // Mirrors the auth assertions in manageRoutes.test.ts: these are management
  // endpoints, not device endpoints. Only the frame route and /health are exempt.
  await withServer(
    async (base) => {
      assert.equal((await fetch(`${base}/api/firmware/manifest`)).status, 401);
    },
    { password: 'hunter2' },
  );
});
