import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FrameService } from '../../src/render/frameService.ts';
import { Renderer } from '../../src/render/browser.ts';
import { HomeAssistantClient } from '../../src/homeAssistant/client.ts';
import { SourceCache } from '../../src/sources/cache.ts';
import { defaultDevice } from '../../src/devices/types.ts';
import { TodoStore } from '../../src/todo/store.ts';
import { WEATHER } from '../fixtures/dashboard.ts';

const weatherSource = { id: 'weather', async fetch() { return { status: 'ok' as const, data: WEATHER, fetchedAt: new Date().toISOString() }; } };

test('HA To Do uses unchanged full-size/Mini layouts, live-only data and per-frame deduplication', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-ha-todo-'));
  const renderer = new Renderer();
  let calls = 0;
  let failed = false;
  let items = ['Buy milk', 'Take bins out', 'Third', 'Fourth', 'Fifth', 'Hidden sixth']
    .map((summary) => ({ summary, status: 'needs_action', uid: 'private-uid', description: 'private-description' }));
  const client = new HomeAssistantClient({ enabled: true, token: 'secret-supervisor-token', fetchImpl: async (url) => {
    if (String(url).includes('/calendars/')) return Response.json([]);
    calls++;
    if (failed) return new Response('secret-supervisor-token', { status: 503 });
    return Response.json({ changed_states: [], service_response: { 'todo.home': { items } } });
  } });
  const cachePath = join(dir, 'cache');
  const frames = new FrameService({ renderer, cache: new SourceCache(cachePath), weatherSource, homeAssistantClient: client });
  try {
    for (const profile of ['wft0583-800x480-mono', 'ssd1681-200x200-mono'] as const) {
      failed = false;
      items = ['Buy milk', 'Take bins out', 'Third', 'Fourth', 'Fifth', 'Hidden sixth']
        .map((summary) => ({ summary, status: 'needs_action', uid: 'private-uid', description: 'private-description' }));
      const device = defaultDevice(`esp32-${profile}`, profile);
      const todo = { type: 'todo' as const, version: 2 as const, config: { provider: 'home-assistant' as const, entityId: 'todo.home' } };
      device.dashboardSections = profile === 'ssd1681-200x200-mono' ? [todo] : [todo, todo,
        { type: 'weather', version: 1, config: {} },
        { type: 'calendar', version: 2, config: { provider: 'home-assistant', entityIds: ['calendar.home'] } }];
      const html = await frames.previewHtml(device);
      assert.match(html, /Buy milk/);
      assert.doesNotMatch(html, /Hidden sixth|private-uid|private-description|secret-supervisor-token/);
      const beforeCalls = calls;
      const first = await frames.frameFor(device, null);
      assert.equal(calls - beforeCalls, 1, 'identical HA widgets share one request within a frame');
      assert.equal(first.buffer.length, profile === 'ssd1681-200x200-mono' ? 5000 : 48000);
      items[0]!.uid = 'changed-hidden-metadata';
      items[5]!.summary = 'Changed invisible sixth';
      assert.equal((await frames.frameFor(device, null)).etag, first.etag);
      items[0]!.status = 'completed';
      assert.notEqual((await frames.frameFor(device, null)).etag, first.etag, 'completion changes the visible list');
      failed = true;
      const unavailable = await frames.previewHtml(device);
      assert.doesNotMatch(unavailable, /Buy milk|Take bins out/, 'no stale task replay');
      await frames.frameFor(device, null);
      assert.ok(frames.sourceIssues().some((issue) => issue.deviceId === device.id && issue.sourceId.includes('home-assistant-todo')));
      if (profile === 'wft0583-800x480-mono') {
        assert.match(unavailable.split('<body>')[1]!, /Next 3 days/);
        assert.equal(frames.sourceIssues().filter((issue) => issue.deviceId === device.id).length, 2, 'only the two To Do slots fail');
      }
      failed = false;
      items = [];
      assert.match(await frames.previewHtml(device), /All done|ALL DONE/);
      const beforeEmpty = calls;
      device.dashboardSections[0] = { ...todo, config: { provider: 'home-assistant', entityId: '' } };
      if (device.dashboardSections.length === 4) device.dashboardSections[1] = { type: 'empty', version: 1, config: {} };
      assert.match(await frames.previewHtml(device), /not set up|Not set up/);
      assert.equal(calls, beforeEmpty, 'unconfigured HA To Do makes no service request');
    }
    for (const file of await readdir(cachePath)) {
      assert.doesNotMatch(await readFile(join(cachePath, file), 'utf8'), /Buy milk|private-uid|private-description|secret-supervisor-token/);
    }
  } finally { await renderer.close(); await rm(dir, { recursive: true, force: true }); }
});

test('V2 local To Do renders exactly like V1 on both profiles', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-local-v2-'));
  const renderer = new Renderer();
  try {
    const todos = new TodoStore(join(dir, 'todos.json'));
    const list = await todos.create('Local');
    await todos.addItem(list.id, 'Existing local task');
    const frames = new FrameService({ renderer, cache: new SourceCache(join(dir, 'cache')), weatherSource, todoStore: todos });
    for (const profile of ['wft0583-800x480-mono', 'ssd1681-200x200-mono'] as const) {
      const device = defaultDevice(`esp32-${profile}`, profile);
      device.dashboardSections = device.dashboardSections.map(() => ({ type: 'todo', version: 1, config: { listId: list.id } }));
      const first = await frames.frameFor(device, null);
      device.dashboardSections = device.dashboardSections.map(() => ({ type: 'todo', version: 2, config: { provider: 'local', listId: list.id } }));
      assert.equal((await frames.frameFor(device, null)).etag, first.etag);
      assert.match(await frames.previewHtml(device), /Existing local task/);
    }
  } finally { await renderer.close(); await rm(dir, { recursive: true, force: true }); }
});
