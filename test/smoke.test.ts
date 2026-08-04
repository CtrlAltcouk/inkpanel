import { test } from 'node:test';
import assert from 'node:assert/strict';
import { version, parseTrustProxy } from '../src/index.ts';

test('exposes a version string', () => {
  assert.equal(typeof version, 'string');
  assert.match(version, /^\d+\.\d+\.\d+$/);
});

test('parseTrustProxy: unset or blank means "do not set it"', () => {
  assert.equal(parseTrustProxy(undefined), undefined);
  assert.equal(parseTrustProxy(''), undefined);
  assert.equal(parseTrustProxy('   '), undefined);
});

test('parseTrustProxy: a bare number is a hop count', () => {
  assert.equal(parseTrustProxy('1'), 1);
  assert.equal(parseTrustProxy('2'), 2);
  assert.equal(parseTrustProxy(' 3 '), 3);
});

test('parseTrustProxy: "true"/"false" become booleans', () => {
  assert.equal(parseTrustProxy('true'), true);
  assert.equal(parseTrustProxy('TRUE'), true);
  assert.equal(parseTrustProxy('false'), false);
});

test('parseTrustProxy: anything else passes through for Express to parse itself', () => {
  // Express's own proxyaddr compiler accepts a single token (e.g.
  // "loopback") or a comma-separated list of addresses/subnets, so those
  // are forwarded unchanged rather than split here.
  assert.equal(parseTrustProxy('loopback'), 'loopback');
  assert.equal(parseTrustProxy('10.0.0.0/8,172.16.0.0/12'), '10.0.0.0/8,172.16.0.0/12');
});
