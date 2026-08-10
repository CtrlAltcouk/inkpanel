import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNationalRailTrainSource } from '../../src/sources/nationalRailTrain.ts';

const ROUTE = { originCrs: 'MKC', destinationCrs: 'EUS' };

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(body), { ...init, headers });
}

function sourceWith(fetchImpl: typeof fetch, overrides: Partial<Parameters<typeof createNationalRailTrainSource>[0]> = {}) {
  return createNationalRailTrainSource({
    baseUrl: 'https://rail.example/api/',
    apiKey: 'super-secret-key',
    fetchImpl,
    ...overrides,
  });
}

test('requests a filtered departure board using the current RDM x-apikey contract', async () => {
  let seenUrl = '';
  let seenInit: RequestInit | undefined;
  const source = sourceWith((async (input, init) => {
    seenUrl = String(input);
    seenInit = init;
    return jsonResponse({
      trainServices: [
        { std: '07:42', etd: 'On time', platform: '3', isCancelled: false },
        { std: '07:58', etd: '08:06', platform: 1, isCancelled: false },
        { std: '08:19', etd: 'On time', platform: '2', isCancelled: true },
      ],
    });
  }) as typeof fetch);

  const result = await source.fetch(ROUTE, new AbortController().signal);
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;

  const url = new URL(seenUrl);
  assert.equal(url.pathname, '/api/GetDepartureBoard/MKC');
  assert.equal(url.searchParams.get('numRows'), '8');
  assert.equal(url.searchParams.get('filterCrs'), 'EUS');
  assert.equal(url.searchParams.get('filterType'), 'to');
  assert.equal(url.searchParams.get('timeOffset'), '0');
  assert.equal(url.searchParams.get('timeWindow'), '120');
  assert.equal(new Headers(seenInit?.headers).get('accept'), 'application/json');
  assert.equal(new Headers(seenInit?.headers).get('x-apikey'), 'super-secret-key');
  assert.equal(seenInit?.redirect, 'error');

  assert.equal(result.data.originCrs, 'MKC');
  assert.equal(result.data.destinationCrs, 'EUS');
  assert.equal(result.data.departures.length, 3);
  assert.deepEqual(result.data.departures[0], {
    scheduled: '07:42', expected: null, status: 'on-time', delayMinutes: 0, platform: '3',
  });
  assert.deepEqual(result.data.departures[1], {
    scheduled: '07:58', expected: '08:06', status: 'delayed', delayMinutes: 8, platform: '1',
  });
  assert.equal(result.data.departures[2]?.status, 'cancelled');
});

test('accepts the observed RDM v1.1 response shape and ignores unrelated fields', async () => {
  const source = sourceWith((async () => jsonResponse({
    trainServices: [
      {
        futureCancellation: false,
        futureDelay: false,
        origin: [{ locationName: 'Crewe', crs: 'CRE', assocIsCancelled: false }],
        destination: [{ locationName: 'London Euston', crs: 'EUS', assocIsCancelled: false }],
        std: '17:49',
        etd: '17:54',
        platform: '4',
        operator: 'LNR & WMR',
        operatorCode: 'LM',
        isCircularRoute: false,
        isCancelled: false,
        filterLocationCancelled: false,
        serviceType: 'train',
        serviceID: 'sanitised-1',
      },
      {
        futureCancellation: false,
        futureDelay: false,
        origin: [{ locationName: 'Milton Keynes Central', crs: 'MKC', assocIsCancelled: false }],
        destination: [{ locationName: 'London Euston', crs: 'EUS', assocIsCancelled: false }],
        currentOrigins: [{ locationName: 'Bletchley', crs: 'BLY', assocIsCancelled: false }],
        std: '17:58',
        etd: 'Cancelled',
        operator: 'LNR & WMR',
        operatorCode: 'LM',
        isCancelled: true,
        cancelReason: 'sanitised cancellation reason',
        serviceType: 'train',
        serviceID: 'sanitised-2',
      },
      {
        origin: [{ locationName: 'London Euston', crs: 'EUS', assocIsCancelled: false }],
        destination: [{ locationName: 'Northampton', crs: 'NMP', assocIsCancelled: false }],
        std: '17:59',
        etd: 'On time',
        platform: '5',
        operator: 'LNR & WMR',
        isCancelled: false,
        serviceType: 'train',
        serviceID: 'sanitised-3',
      },
    ],
    Xmlns: { Count: 8 },
    generatedAt: '2026-08-10T17:48:52.4905645+01:00',
    locationName: 'Milton Keynes Central',
    crs: 'MKC',
    filterType: 'to',
    nrccMessages: [{ Value: 'sanitised disruption message' }],
    platformAvailable: true,
    areServicesAvailable: true,
  })) as typeof fetch);

  const result = await source.fetch(ROUTE, new AbortController().signal);
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;

  assert.deepEqual(result.data.departures, [
    { scheduled: '17:49', expected: '17:54', status: 'delayed', delayMinutes: 5, platform: '4' },
    { scheduled: '17:58', expected: null, status: 'cancelled', delayMinutes: null, platform: null },
    { scheduled: '17:59', expected: null, status: 'on-time', delayMinutes: 0, platform: '5' },
  ]);
});

