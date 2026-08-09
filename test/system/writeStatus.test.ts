import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, symlink, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)), '..', '..',
  'scripts', 'proxmox', 'files', 'write-status.mjs',
);

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-write-status-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

interface WrittenStatus {
  state: string;
  startedAt: string | null;
  finishedAt: string | null;
  log: string[];
  error: string | null;
}

async function readStatus(path: string): Promise<WrittenStatus> {
  return JSON.parse(await readFile(path, 'utf8')) as WrittenStatus;
}

// write-status.mjs is executed by inkpanel-update as:
//   node write-status.mjs <state> <error> <logFile> <statusFile> <startedAt>
//
// `bash -n` on the updater cannot catch an argv-indexing bug — it only
// checks shell syntax, and the call site is syntactically fine either way.
// This is the regression guard for the actual blocker: the original inline
// `node -e '...'` destructured process.argv as if index 1 held a script
// path, which `node -e` never provides, so every field landed one slot to
// the right — state received the error string, statusFile received the
// timestamp, and startedAt came out undefined. Using five distinct,
// order-sensitive values below means any such shift fails these assertions.
test('write-status writes state, startedAt, error and log to the fields the caller asked for', async () => {
  await withTempDir(async (dir) => {
    const logFile = join(dir, 'log.txt');
    const statusFile = join(dir, 'status.json');
    await writeFile(logFile, 'line one\nline two\n\nline three\n', 'utf8');

    const startedAt = '2026-08-04T09:00:00.000Z';
    await run('node', [SCRIPT, 'running', '', logFile, statusFile, startedAt]);

    const status = await readStatus(statusFile);
    assert.equal(status.state, 'running');
    assert.equal(status.startedAt, startedAt);
    assert.equal(status.finishedAt, null, 'still running, so no finish time yet');
    assert.deepEqual(status.log, ['line one', 'line two', 'line three'], 'blank lines dropped');
    assert.equal(status.error, null);
  });
});

test('a failed run records its error message and a finishedAt timestamp', async () => {
  await withTempDir(async (dir) => {
    const logFile = join(dir, 'log.txt');
    const statusFile = join(dir, 'status.json');
    await writeFile(logFile, 'npm ci output\n', 'utf8');

    await run('node', [
      SCRIPT, 'failed', 'npm ci exited 1', logFile, statusFile, '2026-08-04T09:00:00.000Z',
    ]);

    const status = await readStatus(statusFile);
    assert.equal(status.state, 'failed');
    assert.equal(status.error, 'npm ci exited 1');
    assert.match(status.finishedAt ?? '', /^\d{4}-\d{2}-\d{2}T/, 'a terminal state gets a finish time');
  });
});

test('the log is capped at the last 200 lines, matching the reader-side cap', async () => {
  await withTempDir(async (dir) => {
    const logFile = join(dir, 'log.txt');
    const statusFile = join(dir, 'status.json');
    const lines = Array.from({ length: 250 }, (_, i) => `line ${i}`);
    await writeFile(logFile, `${lines.join('\n')}\n`, 'utf8');

    await run('node', [SCRIPT, 'success', '', logFile, statusFile, '2026-08-04T09:00:00.000Z']);

    const status = await readStatus(statusFile);
    assert.equal(status.log.length, 200);
    assert.equal(status.log[0], 'line 50');
    assert.equal(status.log[199], 'line 249');
  });
});

test('a missing log file yields an empty log rather than throwing', async () => {
  await withTempDir(async (dir) => {
    const statusFile = join(dir, 'status.json');
    await run('node', [
      SCRIPT, 'running', '', join(dir, 'does-not-exist.log'), statusFile, '2026-08-04T09:00:00.000Z',
    ]);
    const status = await readStatus(statusFile);
    assert.deepEqual(status.log, []);
  });
});

test('publishing status replaces a symlink instead of following it', {
  skip: process.platform === 'win32' ? 'InkPanel deploys this POSIX boundary on Linux' : false,
}, async () => {
  await withTempDir(async (dir) => {
    const logFile = join(dir, 'log.txt');
    const statusFile = join(dir, 'status.json');
    const sentinel = join(dir, 'protected-sentinel.txt');
    const original = Buffer.from('protected bytes\n');
    await writeFile(logFile, 'safe log\n');
    await writeFile(sentinel, original);
    await symlink(sentinel, statusFile);

    await run('node', [
      SCRIPT, 'running', '', logFile, statusFile, '2026-08-04T09:00:00.000Z',
    ]);

    assert.deepEqual(await readFile(sentinel), original);
    assert.equal((await readStatus(statusFile)).state, 'running');
  });
});
