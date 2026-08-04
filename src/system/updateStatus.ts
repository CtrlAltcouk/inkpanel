import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type UpdatePhase = 'idle' | 'running' | 'success' | 'failed';

export interface UpdateStatus {
  state: UpdatePhase;
  startedAt: string | null;
  finishedAt: string | null;
  log: string[];
  error: string | null;
}

const PHASES: readonly string[] = ['idle', 'running', 'success', 'failed'];

// Matches the cap the updater itself applies (scripts/proxmox/files/
// write-status.mjs slices the log to its last 200 lines before writing).
// Enforced again on read so a status file from an old or hand-edited
// updater can never hand the client an unbounded array.
const MAX_LOG_LINES = 200;

export const FLAG_FILE = '.update-requested';
export const STATUS_FILE = 'update-status.json';

/**
 * A fresh object every call. The previous implementation returned one shared
 * module-level constant for the idle case, so `parseUpdateStatus(null) ===
 * parseUpdateStatus('')` — nothing mutates it today, but a single `push` onto
 * that shared `log` array from any one caller would have silently corrupted
 * every future idle read for the lifetime of the process.
 */
function idleStatus(): UpdateStatus {
  return { state: 'idle', startedAt: null, finishedAt: null, log: [], error: null };
}

/** Anything that isn't already a string is treated as absent, not stringified. */
function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * The updater writes this file while the UI polls it, so a partial or absent
 * read is expected rather than exceptional. Anything unparseable is idle.
 */
export function parseUpdateStatus(raw: string | null): UpdateStatus {
  if (!raw) return idleStatus();
  try {
    const parsed = JSON.parse(raw) as Partial<UpdateStatus> | null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return idleStatus();
    if (!PHASES.includes(String(parsed.state))) return idleStatus();

    return {
      state: parsed.state as UpdatePhase,
      startedAt: toStringOrNull(parsed.startedAt),
      finishedAt: toStringOrNull(parsed.finishedAt),
      log: Array.isArray(parsed.log) ? parsed.log.map(String).slice(-MAX_LOG_LINES) : [],
      error: toStringOrNull(parsed.error),
    };
  } catch {
    return idleStatus();
  }
}

export async function readUpdateStatus(dataDir: string): Promise<UpdateStatus> {
  try {
    return parseUpdateStatus(await readFile(join(dataDir, STATUS_FILE), 'utf8'));
  } catch {
    return idleStatus();
  }
}

/**
 * Ask for an update by creating a flag file.
 *
 * This is the whole of the application's involvement. A systemd path unit
 * notices the file and runs the updater as root — the app has no ability to
 * influence what that script does, only that it runs.
 */
export async function requestUpdate(dataDir: string): Promise<void> {
  await writeFile(join(dataDir, FLAG_FILE), new Date().toISOString(), 'utf8');
}
