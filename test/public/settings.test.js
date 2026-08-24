import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCurrentStatus, settingsView } from '../../public/settings.js';

const info = {
  version: '0.1.0', commit: null, uptimeSeconds: 60, deviceCount: 0, freeBytes: 1024,
  sources: { issues: [], renderedDevices: 0, totalDevices: 0 },
};

test('Settings reports standalone, connected and safely unavailable Home Assistant states', () => {
  assert.match(settingsView(info, { mode: 'standalone', available: false }), /Not running as a Home Assistant App/);
  const connected = settingsView(info, {
    mode: 'home-assistant-app', available: true, version: '2026.8.1',
    locationName: 'Home', timeZone: 'Europe\/London', error: null,
  });
  assert.match(connected, /Connected/);
  assert.match(connected, /Core 2026\.8\.1/);
  assert.match(connected, /Europe\/London/);
  const unavailable = settingsView(info, {
    mode: 'home-assistant-app', available: false, error: 'Home Assistant request failed (401)',
  });
  assert.match(unavailable, /Unavailable/);
  assert.match(unavailable, /request failed \(401\)/);
});

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
