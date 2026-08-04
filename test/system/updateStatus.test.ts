import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseUpdateStatus, readUpdateStatus, requestUpdate } from '../../src/system/updateStatus.ts';

test('an absent status file is idle, not an error', () => {
  const status = parseUpdateStatus(null);
  assert.equal(status.state, 'idle');
  assert.deepEqual(status.log, []);
  assert.equal(status.error, null);
});

test('parses a running status', () => {
  const status = parseUpdateStatus(JSON.stringify({
    state: 'running', startedAt: '2026-08-04T12:00:00.000Z', finishedAt: null,
    log: ['Already up to date.'], error: null,
  }));
  assert.equal(status.state, 'running');
  assert.equal(status.log[0], 'Already up to date.');
});

test('parses a failed status with its error', () => {
  const status = parseUpdateStatus(JSON.stringify({
    state: 'failed', startedAt: '2026-08-04T12:00:00.000Z',
    finishedAt: '2026-08-04T12:00:09.000Z', log: [], error: 'npm ci exited 1',
  }));
  assert.equal(status.state, 'failed');
  assert.match(status.error ?? '', /npm ci/);
});

test('truncated or malformed JSON reads as idle rather than throwing', () => {
  // The updater writes this file while the UI polls it, so a partial read is
  // an expected event, not a bug.
  assert.equal(parseUpdateStatus('{"state":"run').state, 'idle');
  assert.equal(parseUpdateStatus('').state, 'idle');
  assert.equal(parseUpdateStatus('null').state, 'idle');
});

test('an unrecognised state is treated as idle', () => {
  assert.equal(parseUpdateStatus(JSON.stringify({ state: 'exploding' })).state, 'idle');
});

test('requesting an update creates the flag file the systemd path unit watches', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-update-'));
  try {
    await requestUpdate(dir);
    const flag = await readFile(join(dir, '.update-requested'), 'utf8');
    assert.match(flag, /^\d{4}-\d{2}-\d{2}T/, 'contains the request timestamp');
    assert.equal((await readUpdateStatus(dir)).state, 'idle', 'no status until the updater runs');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The status file is written by a root-owned shell script, not by this
// process, so the reader cannot assume it is well-typed. These cover fields
// that JSON.parse happily hands back as the wrong type.

test('non-string timestamps are dropped rather than passed through', () => {
  const status = parseUpdateStatus(JSON.stringify({
    state: 'running', startedAt: { a: 1 }, finishedAt: 12345, log: [], error: null,
  }));
  assert.equal(status.startedAt, null);
  assert.equal(status.finishedAt, null);
});

test('a non-string error is dropped rather than passed through', () => {
  const status = parseUpdateStatus(JSON.stringify({
    state: 'failed', startedAt: null, finishedAt: null, log: [], error: { nested: {} },
  }));
  assert.equal(status.error, null);
});

test('a non-array log is treated as empty rather than passed through', () => {
  const status = parseUpdateStatus(JSON.stringify({
    state: 'running', startedAt: null, finishedAt: null, log: 'not an array', error: null,
  }));
  assert.deepEqual(status.log, []);
});

test('an oversized log is capped rather than passed through whole', () => {
  const log = Array.from({ length: 5000 }, (_, i) => `line ${i}`);
  const status = parseUpdateStatus(JSON.stringify({
    state: 'running', startedAt: null, finishedAt: null, log, error: null,
  }));
  assert.ok(status.log.length <= 200, `expected log capped at 200, got ${status.log.length}`);
  assert.equal(status.log.at(-1), 'line 4999', 'keeps the most recent lines');
});

test('a top-level JSON array reads as idle rather than throwing', () => {
  assert.equal(parseUpdateStatus('[1,2,3]').state, 'idle');
});

test('two idle reads are not the same object', () => {
  const a = parseUpdateStatus(null);
  const b = parseUpdateStatus('');
  assert.notEqual(a, b, 'sharing an object means one caller mutating it would corrupt every other idle read');
  assert.notEqual(a.log, b.log, 'the log array itself must not be shared either');
});
