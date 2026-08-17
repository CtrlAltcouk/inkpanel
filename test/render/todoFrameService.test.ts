import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/http/app.ts';
import { DeviceStore } from '../../src/devices/store.ts';
import { FrameService } from '../../src/render/frameService.ts';
import { Renderer } from '../../src/render/browser.ts';
import { SourceCache } from '../../src/sources/cache.ts';
import type { Source } from '../../src/sources/types.ts';
import type { WeatherData } from '../../src/model/dashboard.ts';
import { TodoStore } from '../../src/todo/store.ts';
import { WEATHER } from '../fixtures/dashboard.ts';

const weatherSource: Source<{ latitude: number; longitude: number; timezone: string }, WeatherData> = {
  id: 'weather',
  async fetch() { return { status: 'ok', data: WEATHER, fetchedAt: '2026-08-03T08:00:00.000Z' }; },
};

test('one local list drives full-size and Mini frames, visible hashes, and HTTP 304s', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-todo-frame-'));
  const devices = new DeviceStore(join(dir, 'config.json'));
  const todos = new TodoStore(join(dir, '.todo-lists.json'));
  const renderer = new Renderer();
  const frames = new FrameService({
    renderer, cache: new SourceCache(join(dir, 'cache')), weatherSource, todoStore: todos,
  });
  const server = createApp({
    store: devices, frames, todoStore: todos,
    publicBaseUrl: 'http://test.local:8080', runtimeState: { httpsPort: null },
    dataDir: dir, firmwareDir: dir, auth: { password: null, secret: randomBytes(32) },
  }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  try {
    const list = await todos.create('Home');
    const first = await todos.addItem(list.id, 'Put bins out');
    const second = await todos.addItem(list.id, 'Buy milk');
    const completed = await todos.addItem(list.id, 'Already finished');
    await todos.updateItem(list.id, completed.id, { completed: true });
    const fourth = await todos.addItem(list.id, 'Book dentist');
    const fifth = await todos.addItem(list.id, 'Water plants');
    const sixth = await todos.addItem(list.id, 'Hidden sixth');
    const seventh = await todos.addItem(list.id, 'Hidden seventh');

    const large = await devices.getOrCreate('esp32-todo-large');
    await devices.update(large.id, {
      claimed: true,
      dashboardSections: [
        { type: 'todo', version: 1, config: { listId: list.id } },
        ...large.dashboardSections.slice(1),
      ],
    });
    const mini = await devices.getOrCreate('esp32-todo-mini', 'ssd1681-200x200-mono');
    await devices.update(mini.id, {
      claimed: true,
      dashboardSections: [{ type: 'todo', version: 1, config: { listId: list.id } }],
    });

    const largeDevice = (await devices.get(large.id))!;
    const miniDevice = (await devices.get(mini.id))!;
    for (const html of [await frames.previewHtml(largeDevice), await frames.previewHtml(miniDevice)]) {
      assert.match(html, /Put bins out/);
      assert.match(html, /Buy milk/);
      assert.doesNotMatch(html, /Already finished/);
    }

    const largeBefore = await frames.frameFor(largeDevice, null);
    const miniBefore = await frames.frameFor(miniDevice, null);
    assert.equal((await frames.frameFor(largeDevice, null)).etag, largeBefore.etag, 'unchanged shared list reuses the full-size frame');
    assert.equal((await frames.frameFor(miniDevice, null)).etag, miniBefore.etag, 'unchanged shared list reuses the Mini frame');

    await todos.updateItem(list.id, seventh.id, { text: 'Still hidden seventh' });
    assert.equal((await frames.frameFor(largeDevice, null)).etag, largeBefore.etag, 'off-screen task edits do not invalidate the full-size frame');
    assert.equal((await frames.frameFor(miniDevice, null)).etag, miniBefore.etag, 'off-screen task edits do not invalidate the Mini frame');

    await todos.updateItem(list.id, first.id, { text: 'Put both bins out' });
    assert.notEqual((await frames.frameFor(largeDevice, null)).etag, largeBefore.etag);
    assert.notEqual((await frames.frameFor(miniDevice, null)).etag, miniBefore.etag);

    const beforeOrder = await frames.frameFor(miniDevice, null);
    await todos.reorderItems(list.id, [second.id, first.id, completed.id, fourth.id, fifth.id, sixth.id, seventh.id]);
    assert.notEqual((await frames.frameFor(miniDevice, null)).etag, beforeOrder.etag);

    const initial = await fetch(`${base}/api/devices/${mini.id}/frame`);
    assert.equal(initial.status, 200);
    const etag = initial.headers.get('etag');
    assert.ok(etag);
    assert.equal((await fetch(`${base}/api/devices/${mini.id}/frame`, { headers: { 'if-none-match': etag } })).status, 304);
    await todos.updateItem(list.id, second.id, { completed: true });
    const changed = await fetch(`${base}/api/devices/${mini.id}/frame`, { headers: { 'if-none-match': etag } });
    assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.get('etag'), etag);
  } finally {
    server.close();
    await renderer.close();
    await rm(dir, { recursive: true, force: true });
  }
});
