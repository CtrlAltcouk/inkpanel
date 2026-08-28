import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DashboardEditorPreferencesStore,
  type DashboardEditorSlots,
} from '../../src/widgets/editorPreferences.ts';

function emptySlots(): DashboardEditorSlots {
  return [[], [], [], []];
}

test('personal To Do is remembered only for its panel while Calendar and Sensors remain shared', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-personal-prefs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'preferences.json');
  const store = new DashboardEditorPreferencesStore(path);
  const slots = emptySlots();
  slots[0] = [
    { type: 'todo', version: 3, config: { provider: 'home-assistant', ownerUserId: 'owner', entityId: 'todo.personal' } },
    { type: 'todo', version: 2, config: { provider: 'local', listId: 'home' } },
    { type: 'calendar', version: 2, config: { provider: 'home-assistant', entityIds: ['calendar.shared'] } },
    { type: 'entities', version: 1, config: { entityIds: ['sensor.shared'] } },
  ];
  await store.set('panel', slots);
  const loaded = new DashboardEditorPreferencesStore(path); await loaded.load();
  assert.deepEqual(loaded.get('panel').slots, slots);
  assert.deepEqual(loaded.get('other').shared, slots[0].slice(1));
});

test('Calendar V2 preferences preserve version and empty provider drafts never replace useful shared settings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-calendar-prefs-'));
  const path = join(dir, 'preferences.json');
  try {
    const store = new DashboardEditorPreferencesStore(path);
    const slots = emptySlots();
    slots[0] = [{ type: 'calendar', version: 1, config: { calendarUrls: ['https://example.com/feed'] } }];
    await store.set('p', slots);
    slots[0] = [{ type: 'calendar', version: 2, config: { provider: 'home-assistant', entityIds: [] } }];
    await store.set('p', slots);
    assert.equal(store.get('new').shared[0]!.version, 1);
    slots[0] = [{ type: 'calendar', version: 2, config: { provider: 'home-assistant', entityIds: ['calendar.home'] } }];
    await store.set('p', slots);
    const loaded = new DashboardEditorPreferencesStore(path); await loaded.load();
    assert.deepEqual(loaded.get('p').slots, slots);
    assert.deepEqual(loaded.get('new').shared[0], slots[0][0]);
    assert.deepEqual(loaded.get('new').shared[1]?.config, { calendarUrls: ['https://example.com/feed'] }, 'inactive iCal provider remains remembered');
    slots[0] = [{ type: 'calendar', version: 2, config: { provider: 'ical', calendarUrls: [] } }];
    await loaded.set('p', slots);
    assert.deepEqual(loaded.get('new').shared[0]!.config, { provider: 'home-assistant', entityIds: ['calendar.home'] });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('provider-specific To Do and Calendar drafts persist per-slot and as shared fallbacks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-provider-prefs-'));
  const path = join(dir, 'preferences.json');
  try {
    const store = new DashboardEditorPreferencesStore(path);
    const slots = emptySlots();
    slots[0] = [
      { type: 'todo', version: 2, config: { provider: 'home-assistant', entityId: 'todo.home' } },
      { type: 'todo', version: 1, config: { listId: 'local-home' } },
      { type: 'calendar', version: 2, config: { provider: 'home-assistant', entityIds: ['calendar.home'] } },
      { type: 'calendar', version: 1, config: { calendarUrls: ['https://example.com/feed'] } },
    ];
    await store.set('p', slots);
    const reloaded = new DashboardEditorPreferencesStore(path); await reloaded.load();
    assert.deepEqual(reloaded.get('p').slots, slots);
    assert.deepEqual(reloaded.get('other').shared, slots[0]);
    const duplicate = emptySlots();
    duplicate[0] = [slots[0][0]!, slots[0][0]!];
    await assert.rejects(store.set('p', duplicate), /duplicate remembered/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('remembered drafts persist per panel while useful values become shared fallbacks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-editor-prefs-'));
  const path = join(dir, '.dashboard-editor-preferences.json');
  try {
    const first = new DashboardEditorPreferencesStore(path);
    await first.load();
    const slots = emptySlots();
    slots[0] = [
      { type: 'calendar', version: 1, config: { calendarUrls: ['https://calendar.example/private.ics'] } },
      { type: 'bins', version: 1, config: { uprn: '25006645' } },
    ];
    slots[1] = [
      { type: 'trains', version: 1, config: { originCrs: '', destinationCrs: '' } },
      { type: 'octopus', version: 1, config: { tariffCode: 'E-1R-AGILE-24-10-01-C' } },
      { type: 'todo', version: 1, config: { listId: 'home' } },
      { type: 'printers', version: 1, config: { printerIds: ['11111111-1111-4111-8111-111111111111'] } },
    ];
    await first.set('esp32-a', slots);

    const own = first.get('esp32-a');
    assert.equal(own.slots[0][1]?.type, 'bins');
    assert.deepEqual(own.slots[0][1]?.config, { uprn: '25006645' });

    const other = first.get('esp32-b');
    assert.deepEqual(other.slots, [[], [], [], []]);
    assert.ok(other.shared.some((widget) => widget.type === 'calendar'));
    assert.ok(other.shared.some((widget) => widget.type === 'bins'));
    assert.ok(other.shared.some((widget) => widget.type === 'octopus'));
    assert.deepEqual(other.shared.find((widget) => widget.type === 'todo')?.config, { listId: 'home' });
    assert.deepEqual(other.shared.find((widget) => widget.type === 'printers')?.config, { printerIds: ['11111111-1111-4111-8111-111111111111'] });
    assert.equal(other.shared.some((widget) => widget.type === 'trains'), false, 'incomplete routes are not promoted as shared defaults');

    const reloaded = new DashboardEditorPreferencesStore(path);
    await reloaded.load();
    assert.deepEqual(reloaded.get('esp32-a'), own);

    if (process.platform !== 'win32') {
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    }
    const raw = await readFile(path, 'utf8');
    assert.match(raw, /25006645/);
    assert.match(raw, /calendar\.example/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('panel-specific remembered values do not overwrite another panel slot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-editor-prefs-isolation-'));
  const path = join(dir, '.dashboard-editor-preferences.json');
  try {
    const store = new DashboardEditorPreferencesStore(path);
    await store.load();
    const a = emptySlots();
    a[3] = [{ type: 'bins', version: 1, config: { uprn: '11111111' } }];
    const b = emptySlots();
    b[3] = [{ type: 'bins', version: 1, config: { uprn: '22222222' } }];
    await store.set('esp32-a', a);
    await store.set('esp32-b', b);

    assert.deepEqual(store.get('esp32-a').slots[3][0]?.config, { uprn: '11111111' });
    assert.deepEqual(store.get('esp32-b').slots[3][0]?.config, { uprn: '22222222' });
    const sharedBins = store.get('esp32-new').shared.find((widget) => widget.type === 'bins');
    assert.deepEqual(sharedBins?.config, { uprn: '22222222' }, 'most recently saved useful value is the new-panel fallback');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('corrupt remembered settings are preserved and reset without affecting device config', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-editor-prefs-corrupt-'));
  const path = join(dir, '.dashboard-editor-preferences.json');
  try {
    await writeFile(path, '{ definitely not json', 'utf8');
    const store = new DashboardEditorPreferencesStore(path);
    await store.load();
    assert.deepEqual(store.get('esp32-a'), { shared: [], slots: [[], [], [], []] });
    const entries = await import('node:fs/promises').then(({ readdir }) => readdir(dir));
    assert.ok(entries.some((name) => name.startsWith('.dashboard-editor-preferences.json.corrupt-')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
