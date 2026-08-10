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
    authHeaderName: 'X-Consumer-Key',
    authHeaderValue: 'super-secret-key',
    fetchImpl,
    ...overrides,
  });
}

test('requests a filtered departure board and maps live services', async () => {
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
  assert.equal(new Headers(seenInit?.headers).get('x-consumer-key'), 'super-secret-key');
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
  assert.equal(result.data.departures[2]?.status, 'cancelled', 'isCancelled overrides a benign etd');
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

test('non-2xx responses return only status and never reflect secret response bodies', async () => {
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

test('source configuration refuses insecure or credential-bearing endpoints', () => {
  assert.throws(() => createNationalRailTrainSource({
    baseUrl: 'http://rail.example/', authHeaderValue: 'secret',
  }), /must use HTTPS/);
  assert.throws(() => createNationalRailTrainSource({
    baseUrl: 'https://user:pass@rail.example/', authHeaderValue: 'secret',
  }), /must not contain credentials/);
  assert.throws(() => createNationalRailTrainSource({
    baseUrl: 'https://rail.example/', authHeaderValue: '',
  }), /auth value is required/);
  assert.throws(() => createNationalRailTrainSource({
    baseUrl: 'https://rail.example/', authHeaderName: 'bad header', authHeaderValue: 'secret',
  }), /invalid HTTP header name/);
});
