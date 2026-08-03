import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextWakeSeconds, MIN_WAKE_SECONDS } from '../../src/schedule/nextWake.ts';
import { defaultDevice } from '../../src/devices/types.ts';

const claimed = { ...defaultDevice('esp32-test'), claimed: true };

// 12:00 UTC = 13:00 London (BST), comfortably inside the active window.
const midday = new Date('2026-08-03T12:00:00.000Z');
// 00:30 UTC = 01:30 London, inside quiet hours (23:00-06:00).
const night = new Date('2026-08-03T00:30:00.000Z');

test('unclaimed devices poll quickly so enrolment feels responsive', () => {
  const device = { ...claimed, claimed: false };
  assert.equal(nextWakeSeconds({ now: midday, device, batteryVolts: 4.0 }), 60);
});

test('uses the active interval during the day', () => {
  assert.equal(nextWakeSeconds({ now: midday, device: claimed, batteryVolts: 4.0 }), 900);
});

test('low battery wins over everything except enrolment', () => {
  assert.equal(nextWakeSeconds({ now: midday, device: claimed, batteryVolts: 3.4 }), 21600);
});

test('an unclaimed device polls fast even on low battery', () => {
  const device = { ...claimed, claimed: false };
  assert.equal(nextWakeSeconds({ now: midday, device, batteryVolts: 3.0 }), 60);
});

test('sleeps until the quiet window ends', () => {
  const seconds = nextWakeSeconds({ now: night, device: claimed, batteryVolts: 4.0 });
  // 01:30 London to 06:00 London is 4h30m.
  assert.equal(seconds, 4 * 3600 + 30 * 60);
});

test('quiet hours are evaluated in the device timezone, not the server', () => {
  // 01:30 London is quiet; the same instant in Auckland is 12:30, which is not.
  const auckland = { ...claimed, timezone: 'Pacific/Auckland' };
  assert.equal(nextWakeSeconds({ now: night, device: auckland, batteryVolts: 4.0 }), 900);
});

test('an unknown battery does not trigger low-battery backoff', () => {
  assert.equal(nextWakeSeconds({ now: midday, device: claimed, batteryVolts: null }), 900);
});

test('never returns less than the floor', () => {
  const device = { ...claimed, activeIntervalSeconds: 5 };
  assert.equal(nextWakeSeconds({ now: midday, device, batteryVolts: 4.0 }), MIN_WAKE_SECONDS);
});

test('always returns a positive whole number of seconds', () => {
  for (let hour = 0; hour < 24; hour++) {
    const now = new Date(`2026-08-03T${String(hour).padStart(2, '0')}:00:00.000Z`);
    const seconds = nextWakeSeconds({ now, device: claimed, batteryVolts: 4.0 });
    assert.ok(Number.isInteger(seconds) && seconds > 0, `hour ${hour} produced ${seconds}`);
    assert.ok(seconds <= 24 * 3600, `hour ${hour} produced ${seconds}`);
  }
});

test('survives both DST transitions without a negative interval', () => {
  for (const iso of ['2026-03-29T01:30:00.000Z', '2026-10-25T01:30:00.000Z']) {
    const seconds = nextWakeSeconds({ now: new Date(iso), device: claimed, batteryVolts: 4.0 });
    assert.ok(seconds > 0 && seconds <= 24 * 3600, `${iso} produced ${seconds}`);
  }
});

test('disabled quiet hours never suppress a refresh', () => {
  const always = { ...claimed, quietHoursStart: 0, quietHoursEnd: 0 };
  assert.equal(nextWakeSeconds({ now: night, device: always, batteryVolts: 4.0 }), 900);
});
