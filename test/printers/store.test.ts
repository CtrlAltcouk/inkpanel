import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrinterConnectionStore, PrinterStoreError } from '../../src/printers/store.ts';

async function withStore(fn: (store: PrinterConnectionStore, path: string, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-printers-'));
  const path = join(dir, '.printer-connections.json');
  try { await fn(new PrinterConnectionStore(path), path, dir); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

test('printer CRUD normalizes URLs, keeps stable IDs, and writes atomically at 0600', async () => {
  await withStore(async (store, path) => {
    assert.deepEqual(await store.list(), []);
    await assert.rejects(() => access(path));
    const created = await store.create({ name: 'Voron 2.4', baseUrl: 'http://192.168.1.50///', apiKey: 'secret' });
    assert.match(created.id, /^[a-f0-9-]{36}$/);
    assert.equal(created.baseUrl, 'http://192.168.1.50');
    await store.update(created.id, { name: 'Voron' });
    const reopened = new PrinterConnectionStore(path);
    assert.deepEqual(await reopened.get(created.id), { ...created, name: 'Voron' });
    if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
    await assert.rejects(() => access(`${path}.tmp`));
    await reopened.delete(created.id);
    assert.deepEqual(await reopened.list(), []);
  });
});

test('API keys can be preserved, replaced, and explicitly cleared', async () => {
  await withStore(async (store) => {
    const printer = await store.create({ name: 'Mini', baseUrl: 'https://printer.local', apiKey: 'first' });
    assert.equal((await store.update(printer.id, { name: 'Mini MK2' })).apiKey, 'first');
    assert.equal((await store.update(printer.id, { apiKey: 'second' })).apiKey, 'second');
    assert.equal((await store.update(printer.id, { apiKey: null })).apiKey, null);
    assert.deepEqual(await store.listPublic(), [{ id: printer.id, name: 'Mini MK2', baseUrl: 'https://printer.local', apiKeyConfigured: false }]);
  });
});

test('invalid URLs, embedded credentials, duplicate names, and capacity fail closed', async () => {
  await withStore(async (store) => {
    await assert.rejects(() => store.create({ name: 'Bad', baseUrl: 'ftp://printer.local' }), /HTTP or HTTPS/);
    await assert.rejects(() => store.create({ name: 'Bad', baseUrl: 'http://user:pass@printer.local' }), /must not contain credentials/);
    await store.create({ name: 'Voron', baseUrl: 'http://voron.local' });
    await assert.rejects(() => store.create({ name: ' voron ', baseUrl: 'http://other.local' }), (err: unknown) => err instanceof PrinterStoreError && err.code === 'printer_conflict');
    for (let index = 1; index < 20; index += 1) await store.create({ name: `Printer ${index}`, baseUrl: `http://printer-${index}.local` });
    await assert.rejects(() => store.create({ name: 'Too many', baseUrl: 'http://extra.local' }), /at most 20/);
  });
});

test('concurrent mutations are serialized without losing printers', async () => {
  await withStore(async (store) => {
    await Promise.all(['One', 'Two', 'Three'].map((name, index) => store.create({ name, baseUrl: `http://printer-${index}.local` })));
    assert.deepEqual((await store.list()).map((printer) => printer.name), ['One', 'Two', 'Three']);
  });
});

test('corrupt JSON and invalid schemas are preserved and never silently reset', async () => {
  for (const raw of ['{ bad json', JSON.stringify({ schemaVersion: 1, printers: [{ id: 'bad' }] })]) {
    await withStore(async (store, path, dir) => {
      await writeFile(path, raw, 'utf8');
      await assert.rejects(() => store.list(), (err: unknown) => err instanceof PrinterStoreError && err.code === 'printer_corrupt');
      assert.equal(await readFile(path, 'utf8'), raw);
      assert.ok((await readdir(dir)).some((name) => name.startsWith('.printer-connections.json.corrupt-')));
      await assert.rejects(() => store.create({ name: 'No reset', baseUrl: 'http://printer.local' }));
      assert.equal(await readFile(path, 'utf8'), raw);
    });
  }
});
