import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const CACHE_MS = 10 * 60 * 1000;

export type UpdateState = 'current' | 'behind' | 'unknown';

export interface UpdateInfo {
  state: UpdateState;
  local: string | null;
  remote: string | null;
  checkedAt: string;
  error?: string;
}

/**
 * Compare a local short SHA against a remote full SHA.
 *
 * "unknown" is deliberately distinct from "current": failing to reach GitHub
 * must not be reported as being up to date.
 */
export function compareRefs(local: string | null, remote: string | null): { state: UpdateState } {
  if (!local || !remote) return { state: 'unknown' };
  const shortest = Math.min(local.length, remote.length);
  return { state: local.slice(0, shortest) === remote.slice(0, shortest) ? 'current' : 'behind' };
}

let cache: { at: number; info: UpdateInfo } | null = null;
// The in-flight check itself, not just its result — so concurrent callers
// arriving during a cold or expired window share one `git` invocation
// instead of each spawning their own. Same pattern as readVersion in
// ./version.ts, which caches `resolve()`'s promise rather than its value.
let pending: Promise<UpdateInfo> | null = null;

async function resolveUpdate(now: number): Promise<UpdateInfo> {
  let local: string | null = null;
  let remote: string | null = null;
  let error: string | undefined;

  try {
    local = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim() || null;
    // ls-remote reads only; it does not touch the working tree or refs.
    const { stdout } = await run('git', ['ls-remote', 'origin', 'HEAD'], { cwd: root, timeout: 15000 });
    remote = stdout.split(/\s+/)[0]?.trim() || null;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const info: UpdateInfo = {
    ...compareRefs(local, remote),
    local: local ? local.slice(0, 7) : null,
    remote: remote ? remote.slice(0, 7) : null,
    checkedAt: new Date(now).toISOString(),
    ...(error ? { error } : {}),
  };

  cache = { at: now, info };
  return info;
}

export function checkForUpdate(force = false): Promise<UpdateInfo> {
  const now = Date.now();
  if (!force && cache && now - cache.at < CACHE_MS) return Promise.resolve(cache.info);

  pending ??= resolveUpdate(now).finally(() => {
    pending = null;
  });
  return pending;
}
