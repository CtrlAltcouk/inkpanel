import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DeviceEnrolmentLimiter,
  firmwareAutoEnrolmentIdSchema,
} from '../../src/http/deviceEnrolment.ts';
import { defaultDeviceV1, deviceStoreV1Schema } from '../../src/devices/schema.ts';

test('only the exact current lowercase firmware ID shape is auto-enrolment eligible', () => {
  for (const id of ['esp32-a1b2c3', 'esp32-000001']) {
    assert.equal(firmwareAutoEnrolmentIdSchema.safeParse(id).success, true, id);
  }
  for (const id of [
    'panel1', 'test-panel', 'ESP32-A1B2C3', 'esp32-a1b2', 'esp32-a1b2c3d4', 'foo',
  ]) assert.equal(firmwareAutoEnrolmentIdSchema.safeParse(id).success, false, id);
});

test('frozen V1 persistence continues to accept legacy and manual IDs', () => {
  const parsed = deviceStoreV1Schema.parse({
    schemaVersion: 1,
    devices: [defaultDeviceV1('test-panel'), defaultDeviceV1('ESP32-A1B2C3')],
  });
  assert.deepEqual(parsed.devices.map(({ id }) => id), ['test-panel', 'ESP32-A1B2C3']);
});

test('per-client reservations count creations, refund failures, and expire', () => {
  let now = 1_000;
  const limiter = new DeviceEnrolmentLimiter({ now: () => now });
  for (let index = 0; index < 5; index += 1) {
    const result = limiter.reserve('client');
    assert.equal(result.allowed, true);
    if (result.allowed) result.reservation.complete(true);
  }
  const limited = limiter.reserve('client');
  assert.equal(limited.allowed, false);
  if (!limited.allowed) assert.equal(limited.retryAfterSeconds, 3600);

  now += 60 * 60 * 1000;
  assert.equal(limiter.reserve('client').allowed, true, 'expired state is pruned');

  const refundable = new DeviceEnrolmentLimiter({ perIpLimit: 1, globalLimit: 1 });
  const failed = refundable.reserve('client');
  assert.equal(failed.allowed, true);
  if (failed.allowed) failed.reservation.complete(false);
  assert.equal(refundable.reserve('client').allowed, true, 'failed creation refunds both limits');
});

test('the global limiter bounds rotating client addresses', () => {
  const limiter = new DeviceEnrolmentLimiter();
  for (let index = 0; index < 20; index += 1) {
    const result = limiter.reserve(`client-${index}`);
    assert.equal(result.allowed, true);
    if (result.allowed) result.reservation.complete(true);
  }
  const limited = limiter.reserve('client-21');
  assert.equal(limited.allowed, false);
  if (!limited.allowed) assert.ok(limited.retryAfterSeconds > 0);
});
