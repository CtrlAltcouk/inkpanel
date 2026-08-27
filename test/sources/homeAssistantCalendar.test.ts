import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HomeAssistantClient } from '../../src/homeAssistant/client.ts';
import { homeAssistantCalendarEventsSchema, type HomeAssistantCalendarEvent } from '../../src/homeAssistant/calendarSchemas.ts';
import { SourceCache } from '../../src/sources/cache.ts';
import { homeAssistantCalendarWindow, normalizeHomeAssistantCalendars, runHomeAssistantCalendars } from '../../src/sources/homeAssistantCalendar.ts';

const timed = (summary: string, start: string, end = start): HomeAssistantCalendarEvent => ({ summary, start: { dateTime: start }, end: { dateTime: end } });
const allDay = (summary: string, start: string, end: string): HomeAssistantCalendarEvent => ({ summary, start: { date: start }, end: { date: end } });
const normalize = (events: HomeAssistantCalendarEvent[], now = '2026-08-27T12:00:00Z', timezone = 'Europe/London') => normalizeHomeAssistantCalendars([{ entityId: 'calendar.home', events }], new Date(now), timezone);

test('HA timed and all-day events populate today/tomorrow with exclusive date ends', () => {
  const data = normalize([
    timed('Today', '2026-08-27T14:00:00+01:00', '2026-08-27T15:00:00+01:00'),
    timed('Tomorrow', '2026-08-28T14:00:00+01:00'),
    allDay('Birthday', '2026-08-27', '2026-08-28'),
    allDay('Holiday', '2026-08-28', '2026-08-29'),
    allDay('Ended', '2026-08-26', '2026-08-27'),
    allDay('Multi-day', '2026-08-26', '2026-08-29'),
  ]);
  assert.deepEqual(data.today.map((event) => event.title), ['Multi-day', 'Birthday', 'Today']);
  assert.deepEqual(data.tomorrow.map((event) => event.title), ['Multi-day', 'Holiday', 'Tomorrow']);
  assert.equal(data.today[1]!.allDay, true);
  assert.equal(data.today[2]!.start, '2026-08-27T13:00:00.000Z');
});

for (const [label, now, zone, today, tomorrow] of [
  ['BST midnight', '2026-08-27T23:30:00Z', 'Europe/London', '2026-08-27T23:15:00Z', '2026-08-28T23:15:00Z'],
  ['GMT change', '2026-10-25T12:00:00Z', 'Europe/London', '2026-10-25T01:30:00+01:00', '2026-10-26T00:30:00Z'],
  ['BST change', '2026-03-29T12:00:00Z', 'Europe/London', '2026-03-29T00:30:00Z', '2026-03-29T23:30:00Z'],
  ['New York midnight', '2026-08-28T02:00:00Z', 'America/New_York', '2026-08-28T03:30:00Z', '2026-08-28T04:30:00Z'],
  ['New York DST', '2026-11-01T12:00:00Z', 'America/New_York', '2026-11-01T01:30:00-04:00', '2026-11-02T00:30:00-05:00'],
  ['Auckland midnight', '2026-08-27T12:30:00Z', 'Pacific/Auckland', '2026-08-27T12:15:00Z', '2026-08-28T12:15:00Z'],
]) test(`HA date classification uses panel timezone: ${label}`, () => {
  const data = normalize([timed('today', today!), timed('tomorrow', tomorrow!)], now, zone);
  assert.deepEqual(data.today.map((event) => event.title), ['today']);
  assert.deepEqual(data.tomorrow.map((event) => event.title), ['tomorrow']);
});

test('floating all-day dates never shift west/east and the bounded range covers extreme offsets', () => {
  for (const zone of ['America/Los_Angeles', 'Pacific/Kiritimati']) {
    const now = zone === 'Pacific/Kiritimati' ? '2026-08-27T00:00:00Z' : '2026-08-27T12:00:00Z';
    const data = normalize([allDay('day', '2026-08-27', '2026-08-28')], now, zone);
    assert.equal(data.today[0]!.title, 'day');
    assert.equal(data.tomorrow.length, 0);
    assert.deepEqual(homeAssistantCalendarWindow(new Date(now), zone), { start: '2026-08-26T00:00:00.000Z', end: '2026-08-30T00:00:00.000Z' });
  }
});

