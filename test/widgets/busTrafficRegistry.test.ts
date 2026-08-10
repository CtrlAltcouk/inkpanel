import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CURRENT_DEVICE_STORE_SCHEMA_VERSION } from '../../src/devices/schema.ts';
import { dashboardWidgetSchema } from '../../src/widgets/registry.ts';

test('Bus and Traffic are runtime widget types without a DeviceStore schema bump', () => {
  assert.equal(CURRENT_DEVICE_STORE_SCHEMA_VERSION, 2);

  assert.deepEqual(dashboardWidgetSchema.parse({
    type: 'bus', version: 1,
    config: { stopCode: '049000000001', stopLabel: 'Central Station', routeFilter: '6' },
  }), {
    type: 'bus', version: 1,
    config: { stopCode: '049000000001', stopLabel: 'Central Station', routeFilter: '6' },
  });

  assert.deepEqual(dashboardWidgetSchema.parse({
    type: 'traffic', version: 1,
    config: { origin: 'MK9 1EA', destination: 'Euston Road, London' },
  }), {
    type: 'traffic', version: 1,
    config: { origin: 'MK9 1EA', destination: 'Euston Road, London' },
  });
});

test('Bus and Traffic registry validation fails closed on malformed config', () => {
  assert.equal(dashboardWidgetSchema.safeParse({
    type: 'bus', version: 1,
    config: { stopCode: 'bad code!', stopLabel: '', routeFilter: '' },
  }).success, false);

  assert.equal(dashboardWidgetSchema.safeParse({
    type: 'traffic', version: 1,
    config: { origin: 'A'.repeat(201), destination: 'B' },
  }).success, false);
});
