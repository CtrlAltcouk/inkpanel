import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapGeocode } from '../../src/sources/geocode.ts';
import { MILTON_KEYNES, NO_ADMIN1, NO_MATCHES } from '../fixtures/geocode.ts';

test('builds a readable label from name, region and country', () => {
  const [first] = mapGeocode(MILTON_KEYNES);
  assert.equal(first?.label, 'Milton Keynes, England, GB');
  assert.equal(first?.latitude, 52.04172);
  assert.equal(first?.longitude, -0.75583);
  assert.equal(first?.timezone, 'Europe/London');
  assert.equal(first?.countryCode, 'GB');
});

test('returns every match, in order', () => {
  const results = mapGeocode(MILTON_KEYNES);
  assert.equal(results.length, 2);
  assert.equal(results[1]?.label, 'Milton Keynes Village, England, GB');
});

test('omits a missing region rather than leaving a gap', () => {
  const [only] = mapGeocode(NO_ADMIN1);
  assert.equal(only?.label, 'Monaco, MC', 'no empty comma-space run');
});

test('an absent results key is no matches, not an error', () => {
  assert.deepEqual(mapGeocode(NO_MATCHES), []);
  assert.deepEqual(mapGeocode({}), []);
});

test('drops entries missing coordinates or timezone rather than emitting NaN', () => {
  const broken = { results: [{ name: 'Nowhere', country_code: 'XX' }] };
  assert.deepEqual(mapGeocode(broken), []);
});
