import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  defaultDevice,
  DeviceStore,
  DeviceStoreError,
  type DeviceStoreErrorCode,
} from '../../src/devices/store.ts';
import {
  CURRENT_DEVICE_STORE_SCHEMA_VERSION,
  currentDeviceRecordSchema,
  defaultDeviceV1,
} from '../../src/devices/schema.ts';

async function withStore(fn: (store: DeviceStore, path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-dev-'));
  const path = join(dir, 'config.json');
  try {
    await fn(new DeviceStore(path), path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function expectStoreError(
  fn: () => Promise<unknown>,
  code: DeviceStoreErrorCode,
): Promise<DeviceStoreError> {
  let caught: unknown = null;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof DeviceStoreError, 'expected a DeviceStoreError');
  assert.equal(caught.code, code);
  return caught;
}

test('creates an unclaimed device on first sight', async () => {
  await withStore(async (store) => {
    const device = await store.getOrCreate('esp32-a1b2c3');
    assert.equal(device.id, 'esp32-a1b2c3');
    assert.equal(device.claimed, false);
    assert.equal(device.panelProfileId, 'wft0583-800x480-mono');
  });
});

test('returns the same record on second sight', async () => {
  await withStore(async (store) => {
    const first = await store.getOrCreate('esp32-a1b2c3');
    await store.update('esp32-a1b2c3', { name: 'Desk panel', claimed: true });
    const second = await store.getOrCreate('esp32-a1b2c3');
    assert.equal(second.name, 'Desk panel');
    assert.equal(second.claimed, true);
    assert.equal(second.id, first.id);
  });
});

test('persists across instances', async () => {
  await withStore(async (store, path) => {
    await store.getOrCreate('esp32-a1b2c3');
    await store.update('esp32-a1b2c3', { name: 'Kitchen' });
    const reopened = new DeviceStore(path);
    assert.equal((await reopened.get('esp32-a1b2c3'))?.name, 'Kitchen');
  });
});

test('writes valid JSON atomically', async () => {
  await withStore(async (store, path) => {
    await store.getOrCreate('esp32-a1b2c3');
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(parsed.schemaVersion, CURRENT_DEVICE_STORE_SCHEMA_VERSION);
    assert.ok(Array.isArray(parsed.devices));
  });
});

test('returns null for an unknown device without creating it', async () => {
  await withStore(async (store) => {
    assert.equal(await store.get('nope'), null);
    assert.deepEqual(await store.list(), []);
  });
});

test('rejects updates to unknown devices', async () => {
  await withStore(async (store) => {
    await assert.rejects(() => store.update('ghost', { name: 'x' }), /unknown device/i);
  });
});

test('serialises concurrent writes without losing one', async () => {
  await withStore(async (store) => {
    await store.getOrCreate('aa');
    await store.getOrCreate('bb');
    await Promise.all([
      store.update('aa', { name: 'Alpha' }),
      store.update('bb', { name: 'Bravo' }),
    ]);
    assert.equal((await store.get('aa'))?.name, 'Alpha');
    assert.equal((await store.get('bb'))?.name, 'Bravo');
  });
});

test('concurrent getOrCreate for the same id creates only one record', async () => {
  await withStore(async (store) => {
    await Promise.all([
      store.getOrCreate('esp32-race'),
      store.getOrCreate('esp32-race'),
      store.getOrCreate('esp32-race'),
    ]);
    const all = await store.list();
    assert.equal(all.length, 1, 'a device that wakes twice must not be duplicated');
  });
});

test('concurrent getOrCreateWithStatus reports exactly one creation', async () => {
  await withStore(async (store) => {
    const results = await Promise.all([
      store.getOrCreateWithStatus('esp32-a1b2c3'),
      store.getOrCreateWithStatus('esp32-a1b2c3'),
      store.getOrCreateWithStatus('esp32-a1b2c3'),
    ]);
    assert.equal(results.filter(({ created }) => created).length, 1);
    assert.equal(results.filter(({ created }) => !created).length, 2);
    assert.equal((await store.list()).length, 1);
  });
});

test('id cannot be overwritten by a patch', async () => {
  await withStore(async (store) => {
    await store.getOrCreate('esp32-a1b2c3');
    const updated = await store.update('esp32-a1b2c3', { id: 'hijacked' } as never);
    assert.equal(updated.id, 'esp32-a1b2c3');
  });
});

test('corrupt config is preserved and can never be overwritten by a later mutation', async () => {
  await withStore(async (store, path) => {
    await store.getOrCreate('esp32-a1b2c3');

    const corrupt = '{ not json';
    await writeFile(path, corrupt, 'utf8');
    const reopened = new DeviceStore(path);

    const readError = await expectStoreError(() => reopened.list(), 'config_corrupt');
    assert.ok(readError.backupPath, 'a diagnostic copy should be preserved when possible');
    assert.equal(await readFile(path, 'utf8'), corrupt, 'the original corrupt bytes stay in place');
    assert.equal(await readFile(readError.backupPath!, 'utf8'), corrupt, 'backup is an exact copy');

    await expectStoreError(() => reopened.getOrCreate('esp32-new'), 'config_corrupt');
    assert.equal(
      await readFile(path, 'utf8'),
      corrupt,
      'getOrCreate must fail before it can replace a corrupt store with an empty-derived one',
    );

    const backupPrefix = `${basename(path)}.corrupt-`;
    const backups = (await readdir(dirname(path))).filter((name) => name.startsWith(backupPrefix));
    assert.equal(backups.length, 1, 're-reading identical corruption must not create backup spam');
  });
});

test('valid JSON with an invalid top-level store shape also fails closed', async () => {
  await withStore(async (_store, path) => {
    const malformed = JSON.stringify({ devices: 'not-an-array' });
    await writeFile(path, malformed, 'utf8');

    const reopened = new DeviceStore(path);
    const err = await expectStoreError(() => reopened.list(), 'config_corrupt');
    assert.match(err.message, /devices.*array/i);
    assert.equal(await readFile(path, 'utf8'), malformed);
  });
});

test('non-ENOENT filesystem read failures are not disguised as a new installation', async () => {
  await withStore(async (_store, path) => {
    await mkdir(path);
    const reopened = new DeviceStore(path);
    const err = await expectStoreError(() => reopened.list(), 'config_io');
    assert.equal(err.backupPath, null);
  });
});

test('new devices carry the Spec 2a fields with safe defaults', async () => {
  await withStore(async (store) => {
    const device = await store.getOrCreate('esp32-new');
    assert.equal(device.locationLabel, '');
    assert.equal(device.lastWakeSeconds, null);
  });
});

test('new devices start with the migrated four-section dashboard', async () => {
  await withStore(async (store) => {
    const device = await store.getOrCreate('esp32-new');
    assert.deepEqual(device.dashboardSections.map((section) => section.type), ['calendar', 'weather', 'trains', 'bins']);
    assert.deepEqual(device.dashboardSections[2], { type: 'trains', version: 1, config: { originCrs: '', destinationCrs: '' } });
    assert.deepEqual(device.dashboardSections[3], { type: 'bins', version: 1, config: { uprn: '' } });
  });
});

test('current runtime defaults are explicit and return independent section configs', () => {
  const first = defaultDevice('default-a');
  const second = defaultDevice('default-b');
  assert.equal('calendarUrls' in first, false, 'runtime defaults use the widget-envelope shape, not historical V1 fields');
  assert.deepEqual(first.dashboardSections.map((section) => section.type), ['calendar', 'weather', 'trains', 'bins']);
  if (first.dashboardSections[0].type === 'calendar') {
    first.dashboardSections[0].config.calendarUrls.push('https://example.com/a.ics');
  }
  assert.deepEqual(second.dashboardSections[0], {
    type: 'calendar', version: 1, config: { calendarUrls: [] },
  }, 'one device cannot mutate the shared default layout for another');
});

test('a minimal legacy config migrates in memory to a complete current record', async () => {
  await withStore(async (_store, path) => {
    await writeFile(path, JSON.stringify({
      devices: [{ id: 'esp32-old', name: 'Old panel', claimed: true }],
    }), 'utf8');

    const reopened = new DeviceStore(path);
    const device = await reopened.get('esp32-old');
    assert.equal(device?.name, 'Old panel', 'existing data survives');
    assert.equal(device?.claimed, true, 'existing boolean configuration survives');
    assert.equal(device?.locationLabel, '', 'missing fields receive current defaults');
    assert.equal(device?.lastWakeSeconds, null);
    assert.deepEqual(
      Object.keys(device!).sort(),
      Object.keys(defaultDevice('esp32-old')).sort(),
      'every current DeviceRecord field is populated',
    );
    assert.equal(currentDeviceRecordSchema.safeParse(device).success, true);
  });
});

test('a complete V1 store migrates in memory without rewriting the file', async () => {
  await withStore(async (_store, path) => {
    const device = {
      ...defaultDeviceV1('esp32-current'),
      name: 'Kitchen panel',
      claimed: true,
      latitude: 51.5074,
      longitude: -0.1278,
      calendarUrls: ['https://example.com/calendar.ics'],
    };
    const original = JSON.stringify({ schemaVersion: 1, devices: [device] }, null, 2);
    await writeFile(path, original, 'utf8');

    const reopened = new DeviceStore(path);
    const [migrated] = await reopened.list();
    assert.equal(migrated?.name, device.name);
    assert.deepEqual(migrated?.dashboardSections[0], { type: 'calendar', version: 1, config: { calendarUrls: device.calendarUrls } });
    assert.equal(await readFile(path, 'utf8'), original, 'a read does not rewrite current config');
  });
});

test('an incomplete V1 record fails closed instead of receiving legacy defaults', async () => {
  await withStore(async (_store, path) => {
    const original = JSON.stringify({
      schemaVersion: 1,
      devices: [{ id: 'esp32-incomplete', name: 'Incomplete', claimed: false }],
    });
    await writeFile(path, original, 'utf8');

    const reopened = new DeviceStore(path);
    await expectStoreError(() => reopened.list(), 'config_corrupt');
    assert.equal(await readFile(path, 'utf8'), original);
  });
});

test('legacy migration preserves explicit user configuration and defaults only missing fields', async () => {
  await withStore(async (_store, path) => {
    const original = JSON.stringify({
      devices: [{
        id: 'esp32-legacy',
        name: 'Hallway',
        claimed: true,
        latitude: 40.7128,
        longitude: -74.006,
        calendarUrls: ['https://example.com/home.ics'],
      }],
    });
    await writeFile(path, original, 'utf8');

    const reopened = new DeviceStore(path);
    const device = await reopened.get('esp32-legacy');
    assert.equal(device?.name, 'Hallway');
    assert.equal(device?.claimed, true);
    assert.equal(device?.latitude, 40.7128);
    assert.equal(device?.longitude, -74.006);
    assert.deepEqual(device?.dashboardSections[0], { type: 'calendar', version: 1, config: { calendarUrls: ['https://example.com/home.ics'] } });
    assert.equal(device?.activeIntervalSeconds, 900);
    assert.equal(await readFile(path, 'utf8'), original, 'migration during reads is in memory');

    await reopened.update('esp32-legacy', { name: 'Updated hallway' });
    const persisted = JSON.parse(await readFile(path, 'utf8')) as {
      schemaVersion: number;
      devices: unknown[];
    };
    assert.equal(persisted.schemaVersion, CURRENT_DEVICE_STORE_SCHEMA_VERSION);
    assert.equal(currentDeviceRecordSchema.safeParse(persisted.devices[0]).success, true);
  });
});

test('an explicitly invalid legacy value fails instead of being defaulted', async () => {
  await withStore(async (_store, path) => {
    const original = JSON.stringify({
      devices: [{ id: 'esp32-invalid', activeIntervalSeconds: 'invalid' }],
    });
    await writeFile(path, original, 'utf8');

    const reopened = new DeviceStore(path);
    await expectStoreError(() => reopened.list(), 'config_corrupt');
    await expectStoreError(() => reopened.getOrCreate('esp32-new'), 'config_corrupt');
    assert.equal(await readFile(path, 'utf8'), original);
  });
});

test('duplicate device ids fail closed', async () => {
  await withStore(async (_store, path) => {
    const original = JSON.stringify({
      devices: [{ id: 'esp32-duplicate' }, { id: 'esp32-duplicate' }],
    });
    await writeFile(path, original, 'utf8');

    const reopened = new DeviceStore(path);
    const err = await expectStoreError(() => reopened.list(), 'config_corrupt');
    assert.match(err.message, /duplicate device id/i);
    assert.equal(await readFile(path, 'utf8'), original);
  });
});

test('invalid persisted IANA timezone fails closed', async () => {
  await withStore(async (_store, path) => {
    const original = JSON.stringify({
      schemaVersion: 2,
      devices: [{ ...defaultDevice('esp32-timezone'), timezone: 'Not/A_Timezone' }],
    });
    await writeFile(path, original, 'utf8');

    const reopened = new DeviceStore(path);
    const err = await expectStoreError(() => reopened.list(), 'config_corrupt');
    assert.match(err.message, /IANA timezone/i);
    assert.equal(await readFile(path, 'utf8'), original);
  });
});

for (const [description, sections] of [
  ['fewer than four sections', defaultDevice('esp32-layout').dashboardSections.slice(0, 3)],
  ['more than four sections', [...defaultDevice('esp32-layout').dashboardSections, { type: 'empty', version: 1, config: {} }]],
  ['an unknown widget type', [{ type: 'future-widget', version: 1, config: {} }, ...defaultDevice('esp32-layout').dashboardSections.slice(1)]],
  ['an unsupported widget version', [{ type: 'calendar', version: 2, config: { calendarUrls: [] } }, ...defaultDevice('esp32-layout').dashboardSections.slice(1)]],
  ['a malformed strict widget config', [{ type: 'calendar', version: 1, config: { calendarUrls: [], extra: true } }, ...defaultDevice('esp32-layout').dashboardSections.slice(1)]],
] as const) {
  test(`${description} fails closed and preserves the original bytes`, async () => {
    await withStore(async (_store, path) => {
      const record = { ...defaultDevice('esp32-layout'), dashboardSections: sections };
      const original = JSON.stringify({ schemaVersion: 2, devices: [record] });
      await writeFile(path, original, 'utf8');
      await expectStoreError(() => new DeviceStore(path).list(), 'config_corrupt');
      assert.equal(await readFile(path, 'utf8'), original);
    });
  });
}

test('a future schema version is unsupported and remains byte-for-byte unchanged', async () => {
  await withStore(async (_store, path) => {
    const original = `${JSON.stringify({
      schemaVersion: CURRENT_DEVICE_STORE_SCHEMA_VERSION + 1,
      devices: [],
      futureFeature: true,
    })}\n`;
    await writeFile(path, original, 'utf8');

    const reopened = new DeviceStore(path);
    const err = await expectStoreError(() => reopened.list(), 'config_unsupported_version');
    assert.match(err.message, /newer InkPanel version/i);
    await expectStoreError(
      () => reopened.getOrCreate('esp32-new'),
      'config_unsupported_version',
    );
    assert.equal(await readFile(path, 'utf8'), original);
  });
});

test('an invalid prospective record is never committed', async () => {
  await withStore(async (store, path) => {
    await store.getOrCreate('esp32-safe');
    const original = await readFile(path, 'utf8');

    await expectStoreError(
      () => store.update('esp32-safe', { timezone: 'Definitely/Invalid' }),
      'config_invalid',
    );
    assert.equal(await readFile(path, 'utf8'), original);
  });
});
