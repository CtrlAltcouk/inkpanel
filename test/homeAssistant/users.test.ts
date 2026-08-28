import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, stat, rm, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseIngressUser } from '../../src/homeAssistant/ingressUser.ts';
import { HomeAssistantUserStore, homeAssistantUsersV1Schema } from '../../src/homeAssistant/userStore.ts';

const chris = { id: 'id-chris', username: 'chris', displayName: 'Chris' };
test('central identity parser rejects missing, malformed, duplicate and control headers; LAN ignores all headers', () => {
  const headers = { 'x-remote-user-id': chris.id, 'x-remote-user-name': ' chris ', 'x-remote-user-display-name': ' Chris ' };
  assert.deepEqual(parseIngressUser({ headers }, true), chris);
  assert.equal(parseIngressUser({ headers }, false), null);
  for (const id of [undefined, '', ' ', ' x', 'x\n', 'x\u007f', 'x\u0085', 'a'.repeat(129), ['one', 'two']]) {
    assert.equal(parseIngressUser({ headers: { ...headers, 'x-remote-user-id': id } }, true), null);
  }
  for (const name of ['x\t', 'x'.repeat(257), ['one', 'two']]) {
    assert.equal(parseIngressUser({ headers: { ...headers, 'x-remote-user-name': name } }, true), null);
  }
});

test('ownership persists atomically, refreshes metadata by ID only and supports stale mapping removal', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-users-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, '.home-assistant-users.json');
  const store = new HomeAssistantUserStore(path);
  assert.deepEqual(await store.list(), []);
  await store.observe(chris);
  await store.assign(chris.id, ['todo.chris', 'todo.removed']);
  await store.observe({ ...chris, username: 'new-name', displayName: 'New name' });
  await store.observe({ id: 'new-id', username: 'chris', displayName: 'Chris' });
  assert.equal(await store.assigned(chris.id, 'todo.removed'), true, 'missing entities remain assigned');
  assert.equal(await store.assigned('new-id', 'todo.chris'), false, 'reused names never inherit');
  const restarted = new HomeAssistantUserStore(path);
  assert.deepEqual(await restarted.list(), [
    { userId: chris.id, username: 'new-name', displayName: 'New name', todoEntityIds: ['todo.chris', 'todo.removed'] },
    { userId: 'new-id', username: 'chris', displayName: 'Chris', todoEntityIds: [] },
  ]);
  const original = await readFile(path, 'utf8');
  await assert.rejects(store.assign('new-id', ['todo.chris']), /duplicate/);
  await assert.rejects(store.assign(chris.id, ['todo.chris', 'todo.chris']));
  await assert.rejects(store.assign('unknown', []), /Unknown/);
  assert.equal(await readFile(path, 'utf8'), original);
  assert.deepEqual(await readdir(dir), ['.home-assistant-users.json']);
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
  await store.remove(chris.id);
  assert.equal(await restarted.assigned(chris.id, 'todo.chris'), false);
  await store.assign('new-id', ['todo.chris']);
  assert.equal(await restarted.assigned('new-id', 'todo.chris'), true);
});

test('concurrent observations and assignments retain every successful mutation', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-users-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new HomeAssistantUserStore(join(dir, 'users.json'));
  await Promise.all(Array.from({ length: 15 }, (_, index) => store.observe({ ...chris, id: `user-${index}` })));
  await Promise.all(Array.from({ length: 15 }, (_, index) => store.assign(`user-${index}`, [`todo.user_${index}`])));
  assert.equal((await store.list()).length, 15);
  assert.equal((await readdir(dir)).length, 1);
});

test('invalid JSON/schema remains untouched, backed up, and cannot be reset by registration', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-users-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'users.json');
  const store = new HomeAssistantUserStore(path);
  for (const raw of ['{bad', JSON.stringify({ version: 2, users: [] }), JSON.stringify({ version: 1, users: [{ userId: chris.id, username: null, displayName: null, todoEntityIds: ['sensor.bad'] }] })]) {
    await writeFile(path, raw);
    await assert.rejects(store.observe(chris), /original left untouched/);
    await assert.rejects(store.assigned(chris.id, 'todo.chris'));
    assert.equal(await readFile(path, 'utf8'), raw);
    const backups = (await readdir(dir)).filter((name) => name.includes('.corrupt-'));
    assert.ok((await Promise.all(backups.map((name) => readFile(join(dir, name), 'utf8')))).includes(raw));
  }
});

test('strict ownership format rejects duplicate users, cross-user lists, secrets and contents', () => {
  const user = { userId: chris.id, username: null, displayName: null, todoEntityIds: ['todo.chris'] };
  for (const users of [[user, user], [user, { ...user, userId: 'different' }], [{ ...user, token: 'secret' }], [{ ...user, items: ['private'] }]]) {
    assert.equal(homeAssistantUsersV1Schema.safeParse({ version: 1, users }).success, false);
  }
});

test('unreadable ownership pathname fails closed without altering the existing directory', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-users-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'users.json');
  await mkdir(path);
  await assert.rejects(new HomeAssistantUserStore(path).observe(chris), /unavailable/);
  assert.deepEqual(await readdir(dir), ['users.json']);
});

test('Linux write failure preserves the committed file and later mutation can retry', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-users-write-'));
  t.after(async () => { await chmod(dir, 0o700); await rm(dir, { recursive: true, force: true }); });
  const path = join(dir, 'users.json');
  const store = new HomeAssistantUserStore(path);
  await store.observe(chris);
  const original = await readFile(path, 'utf8');
  await chmod(dir, 0o500);
  await assert.rejects(store.assign(chris.id, ['todo.chris']), /Could not commit/);
  assert.equal(await readFile(path, 'utf8'), original);
  assert.deepEqual(await readdir(dir), ['users.json']);
  await chmod(dir, 0o700);
  await store.assign(chris.id, ['todo.chris']);
  assert.equal(await store.assigned(chris.id, 'todo.chris'), true, 'write queue is not poisoned');
});
