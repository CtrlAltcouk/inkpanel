import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTrainSourceFromEnv } from '../src/index.ts';

test('National Rail transport stays optional when no environment is configured', () => {
  assert.equal(createTrainSourceFromEnv({}), undefined);
});

test('partial National Rail environment fails closed instead of silently disabling trains', () => {
  assert.throws(
    () => createTrainSourceFromEnv({ NATIONAL_RAIL_LDB_BASE_URL: 'https://rail.example/api/' }),
    /require both NATIONAL_RAIL_LDB_BASE_URL and NATIONAL_RAIL_LDB_AUTH_VALUE/,
  );
  assert.throws(
    () => createTrainSourceFromEnv({ NATIONAL_RAIL_LDB_AUTH_VALUE: 'secret' }),
    /require both NATIONAL_RAIL_LDB_BASE_URL and NATIONAL_RAIL_LDB_AUTH_VALUE/,
  );
});

test('complete National Rail environment builds the train source without exposing credentials', () => {
  const source = createTrainSourceFromEnv({
    NATIONAL_RAIL_LDB_BASE_URL: 'https://rail.example/api/',
    NATIONAL_RAIL_LDB_AUTH_HEADER: 'X-Consumer-Key',
    NATIONAL_RAIL_LDB_AUTH_VALUE: 'very-secret-value',
  });
  assert.equal(source?.id, 'trains');
  assert.doesNotMatch(JSON.stringify(source), /very-secret-value/);
});

test('National Rail environment still enforces HTTPS', () => {
  assert.throws(
    () => createTrainSourceFromEnv({
      NATIONAL_RAIL_LDB_BASE_URL: 'http://rail.example/api/',
      NATIONAL_RAIL_LDB_AUTH_VALUE: 'secret',
    }),
    /must use HTTPS/,
  );
});
