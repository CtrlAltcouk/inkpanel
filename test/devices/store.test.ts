import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DeviceStore, DeviceStoreError, type DeviceStoreErrorCode } from '../../src/devices/store.ts';

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
    await store.getOrCreate('a');
    await store.getOrCreate('b');
    await Promise.all([
      store.update('a', { name: 'Alpha' }),
      store.update('b', { name: 'Bravo' }),
    ]);
    assert.equal((await store.get('a'))?.name, 'Alpha');
    assert.equal((await store.get('b'))?.name, 'Bravo');
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
    assert.match(err.message, /devices array/i);
    assert.equal(await readFile(path, 'utf8'), malformed);
  });
});

test('non-ENOENT filesystem read failures are not disguised as a new installation', async () => {
  await withStore(async (_store, path) => {
    // A directory at the config-file path reliably makes readFile fail on the
    // Linux environment used by CI without relying on chmod/root semantics.
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

test('new devices start with no route configured', async () => {
  await withStore(async (store) => {
    const device = await store.getOrCreate('esp32-new');
    assert.equal(device.trainOriginCrs, '');
    assert.equal(device.trainDestinationCrs, '');
  });
});

test('new devices start with no UPRN configured', async () => {
  await withStore(async (store) => {
    assert.equal((await store.getOrCreate('esp32-new')).binsUprn, '');
  });
});

test('a config file written before Spec 2a still loads', async () => {
  await withStore(async (_store, path) => {
    // A record with none of the new fields, as Spec 1 would have written it.
    await writeFile(path, JSON.stringify({
      devices: [{ id: 'esp32-old', name: 'Old panel', claimed: true }],
    }), 'utf8');

    const reopened = new DeviceStore(path);
    const device = await reopened.get('esp32-old');
    assert.equal(device?.name, 'Old panel', 'existing data survives');
    // Missing fields read as undefined for now. The next backlog item adds the
    // explicit schema/version migration layer that fills these defaults.
    assert.equal(device?.locationLabel, undefined);
    assert.equal(device?.lastWakeSeconds, undefined);
  });
});
