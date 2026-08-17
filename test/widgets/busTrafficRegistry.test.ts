import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dashboardWidgetSchema } from '../../src/widgets/registry.ts';

test('Bus and Traffic remain runtime widget-registry types', () => {
  // The DeviceStore is now V3 because physical display profiles introduced a
  // real persistence change. Bus/Traffic themselves remain V1 widget-registry
  // entries and still do not require their own store migration.
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
