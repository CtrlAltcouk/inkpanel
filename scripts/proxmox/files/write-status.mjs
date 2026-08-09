#!/usr/bin/env node
//
// Writes the self-update status file. Extracted out of inkpanel-update (a
// bash script) into its own file for two reasons: it is real code, not shell
// glue, and pulling it out lets test/system/writeStatus.test.ts execute it
// exactly as the updater does rather than only lint its syntax.
//
// Usage (matches the call in inkpanel-update's write_status()):
//   node write-status.mjs <state> <error> <logFile> <statusFile> <startedAt>
//
// Invoked as `node write-status.mjs ...`, so argv[0] is the node binary and
// argv[1] is this file's path — the five positional args start at argv[2].
// (This is the inverse of the bug this file replaces: the previous inline
// `node -e '...'` had no script-path slot in argv at all, so destructuring
// as if index 1 were the script path silently shifted every field by one.)

import {
  closeSync,
  fchmodSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';

const [state, error, logFile, statusFile, startedAt] = process.argv.slice(2);

let log = [];
try {
  log = readFileSync(logFile, 'utf8').split('\n').filter(Boolean).slice(-200);
} catch {
  // No log file yet (e.g. nothing has been written to it) — an empty log.
}

const body = JSON.stringify({
  state,
  startedAt,
  finishedAt: state === 'running' ? null : new Date().toISOString(),
  log,
  error: error || null,
}, null, 2);

// The status directory and destination pathname are app-controlled. Publish a
// new regular file from the same directory and atomically rename it over the
// destination. POSIX rename replaces a symlink itself rather than following
// its target; fchmod operates on the already-open descriptor, not a pathname.
const tempFile = `${statusFile}.${process.pid}.${randomUUID()}.tmp`;
let fd;
try {
  fd = openSync(tempFile, 'wx', 0o644);
  writeFileSync(fd, body);
  fchmodSync(fd, 0o644);
  closeSync(fd);
  fd = undefined;
  renameSync(tempFile, statusFile);
} finally {
  if (fd !== undefined) closeSync(fd);
  try {
    unlinkSync(tempFile);
  } catch {
    // Already published, or creation itself failed.
  }
}
