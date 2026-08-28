import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dashboardWidgetSchema } from '../../src/widgets/registry.ts';
import { DeviceStore } from '../../src/devices/store.ts';
import { CURRENT_DEVICE_STORE_SCHEMA_VERSION } from '../../src/devices/schema.ts';
import { DashboardEditorPreferencesStore } from '../../src/widgets/editorPreferences.ts';

const widget = (entityIds: string[]) => ({ type: 'entities' as const, version: 1 as const, config: { entityIds } });

test('entities V1 validates zero to four ordered, unique sensor IDs without existence checks', () => {
  for (const ids of [[], ['sensor.missing'], ['sensor.d', 'sensor.a', 'sensor.b', 'sensor.c']]) {
    assert.deepEqual(dashboardWidgetSchema.parse(widget(ids)), widget(ids));
  }
  for (const ids of [['sensor.a', 'sensor.a'], ['sensor.a', 'sensor.b', 'sensor.c', 'sensor.d', 'sensor.e'], ['binary_sensor.a'], ['sensor.A'], ['sensor.a/path'], ['sensor.'], [`sensor.${'a'.repeat(250)}`]]) {
    assert.equal(dashboardWidgetSchema.safeParse(widget(ids)).success, false);
  }
  assert.equal(dashboardWidgetSchema.safeParse({ ...widget([]), version: 2 }).success, false);
  assert.equal(dashboardWidgetSchema.safeParse({ ...widget([]), config: { entityIds: [], extra: true } }).success, false);
});

test('Sensors persist on both profiles without migration and participate in slot/shared remembered settings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-entities-store-'));
  try {
    const file = join(dir, 'config.json');
    const store = new DeviceStore(file);
    const sensors = widget(['sensor.removed_b', 'sensor.removed_a']);
    for (const profile of ['wft0583-800x480-mono', 'ssd1681-200x200-mono'] as const) {
      const device = await store.getOrCreate(profile, profile);
      device.dashboardSections[0] = sensors;
      await store.update(device.id, { dashboardSections: device.dashboardSections });
      const reopened = await new DeviceStore(file).get(device.id);
      assert.deepEqual(reopened!.dashboardSections[0], sensors);
      assert.equal(JSON.parse(await readFile(file, 'utf8')).schemaVersion, CURRENT_DEVICE_STORE_SCHEMA_VERSION);
    }
    const preferencesFile = join(dir, 'preferences.json');
    const preferences = new DashboardEditorPreferencesStore(preferencesFile);
    await preferences.set('panel', [[sensors, { type: 'weather', version: 1, config: {} }], [], [], []]);
    const reopened = new DashboardEditorPreferencesStore(preferencesFile);
    await reopened.load();
    assert.deepEqual(reopened.get('panel').slots[0]![0], sensors);
    assert.deepEqual(reopened.get('other-panel').shared.find((item) => item.type === 'entities'), sensors);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
