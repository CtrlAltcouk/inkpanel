import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/http/app.ts';
import { DeviceStore } from '../../src/devices/store.ts';
import type { FrameService } from '../../src/render/frameService.ts';
import { HomeAssistantUserStore } from '../../src/homeAssistant/userStore.ts';
import { HomeAssistantClient } from '../../src/homeAssistant/client.ts';
import { createRuntimeState } from '../../src/runtimeConfig.ts';

test('trusted identity, scoped discovery, admin mappings and shared APIs enforce separate boundaries', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-user-api-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, '.home-assistant-users.json');
  const users = new HomeAssistantUserStore(path);
  const store = new DeviceStore(join(dir, 'config.json'));
  await store.getOrCreate('panel');
  const token = 'never-return-or-persist-supervisor-token';
  const client = new HomeAssistantClient({ enabled: true, token, fetchImpl: async (url) => Response.json(String(url).endsWith('/calendars')
    ? [{ entity_id: 'calendar.shared', name: 'Shared' }]
    : [{ entity_id: 'todo.chris', attributes: { friendly_name: 'Chris', token } }, { entity_id: 'todo.other', attributes: { friendly_name: 'Other', token } },
      { entity_id: 'sensor.shared', state: '20', attributes: { friendly_name: 'Shared', token } }]) });
  const frame = { buffer: Buffer.alloc(48000), etag: 'fixed-frame', renderedAt: new Date().toISOString() };
  const deps = { store, frames: { warmUp: async () => {}, enrolmentFrame: async () => frame } as unknown as FrameService,
    homeAssistantClient: client, homeAssistantUserStore: users, dataDir: dir, firmwareDir: dir,
    publicBaseUrl: 'http://panel.test:8080', runtimeState: createRuntimeState(), auth: { password: null, secret: randomBytes(32) } };
  const servers = ['lan', 'trusted', 'untrusted'].map((mode) => createApp({ ...deps,
    access: mode === 'lan' ? { mode: 'lan' } : { mode: 'home-assistant-ingress', ...(mode === 'trusted' ? { isTrustedRequest: () => true } : {}) },
  }).listen(0, '127.0.0.1'));
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.once('listening', resolve))));
  t.after(() => Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))));
  const request = async (index: number, path: string, id?: string, method = 'GET', body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${(servers[index]!.address() as AddressInfo).port}${path}`, {
      method, headers: { ...(id === undefined ? {} : { 'x-remote-user-id': id, 'x-remote-user-display-name': 'Chris' }),
        'x-forwarded-for': '172.30.32.2', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await request(2, '/api/home-assistant/current-user', 'chris-id')).status, 403);
  assert.deepEqual((await request(0, '/api/home-assistant/current-user', 'forged')).body, { available: false, user: null, accessMode: 'lan' });
  assert.deepEqual(await users.list(), []);
  for (const id of [undefined, '', 'x'.repeat(129)]) for (const route of ['current-user', 'my-todo-lists', 'users']) {
    assert.equal((await request(1, `/api/home-assistant/${route}`, id)).status, 403);
    assert.equal((await request(1, `/api/HOME-ASSISTANT/${route.toUpperCase()}/`, id)).status, 403,
      'identity guard follows the same case/trailing-slash rules as Express routes');
  }
  const identity = await request(1, '/api/home-assistant/current-user', 'chris-id');
  assert.deepEqual(identity.body, { available: true, user: { id: 'chris-id', username: null, displayName: 'Chris' } });
  await request(1, '/api/home-assistant/current-user', 'other-id');
  assert.equal((await request(0, '/api/home-assistant/users/chris-id', undefined, 'PUT', { todoEntityIds: ['todo.chris', 'todo.missing'] })).status, 200);
  assert.equal((await request(0, '/api/home-assistant/users/other-id', undefined, 'PUT', { todoEntityIds: ['todo.other'] })).status, 200);
  const mine = await request(1, '/api/home-assistant/my-todo-lists', 'chris-id');
  assert.deepEqual(mine.body.lists.map((list: { entityId: string }) => list.entityId), ['todo.chris', 'todo.missing']);
  assert.doesNotMatch(JSON.stringify(mine.body), /todo.other|other-id|never-return|items/);
  assert.equal((await request(0, '/api/home-assistant/my-todo-lists', 'chris-id')).status, 403);
  assert.equal((await request(0, '/api/home-assistant/users/other-id', undefined, 'PUT', { todoEntityIds: ['todo.chris'] })).status, 400);
  assert.equal((await request(1, '/api/home-assistant/users/chris-id', undefined, 'DELETE')).status, 403);
  for (const route of ['calendars', 'sensors']) {
    const shared = await request(1, `/api/home-assistant/${route}`);
    assert.equal(shared.status, 200, 'household discovery does not require personal identity');
    assert.match(JSON.stringify(shared.body), /shared/);
  }
  const widget = { type: 'todo', version: 3, config: { provider: 'home-assistant', ownerUserId: 'chris-id', entityId: 'todo.missing' } };
  const dashboardSections = [widget, ...Array.from({ length: 3 }, () => ({ type: 'empty', version: 1, config: {} }))];
  assert.equal((await request(1, '/api/devices/panel', undefined, 'PUT', { dashboardSections })).status, 403);
  assert.equal((await request(1, '/api/dashboard-editor/panel', undefined, 'PUT', { slots: [[widget], [], [], []] })).status, 403);
  assert.equal((await request(0, '/api/devices/panel', undefined, 'PUT', { dashboardSections })).status, 200);
  assert.equal((await request(0, '/api/devices/panel', undefined, 'PUT', { name: 'Still personal' })).status, 200);
  assert.deepEqual((await store.get('panel'))!.dashboardSections[0], widget);
  for (const route of ['/api/devices', '/api/devices/panel', '/api/devices/panel/preview', '/api/devices/panel/render.png', '/api/devices/panel/frame']) {
    assert.equal((await request(1, route)).status, 403, 'missing Ingress identity cannot read personal config or preview');
  }
  assert.equal((await request(1, '/api/devices/panel/push', undefined, 'POST')).status, 403);
  assert.equal((await request(0, '/api/dashboard-editor/panel', undefined, 'PUT', { slots: [[widget], [], [], []] })).status, 200);
  assert.equal((await request(1, '/api/dashboard-editor/panel')).status, 403);
  const firmware = await fetch(`http://127.0.0.1:${(servers[0]!.address() as AddressInfo).port}/api/devices/panel/frame`, { headers: { 'x-remote-user-id': 'forged' } });
  assert.equal(firmware.status, 200);
  assert.equal((await firmware.arrayBuffer()).byteLength, 48000);
  assert.doesNotMatch(await readFile(path, 'utf8'), new RegExp(`${token}|forged`));
  await writeFile(path, '{broken');
  assert.equal((await request(1, '/api/home-assistant/my-todo-lists', 'chris-id')).status, 503);
  assert.equal((await request(0, '/api/home-assistant/users/chris-id', undefined, 'DELETE')).status, 503);
  assert.equal(await readFile(path, 'utf8'), '{broken');
});
