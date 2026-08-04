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

test('formats battery voltage, tolerating unknown', () => {
  assert.equal(formatVolts(4.02), '4.02 V');
  assert.equal(formatVolts(null), 'unknown');
});
