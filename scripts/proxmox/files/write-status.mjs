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

import { readFileSync, writeFileSync } from 'node:fs';

const [state, error, logFile, statusFile, startedAt] = process.argv.slice(2);

let log = [];
try {
  log = readFileSync(logFile, 'utf8').split('\n').filter(Boolean).slice(-200);
} catch {
  // No log file yet (e.g. nothing has been written to it) — an empty log.
}

writeFileSync(statusFile, JSON.stringify({
  state,
  startedAt,
  finishedAt: state === 'running' ? null : new Date().toISOString(),
  log,
  error: error || null,
}, null, 2));
