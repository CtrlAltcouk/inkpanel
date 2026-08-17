import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dashboardWidgetSchema, printersWidgetV1Schema, widgetRegistry } from '../../src/widgets/registry.ts';
import { CURRENT_DEVICE_STORE_SCHEMA_VERSION, defaultDeviceV3, deviceRecordV3Schema } from '../../src/devices/schema.ts';

const ids = Array.from({ length: 5 }, (_, index) => `${index + 1}1111111-1111-4111-8111-111111111111`);

test('Printers V1 accepts unique ordered IDs up to four and rejects malformed/duplicate/excess IDs', () => {
  for (let count = 0; count <= 4; count += 1) {
    assert.equal(printersWidgetV1Schema.safeParse({ type: 'printers', version: 1, config: { printerIds: ids.slice(0, count) } }).success, true);
  }
  assert.equal(dashboardWidgetSchema.safeParse({ type: 'printers', version: 1, config: { printerIds: ids } }).success, false);
  assert.equal(dashboardWidgetSchema.safeParse({ type: 'printers', version: 1, config: { printerIds: [ids[0], ids[0]] } }).success, false);
  assert.equal(dashboardWidgetSchema.safeParse({ type: 'printers', version: 1, config: { printerIds: ['bad'] } }).success, false);
  assert.ok(widgetRegistry.printers[1]);
});

test('Printers uses the generic V3 envelope without a DeviceStore migration', () => {
  assert.equal(CURRENT_DEVICE_STORE_SCHEMA_VERSION, 3);
  const device = defaultDeviceV3('esp32-printer');
  device.dashboardSections[0] = { type: 'printers', version: 1, config: { printerIds: [ids[0]!] } };
  assert.equal(deviceRecordV3Schema.safeParse(device).success, true);
});