test('fallback UIDs, title trimming and ordering are deterministic; irrelevant fields are discarded', () => {
  const events = homeAssistantCalendarEventsSchema.parse([
    { ...timed(' Z ', '2026-08-27T12:00:00Z'), uid: '', description: 'secret', location: 'ignored' },
    timed(' A ', '2026-08-27T12:00:00Z'),
    { ...allDay(' ', '2026-08-27', '2026-08-28'), uid: 'ha-uid' },
  ]);
  const first = normalize(events);
  assert.deepEqual(normalize([...events].reverse()), first);
  assert.deepEqual(first.today.map((event) => event.title), ['(no title)', 'A', 'Z']);
  assert.equal(first.today[0]!.uid, 'ha-uid');
  assert.equal(first.today[2]!.uid.length, 64);
  assert.doesNotMatch(JSON.stringify(first), /secret|ignored/);
});

test('HA calendars fetch concurrently, deduplicate IDs, aggregate failure and isolate stale caches', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-ha-cal-'));
  const cache = new SourceCache(dir);
  const options = { deviceId: 'panel', timeoutMs: 1000, now: new Date('2026-08-27T12:00:00Z') };
  const token = 'never-cache-supervisor-token';
  let failing = false;
  let concurrent = 0; let peak = 0; let calls = 0;
  const client = new HomeAssistantClient({ enabled: true, token, fetchImpl: async (url) => {
    calls++; concurrent++; peak = Math.max(peak, concurrent);
    await new Promise((resolve) => setTimeout(resolve, 10)); concurrent--;
    if (failing || String(url).includes('calendar.bad')) return new Response('private detail', { status: 500 });
    return Response.json([allDay('Available', '2026-08-27', '2026-08-28')]);
  } });
  try {
    const partial = await runHomeAssistantCalendars(['calendar.good', 'calendar.bad', 'calendar.good'], 'Europe/London', client, cache, options);
    assert.equal(calls, 2); assert.equal(peak, 2);
    assert.equal(partial.data!.today[0]!.title, 'Available');
    assert.equal(partial.health.status, 'error');
    assert.equal(partial.health.error, '1 of 2 Home Assistant calendars unavailable');
    const multiple = await runHomeAssistantCalendars(['calendar.good', 'calendar.other'], 'Europe/London', client, cache, options);
    assert.equal(multiple.health.status, 'ok'); assert.equal(multiple.data!.today.length, 2);
    const healthy = await runHomeAssistantCalendars(['calendar.good'], 'Europe/London', client, cache, options);
    assert.equal(healthy.health.status, 'ok');
    failing = true;
    const stale = await runHomeAssistantCalendars(['calendar.good'], 'Europe/London', client, cache, options);
    assert.equal(stale.health.status, 'stale'); assert.deepEqual(stale.data, healthy.data);
    const allFailed = await runHomeAssistantCalendars(['calendar.bad'], 'Europe/London', client, cache, options);
    assert.equal(allFailed.data, null); assert.equal(allFailed.health.status, 'error');
    const other = new HomeAssistantClient({ enabled: true, baseUrl: 'http://other/core/api/', token, fetchImpl: async () => { throw new Error(token); } });
    assert.equal((await runHomeAssistantCalendars(['calendar.good'], 'Europe/London', other, cache, options)).data, null);
    assert.equal((await runHomeAssistantCalendars(['calendar.good'], 'Europe/London', client, cache, { ...options, deviceId: 'other-panel' })).data, null);
    assert.equal((await runHomeAssistantCalendars(['calendar.good'], 'Europe/London', client, cache, { ...options, now: new Date('2026-08-28T12:00:00Z') })).data, null);
    assert.equal((await runHomeAssistantCalendars(['calendar.good'], 'Europe/London', undefined, cache, options)).data, null);
    for (const name of await readdir(dir)) assert.doesNotMatch(name + await readFile(join(dir, name), 'utf8'), /never-cache|supervisor|private detail/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
