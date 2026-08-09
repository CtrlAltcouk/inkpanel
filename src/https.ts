import { createPrivateKey, randomUUID, X509Certificate } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:https';
import {
  chmod, lstat, mkdir, mkdtemp, readFile, rename, rm,
} from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type express from 'express';

const run = promisify(execFile);

const CERT_FILE = 'tls-cert.pem';
const KEY_FILE = 'tls-key.pem';
const DAYS = '3650';

export interface CertificateIdentitySources {
  lanAddress?: string;
  publicBaseUrl?: string;
  hostname?: string;
}

export interface CertificateIdentity {
  type: 'DNS' | 'IP';
  value: string;
}

interface CertificateMaterial {
  cert: Buffer;
  key: Buffer;
}

/** Conservative DNS syntax suitable for direct use as an OpenSSL DNS SAN. */
export function isValidDnsHostname(value: string): boolean {
  if (value.length === 0 || value.length > 253 || value.includes('..')) return false;
  const hostname = value.endsWith('.') ? value.slice(0, -1) : value;
  if (hostname.length === 0) return false;
  return hostname.split('.').every((label) =>
    label.length >= 1 && label.length <= 63 &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label));
}

/** Build the exact validated SAN set required by the current deployment. */
export function deriveCertificateIdentities(
  sources: CertificateIdentitySources = {},
): CertificateIdentity[] {
  const identities: CertificateIdentity[] = [];
  const seen = new Set<string>();

  const addHost = (raw: string | undefined) => {
    if (!raw) return;
    const candidate = raw.trim().replace(/^\[|\]$/g, '');
    const ipVersion = isIP(candidate);
    if (ipVersion !== 0) {
      const key = `IP:${candidate.toLowerCase()}`;
      if (!seen.has(key)) {
        seen.add(key);
        identities.push({ type: 'IP', value: candidate });
      }
      return;
    }
    if (!isValidDnsHostname(candidate)) return;
    const normalized = candidate.replace(/\.$/, '').toLowerCase();
    const key = `DNS:${normalized}`;
    if (!seen.has(key)) {
      seen.add(key);
      identities.push({ type: 'DNS', value: normalized });
    }
  };

  addHost('localhost');
  addHost('127.0.0.1');
  addHost(sources.lanAddress);

  if (sources.publicBaseUrl) {
    try {
      const url = new URL(sources.publicBaseUrl);
      if (url.protocol === 'http:' || url.protocol === 'https:') addHost(url.hostname);
    } catch {
      // PUBLIC_BASE_URL validation belongs elsewhere; malformed values simply
      // cannot contribute an identity to a certificate.
    }
  }

  addHost(sources.hostname);
  return identities;
}

function inspectMaterial(material: CertificateMaterial): X509Certificate | null {
  try {
    const certificate = new X509Certificate(material.cert);
    const key = createPrivateKey(material.key);
    if (!certificate.checkPrivateKey(key)) return null;
    const now = Date.now();
    if (now < Date.parse(certificate.validFrom) || now > Date.parse(certificate.validTo)) return null;
    return certificate;
  } catch {
    return null;
  }
}

export function certificateCoversIdentities(
  certificate: X509Certificate,
  identities: CertificateIdentity[],
): boolean {
  return identities.every((identity) => identity.type === 'IP'
    ? certificate.checkIP(identity.value) !== undefined
    : certificate.checkHost(identity.value) !== undefined);
}

