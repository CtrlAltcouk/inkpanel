import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findStation, searchStations, stationCount } from '../../src/sources/stations.ts';

test('the bundled list is present and plausible', () => {
  const count = stationCount();
  assert.ok(count > 2000 && count < 4000, `expected 2000-4000 stations, got ${count}`);
});

test('finds a station by CRS, case-insensitively', () => {
  assert.match(findStation('MKC')?.name ?? '', /Milton Keynes/);
  assert.match(findStation('mkc')?.name ?? '', /Milton Keynes/);
  assert.equal(findStation('EUS')?.name, findStation('eus')?.name);
});

test('an unknown CRS is null, not a throw', () => {
  assert.equal(findStation('ZZZ'), null);
  assert.equal(findStation(''), null);
  assert.equal(findStation('TOOLONG'), null);
});

test('searches by name fragment', () => {
  const hits = searchStations('milton keynes');
  assert.ok(hits.length >= 1);
  assert.ok(hits.some((s) => s.crs === 'MKC'));
});

test('searches by CRS too, so typing a known code finds it', () => {
  const hits = searchStations('EUS');
  assert.equal(hits[0]?.crs, 'EUS', 'an exact CRS match sorts first');
});

test('caps results so the picker never renders hundreds of rows', () => {
  assert.ok(searchStations('e').length <= 8);
  assert.equal(searchStations('e', 3).length, 3);
});

test('a query matching nothing returns empty, not everything', () => {
  assert.deepEqual(searchStations('zzzzzzzz'), []);
});
