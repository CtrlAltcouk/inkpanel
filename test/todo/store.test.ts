import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TodoStore, TodoStoreError } from '../../src/todo/store.ts';

async function withStore(fn: (store: TodoStore, path: string, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-todo-'));
  const path = join(dir, '.todo-lists.json');
  try {
    await fn(new TodoStore(path), path, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('reads do not create storage and list CRUD persists stable IDs', async () => {
  await withStore(async (store, path) => {
    assert.deepEqual(await store.list(), []);
    await assert.rejects(() => access(path));

    const home = await store.create('Home');
    assert.match(home.id, /^[a-f0-9-]{36}$/);
    await store.rename(home.id, 'Household');

    const reopened = new TodoStore(path);
    assert.deepEqual((await reopened.list()).map(({ id, name }) => ({ id, name })), [
      { id: home.id, name: 'Household' },
    ]);

    await reopened.delete(home.id);
    assert.deepEqual(await reopened.list(), []);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).schemaVersion, 1);
    await assert.rejects(() => access(`${path}.tmp`));
  });
});

test('tasks retain array order and completed state across updates and reloads', async () => {
  await withStore(async (store, path) => {
    const list = await store.create('Workshop');
    const first = await store.addItem(list.id, 'Order filament');
    const second = await store.addItem(list.id, 'Charge batteries');
    await store.updateItem(list.id, first.id, { text: 'Order black filament', completed: true });
    await store.reorderItems(list.id, [second.id, first.id]);

    const reopened = new TodoStore(path);
    assert.deepEqual((await reopened.get(list.id))?.items, [
      { id: second.id, text: 'Charge batteries', completed: false },
      { id: first.id, text: 'Order black filament', completed: true },
    ]);

    await reopened.deleteItem(list.id, second.id);
    assert.deepEqual((await reopened.get(list.id))?.items.map((item) => item.id), [first.id]);
  });
});

test('serialized concurrent mutations do not lose tasks', async () => {
  await withStore(async (store) => {
    const list = await store.create('Home');
    await Promise.all(['One', 'Two', 'Three', 'Four'].map((text) => store.addItem(list.id, text)));
    assert.deepEqual((await store.get(list.id))?.items.map((item) => item.text), ['One', 'Two', 'Three', 'Four']);
  });
});

test('invalid IDs, duplicate names, stale IDs, and incomplete reorders fail closed', async () => {
  await withStore(async (store) => {
    const list = await store.create('Home');
    const item = await store.addItem(list.id, 'Buy milk');
    await assert.rejects(() => store.create(' home '), (err: unknown) => err instanceof TodoStoreError && err.code === 'todo_conflict');
    await assert.rejects(() => store.addItem('Missing List!', 'No'), /invalid To Do list id/);
    await assert.rejects(() => store.updateItem(list.id, 'not-an-item-id', { completed: true }), /invalid To Do item id/);
    await assert.rejects(() => store.updateItem('missing', item.id, { completed: true }), (err: unknown) => err instanceof TodoStoreError && err.code === 'todo_not_found');
    await assert.rejects(() => store.reorderItems(list.id, []), (err: unknown) => err instanceof TodoStoreError && err.code === 'todo_conflict');
    assert.deepEqual((await store.get(list.id))?.items.map((candidate) => candidate.id), [item.id]);
  });
});

test('corrupt JSON and invalid schemas are preserved without write-on-read recovery', async () => {
  for (const raw of [
    '{ definitely not json',
    JSON.stringify({ schemaVersion: 1, lists: [{ id: 'BAD ID', name: 'Home', items: [] }] }),
  ]) {
    await withStore(async (store, path, dir) => {
      await writeFile(path, raw, 'utf8');
      await assert.rejects(() => store.list(), (err: unknown) => err instanceof TodoStoreError && err.code === 'todo_corrupt');
      assert.equal(await readFile(path, 'utf8'), raw);
      assert.ok((await readdir(dir)).some((name) => name.startsWith('.todo-lists.json.corrupt-')));
      await assert.rejects(() => store.create('Must not overwrite'));
      assert.equal(await readFile(path, 'utf8'), raw);
    });
  }
});
