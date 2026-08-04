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

const IDLE: UpdateStatus = {
  state: 'idle', startedAt: null, finishedAt: null, log: [], error: null,
};

const PHASES: readonly string[] = ['idle', 'running', 'success', 'failed'];

export const FLAG_FILE = '.update-requested';
export const STATUS_FILE = 'update-status.json';

/**
 * The updater writes this file while the UI polls it, so a partial or absent
 * read is expected rather than exceptional. Anything unparseable is idle.
 */
export function parseUpdateStatus(raw: string | null): UpdateStatus {
  if (!raw) return IDLE;
  try {
    const parsed = JSON.parse(raw) as Partial<UpdateStatus> | null;
    if (!parsed || typeof parsed !== 'object') return IDLE;
    if (!PHASES.includes(String(parsed.state))) return IDLE;

    return {
      state: parsed.state as UpdatePhase,
      startedAt: parsed.startedAt ?? null,
      finishedAt: parsed.finishedAt ?? null,
      log: Array.isArray(parsed.log) ? parsed.log.map(String) : [],
      error: parsed.error ?? null,
    };
  } catch {
    return IDLE;
  }
}

export async function readUpdateStatus(dataDir: string): Promise<UpdateStatus> {
  try {
    return parseUpdateStatus(await readFile(join(dataDir, STATUS_FILE), 'utf8'));
  } catch {
    return IDLE;
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
