import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTrainSourceFromEnv, resolveHomeAssistantIngressPort } from '../src/index.ts';

test('Home Assistant Ingress uses its internal default and validates overrides', () => {
  assert.equal(resolveHomeAssistantIngressPort(undefined), 8099);
  assert.equal(resolveHomeAssistantIngressPort(' 9010 '), 9010);
  for (const value of ['0', '65536', '1.5', 'bad']) {
    assert.throws(() => resolveHomeAssistantIngressPort(value), /HOME_ASSISTANT_INGRESS_PORT/);
  }
});

test('National Rail transport stays optional when no environment is configured', () => {
  assert.equal(createTrainSourceFromEnv({}), undefined);
});

test('a base-url override without an API key fails closed', () => {
  assert.throws(
    () => createTrainSourceFromEnv({ NATIONAL_RAIL_LDB_BASE_URL: 'https://rail.example/api/' }),
    /require NATIONAL_RAIL_LDB_API_KEY/,
  );
});

test('an API key alone builds the current RDM train source without exposing credentials', () => {
  const source = createTrainSourceFromEnv({ NATIONAL_RAIL_LDB_API_KEY: 'very-secret-value' });
  assert.equal(source?.id, 'trains');
  assert.doesNotMatch(JSON.stringify(source), /very-secret-value/);
});

test('optional National Rail base-url override still enforces HTTPS', () => {
  assert.throws(
    () => createTrainSourceFromEnv({
      NATIONAL_RAIL_LDB_API_KEY: 'secret',
      NATIONAL_RAIL_LDB_BASE_URL: 'http://rail.example/api/',
    }),
    /must use HTTPS/,
  );
});
