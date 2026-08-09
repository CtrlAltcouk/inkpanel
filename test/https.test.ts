import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp, stat, rm, mkdir, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get, type Server } from 'node:https';
import { get as httpGet, type Server as HttpServer } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import express from 'express';
import { ensureCertificate, startHttpsListener } from '../src/https.ts';
import { createApp } from '../src/http/app.ts';
import { DeviceStore } from '../src/devices/store.ts';
import type { FrameService } from '../src/render/frameService.ts';

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'inkpanel-https-'));
}

/** GET a path over HTTPS against a self-signed cert, ignoring trust errors. */
function getJson(port: number, path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    get({ hostname: '127.0.0.1', port, path, rejectUnauthorized: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null });
      });
    }).on('error', reject);
  });
}

function closeServer(server: Server | null): Promise<void> {
  return new Promise((resolve) => {
    if (!server) { resolve(); return; }
    server.close(() => resolve());
  });
}

/** GET a path over plain HTTP — used to prove the *other* listener survives. */
function getPlainJson(port: number, path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    httpGet({ hostname: '127.0.0.1', port, path }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null });
      });
    }).on('error', reject);
  });
}

test('generates a certificate and key on first call', async () => {
  const dir = await tempDir();
  try {
    const result = await ensureCertificate(dir);
    if (result === null) return; // openssl unavailable — covered by its own test
    assert.ok(result.cert.includes('BEGIN CERTIFICATE'));
    assert.ok(result.key.length > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reuses an existing certificate rather than regenerating it', async () => {
  // Regenerating on every boot would re-trigger the browser trust warning
  // every restart, training the user to click through it without reading.
  const dir = await tempDir();
  try {
    const first = await ensureCertificate(dir);
    if (first === null) return;
    const second = await ensureCertificate(dir);
    assert.ok(second !== null);
    assert.deepEqual(first.cert, second?.cert, 'the certificate must be stable across restarts');
    assert.deepEqual(first.key, second?.key, 'the key must be stable across restarts');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the private key is not world-readable', { skip: process.platform === 'win32' }, async () => {
  const dir = await tempDir();
  try {
    if ((await ensureCertificate(dir)) === null) return;
    const mode = (await stat(join(dir, 'tls-key.pem'))).mode & 0o777;
    assert.equal(mode, 0o600, `key mode was ${mode.toString(8)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('returns null rather than throwing when openssl is unavailable', async () => {
  // The server must still boot without HTTPS. A missing flash tab is a far
  // smaller problem than a server that refuses to start.
  const dir = await tempDir();
  const original = process.env.PATH;
  process.env.PATH = dir; // an empty directory: no openssl on it
  try {
    assert.equal(await ensureCertificate(join(dir, 'certs')), null);
  } finally {
    process.env.PATH = original;
    await rm(dir, { recursive: true, force: true });
  }
});

test('startHttpsListener binds an ephemeral port and serves the app over TLS', async () => {
  const dir = await tempDir();
  let server: Server | null = null;
  try {
    const app = express();
    app.get('/health', (_req, res) => res.json({ status: 'ok' }));

    server = await startHttpsListener(app, { dataDir: dir, port: 0 });
    if (server === null) return; // openssl unavailable — covered by its own test

    const address = server.address();
    assert.ok(address && typeof address === 'object', 'expected an AddressInfo, not a pipe name');
    const port = (address as { port: number }).port;
    assert.notEqual(port, 0, 'the OS must have assigned a real ephemeral port');
    // Proves the requested port (0) was actually honoured rather than some
    // hardcoded value (e.g. the production default of 8443) that happens to
    // also be free on the test machine.
    assert.notEqual(port, 8443, 'must bind the port that was requested, not a hardcoded default');

    const { status, body } = await getJson(port, '/health');
    assert.equal(status, 200);
    assert.deepEqual(body, { status: 'ok' });
  } finally {
    await closeServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test('startHttpsListener returns null rather than throwing when no certificate can be produced', async () => {
  const dir = await tempDir();
  const original = process.env.PATH;
  process.env.PATH = dir;
  try {
    const app = express();
    const server = await startHttpsListener(app, { dataDir: join(dir, 'certs'), port: 0 });
    assert.equal(server, null);
  } finally {
    process.env.PATH = original;
    await rm(dir, { recursive: true, force: true });
  }
});

// --- Fix 1: HTTPS failures must degrade, never take the process (and the
// plain-HTTP listener) down with them. ---------------------------------

test('startHttpsListener returns null and leaves the HTTP listener running when the port is already in use', async () => {
  const dir = await tempDir();
  const scratch = createNetServer();
  let httpServer: HttpServer | null = null;
  let leaked: Server | null = null;
  try {
    // Occupy a real ephemeral port so startHttpsListener's own listen() call
    // is guaranteed to collide with something (EADDRINUSE), not race for one.
    //
    // Bind the wildcard address, exactly as startHttpsListener does. Binding
    // 127.0.0.1 here instead does NOT collide on Windows — a wildcard bind and
    // a loopback bind are different addresses there, so listen() succeeds and
    // this test silently stops testing anything.
    await new Promise<void>((resolve, reject) => {
      scratch.once('error', reject);
      scratch.listen(0, () => resolve());
    });
    const scratchPort = (scratch.address() as AddressInfo).port;

    // Stand-in for the always-on plain-HTTP listener that must survive
    // whatever happens to the HTTPS one.
    const httpApp = express();
    httpApp.get('/health', (_req, res) => res.json({ status: 'ok' }));
    httpServer = httpApp.listen(0);
    await new Promise<void>((resolve) => httpServer!.once('listening', resolve));
    const httpPort = (httpServer!.address() as AddressInfo).port;

    const app = express();
    const server = await startHttpsListener(app, { dataDir: dir, port: scratchPort });
    // Track it before asserting: if this ever does return a server, the
    // assertion below throws and an unclosed handle would keep the whole test
    // process alive forever rather than failing it.
    leaked = server;
    assert.equal(server, null, 'a bound port must degrade to null, not throw');

    // The process — and the pre-existing HTTP listener — must still be alive.
    const { status, body } = await getPlainJson(httpPort, '/health');
    assert.equal(status, 200);
    assert.deepEqual(body, { status: 'ok' });
  } finally {
    if (leaked) await new Promise<void>((resolve) => leaked!.close(() => resolve()));
    await new Promise<void>((resolve) => scratch.close(() => resolve()));
    if (httpServer) await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('startHttpsListener returns null rather than throwing when the cert/key on disk are malformed', async () => {
  // Simulates an interrupted first boot, tampering, or disk corruption:
  // ensureCertificate only checks the files exist and are readable, so
  // garbage bytes come back as "material" and createServer() throws
  // synchronously on invalid PEM content.
  const dir = await tempDir();
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'tls-cert.pem'), 'not a real certificate');
    await writeFile(join(dir, 'tls-key.pem'), 'not a real key');

    const app = express();
    const server = await startHttpsListener(app, { dataDir: dir, port: 0 });
    assert.equal(server, null, 'malformed PEM must degrade to null, not crash the process');

    // Prove the process is still alive: a normal HTTP server can still be
    // started and answers, which would be impossible after an uncaught
    // synchronous throw from createServer() took the runtime down.
    const httpApp = express();
    httpApp.get('/health', (_req, res) => res.json({ status: 'ok' }));
    const httpServer = httpApp.listen(0);
    await new Promise<void>((resolve) => httpServer.once('listening', resolve));
    const port = (httpServer.address() as AddressInfo).port;
    try {
      const { status, body } = await getPlainJson(port, '/health');
      assert.equal(status, 200);
      assert.deepEqual(body, { status: 'ok' });
    } finally {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- Fix 2: the device-facing routes must stay reachable, without a
// session, over the HTTPS listener specifically — not just in theory
// because it shares the same Express app instance. ----------------------

const frames = {
  frameFor: async () => ({ buffer: Buffer.alloc(48000, 0), etag: 'e'.repeat(32), renderedAt: '2026-08-04T00:00:00.000Z' }),
  enrolmentFrame: async () => ({ buffer: Buffer.alloc(48000, 0), etag: 'f'.repeat(32), renderedAt: '2026-08-04T00:00:00.000Z' }),
  previewHtml: async () => '<html></html>',
  renderNow: async () => ({ buffer: Buffer.alloc(48000, 0), etag: 'e'.repeat(32), renderedAt: '2026-08-04T00:00:00.000Z' }),
  sourceIssues: () => [],
  renderedDeviceCount: () => 0,
  warmUp: async () => {},
} as unknown as FrameService;

/** Request over real TLS, accepting the self-signed cert for this call only. */
function getOverTls(port: number, path: string): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    get({
      hostname: '127.0.0.1',
      port,
      path,
      rejectUnauthorized: false, // scoped to this one request, not global
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

test('the frame endpoint and health stay open over HTTPS even with a password set', async () => {
  const dir = await tempDir();
  let server: Server | null = null;
  try {
    const store = new DeviceStore(join(dir, 'config.json'));
    const app = createApp({
      store,
      frames,
      publicBaseUrl: 'https://test:8443',
      dataDir: dir,
      firmwareDir: dir,
      auth: { password: 'hunter2', secret: Buffer.from('a'.repeat(64), 'hex') },
    });

    server = await startHttpsListener(app, { dataDir: dir, port: 0 });
    if (server === null) return; // openssl unavailable — covered by its own test
    const port = (server.address() as AddressInfo).port;

    const health = await getOverTls(port, '/health');
    assert.equal(health.status, 200, 'health must stay reachable over HTTPS without a session');

    const frame = await getOverTls(port, '/api/devices/esp32-1/frame');
    assert.equal(frame.status, 200, 'the panel frame endpoint must stay reachable over HTTPS without a session');
    assert.equal(frame.body.length, 48000);

    const gated = await getOverTls(port, '/api/devices');
    assert.equal(gated.status, 401, 'a genuinely gated route must still require auth, even over HTTPS');
  } finally {
    await closeServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});
