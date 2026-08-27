import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FrameService } from '../../src/render/frameService.ts';
import { Renderer } from '../../src/render/browser.ts';
import { SourceCache } from '../../src/sources/cache.ts';
import { HomeAssistantClient } from '../../src/homeAssistant/client.ts';
import { defaultDevice, type DeviceRecord } from '../../src/devices/types.ts';
import { localDateKey } from '../../src/sources/ical.ts';
import { WFT0583, SSD1681_200X200 } from '../../src/panel/profile.ts';
import { WEATHER } from '../fixtures/dashboard.ts';

for (const profile of [WFT0583, SSD1681_200X200]) test(`HA Calendar uses the unchanged ${profile.id} renderer and stable visible content memo`, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-ha-frame-'));
  const renderer = new Renderer();
  let screenshots = 0; let lastHtml = ''; let title = 'HA family birthday'; let uid = 'first'; let reverse = false;
  const today = localDateKey(new Date(), 'Europe/London');
  const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const client = new HomeAssistantClient({ enabled: true, token: 'secret-frame-token', fetchImpl: async (url) => {
    if (String(url).includes('calendar.failed')) return new Response('secret error', { status: 503 });
    const events = [
      { summary: title, uid, start: { date: today }, end: { date: tomorrow }, description: 'metadata' },
      { summary: 'Another event', uid: 'other', start: { date: today }, end: { date: tomorrow } },
    ];
    return Response.json(reverse ? events.reverse() : events);
  } });
  let icalCalls = 0;
  const service = new FrameService({
    renderer: { screenshot: async (html, panel) => { screenshots++; lastHtml = html; return renderer.screenshot(html, panel); } } as Renderer,
    cache: new SourceCache(dir), homeAssistantClient: client,
    weatherSource: { id: 'weather', fetch: async () => ({ status: 'ok', data: WEATHER, fetchedAt: new Date().toISOString() }) },
    calendarSource: { id: 'ical', fetch: async () => { icalCalls++; return { status: 'ok', data: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR', fetchedAt: new Date().toISOString() }; } },
  });
  const calendar = { type: 'calendar' as const, version: 2 as const, config: { provider: 'home-assistant' as const, entityIds: ['calendar.family'] } };
  const device: DeviceRecord = { ...defaultDevice('ha-panel'), claimed: true, panelProfileId: profile.dashboardSlots === 1 ? 'ssd1681-200x200-mono' : 'wft0583-800x480-mono', dashboardSections: profile.dashboardSlots === 1 ? [calendar] : [calendar, { type: 'weather', version: 1, config: {} }, { type: 'empty', version: 1, config: {} }, { type: 'empty', version: 1, config: {} }] };
  try {
    const frame = await service.frameFor(device, 4);
    assert.equal(frame.buffer.length, profile.width * profile.height / 8);
    assert.match(lastHtml, /HA family birthday/);
    assert.doesNotMatch(lastHtml, /secret-frame-token|metadata|first/);
    uid = 'changed-hidden-uid'; reverse = true;
    const again = await service.frameFor(device, 4);
    assert.equal(again.etag, frame.etag); assert.equal(screenshots, 1);
    title = 'Changed visible title';
    await service.frameFor(device, 4); assert.equal(screenshots, 2);
    assert.equal(icalCalls, 0, 'HA never invokes the iCal runner');
    for (const widget of [
      { type: 'calendar' as const, version: 1 as const, config: { calendarUrls: ['https://example.com/feed'] } },
      { type: 'calendar' as const, version: 2 as const, config: { provider: 'ical' as const, calendarUrls: ['https://example.com/feed'] } },
    ]) await service.previewHtml({ ...device, dashboardSections: [widget, ...device.dashboardSections.slice(1)] });
    assert.equal(icalCalls, 2, 'both iCal widget versions use the existing runner');
    const failed = { ...calendar, config: { ...calendar.config, entityIds: ['calendar.failed'] } };
    const html = await service.previewHtml({ ...device, dashboardSections: [failed, ...device.dashboardSections.slice(1)] });
    const body = html.split('</style>')[1]!;
    assert.match(body, /unavailable/i);
    if (profile.dashboardSlots === 4) assert.match(body, /Next 3 days/);
  } finally { await renderer.close(); await rm(dir, { recursive: true, force: true }); }
});
