import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:https';
import { chmod, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type express from 'express';

const run = promisify(execFile);

const CERT_FILE = 'tls-cert.pem';
const KEY_FILE = 'tls-key.pem';

/** Ten years: this is a LAN convenience cert, not a public one. */
const DAYS = '3650';

/**
 * Load the self-signed certificate, generating one on first run.
 *
 * Returns null — rather than throwing — when a certificate cannot be produced.
 * HTTPS here is an optional extra that exists so WebSerial has a secure
 * context; the server must still start and serve panels without it.
 */
export async function ensureCertificate(dir: string): Promise<{ cert: Buffer; key: Buffer } | null> {
  const certPath = join(dir, CERT_FILE);
  const keyPath = join(dir, KEY_FILE);

  try {
    // Stable across restarts: regenerating would re-trigger the browser's
    // trust warning every boot.
    return { cert: await readFile(certPath), key: await readFile(keyPath) };
  } catch {
    // Not generated yet.
  }

  try {
    await mkdir(dir, { recursive: true });
    await run('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath,
      '-out', certPath,
      '-days', DAYS,
      '-subj', '/CN=inkpanel',
      // The browser needs the address it was reached on to be in the cert.
      // A LAN IP can change, so cover localhost and mark it a CA-less leaf;
      // this cert is trusted by explicit exception, never by chain.
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ]);
    // Applied unconditionally after every generation, mirroring
    // loadOrCreateSecret's tightenPermissions — that function's own bug
    // report was a restrictive mode applied only on creation and skipped on
    // rewrite. There is no separate rewrite path here (a cache hit above
    // returns before this point), but the chmod stays explicit and
    // unconditional rather than relying on openssl's own umask-dependent
    // output mode.
    await chmod(keyPath, 0o600);
    return { cert: await readFile(certPath), key: await readFile(keyPath) };
  } catch {
    return null;
  }
}

export interface HttpsOptions {
  dataDir: string;
  port: number;
}

/**
 * Start the HTTPS listener beside the existing HTTP one. Returns null when no
 * certificate could be produced — callers log and carry on.
 */
export async function startHttpsListener(
  app: express.Express,
  options: HttpsOptions,
): Promise<Server | null> {
  const material = await ensureCertificate(options.dataDir);
  if (material === null) return null;

  try {
    const server = createServer({ cert: material.cert, key: material.key }, app);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port, () => {
        server.off('error', reject);
        resolve();
      });
    });
    return server;
  } catch (err) {
    console.error('https disabled: failed to start listener:', err);
    return null;
  }
}
