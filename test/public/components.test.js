import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc, formatRelative, formatVolts } from '../../public/components.js';

test('escapes the characters that break markup', () => {
  assert.equal(esc('<script>'), '&lt;script&gt;');
  assert.equal(esc('a & b'), 'a &amp; b');
  assert.equal(esc('say "hi"'), 'say &quot;hi&quot;');
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
});

test('formats recent times in relative terms', () => {
  const now = new Date('2026-08-04T12:00:00.000Z');
  assert.equal(formatRelative('2026-08-04T11:59:30.000Z', now), 'just now');
  assert.equal(formatRelative('2026-08-04T11:55:00.000Z', now), '5m ago');
  assert.equal(formatRelative('2026-08-04T09:00:00.000Z', now), '3h ago');
  assert.equal(formatRelative('2026-08-01T12:00:00.000Z', now), '3d ago');
});

test('a never-seen device reads as never, not as an epoch date', () => {
  assert.equal(formatRelative(null, new Date()), 'never');
  assert.equal(formatRelative('not a date', new Date()), 'never');
});

test('unit-boundary rounding does not overflow its bucket', () => {
  const now = new Date('2026-08-04T12:00:00.000Z');
  // 44s: still "just now"; 45s: first second that reads as elapsed time.
  assert.equal(formatRelative(new Date(now.getTime() - 44_000).toISOString(), now), 'just now');
  assert.equal(formatRelative(new Date(now.getTime() - 45_000).toISOString(), now), '1m ago');
  // 3599s rounds to 60m under naive division; must roll over to 1h.
  assert.equal(formatRelative(new Date(now.getTime() - 3599_000).toISOString(), now), '1h ago');
  assert.equal(formatRelative(new Date(now.getTime() - 3600_000).toISOString(), now), '1h ago');
  // 86399s rounds to 24h under naive division; must roll over to 1d.
  assert.equal(formatRelative(new Date(now.getTime() - 86399_000).toISOString(), now), '1d ago');
  assert.equal(formatRelative(new Date(now.getTime() - 86400_000).toISOString(), now), '1d ago');
});

test('a clock-skewed device reporting a future timestamp is not shown as just now', () => {
  const now = new Date('2026-08-04T12:00:00.000Z');
  // Trivial skew (under the same 45s threshold as the past case) is noise, not signal.
  assert.equal(formatRelative(new Date(now.getTime() + 30_000).toISOString(), now), 'just now');
  // Anything beyond that must be visibly distinct from a fresh check-in.
  assert.equal(formatRelative(new Date(now.getTime() + 45_000).toISOString(), now), 'in 1m');
  assert.equal(formatRelative(new Date(now.getTime() + 5 * 60_000).toISOString(), now), 'in 5m');
  assert.equal(formatRelative(new Date(now.getTime() + 3600_000).toISOString(), now), 'in 1h');
  assert.equal(formatRelative(new Date(now.getTime() + 86400_000).toISOString(), now), 'in 1d');
});

test('formats battery voltage, tolerating unknown', () => {
  assert.equal(formatVolts(4.02), '4.02 V');
  assert.equal(formatVolts(null), 'unknown');
});
