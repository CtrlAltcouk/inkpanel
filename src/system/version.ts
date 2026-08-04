import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface VersionInfo {
  version: string;
  /** Short commit SHA, or null when not a git checkout. */
  commit: string | null;
}

// Neither value changes while the process runs, so resolve once.
let cached: Promise<VersionInfo> | null = null;

async function resolve(): Promise<VersionInfo> {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string };

  let commit: string | null = null;
  try {
    const { stdout } = await run('git', ['rev-parse', '--short', 'HEAD'], { cwd: root });
    commit = stdout.trim() || null;
  } catch {
    // A tarball deployment has no .git, and that is not an error.
  }

  return { version: pkg.version, commit };
}

export function readVersion(): Promise<VersionInfo> {
  cached ??= resolve();
  return cached;
}
