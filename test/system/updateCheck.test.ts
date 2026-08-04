import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareRefs } from '../../src/system/updateCheck.ts';

test('identical refs are current', () => {
  assert.equal(compareRefs('abc123', 'abc123').state, 'current');
});

test('differing refs mean an update is available', () => {
  assert.equal(compareRefs('abc123', 'def456').state, 'behind');
});

test('a missing ref is unknown, never "current"', () => {
  assert.equal(compareRefs(null, 'def456').state, 'unknown');
  assert.equal(compareRefs('abc123', null).state, 'unknown');
  assert.equal(compareRefs(null, null).state, 'unknown');
});

test('short and long forms of the same commit are current', () => {
  assert.equal(compareRefs('abc1234', 'abc1234def567890').state, 'current',
    'git rev-parse --short and ls-remote return different lengths');
});
