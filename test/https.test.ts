import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get, type Server } from 'node:https';
import express from 'express';
import { ensureCertificate, startHttpsListener } from '../src/https.ts';

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
