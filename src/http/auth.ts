import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Router, type RequestHandler } from 'express';

const COOKIE_NAME = 'inkpanel_session';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const RATE_MAX = 5;
const RATE_WINDOW_MS = 15 * 60 * 1000;

/** Load the HMAC secret, generating one on first run. */
export async function loadOrCreateSecret(path: string): Promise<Buffer> {
  try {
    const existing = await readFile(path);
    if (existing.length >= 32) return existing.subarray(0, 32);
  } catch {
    // fall through and create
  }
  const secret = randomBytes(32);
  await mkdir(dirname(path), { recursive: true });
  // Sessions are only as private as this file.
  await writeFile(path, secret, { mode: 0o600 });
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
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const pair of header.split(';')) {
    const index = pair.indexOf('=');
    if (index < 1) continue;
    const key = pair.slice(0, index).trim();
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
  // Firmware cannot log in.
  if (method === 'GET' && /^\/devices\/[^/]+\/frame$/.test(path)) return true;
  // Otherwise nobody could ever authenticate.
  if (path === '/auth/login') return true;
  return false;
}

export interface AuthOptions {
  /** Null disables authentication entirely. */
  password: string | null;
  secret: Buffer;
}

export function createAuth(options: AuthOptions): { middleware: RequestHandler; router: Router } {
  const attempts = new Map<string, { count: number; resetAt: number }>();

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
    const expected = Buffer.from(options.password);
    const given = Buffer.from(supplied);
    const ok = expected.length === given.length && timingSafeEqual(expected, given);

    if (!ok) {
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
