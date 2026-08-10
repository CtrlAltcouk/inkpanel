import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CURRENT_DEVICE_STORE_SCHEMA_VERSION } from '../../src/devices/schema.ts';
import { dashboardWidgetSchema } from '../../src/widgets/registry.ts';

test('Octopus Agile is a V1 widget without a DeviceStore schema bump', () => {
  assert.equal(CURRENT_DEVICE_STORE_SCHEMA_VERSION, 2);
  assert.deepEqual(dashboardWidgetSchema.parse({
    type: 'octopus',
    version: 1,
    config: { tariffCode: 'E-1R-AGILE-24-10-01-C' },
  }), {
    type: 'octopus',
    version: 1,
    config: { tariffCode: 'E-1R-AGILE-24-10-01-C' },
  });
});

test('Octopus widget permits not-set-up state but rejects malformed/non-Agile tariffs', () => {
  assert.equal(dashboardWidgetSchema.safeParse({
    type: 'octopus', version: 1, config: { tariffCode: '' },
  }).success, true);

  for (const tariffCode of ['AGILE-24-10-01-C', 'E-1R-GO-VAR-22-10-14-C', 'E-1R-AGILE-24-10-01']) {
    const result = dashboardWidgetSchema.safeParse({ type: 'octopus', version: 1, config: { tariffCode } });
    assert.equal(result.success, false, tariffCode);
  }
});
