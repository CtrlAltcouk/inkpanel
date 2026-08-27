import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/http/app.ts';
import { DeviceStore } from '../../src/devices/store.ts';
import type { FrameService } from '../../src/render/frameService.ts';
import { TodoStore } from '../../src/todo/store.ts';

const frames = {
  warmUp: async () => {}, sourceIssues: () => [], renderedDeviceCount: () => 0,
} as unknown as FrameService;

async function withServer(fn: (base: string, cookie: string, devices: DeviceStore, todos: TodoStore) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-todo-http-'));
  const devices = new DeviceStore(join(dir, 'config.json'));
  const todos = new TodoStore(join(dir, '.todo-lists.json'));
  const server = createApp({
    store: devices, frames, todoStore: todos,
    publicBaseUrl: 'http://test.local:8080', runtimeState: { httpsPort: null },
    dataDir: dir, firmwareDir: dir,
    auth: { password: 'hunter2', secret: randomBytes(32) },
  }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'hunter2' }),
    });
    const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
    await fn(base, cookie, devices, todos);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function request(base: string, cookie: string, method: string, path: string, body?: unknown) {
  return fetch(`${base}${path}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('To Do management CRUD is authenticated and preserves task order/completion', async () => {
  await withServer(async (base, cookie) => {
    assert.equal((await fetch(`${base}/api/todo-lists`)).status, 401);

    const createdResponse = await request(base, cookie, 'POST', '/api/todo-lists', { name: 'Home' });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as { id: string };

    const first = await (await request(base, cookie, 'POST', `/api/todo-lists/${created.id}/items`, { text: 'Put bins out' })).json() as { id: string };
    const second = await (await request(base, cookie, 'POST', `/api/todo-lists/${created.id}/items`, { text: 'Buy milk' })).json() as { id: string };
    assert.equal((await request(base, cookie, 'PUT', `/api/todo-lists/${created.id}/items/${first.id}`, { completed: true, text: 'Put both bins out' })).status, 200);
    assert.equal((await request(base, cookie, 'PUT', `/api/todo-lists/${created.id}/items/order`, { itemIds: [second.id, first.id] })).status, 200);
    assert.equal((await request(base, cookie, 'PUT', `/api/todo-lists/${created.id}`, { name: 'Household' })).status, 200);

    const body = await (await request(base, cookie, 'GET', '/api/todo-lists')).json() as { lists: Array<{ name: string; items: Array<{ text: string; completed: boolean }> }> };
    assert.equal(body.lists[0]?.name, 'Household');
    assert.deepEqual(body.lists[0]?.items.map((item) => [item.text, item.completed]), [
      ['Buy milk', false], ['Put both bins out', true],
    ]);

    assert.equal((await request(base, cookie, 'DELETE', `/api/todo-lists/${created.id}/items/${first.id}`)).status, 204);
    assert.equal((await request(base, cookie, 'DELETE', `/api/todo-lists/${created.id}`)).status, 204);
  });
});

test('V2 local saves validate list existence; HA IDs persist offline without migrating V1', async () => {
  await withServer(async (base, cookie, devices, todos) => {
    assert.equal((await fetch(`${base}/api/home-assistant/todo-lists`)).status, 401);
    assert.deepEqual(await (await request(base, cookie, 'GET', '/api/home-assistant/todo-lists')).json(), {
      supported: false, available: false, lists: [], error: null,
    });
    const device = await devices.getOrCreate('esp32-provider', 'ssd1681-200x200-mono');
    const list = await todos.create('Home');
    const save = (widget: unknown) => request(base, cookie, 'PUT', `/api/devices/${device.id}`, { dashboardSections: [widget] });
    const local = { type: 'todo', version: 2, config: { provider: 'local', listId: list.id } };
    assert.equal((await save({ ...local, config: { provider: 'local', listId: 'missing' } })).status, 400);
    assert.equal((await save(local)).status, 200);
    assert.equal((await request(base, cookie, 'DELETE', `/api/todo-lists/${list.id}`)).status, 409);
    const ha = { type: 'todo', version: 2, config: { provider: 'home-assistant', entityId: 'todo.removed' } };
    assert.equal((await save(ha)).status, 200, 'syntax is sufficient; discovery need not be available');
    assert.deepEqual((await devices.get(device.id))?.dashboardSections, [ha]);
    assert.equal((await request(base, cookie, 'DELETE', `/api/todo-lists/${list.id}`)).status, 204, 'HA config is not a local list reference');
    const legacy = await todos.create('Legacy');
    const v1 = { type: 'todo', version: 1, config: { listId: legacy.id } };
    assert.equal((await save(v1)).status, 200);
    assert.equal((await request(base, cookie, 'PUT', `/api/devices/${device.id}`, { name: 'Renamed' })).status, 200);
    assert.deepEqual((await devices.get(device.id))?.dashboardSections, [v1]);
  });
});

test('invalid and stale To Do requests return useful client errors', async () => {
  await withServer(async (base, cookie, devices) => {
    assert.equal((await request(base, cookie, 'POST', '/api/todo-lists', { name: '' })).status, 400);
    assert.equal((await request(base, cookie, 'PUT', '/api/todo-lists/BAD!', { name: 'No' })).status, 400);
    assert.equal((await request(base, cookie, 'POST', '/api/todo-lists/missing/items', { text: 'Task' })).status, 404);

    const list = await (await request(base, cookie, 'POST', '/api/todo-lists', { name: 'Home' })).json() as { id: string };
    const item = await (await request(base, cookie, 'POST', `/api/todo-lists/${list.id}/items`, { text: 'Task' })).json() as { id: string };
    assert.equal((await request(base, cookie, 'PUT', `/api/todo-lists/${list.id}/items/order`, { itemIds: [] })).status, 409);
    assert.equal((await request(base, cookie, 'PUT', `/api/todo-lists/${list.id}/items/00000000-0000-4000-8000-000000000000`, { completed: true })).status, 404);
    assert.equal((await request(base, cookie, 'PUT', `/api/todo-lists/${list.id}/items/${item.id}`, {})).status, 400);

    const device = await devices.getOrCreate('esp32-stale-list');
    const staleConfig = [
      { type: 'todo', version: 1, config: { listId: '00000000-0000-4000-8000-000000000000' } },
      ...device.dashboardSections.slice(1),
    ];
    assert.equal((await request(base, cookie, 'PUT', `/api/devices/${device.id}`, { dashboardSections: staleConfig })).status, 400);
    assert.notEqual((await devices.get(device.id))?.dashboardSections[0]?.type, 'todo');
  });
});

test('referenced lists cannot be deleted and no mutation API exists below the ESP32 frame path', async () => {
  await withServer(async (base, cookie, devices, todos) => {
    const list = await todos.create('Shared Home');
    const device = await devices.getOrCreate('esp32-todo');
    await devices.update(device.id, {
      dashboardSections: [
        { type: 'todo', version: 1, config: { listId: list.id } },
        ...device.dashboardSections.slice(1),
      ],
    });

    const conflict = await request(base, cookie, 'DELETE', `/api/todo-lists/${list.id}`);
    assert.equal(conflict.status, 409);
    const body = await conflict.json() as { referencedBy: Array<{ id: string }> };
    assert.deepEqual(body.referencedBy.map((reference) => reference.id), ['esp32-todo']);
    assert.ok(await todos.get(list.id));

    assert.equal((await request(base, cookie, 'POST', '/api/devices/esp32-todo/frame/todo-lists', { name: 'Injected' })).status, 404);
    assert.deepEqual((await todos.list()).map((candidate) => candidate.name), ['Shared Home']);
  });
});
