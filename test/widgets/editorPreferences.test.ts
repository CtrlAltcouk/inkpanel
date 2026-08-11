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
