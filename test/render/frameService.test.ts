import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FrameService, type SourceBundle } from '../../src/render/frameService.ts';
import { batteryPercent } from '../../src/devices/battery.ts';
import { SourceCache } from '../../src/sources/cache.ts';
import { Renderer } from '../../src/render/browser.ts';
import { defaultDevice } from '../../src/devices/types.ts';
import type { Source } from '../../src/sources/types.ts';
import type { IcalFeedConfig } from '../../src/sources/ical.ts';
import { CALENDAR, OK_CALENDAR, OK_WEATHER, WEATHER } from '../fixtures/dashboard.ts';
import { MK_FORECAST } from '../fixtures/openMeteo.ts';
import { SINGLE_TIMED } from '../fixtures/ics.ts';
import type { WeatherData } from '../../src/model/dashboard.ts';
import type { BinsData } from '../../src/sources/bins.ts';

function bundle(calendar = CALENDAR): SourceBundle {
  return {
    headerWeather: { data: WEATHER, health: OK_WEATHER },
    sections: [
      { type: 'calendar', data: calendar, health: OK_CALENDAR },
      { type: 'weather', data: WEATHER, health: OK_WEATHER },
      { type: 'trains', data: null, health: null },
      { type: 'bins', data: null, health: null },
    ],
  };
}

async function withService(fetchData: () => Promise<SourceBundle>, fn: (service: FrameService, screenshots: () => number) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-frame-'));
  const renderer = new Renderer();
  let count = 0;
  const counting = {
    screenshot: (html: string, profile: Parameters<Renderer['screenshot']>[1]) => { count += 1; return renderer.screenshot(html, profile); },
    warmUp: () => renderer.warmUp(), close: () => renderer.close(),
  } as Renderer;
  try { await fn(new FrameService({ renderer: counting, cache: new SourceCache(dir), fetchData }), () => count); }
  finally { await renderer.close(); await rm(dir, { recursive: true, force: true }); }
}

test('maps battery volts to a percentage', () => {
  assert.equal(batteryPercent(4.2), 100);
  assert.equal(batteryPercent(3.3), 0);
  assert.equal(batteryPercent(5), 100, 'over-voltage readings are clamped');
  assert.equal(batteryPercent(2), 0, 'under-voltage readings are clamped');
  assert.equal(batteryPercent(null), null);
  assert.equal(batteryPercent(0), null, 'zero means no battery reading');
});

test('renders 48000 bytes and memoises unchanged visible content', async () => {
  await withService(async () => bundle(), async (service, count) => {
    const device = { ...defaultDevice('esp32-test'), claimed: true };
    const first = await service.frameFor(device, 4.0);
    const second = await service.frameFor(device, 4.0);
    assert.equal(first.buffer.length, 48_000);
    assert.equal(second.etag, first.etag);
    assert.equal(count(), 1);
    await service.renderNow(device, 4.0);
    assert.equal(count(), 2, 'Push still forces rasterisation');
  });
});

test('ordered section content changes invalidate the memo', async () => {
  let title = 'First';
  await withService(async () => bundle({ ...CALENDAR, today: [{ ...CALENDAR.today[0]!, title }] }), async (service, count) => {
    const device = { ...defaultDevice('esp32-test'), claimed: true };
    await service.frameFor(device, 4.0);
    title = 'Second';
    await service.frameFor(device, 4.0);
    assert.equal(count(), 2);
  });
});

test('device and enrolment memos remain isolated by device and server URL', async () => {
  await withService(async () => bundle(), async (service, count) => {
    await service.frameFor({ ...defaultDevice('panel-a'), claimed: true }, 4.0);
    await service.frameFor({ ...defaultDevice('panel-b'), claimed: true }, 4.0);
    assert.equal(count(), 2);
    const device = defaultDevice('esp32-enrol');
    const first = await service.enrolmentFrame(device, 'http://192.168.1.20:8080');
    const cached = await service.enrolmentFrame(device, 'http://192.168.1.20:8080');
    const moved = await service.enrolmentFrame(device, 'http://10.0.0.5:8080');
    assert.equal(cached.etag, first.etag);
    assert.notEqual(moved.etag, first.etag);
  });
});

test('rendered-device coverage distinguishes unchecked from healthy devices', async () => {
  await withService(async () => bundle(), async (service) => {
    assert.equal(service.renderedDeviceCount(), 0);
    assert.deepEqual(service.sourceIssues(), [], 'no issues before checking means unknown coverage');
    await service.frameFor({ ...defaultDevice('healthy-a'), claimed: true }, 4);
    await service.frameFor({ ...defaultDevice('healthy-b'), claimed: true }, 4);
    assert.equal(service.renderedDeviceCount(), 2);
    assert.deepEqual(service.sourceIssues(), [], 'checked healthy devices have no issues');
  });
});

