import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HomeAssistantClient } from '../../src/homeAssistant/client.ts';
import { runHomeAssistantEntities } from '../../src/sources/homeAssistantEntities.ts';
import { FrameService } from '../../src/render/frameService.ts';
import { Renderer } from '../../src/render/browser.ts';
import { SourceCache } from '../../src/sources/cache.ts';
import { defaultDevice } from '../../src/devices/types.ts';
import { WEATHER } from '../fixtures/dashboard.ts';

const options = { deviceId: 'panel', timeoutMs: 1000 };
const weatherSource = { id: 'weather', async fetch() { return { status: 'ok' as const, data: WEATHER, fetchedAt: new Date().toISOString() }; } };

test('live sensor fetches are concurrent and ordered with honest partial/total failure states', async () => {
  const ids = ['sensor.power', 'sensor.missing', 'sensor.unknown', 'sensor.temperature'];
  let active = 0; let peak = 0; let calls = 0;
  const client = new HomeAssistantClient({ enabled: true, token: 'secret', fetchImpl: async (url) => {
    calls++; active++; peak = Math.max(active, peak);
    await new Promise((resolve) => setImmediate(resolve)); active--;
    const id = String(url).split('/').at(-1)!;
    assert.ok(String(url).includes('/states/sensor.'), 'rendering never calls the bulk states endpoint');
    if (id === 'sensor.missing') return new Response('', { status: 404 });
    return Response.json({ entity_id: id, state: id === 'sensor.unknown' ? 'unknown' : '21.40', attributes: { friendly_name: id.slice(7), unit_of_measurement: '°C', device_class: 'temperature', secret: 'hidden' } });
  } });
  const result = await runHomeAssistantEntities(ids, client, options);
  assert.equal(calls, 4); assert.equal(peak, 4);
  assert.deepEqual(result.data?.items, [
    { name: 'power', value: '21.40', unit: '°C', available: true },
    { name: 'missing', value: '', unit: null, available: false },
    { name: 'unknown', value: '', unit: null, available: false },
    { name: 'temperature', value: '21.40', unit: '°C', available: true },
  ]);
  assert.equal(result.health.status, 'error');
  assert.doesNotMatch(JSON.stringify(result.data), /entityId|sensor\.|deviceClass|hidden|secret/);
  const disabled = await runHomeAssistantEntities(ids, undefined, options);
  assert.equal(disabled.data, null);
  assert.equal(disabled.health.status, 'error');
  const unknown = await runHomeAssistantEntities(['sensor.unknown'], client, options);
  assert.equal(unknown.data?.items[0]?.available, false, 'a valid unavailable state retains its row');
});

test('Sensors integrate with both frame profiles, deduplicate, hash visible content and never replay stale state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-sensor-frame-'));
  const renderer = new Renderer();
  let calls = 0; let failed = false; let value = '21.4'; let hidden = 'old';
  const client = new HomeAssistantClient({ enabled: true, token: 'secret-token', fetchImpl: async (url) => {
    if (String(url).includes('/calendars/')) return Response.json([]);
    if (String(url).includes('/services/todo/')) return Response.json({ changed_states: [], service_response: { 'todo.home': { items: [{ summary: 'Buy milk', status: 'needs_action' }] } } });
    calls++;
    if (failed) return new Response('secret-token', { status: 503 });
    return Response.json({ entity_id: String(url).split('/').at(-1), state: value,
      attributes: { friendly_name: 'Living Room', unit_of_measurement: '°C', device_class: hidden, private: hidden }, last_updated: hidden });
  } });
  const cachePath = join(dir, 'cache');
  const service = new FrameService({ renderer, cache: new SourceCache(cachePath), weatherSource, homeAssistantClient: client });
  try {
    for (const profile of ['wft0583-800x480-mono', 'ssd1681-200x200-mono'] as const) {
      failed = false; value = '21.4';
      const device = defaultDevice(profile, profile);
      const sensors = { type: 'entities' as const, version: 1 as const, config: { entityIds: ['sensor.living_room'] } };
      device.dashboardSections = profile === 'ssd1681-200x200-mono' ? [sensors] : [sensors, sensors,
        { type: 'todo', version: 2, config: { provider: 'home-assistant', entityId: 'todo.home' } },
        { type: 'calendar', version: 2, config: { provider: 'home-assistant', entityIds: ['calendar.home'] } }];
      const before = calls;
      const first = await service.frameFor(device, null);
      assert.equal(calls - before, 1, 'identical widgets share the per-frame request');
      assert.equal(first.buffer.length, profile === 'ssd1681-200x200-mono' ? 5000 : 48000);
      hidden = 'changed-metadata';
      assert.equal((await service.frameFor(device, null)).etag, first.etag);
      value = '22.4';
      assert.notEqual((await service.frameFor(device, null)).etag, first.etag);
      failed = true;
      const html = await service.previewHtml(device);
      assert.match(html, /Sensors unavailable/);
      assert.doesNotMatch(html, /21\.4|22\.4|secret-token|sensor\.living_room/);
      if (profile !== 'ssd1681-200x200-mono') assert.match(html, /Buy milk/);
      await service.frameFor(device, null);
      assert.ok(service.sourceIssues().some((issue) => issue.deviceId === device.id && issue.sourceId.includes('home-assistant-sensors')));
      failed = false;
      device.dashboardSections[0] = { ...sensors, config: { entityIds: [] } };
      if (device.dashboardSections.length === 4) device.dashboardSections[1] = { type: 'empty', version: 1, config: {} };
      const beforeEmpty = calls;
      assert.match(await service.previewHtml(device), /Sensors — not set up/);
      assert.equal(calls, beforeEmpty);
    }
    for (const file of await readdir(cachePath)) assert.doesNotMatch(await readFile(join(cachePath, file), 'utf8'), /Living Room|sensor\.living_room|secret-token|changed-metadata/);
  } finally { await renderer.close(); await rm(dir, { recursive: true, force: true }); }
});
