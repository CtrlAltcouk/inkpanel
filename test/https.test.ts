import { test } from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import {
  chmod, mkdtemp, stat, rm, mkdir, readFile, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get, type Server } from 'node:https';
import { get as httpGet, type Server as HttpServer } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import express from 'express';
import {
  activateHttpsListener, deriveCertificateIdentities, ensureCertificate, startHttpsListener,
} from '../src/https.ts';
import { createApp } from '../src/http/app.ts';
import { DeviceStore } from '../src/devices/store.ts';
import type { FrameService } from '../src/render/frameService.ts';
import { createRuntimeState, type RuntimeState } from '../src/runtimeConfig.ts';

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
    const certificate = new X509Certificate(result.cert);
    assert.equal(certificate.checkHost('localhost'), 'localhost');
    assert.equal(certificate.checkIP('127.0.0.1'), '127.0.0.1');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('generated certificate covers supplied LAN IP and configured DNS hostname', async () => {
  const dir = await tempDir();
  try {
    const result = await ensureCertificate(dir, {
      lanAddress: '192.168.1.50',
      publicBaseUrl: 'http://inkpanel.local:8080',
      hostname: 'inkpanel',
    });
    if (result === null) return;
    const certificate = new X509Certificate(result.cert);
    assert.equal(certificate.checkIP('192.168.1.50'), '192.168.1.50');
    assert.equal(certificate.checkHost('inkpanel.local'), 'inkpanel.local');
    assert.equal(certificate.checkHost('inkpanel'), 'inkpanel');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reuses an existing certificate rather than regenerating it', async () => {
  // Regenerating on every boot would re-trigger the browser trust warning
  // every restart, training the user to click through it without reading.
  const dir = await tempDir();
  try {
    const sources = { lanAddress: '192.168.1.50', publicBaseUrl: 'http://inkpanel.local:8080' };
    const first = await ensureCertificate(dir, sources);
    if (first === null) return;
    const second = await ensureCertificate(dir, sources);
    assert.ok(second !== null);
    assert.deepEqual(first.cert, second?.cert, 'the certificate must be stable across restarts');
    assert.deepEqual(first.key, second?.key, 'the key must be stable across restarts');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('adding a newly required LAN IP regenerates the certificate once', async () => {
  const dir = await tempDir();
  try {
    const first = await ensureCertificate(dir);
    if (first === null) return;
    const second = await ensureCertificate(dir, { lanAddress: '192.168.1.77' });
    assert.ok(second !== null);
    assert.notDeepEqual(second?.cert, first.cert);
    assert.equal(new X509Certificate(second!.cert).checkIP('192.168.1.77'), '192.168.1.77');
    const third = await ensureCertificate(dir, { lanAddress: '192.168.1.77' });
    assert.deepEqual(third?.cert, second?.cert, 'the corrected certificate must then stay stable');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('PUBLIC_BASE_URL IP identities are validated and deduplicated', () => {
  const identities = deriveCertificateIdentities({
    lanAddress: '192.168.1.50',
    publicBaseUrl: 'https://192.168.1.50:9443/flash?device=kitchen',
  });
  assert.deepEqual(identities, [
    { type: 'DNS', value: 'localhost' },
    { type: 'IP', value: '127.0.0.1' },
    { type: 'IP', value: '192.168.1.50' },
  ]);
});

test('malformed identity inputs cannot inject OpenSSL SAN entries', () => {
  const identities = deriveCertificateIdentities({
    lanAddress: '192.168.1.50,IP:10.0.0.1',
    publicBaseUrl: 'http://good.example:8080',
    hostname: 'inkpanel\nsubjectAltName=IP:10.0.0.1',
  });
  assert.deepEqual(identities, [
    { type: 'DNS', value: 'localhost' },
    { type: 'IP', value: '127.0.0.1' },
    { type: 'DNS', value: 'good.example' },
  ]);
});

test('OpenSSL generation uses execFile arguments and never a shell', async () => {
  const source = await readFile(new URL('../src/https.ts', import.meta.url), 'utf8');
  assert.match(source, /import \{ execFile \} from 'node:child_process'/);
  assert.match(source, /await run\('openssl', \[/);
  assert.doesNotMatch(source, /shell\s*:\s*true|\bexec\(/);
});

test('malformed existing PEM is replaced when generation succeeds', async () => {
  const dir = await tempDir();
  try {
    await writeFile(join(dir, 'tls-cert.pem'), 'not a real certificate');
    await writeFile(join(dir, 'tls-key.pem'), 'not a real key');
    const result = await ensureCertificate(dir, { lanAddress: '192.168.1.50' });
    if (result === null) return;
    assert.equal(new X509Certificate(result.cert).checkIP('192.168.1.50'), '192.168.1.50');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('failed regeneration preserves an otherwise usable certificate and key', async () => {
  const dir = await tempDir();
  const originalPath = process.env.PATH;
  try {
    const first = await ensureCertificate(dir);
    if (first === null) return;
    process.env.PATH = join(dir, 'no-tools');
    const fallback = await ensureCertificate(dir, { lanAddress: '192.168.1.99' });
    assert.deepEqual(fallback, first);
    assert.deepEqual(await readFile(join(dir, 'tls-cert.pem')), first.cert);
    assert.deepEqual(await readFile(join(dir, 'tls-key.pem')), first.key);
  } finally {
    process.env.PATH = originalPath;
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

test('reusing a certificate tightens a loose private-key mode', { skip: process.platform === 'win32' }, async () => {
  const dir = await tempDir();
  try {
    const first = await ensureCertificate(dir);
    if (first === null) return;
    await chmod(join(dir, 'tls-key.pem'), 0o644);
    const reused = await ensureCertificate(dir);
    assert.deepEqual(reused?.cert, first.cert);
    assert.equal((await stat(join(dir, 'tls-key.pem'))).mode & 0o777, 0o600);
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

test('startHttpsListener replaces malformed cert/key material when possible', async () => {
  const dir = await tempDir();
  let server: Server | null = null;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'tls-cert.pem'), 'not a real certificate');
    await writeFile(join(dir, 'tls-key.pem'), 'not a real key');

    const app = express();
    server = await startHttpsListener(app, {
      dataDir: dir, port: 0, identities: { lanAddress: '192.168.1.50' },
    });
    if (server === null) return;
    const certificate = new X509Certificate(await readFile(join(dir, 'tls-cert.pem')));
    assert.equal(certificate.checkIP('192.168.1.50'), '192.168.1.50');
  } finally {
    await closeServer(server);
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

function createRuntimeApp(dir: string, runtimeState: RuntimeState) {
  return createApp({
    store: new DeviceStore(join(dir, 'config.json')),
    frames,
    publicBaseUrl: 'http://127.0.0.1:8080',
    runtimeState,
    dataDir: dir,
    firmwareDir: dir,
    auth: { password: null, secret: Buffer.from('b'.repeat(64), 'hex') },
  });
}

test('active HTTPS port is published only after a successful listener start', async () => {
  const dir = await tempDir();
  const runtimeState = createRuntimeState();
  const app = createRuntimeApp(dir, runtimeState);
  const httpServer = app.listen(0, '127.0.0.1');
  const listener = createNetServer();
  let releaseStart!: () => void;
  const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
  try {
    await once(httpServer, 'listening');
    const httpPort = (httpServer.address() as AddressInfo).port;

    const activation = activateHttpsListener(
      app,
      { dataDir: dir, port: 9443 },
      runtimeState,
      async (_app, options) => {
        await new Promise<void>((resolve, reject) => {
          listener.once('error', reject);
          listener.listen(options.port, '127.0.0.1', resolve);
        });
        await startGate;
        return listener as unknown as Server;
      },
    );

    assert.deepEqual((await getPlainJson(httpPort, '/api/runtime-config')).body, { httpsPort: null },
      'a requested port must not be advertised while listener startup is still pending');
    releaseStart();
    const server = await activation;
    assert.ok(server?.listening);
    assert.deepEqual((await getPlainJson(httpPort, '/api/runtime-config')).body, { httpsPort: 9443 });
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    assert.deepEqual((await getPlainJson(httpPort, '/api/runtime-config')).body, { httpsPort: null },
      'a stopped listener must no longer be advertised');
  } finally {
    releaseStart();
    if (listener.listening) await new Promise<void>((resolve) => listener.close(() => resolve()));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('failed HTTPS activation leaves runtime config unavailable', async () => {
  const dir = await tempDir();
  const runtimeState = createRuntimeState();
  const app = createRuntimeApp(dir, runtimeState);
  const server = await activateHttpsListener(
    app,
    { dataDir: dir, port: 9443 },
    runtimeState,
    async () => null,
  );
  assert.equal(server, null);
  assert.deepEqual(runtimeState, { httpsPort: null });
  await rm(dir, { recursive: true, force: true });
});

test('HTTP and HTTPS port collision keeps HTTP healthy and HTTPS undisclosed', async () => {
  const dir = await tempDir();
  const runtimeState = createRuntimeState();
  const app = createRuntimeApp(dir, runtimeState);
  const httpServer = app.listen(0);
  let httpsServer: Server | null = null;
  try {
    await once(httpServer, 'listening');
    const httpPort = (httpServer.address() as AddressInfo).port;
    if (await ensureCertificate(dir) === null) return;

    httpsServer = await activateHttpsListener(
      app,
      { dataDir: dir, port: httpPort },
      runtimeState,
    );
    assert.equal(httpsServer, null, 'the already-bound HTTP port must reject the HTTPS listener');
    assert.deepEqual((await getPlainJson(httpPort, '/api/runtime-config')).body, { httpsPort: null });
    assert.equal((await getPlainJson(httpPort, '/health')).status, 200,
      'optional HTTPS failure must not affect the primary HTTP service');
  } finally {
    await closeServer(httpsServer);
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

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
      runtimeState: { httpsPort: null },
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
