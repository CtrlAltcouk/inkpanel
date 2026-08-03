import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceStore } from '../../src/devices/store.ts';

async function withStore(fn: (store: DeviceStore, path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-dev-'));
  const path = join(dir, 'config.json');
  try {
    await fn(new DeviceStore(path), path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

test('a corrupt config file is treated as empty rather than throwing', async () => {
  await withStore(async (store, path) => {
    await store.getOrCreate('esp32-a1b2c3');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, '{ not json', 'utf8');
    const reopened = new DeviceStore(path);
    assert.deepEqual(await reopened.list(), [], 'must not crash the server on startup');
  });
});