test('forced rendering moves contentChangedAt only for a real visible change', async () => {
  let title = 'First';
  await withService(async () => bundle({ ...CALENDAR, today: [{ ...CALENDAR.today[0]!, title }] }), async (service) => {
    const device = { ...defaultDevice('esp32-timestamp'), claimed: true };
    const first = await service.frameFor(device, 4.0);
    const unchangedPush = await service.renderNow(device, 4.0);
    assert.equal(unchangedPush.contentChangedAt, first.contentChangedAt);
    title = 'Changed';
    await new Promise((resolve) => setTimeout(resolve, 2));
    const changedPush = await service.renderNow(device, 4.0);
    assert.notEqual(changedPush.contentChangedAt, first.contentChangedAt);
  });
});

test('partial source data reaches its own section even when aggregate health is error', async () => {
  const partial = bundle({ ...CALENDAR, today: [{ ...CALENDAR.today[0]!, title: 'Healthy feed event' }] });
  partial.sections[0] = { type: 'calendar', data: (partial.sections[0] as { type: 'calendar'; data: typeof CALENDAR }).data, health: { id: 'ical', status: 'error', fetchedAt: null, error: '1 of 3 feeds unavailable' } };
  partial.sections[3] = { type: 'bins', data: { next: { date: '2026-08-10', types: ['recycling'] }, rawLabels: ['Collect Recycling Red'] }, health: { id: 'bins', status: 'ok', fetchedAt: null, error: null } };
  await withService(async () => partial, async (service) => {
    const device = { ...defaultDevice('esp32-partial'), claimed: true };
    const html = await service.previewHtml(device);
    assert.match(html, /Healthy feed event/);
    assert.match(html, /Collect Recycling Red/);
    await service.frameFor(device, 4.0);
    assert.deepEqual(service.sourceIssues(), [{ deviceId: 'esp32-partial', sourceId: 'section-0:ical', status: 'error', error: '1 of 3 feeds unavailable' }]);
  });
});

test('section health remains independently reportable', async () => {
  const failing = bundle();
  failing.sections[0] = { type: 'calendar', data: null, health: { id: 'ical', status: 'error', fetchedAt: null, error: 'timed out' } };
  await withService(async () => failing, async (service) => {
    await service.frameFor({ ...defaultDevice('panel-a'), claimed: true }, 4.0);
    assert.deepEqual(service.sourceIssues(), [{ deviceId: 'panel-a', sourceId: 'section-0:ical', status: 'error', error: 'timed out' }]);
    assert.equal(service.renderedDeviceCount(), 1);
  });
});

test('hidden health changes reuse the frame while diagnostics still refresh', async () => {
  let failed = false;
  await withService(async () => {
    const next = bundle();
    if (failed) {
      next.headerWeather = {
        data: WEATHER,
        health: { id: 'weather', status: 'error', fetchedAt: null, error: 'new hidden diagnostic' },
      };
    }
    return next;
  }, async (service, count) => {
    const device = { ...defaultDevice('panel-hidden-health'), claimed: true };
    const first = await service.frameFor(device, 4);
    failed = true;
    const second = await service.frameFor(device, 4);
    assert.equal(second.etag, first.etag);
    assert.equal(count(), 1, 'identical pixels do not launch Chromium again');
    assert.deepEqual(service.sourceIssues(), [{
      deviceId: 'panel-hidden-health', sourceId: 'header:weather',
      status: 'error', error: 'new hidden diagnostic',
    }]);
  });
});

test('a changed displayed stale minute invalidates the frame', async () => {
  let minute = '10';
  await withService(async () => {
    const next = bundle();
    next.sections[0] = {
      type: 'calendar', data: CALENDAR,
      health: { id: 'ical', status: 'stale', fetchedAt: `2026-08-03T03:${minute}:00.000Z`, error: 'timeout' },
    };
    return next;
  }, async (service, count) => {
    const device = { ...defaultDevice('panel-stale-minute'), claimed: true };
    const first = await service.frameFor(device, 4);
    minute = '11';
    const second = await service.frameFor(device, 4);
    assert.notEqual(second.etag, first.etag);
    assert.equal(count(), 2);
  });
});

test('duplicate widget diagnostics retain section identity', async () => {
  const duplicateFailures = bundle();
  duplicateFailures.sections[0] = { type: 'calendar', data: null, health: { id: 'ical', status: 'error', fetchedAt: null, error: 'work failed' } };
  duplicateFailures.sections[1] = { type: 'calendar', data: null, health: { id: 'ical', status: 'error', fetchedAt: null, error: 'personal failed' } };
  await withService(async () => duplicateFailures, async (service) => {
    await service.frameFor({ ...defaultDevice('panel-duplicates'), claimed: true }, 4);
    assert.deepEqual(service.sourceIssues(), [
      { deviceId: 'panel-duplicates', sourceId: 'section-0:ical', status: 'error', error: 'work failed' },
      { deviceId: 'panel-duplicates', sourceId: 'section-1:ical', status: 'error', error: 'personal failed' },
    ]);
  });
});

