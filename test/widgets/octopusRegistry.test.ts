import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dashboardWidgetSchema } from '../../src/widgets/registry.ts';

test('Octopus Agile remains a V1 widget-registry type', () => {
  // DeviceStore V3 exists for physical display profiles; Octopus itself is
  // still the same V1 runtime widget and needs no widget-specific migration.
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
