import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dashboardWidgetSchema,
  todoWidgetV1Schema,
  widgetRegistry,
} from '../../src/widgets/registry.ts';
import {
  CURRENT_DEVICE_STORE_SCHEMA_VERSION,
  deviceRecordV3Schema,
  defaultDeviceV3,
} from '../../src/devices/schema.ts';

test('To Do V1 validates only its shared list identity', () => {
  assert.deepEqual(todoWidgetV1Schema.parse({ type: 'todo', version: 1, config: { listId: 'home' } }), {
    type: 'todo', version: 1, config: { listId: 'home' },
  });
  assert.equal(dashboardWidgetSchema.safeParse({ type: 'todo', version: 1, config: { listId: '' } }).success, true);
  assert.equal(dashboardWidgetSchema.safeParse({ type: 'todo', version: 1, config: { listId: 'BAD ID' } }).success, false);
  assert.equal(dashboardWidgetSchema.safeParse({ type: 'todo', version: 1, config: { listId: 'home', items: [] } }).success, false);
  assert.ok(widgetRegistry.todo[1]);
});

test('adding To Do uses the generic V3 envelope without a DeviceStore migration', () => {
  assert.equal(CURRENT_DEVICE_STORE_SCHEMA_VERSION, 3);
  const device = defaultDeviceV3('esp32-todo');
  device.dashboardSections[0] = { type: 'todo', version: 1, config: { listId: 'home' } };
  assert.equal(deviceRecordV3Schema.safeParse(device).success, true);

  const existing = defaultDeviceV3('esp32-existing');
  assert.equal(deviceRecordV3Schema.safeParse(existing).success, true, 'existing widget configurations remain valid');
});

test('To Do V2 discriminates local and HA providers without changing V1 or store versions', () => {
  for (const config of [{ provider: 'local', listId: 'home' }, { provider: 'home-assistant', entityId: 'todo.shopping_list' },
    { provider: 'home-assistant', entityId: '' }]) {
    const widget = { type: 'todo', version: 2, config };
    assert.deepEqual(dashboardWidgetSchema.parse(widget), widget);
    const mini = defaultDeviceV3('esp32-mini', 'ssd1681-200x200-mono');
    assert.ok(deviceRecordV3Schema.safeParse({ ...mini, dashboardSections: [widget] }).success);
  }
  for (const config of [{ provider: 'local', entityId: 'todo.home' }, { provider: 'home-assistant', listId: 'home' },
    { provider: 'home-assistant', entityId: 'todo.HOME' }, { provider: 'home-assistant', entityId: 'todo.a/evil' },
    { provider: 'home-assistant', entityId: 'sensor.home' }, { provider: 'other', listId: 'home' },
    { provider: 'local', listId: 'BAD ID' }, { provider: 'home-assistant', entityId: 'todo.home', token: 'secret' }]) {
    assert.equal(dashboardWidgetSchema.safeParse({ type: 'todo', version: 2, config }).success, false);
  }
  assert.equal(CURRENT_DEVICE_STORE_SCHEMA_VERSION, 3);
});