test('identical widget configs dedupe within a render while different configs stay isolated', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-dedupe-'));
  const calls: string[] = [];
  const calendarSource: Source<IcalFeedConfig, string> = {
    id: 'ical-raw',
    async fetch(config) { calls.push(config.url); return { status: 'ok', data: SINGLE_TIMED, fetchedAt: new Date().toISOString() }; },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes('api.open-meteo.com')) return new Response(JSON.stringify(MK_FORECAST));
    throw new Error(`unexpected fetch ${String(input)}`);
  }) as typeof fetch;
  try {
    const service = new FrameService({ renderer: {} as Renderer, cache: new SourceCache(dir), calendarSource });
    const same = { type: 'calendar' as const, version: 1 as const, config: { calendarUrls: ['https://one.example/a.ics'] } };
    const dashboardSections = [same, structuredClone(same), { ...same, config: { calendarUrls: ['https://two.example/b.ics'] } }, { type: 'weather' as const, version: 1 as const, config: {} }] as ReturnType<typeof defaultDevice>['dashboardSections'];
    const device = { ...defaultDevice('esp32-dedupe'), dashboardSections };
    await service.previewHtml(device);
    assert.deepEqual(calls.sort(), ['https://one.example/a.ics', 'https://two.example/b.ics']);
  } finally { globalThis.fetch = realFetch; await rm(dir, { recursive: true, force: true }); }
});

test('header weather is always fetched; Empty and unselected sources do no work', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-source-selection-'));
  const calls = { weather: 0, calendar: 0, bins: 0 };
  const weatherSource: Source<{ latitude: number; longitude: number; timezone: string }, WeatherData> = {
    id: 'weather', async fetch() { calls.weather += 1; return { status: 'ok', data: WEATHER, fetchedAt: new Date().toISOString() }; },
  };
  const calendarSource: Source<IcalFeedConfig, string> = {
    id: 'ical-raw', async fetch() { calls.calendar += 1; return { status: 'ok', data: SINGLE_TIMED, fetchedAt: new Date().toISOString() }; },
  };
  const binsTestSource: Source<{ uprn: string }, BinsData> = {
    id: 'bins', async fetch() { calls.bins += 1; return { status: 'ok', data: { next: null, rawLabels: [] }, fetchedAt: new Date().toISOString() }; },
  };
  try {
    const service = new FrameService({ renderer: {} as Renderer, cache: new SourceCache(dir), weatherSource, calendarSource, binsSource: binsTestSource });
    const empty = { type: 'empty' as const, version: 1 as const, config: {} };
    await service.previewHtml({ ...defaultDevice('esp32-empty'), dashboardSections: [empty, structuredClone(empty), structuredClone(empty), structuredClone(empty)] });
    assert.deepEqual(calls, { weather: 1, calendar: 0, bins: 0 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('real fetchAll does not call the bins source for an empty configured UPRN', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-no-uprn-'));
  let binsCalls = 0;
  const weatherSource: Source<{ latitude: number; longitude: number; timezone: string }, WeatherData> = {
    id: 'weather', async fetch() { return { status: 'ok', data: WEATHER, fetchedAt: new Date().toISOString() }; },
  };
  const binsTestSource: Source<{ uprn: string }, BinsData> = {
    id: 'bins', async fetch() { binsCalls += 1; throw new Error('empty UPRN must not reach bins'); },
  };
  try {
    const service = new FrameService({
      renderer: {} as Renderer, cache: new SourceCache(dir), weatherSource, binsSource: binsTestSource,
    });
    const html = await service.previewHtml(defaultDevice('panel-no-uprn'));
    assert.equal(binsCalls, 0);
    assert.match(html, /Bins — not set up/);
    assert.doesNotMatch(html, /Bins unavailable/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Weather reuses header result and identical Bins configs dedupe', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-source-dedupe-'));
  let weatherCalls = 0;
  const binCalls: string[] = [];
  const weatherSource: Source<{ latitude: number; longitude: number; timezone: string }, WeatherData> = {
    id: 'weather', async fetch() { weatherCalls += 1; return { status: 'ok', data: WEATHER, fetchedAt: new Date().toISOString() }; },
  };
  const binsTestSource: Source<{ uprn: string }, BinsData> = {
    id: 'bins', async fetch(config) { binCalls.push(config.uprn); return { status: 'ok', data: { next: null, rawLabels: [] }, fetchedAt: new Date().toISOString() }; },
  };
  try {
    const service = new FrameService({ renderer: {} as Renderer, cache: new SourceCache(dir), weatherSource, binsSource: binsTestSource });
    await service.previewHtml({ ...defaultDevice('esp32-reuse'), dashboardSections: [
      { type: 'weather', version: 1, config: {} },
      { type: 'bins', version: 1, config: { uprn: '100080152345' } },
      { type: 'bins', version: 1, config: { uprn: '100080152345' } },
      { type: 'bins', version: 1, config: { uprn: '100080152346' } },
    ] });
    assert.equal(weatherCalls, 1);
    assert.deepEqual(binCalls.sort(), ['100080152345', '100080152346']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('enrolment output remains 48000-byte firmware-compatible', async () => {
  await withService(async () => { throw new Error('sources must not run'); }, async (service) => {
    assert.equal((await service.enrolmentFrame(defaultDevice('esp32-new'), 'http://panel:8080')).buffer.length, 48_000);
  });
});