test('normalises lowercase route codes before the request', async () => {
  let seen = '';
  const source = sourceWith((async (input) => {
    seen = String(input);
    return jsonResponse({ trainServices: [] });
  }) as typeof fetch);
  const result = await source.fetch({ originCrs: 'mkc', destinationCrs: 'eus' }, new AbortController().signal);
  assert.equal(result.status, 'ok');
  assert.match(seen, /GetDepartureBoard\/MKC/);
  assert.match(seen, /filterCrs=EUS/);
});

test('a successful empty board is valid data, not a source failure', async () => {
  const source = sourceWith((async () => jsonResponse({ trainServices: null })) as typeof fetch);
  const result = await source.fetch(ROUTE, new AbortController().signal);
  assert.equal(result.status, 'ok');
  if (result.status === 'ok') assert.deepEqual(result.data.departures, []);
});

test('malformed individual services are dropped without poisoning valid rows', async () => {
  const source = sourceWith((async () => jsonResponse({
    trainServices: [
      { nonsense: true },
      { std: '09:10', etd: 'Delayed', platform: null },
      { std: 123, etd: 'On time' },
    ],
  })) as typeof fetch);
  const result = await source.fetch(ROUTE, new AbortController().signal);
  assert.equal(result.status, 'ok');
  if (result.status === 'ok') {
    assert.equal(result.data.departures.length, 1);
    assert.equal(result.data.departures[0]?.scheduled, '09:10');
    assert.equal(result.data.departures[0]?.status, 'delayed');
  }
});

test('a non-empty board with no usable services fails closed', async () => {
  const source = sourceWith((async () => jsonResponse({
    trainServices: [
      { nonsense: true },
      { std: 123, etd: 'On time' },
      { std: 'not-a-time', etd: 'Delayed', platform: '1' },
    ],
  })) as typeof fetch);
  const result = await source.fetch(ROUTE, new AbortController().signal);
  assert.deepEqual(result, { status: 'error', error: 'National Rail returned no usable train services' });
});

test('fundamentally malformed departure-board JSON fails cleanly', async () => {
  const source = sourceWith((async () => jsonResponse({ trainServices: 'not-an-array' })) as typeof fetch);
  const result = await source.fetch(ROUTE, new AbortController().signal);
  assert.deepEqual(result, { status: 'error', error: 'National Rail returned an invalid departure board' });
});

test('invalid JSON and non-JSON responses fail without exposing credentials', async () => {
  const invalid = sourceWith((async () => new Response('{broken', {
    status: 200, headers: { 'content-type': 'application/json' },
  })) as typeof fetch);
  assert.deepEqual(
    await invalid.fetch(ROUTE, new AbortController().signal),
    { status: 'error', error: 'National Rail returned invalid JSON' },
  );

  const html = sourceWith((async () => new Response('<html>nope</html>', {
    status: 200, headers: { 'content-type': 'text/html' },
  })) as typeof fetch);
  const result = await html.fetch(ROUTE, new AbortController().signal);
  assert.deepEqual(result, { status: 'error', error: 'National Rail returned a non-JSON response' });
  assert.doesNotMatch(JSON.stringify(result), /super-secret-key/);
});

test('non-2xx responses never reflect secret response bodies', async () => {
  const source = sourceWith((async () => new Response('super-secret-key upstream diagnostic', {
    status: 401, headers: { 'content-type': 'text/plain' },
  })) as typeof fetch);
  const result = await source.fetch(ROUTE, new AbortController().signal);
  assert.deepEqual(result, { status: 'error', error: 'National Rail request failed (HTTP 401)' });
  assert.doesNotMatch(JSON.stringify(result), /super-secret-key/);
});

test('response body is bounded before JSON parsing', async () => {
  const body = 'x'.repeat(1025);
  const source = sourceWith((async () => new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
  })) as typeof fetch, { maxResponseBytes: 1024 });
  const result = await source.fetch(ROUTE, new AbortController().signal);
  assert.deepEqual(result, { status: 'error', error: 'National Rail response exceeded size limit' });
});

test('passes the caller AbortSignal to fetch', async () => {
  const source = sourceWith(((input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    assert.match(String(input), /GetDepartureBoard/);
    const signal = init?.signal;
    assert.ok(signal);
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  })) as typeof fetch);
  const controller = new AbortController();
  const pending = source.fetch(ROUTE, controller.signal);
  controller.abort();
  await assert.rejects(pending, (err: unknown) => err instanceof DOMException && err.name === 'AbortError');
});

test('source configuration refuses insecure endpoints and empty API keys', () => {
  assert.throws(() => createNationalRailTrainSource({
    baseUrl: 'http://rail.example/', apiKey: 'secret',
  }), /must use HTTPS/);
  assert.throws(() => createNationalRailTrainSource({
    baseUrl: 'https://user:pass@rail.example/', apiKey: 'secret',
  }), /must not contain credentials/);
  assert.throws(() => createNationalRailTrainSource({ apiKey: '' }), /API key is required/);
});
