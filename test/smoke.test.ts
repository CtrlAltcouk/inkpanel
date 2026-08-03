import { test } from 'node:test';
import assert from 'node:assert/strict';
import { version } from '../src/index.ts';

test('exposes a version string', () => {
  assert.equal(typeof version, 'string');
  assert.match(version, /^\d+\.\d+\.\d+$/);
});