async function readMaterial(certPath: string, keyPath: string): Promise<CertificateMaterial | null> {
  try {
    return { cert: await readFile(certPath), key: await readFile(keyPath) };
  } catch {
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** Replace both files with rollback if any rename/chmod step fails. */
async function installGeneratedPair(
  certPath: string,
  keyPath: string,
  generatedCertPath: string,
  generatedKeyPath: string,
): Promise<void> {
  const suffix = randomUUID();
  const certBackup = `${certPath}.backup-${suffix}`;
  const keyBackup = `${keyPath}.backup-${suffix}`;
  let certBackedUp = false;
  let keyBackedUp = false;
  let certInstalled = false;
  let keyInstalled = false;

  try {
    if (await exists(certPath)) {
      await rename(certPath, certBackup);
      certBackedUp = true;
    }
    if (await exists(keyPath)) {
      await rename(keyPath, keyBackup);
      keyBackedUp = true;
    }

    await rename(generatedKeyPath, keyPath);
    keyInstalled = true;
    await chmod(keyPath, 0o600);
    await rename(generatedCertPath, certPath);
    certInstalled = true;

  } catch (err) {
    if (certInstalled) await rm(certPath, { force: true }).catch(() => {});
    if (keyInstalled) await rm(keyPath, { force: true }).catch(() => {});
    if (certBackedUp) await rename(certBackup, certPath).catch(() => {});
    if (keyBackedUp) await rename(keyBackup, keyPath).catch(() => {});
    throw err;
  }

  // Backup cleanup cannot turn a successfully installed pair into a rollback:
  // failure here merely leaves a root/app-private stale backup for inspection.
  if (certBackedUp) await rm(certBackup, { force: true }).catch(() => {});
  if (keyBackedUp) await rm(keyBackup, { force: true }).catch(() => {});
}

/**
 * Load or generate the browser-only self-signed certificate.
 * Existing material is reused only when it covers every required identity.
 */
export async function ensureCertificate(
  dir: string,
  sources: CertificateIdentitySources = {},
): Promise<CertificateMaterial | null> {
  const certPath = join(dir, CERT_FILE);
  const keyPath = join(dir, KEY_FILE);
  const identities = deriveCertificateIdentities(sources);
  const existing = await readMaterial(certPath, keyPath);
  const existingCertificate = existing ? inspectMaterial(existing) : null;

  if (existing && existingCertificate &&
      certificateCoversIdentities(existingCertificate, identities)) {
    try {
      await chmod(keyPath, 0o600);
      return existing;
    } catch (err) {
      console.error('https disabled: could not restrict the existing TLS private key:', err);
      return null;
    }
  }

  let generationDir: string | null = null;
  try {
    await mkdir(dir, { recursive: true });
    generationDir = await mkdtemp(join(dir, '.tls-generation-'));
    const generatedCertPath = join(generationDir, CERT_FILE);
    const generatedKeyPath = join(generationDir, KEY_FILE);
    const san = identities.map(({ type, value }) => `${type}:${value}`).join(',');

    await run('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', generatedKeyPath,
      '-out', generatedCertPath,
      '-days', DAYS,
      '-subj', '/CN=inkpanel',
      '-addext', `subjectAltName=${san}`,
    ]);
    await chmod(generatedKeyPath, 0o600);

    const generated = await readMaterial(generatedCertPath, generatedKeyPath);
    const generatedCertificate = generated ? inspectMaterial(generated) : null;
    if (!generated || !generatedCertificate ||
        !certificateCoversIdentities(generatedCertificate, identities)) {
      throw new Error('generated TLS material failed validation');
    }

    await installGeneratedPair(certPath, keyPath, generatedCertPath, generatedKeyPath);
    return { cert: await readFile(certPath), key: await readFile(keyPath) };
  } catch (err) {
    console.error('https certificate generation failed:', err);
    // A missing SAN is less severe than losing otherwise usable HTTPS during
    // a failed rotation. The original bytes were never destroyed.
    return existing && existingCertificate ? existing : null;
  } finally {
    if (generationDir) await rm(generationDir, { recursive: true, force: true }).catch(() => {});
  }
}

export interface HttpsOptions {
  dataDir: string;
  port: number;
  identities?: CertificateIdentitySources;
}

/** Start optional HTTPS beside the always-on panel-facing HTTP listener. */
export async function startHttpsListener(
  app: express.Express,
  options: HttpsOptions,
): Promise<Server | null> {
  const material = await ensureCertificate(options.dataDir, options.identities);
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
