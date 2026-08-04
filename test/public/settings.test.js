import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCurrentStatus } from '../../public/settings.js';

test('a status with no startedAt is not current — including the idle default', () => {
  assert.equal(isCurrentStatus({ state: 'idle', startedAt: null }, '2026-08-04T12:00:00.000Z'), false);
  assert.equal(isCurrentStatus({ state: 'success', startedAt: null }, '2026-08-04T12:00:00.000Z'), false);
});

test('a status that started before the request was made is stale', () => {
  // This is the bug from the review: a previous run's terminal status
  // ('success' or 'failed') persists in update-status.json until the path
  // unit overwrites it, so a client polling before that overwrite would
  // otherwise read last run's outcome as belonging to the update it just
  // triggered.
  const requestedAt = '2026-08-04T12:00:00.000Z';
  const staleSuccess = { state: 'success', startedAt: '2026-08-04T11:00:00.000Z' };
  const staleFailed = { state: 'failed', startedAt: '2026-08-04T11:00:00.000Z' };
  assert.equal(isCurrentStatus(staleSuccess, requestedAt), false);
  assert.equal(isCurrentStatus(staleFailed, requestedAt), false);
});

test('a status that started at or after the request is current', () => {
  const requestedAt = '2026-08-04T12:00:00.000Z';
  assert.equal(isCurrentStatus({ state: 'running', startedAt: '2026-08-04T12:00:00.000Z' }, requestedAt), true);
  assert.equal(isCurrentStatus({ state: 'success', startedAt: '2026-08-04T12:00:05.000Z' }, requestedAt), true);
  assert.equal(isCurrentStatus({ state: 'failed', startedAt: '2026-08-04T12:05:00.000Z' }, requestedAt), true);
});
