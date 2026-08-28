import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HomeAssistantClient } from '../../src/homeAssistant/client.ts';

const token = 'private-supervisor-test-token';
const start = '2026-08-27T00:00:00+01:00';
const end = '2026-08-29T00:00:00+01:00';
const event = { summary: 'Appointment', start: { dateTime: start }, end: { dateTime: end } };

test('calendar discovery and events use the shared authenticated base and strip unrelated fields', async () => {
  const calls: URL[] = [];
  const client = new HomeAssistantClient({ enabled: true, token, fetchImpl: async (input, init) => {
    const url = new URL(String(input)); calls.push(url);
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${token}`);
    assert.equal(init?.redirect, 'error');
    return Response.json(url.pathname.endsWith('/calendars')
      ? [{ entity_id: 'calendar.family', name: 'Family', attributes: { secret: token } }]
      : [{ ...event, description: token, location: 'ignored', uid: 'known-uid' }]);
  } });
  const discovery = await client.listCalendars();
  assert.deepEqual(discovery, { supported: true, available: true, calendars: [{ entityId: 'calendar.family', name: 'Family' }], error: null });
  const events = await client.getCalendarEvents('calendar.family', start, end);
  assert.deepEqual(events, { available: true, data: [{ ...event, uid: 'known-uid' }] });
  assert.equal(calls[0]!.href, 'http://supervisor/core/api/calendars');
  assert.equal(calls[1]!.pathname, '/core/api/calendars/calendar.family');
  assert.equal(calls[1]!.searchParams.get('start'), start);
  assert.match(calls[1]!.search, /%2B01%3A00/);
  assert.doesNotMatch(JSON.stringify([discovery, events, client.calendarCacheScope]), new RegExp(token));
});

test('disabled discovery is cleanly unavailable and unsafe entity paths never reach fetch', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return Response.json([]); };
  const disabled = new HomeAssistantClient({ enabled: false, token, fetchImpl });
  assert.deepEqual(await disabled.listCalendars(), { supported: false, available: false, calendars: [], error: null });
  assert.equal(disabled.calendarCacheScope, null);
  const enabled = new HomeAssistantClient({ enabled: true, token, fetchImpl });
  for (const id of ['light.home', '../config', 'calendar.a/../config', 'calendar.a%2f..', 'calendar.a?x=1', 'https://evil']) {
    assert.equal((await enabled.getCalendarEvents(id, start, end)).available, false);
  }
  assert.equal(calls, 0);
});

test('calendar failures are safe and response shapes are runtime validated', async () => {
  for (const fetchImpl of [
    async () => new Response(token, { status: 401 }),
    async () => new Response('{not json'),
    async () => Response.json([{ ...event, start: { dateTime: 'not a timestamp' } }]),
    async () => Response.json([{ ...event, end: { date: '2026-08-28' } }]),
    async () => { throw new Error(`request to internal URL failed: ${token}`); },
  ]) {
    const client = new HomeAssistantClient({ enabled: true, token, fetchImpl });
    const result = await client.getCalendarEvents('calendar.home', start, end);
    assert.equal(result.available, false);
    assert.doesNotMatch(JSON.stringify(result), /private-supervisor|internal URL/);
    assert.equal((await client.listCalendars()).available, false);
  }
});

test('calendar request timeout and cancellation use safe shared-client handling', async () => {
  const client = new HomeAssistantClient({ enabled: true, token, timeoutMs: 5, fetchImpl: async (_input, init) => new Promise((_resolve, reject) => {
    if (init?.signal?.aborted) reject(init.signal.reason);
    else init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
  }) });
  assert.deepEqual(await client.getCalendarEvents('calendar.home', start, end), { available: false, error: 'Home Assistant request timed out' });
  assert.deepEqual(await client.getCalendarEvents('calendar.home', start, end, AbortSignal.abort()), { available: false, error: 'Home Assistant request was cancelled' });
});
