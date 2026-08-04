import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextCheckIn } from '../../src/devices/nextCheckIn.ts';
import { defaultDevice, type DeviceRecord } from '../../src/devices/types.ts';

const now = new Date('2026-08-04T12:00:00.000Z');

test('reports when the panel will next collect a frame', () => {
  const device = {
    ...defaultDevice('esp32-1'),
    lastSeenAt: '2026-08-04T11:55:00.000Z',
    lastWakeSeconds: 900,
  };
  const { willAppearBy, overdueSince } = nextCheckIn(device, now);
  assert.equal(willAppearBy, '2026-08-04T12:10:00.000Z', '11:55 plus 15 minutes');
  assert.equal(overdueSince, null);
});

test('reports overdue when the check-in has been missed', () => {
  const device = {
    ...defaultDevice('esp32-1'),
    lastSeenAt: '2026-08-04T11:00:00.000Z',
    lastWakeSeconds: 900,
  };
  const { willAppearBy, overdueSince } = nextCheckIn(device, now);
  assert.equal(willAppearBy, null);
  assert.equal(overdueSince, '2026-08-04T11:15:00.000Z');
});

test('a device that has never checked in has no prediction', () => {
  const { willAppearBy, overdueSince } = nextCheckIn(defaultDevice('esp32-new'), now);
  assert.equal(willAppearBy, null);
  assert.equal(overdueSince, null, 'unknown is not the same as overdue');
});

test('a device seen but with no recorded interval has no prediction', () => {
  const device = { ...defaultDevice('esp32-1'), lastSeenAt: '2026-08-04T11:55:00.000Z' };
  assert.deepEqual(nextCheckIn(device, now), { willAppearBy: null, overdueSince: null });
});

test('a device record predating lastWakeSeconds has no prediction', () => {
  // Records persisted before lastWakeSeconds existed load from disk with the
  // key genuinely absent (undefined), not merely null. Build that shape
  // directly rather than relying on defaultDevice, which always sets null.
  const { lastWakeSeconds: _omitted, ...withoutWakeSeconds } = {
    ...defaultDevice('esp32-1'),
    lastSeenAt: '2026-08-04T11:55:00.000Z',
  };
  const device = withoutWakeSeconds as unknown as DeviceRecord;
  assert.ok(!('lastWakeSeconds' in device), 'test setup must genuinely omit the field, not set it to null');

  assert.deepEqual(nextCheckIn(device, now), { willAppearBy: null, overdueSince: null });
});

test('the exact due moment counts as overdue, not upcoming', () => {
  const device = {
    ...defaultDevice('esp32-1'),
    lastSeenAt: '2026-08-04T11:45:00.000Z',
    lastWakeSeconds: 900,
  };
  // due = 11:45:00 + 900s = 12:00:00.000Z, exactly equal to `now`.
  const { willAppearBy, overdueSince } = nextCheckIn(device, now);
  assert.equal(willAppearBy, null, 'due-now must not read as still upcoming');
  assert.equal(overdueSince, '2026-08-04T12:00:00.000Z');
});
