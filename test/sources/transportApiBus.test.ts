import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTransportApiBusSource, searchTransportApiBusStops } from '../../src/sources/transportApiBus.ts';
import { TransportApiCredentialStore } from '../../src/sources/transportApiCredentials.ts';

const credentials = { appId: 'app-id-1234', appKey: 'app-key-abcdefghijklmnopqrstuvwxyz' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('TransportAPI bus source keeps credentials in headers and maps live departures', async () => {
  let seenUrl = '';
  let seenHeaders = new Headers();
  const source = createTransportApiBusSource({
    credentials,
    fetchImpl: (async (input, init) => {
      seenUrl = String(input);
      seenHeaders = new Headers(init?.headers);
      return jsonResponse({
        name: 'Central Railway Station Stop Y4',
        departures: {
          all: [
            {
              line_name: '6',
              direction: 'Lakes Estate',
              aimed_departure_time: '20:24',
              expected_departure_time: '20:28',
              best_departure_estimate: '20:28',
            },
            {
              line_name: 'X5',
              direction: 'Oxford',
              aimed_departure_time: '20:31',
              best_departure_estimate: '20:31',
            },
          ],
        },
      });
    }) as typeof fetch,
  });

  const result = await source.fetch(
    { stopCode: '049000000001', stopLabel: '', routeFilter: '' },
    new AbortController().signal,
  );

  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;
  assert.match(seenUrl, /bus\/stop\/049000000001\/live\.json/);
  assert.match(seenUrl, /group=no/);
  assert.match(seenUrl, /nextbuses=yes/);
  assert.doesNotMatch(seenUrl, /app[_-]?(?:id|key)/i);
  assert.equal(seenHeaders.get('X-App-Id'), credentials.appId);
  assert.equal(seenHeaders.get('X-App-Key'), credentials.appKey);
  assert.equal(result.data.stopName, 'Central Railway Station Stop Y4');
  assert.deepEqual(result.data.departures[0], {
    line: '6',
    destination: 'Lakes Estate',
    scheduled: '20:24',
    expected: '20:28',
    status: 'live',
  });
  assert.equal(result.data.departures[1]?.status, 'scheduled');
});

test('TransportAPI route filter is applied after parsing without putting it into credentials', async () => {
  const source = createTransportApiBusSource({
    credentials,
    fetchImpl: (async () => jsonResponse({
      name: 'Test Stop',
      departures: {
        all: [
          { line_name: '6', direction: 'A', aimed_departure_time: '10:00' },
          { line_name: 'X5', direction: 'B', aimed_departure_time: '10:05' },
        ],
      },
    })) as typeof fetch,
  });
  const result = await source.fetch(
    { stopCode: '049000000001', stopLabel: '', routeFilter: 'x5' },
    new AbortController().signal,
  );
  assert.equal(result.status, 'ok');
  if (result.status === 'ok') assert.deepEqual(result.data.departures.map((row) => row.line), ['X5']);
});

test('TransportAPI stop search maps ATCO-coded bus stops', async () => {
  const store = new TransportApiCredentialStore('/unused', credentials.appId, credentials.appKey);
  let seenHeaders = new Headers();
  const results = await searchTransportApiBusStops(
    store,
    'Central Station',
    new AbortController().signal,
    {
      fetchImpl: (async (_input, init) => {
        seenHeaders = new Headers(init?.headers);
        return jsonResponse({
          member: [
            { type: 'bus_stop', name: 'Central Railway Station Stop Y4', atcocode: '049000000001', locality: 'Milton Keynes' },
            { type: 'bus_stop', name: 'Duplicate', atcocode: '049000000001' },
            { type: 'train_station', name: 'No ATCO' },
          ],
        });
      }) as typeof fetch,
    },
  );
  assert.equal(seenHeaders.get('X-App-Id'), credentials.appId);
  assert.equal(seenHeaders.get('X-App-Key'), credentials.appKey);
  assert.deepEqual(results, [{ stopCode: '049000000001', name: 'Central Railway Station Stop Y4', locality: 'Milton Keynes' }]);
});

test('TransportAPI errors never reflect credentials', async () => {
  const source = createTransportApiBusSource({
    credentials,
    fetchImpl: (async () => jsonResponse({ error: credentials.appKey }, 401)) as typeof fetch,
  });
  const result = await source.fetch(
    { stopCode: '049000000001', stopLabel: '', routeFilter: '' },
    new AbortController().signal,
  );
  assert.equal(result.status, 'error');
  if (result.status === 'error') assert.doesNotMatch(result.error, new RegExp(credentials.appKey));
});
