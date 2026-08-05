import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapBins, normaliseBinType } from '../../src/sources/bins.ts';
import { REAL_RESPONSE, NO_COLLECTIONS } from '../fixtures/bins.ts';

// Well before every NextInstance in the fixture (2026-08-07 and 2026-08-14).
const BEFORE_ALL = new Date('2026-08-04T09:00:00.000Z');
// After the 2026-08-07 rounds but before the 2026-08-14 one.
const AFTER_FIRST = new Date('2026-08-08T09:00:00.000Z');
// After every NextInstance in the fixture.
const AFTER_ALL = new Date('2026-08-15T09:00:00.000Z');

test('normalises council wording to known bin types', () => {
  assert.equal(normaliseBinType('Recycling Sacks'), 'recycling');
  assert.equal(normaliseBinType('Mixed Recycling'), 'recycling');
  assert.equal(normaliseBinType('Food Waste Caddy'), 'food');
  assert.equal(normaliseBinType('Garden Waste'), 'garden');
  assert.equal(normaliseBinType('Green Waste'), 'garden');
  assert.equal(normaliseBinType('Refuse'), 'general');
});

test('an unrecognised description falls back to general rather than vanishing', () => {
  // Putting the wrong bin out is bad; not being told about a bin is worse.
  assert.equal(normaliseBinType('Some New Scheme 2027'), 'general');
});

test('extracts the next collection from a real response', () => {
  const data = mapBins(REAL_RESPONSE, BEFORE_ALL);
  assert.ok(data.next, 'a real response has an upcoming collection');
  assert.match(data.next!.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(data.next!.types.length > 0);
});

test('the next collection is the soonest one not in the past', () => {
  const data = mapBins(REAL_RESPONSE, BEFORE_ALL);
  assert.equal(data.next!.date, '2026-08-07');
});

test('multiple bins collected on the same day are all grouped into one collection', () => {
  const data = mapBins(REAL_RESPONSE, BEFORE_ALL);
  assert.equal(data.next!.date, '2026-08-07');
  // Blue recycling, food & garden, and refuse all fall on 2026-08-07.
  assert.deepEqual(new Set(data.next!.types), new Set(['recycling', 'food', 'general']));
  assert.equal(data.rawLabels.length, 3);
});

test('a later collection is only surfaced once the nearer one has passed', () => {
  // If "next" were computed wrong (e.g. always the first row, or unsorted),
  // this is the case that would catch it: the 2026-08-07 round is gone, so
  // only the fortnightly 2026-08-14 red-recycling round remains.
  const data = mapBins(REAL_RESPONSE, AFTER_FIRST);
  assert.equal(data.next!.date, '2026-08-14');
  assert.deepEqual(data.next!.types, ['recycling']);
  assert.deepEqual(data.rawLabels, ['Collect Recycling Red']);
});

test('a collection scheduled for today counts as next, not as past', () => {
  const data = mapBins(REAL_RESPONSE, new Date('2026-08-07T23:00:00.000Z'));
  assert.equal(data.next!.date, '2026-08-07');
});

test('keeps the original labels so the panel can print what the council said', () => {
  const data = mapBins(REAL_RESPONSE, AFTER_FIRST);
  assert.deepEqual(data.rawLabels, ['Collect Recycling Red']);
});

test('when every collection is in the past, next is null rather than a stale date', () => {
  const data = mapBins(REAL_RESPONSE, AFTER_ALL);
  assert.equal(data.next, null);
});

test('no upcoming collection is null, not a throw', () => {
  assert.equal(mapBins(NO_COLLECTIONS, BEFORE_ALL).next, null);
  assert.deepEqual(mapBins(NO_COLLECTIONS, BEFORE_ALL).rawLabels, []);
});

test('a malformed response throws rather than reporting no bins', () => {
  // "The API changed" and "you have no collections" must not look identical.
  assert.throws(() => mapBins({ nonsense: true }, BEFORE_ALL), /malformed/i);
  assert.throws(() => mapBins(null, BEFORE_ALL), /malformed/i);
});
