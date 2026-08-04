import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Router, type RequestHandler } from 'express';

const COOKIE_NAME = 'inkpanel_session';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const RATE_MAX = 5;
const RATE_WINDOW_MS = 15 * 60 * 1000;

/**
 * `mode` on `writeFile` only applies when the file is created. A pre-existing
 * file keeps whatever mode it already had, so every write path here follows
 * up with an explicit chmod. Meaningless on Windows, where ACLs (not the
 * POSIX mode bits) govern access, so both the chmod and the load-time warning
 * are skipped there.
 */
async function tightenPermissions(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  await chmod(path, 0o600);
}

async function warnIfLoose(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const mode = (await stat(path)).mode & 0o777;
  if (mode & 0o077) {
    console.error(
      `warning: session secret ${path} is mode ${mode.toString(8)} (expected 0600) — ` +
      'sessions are only as private as this file',
    );
  }
}

/** Load the HMAC secret, generating one on first run. */
export async function loadOrCreateSecret(path: string): Promise<Buffer> {
  try {
    const existing = await readFile(path);
    if (existing.length >= 32) {
      await warnIfLoose(path);
      return existing.subarray(0, 32);
    }
  } catch {
    // fall through and create
  }
  const secret = randomBytes(32);
  await mkdir(dirname(path), { recursive: true });
  // Sessions are only as private as this file.
  await writeFile(path, secret, { mode: 0o600 });
  await tightenPermissions(path);
  return secret;
}

function hmac(secret: Buffer, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function signSession(secret: Buffer, expiresAtMs: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: expiresAtMs })).toString('base64url');
  return `${payload}.${hmac(secret, payload)}`;
}

export function verifySession(secret: Buffer, token: string, nowMs: number): boolean {
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payload, signature] = parts as [string, string];
  if (!payload || !signature) return false;

  const expected = Buffer.from(hmac(secret, payload));
  const supplied = Buffer.from(signature);
  // Length check first: timingSafeEqual throws on a mismatch.
  if (expected.length !== supplied.length) return false;
  if (!timingSafeEqual(expected, supplied)) return false;

  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: number };
    return typeof exp === 'number' && exp > nowMs;
  } catch {
    return false;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  // Object.create(null): a forged cookie named e.g. "toString" must never
  // resolve to Object.prototype's method instead of being an own property.
  const out: Record<string, string> = Object.create(null);
  if (!header) return out;
  for (const pair of header.split(';')) {
    const index = pair.indexOf('=');
    if (index < 1) continue;
    const key = pair.slice(0, index).trim();
    // First cookie wins, matching cookie-parser and most other parsers.
    // Last-wins would let a later, less-specific-path cookie shadow an
    // earlier, more-specific one — the wrong side of a cookie-shadowing
    // attack.
    if (key in out) continue;
    const value = pair.slice(index + 1).trim();
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

/** Paths under /api that must work without a session. */
function isExempt(method: string, path: string): boolean {
  // Firmware cannot log in, and can't be relied on to send GET, exact case,
  // or no trailing slash — Express's own router isn't that strict either, so
  // the exemption must be at least as lenient or a firmware/proxy quirk that
  // the router would happily serve turns into a silent 401 with no picture
  // on the panel and no error visible anywhere.
  if (method !== 'GET' && method !== 'HEAD') return false;
  const normalised = path.replace(/\/+$/, '');
  return /^\/devices\/[^/]+\/frame$/i.test(normalised);
}

/** Constant-time password comparison that leaks neither content nor length. */
function passwordsMatch(expected: string, supplied: string): boolean {
  // Hash both sides to a fixed 32-byte digest before comparing. Comparing
  // the raw strings would need a length check first, because
  // timingSafeEqual throws on mismatched lengths — but that check itself
  // returns faster on a length mismatch than on a same-length wrong
  // password, leaking the password's length through timing. Hashing removes
  // the length variable (and the throw hazard) entirely.
  const expectedDigest = createHash('sha256').update(expected).digest();
  const suppliedDigest = createHash('sha256').update(supplied).digest();
  return timingSafeEqual(expectedDigest, suppliedDigest);
}

type AttemptRecord = { count: number; resetAt: number };

/** Drop rate-limit entries whose window has already expired. Exported for tests. */
export function pruneExpiredAttempts(attempts: Map<string, AttemptRecord>, now: number): void {
  for (const [ip, record] of attempts) {
    if (record.resetAt <= now) attempts.delete(ip);
  }
}

export interface AuthOptions {
  /** Null disables authentication entirely. */
  password: string | null;
  secret: Buffer;
}

export function createAuth(options: AuthOptions): { middleware: RequestHandler; router: Router } {
  const attempts = new Map<string, AttemptRecord>();

  const middleware: RequestHandler = (req, res, next) => {
    if (!options.password) return next();
    if (isExempt(req.method, req.path)) return next();

    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (token && verifySession(options.secret, token, Date.now())) return next();

    res.status(401).json({ error: 'authentication required' });
  };

  const router = Router();

  router.post('/auth/login', (req, res) => {
    if (!options.password) {
      res.json({ ok: true, authRequired: false });
      return;
    }

    const ip = req.ip ?? 'unknown';
    const now = Date.now();
    const record = attempts.get(ip);
    if (record && record.resetAt > now && record.count >= RATE_MAX) {
      res.status(429).json({ error: 'too many attempts, try again later' });
      return;
    }

    const supplied = String((req.body as { password?: unknown })?.password ?? '');
    const ok = passwordsMatch(options.password, supplied);

    if (!ok) {
      // Sweep on failure, not on every request: a lone attacker cycling
      // through addresses generates failures, so this is exactly the path
      // that would otherwise grow the map without bound.
      pruneExpiredAttempts(attempts, now);
      const next = record && record.resetAt > now
        ? { count: record.count + 1, resetAt: record.resetAt }
        : { count: 1, resetAt: now + RATE_WINDOW_MS };
      attempts.set(ip, next);
      res.status(401).json({ error: 'incorrect password' });
      return;
    }

    attempts.delete(ip);
    res.cookie(COOKIE_NAME, signSession(options.secret, now + SESSION_MS), {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: SESSION_MS,
      path: '/',
    });
    res.json({ ok: true, authRequired: true });
  });

  router.post('/auth/logout', (_req, res) => {
    res.clearCookie(COOKIE_NAME, { path: '/' });
    res.json({ ok: true });
  });

  router.get('/auth/state', (_req, res) => {
    res.json({ authRequired: Boolean(options.password) });
  });

  return { middleware, router };
}
