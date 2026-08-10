import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGoogleTrafficSource } from '../../src/sources/googleTraffic.ts';

const API_KEY = 'AIza' + 'x'.repeat(35);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('Google traffic source requests TRAFFIC_AWARE driving route and retains localized durations', async () => {
  let seenUrl = '';
  let seenHeaders = new Headers();
  let seenBody: unknown = null;
  const source = createGoogleTrafficSource({
    apiKey: API_KEY,
    fetchImpl: (async (input, init) => {
      seenUrl = String(input);
      seenHeaders = new Headers(init?.headers);
      seenBody = JSON.parse(String(init?.body));
      return jsonResponse({
        routes: [{
          localizedValues: {
            duration: { text: '36 mins' },
            staticDuration: { text: '24 mins' },
          },
          description: 'A5 and M1',
          warnings: [],
        }],
      });
    }) as typeof fetch,
  });

  const result = await source.fetch(
    { origin: 'Milton Keynes', destination: 'London Euston' },
    new AbortController().signal,
  );

  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;
  assert.equal(seenUrl, 'https://routes.googleapis.com/directions/v2:computeRoutes');
  assert.equal(seenHeaders.get('X-Goog-Api-Key'), API_KEY);
  assert.match(seenHeaders.get('X-Goog-FieldMask') ?? '', /routes\.localizedValues/);
  assert.deepEqual(seenBody, {
    origin: { address: 'Milton Keynes' },
    destination: { address: 'London Euston' },
    travelMode: 'DRIVE',
    routingPreference: 'TRAFFIC_AWARE',
    languageCode: 'en-GB',
    units: 'IMPERIAL',
  });
  assert.equal(result.data.durationText, '36 mins');
  assert.equal(result.data.staticDurationText, '24 mins');
  assert.equal(result.data.description, 'A5 and M1');
  assert.equal('durationMinutes' in result.data, false, 'do not manufacture a duration value from Google Maps Content');
  assert.equal('delayMinutes' in result.data, false, 'do not create a derived Google Maps metric');
});

test('Google traffic source preserves provider warnings for display', async () => {
  const source = createGoogleTrafficSource({
    apiKey: API_KEY,
    fetchImpl: (async () => jsonResponse({
      routes: [{
        localizedValues: {
          duration: { text: '10 mins' },
          staticDuration: { text: '9 mins' },
        },
        warnings: ['Private road restrictions may apply'],
      }],
    })) as typeof fetch,
  });
  const result = await source.fetch(
    { origin: 'A', destination: 'B' },
    new AbortController().signal,
  );
  assert.equal(result.status, 'ok');
  if (result.status === 'ok') assert.equal(result.data.warning, 'Private road restrictions may apply');
});

test('Google traffic rejects a route missing required localized duration values', async () => {
  const source = createGoogleTrafficSource({
    apiKey: API_KEY,
    fetchImpl: (async () => jsonResponse({ routes: [{ description: 'A5' }] })) as typeof fetch,
  });
  const result = await source.fetch(
    { origin: 'A', destination: 'B' },
    new AbortController().signal,
  );
  assert.deepEqual(result, { status: 'error', error: 'Google Routes returned an invalid route' });
});

test('Google traffic HTTP errors do not reflect the API key or response body', async () => {
  const source = createGoogleTrafficSource({
    apiKey: API_KEY,
    fetchImpl: (async () => jsonResponse({ error: { message: API_KEY } }, 403)) as typeof fetch,
  });
  const result = await source.fetch(
    { origin: 'A', destination: 'B' },
    new AbortController().signal,
  );
  assert.equal(result.status, 'error');
  if (result.status === 'error') {
    assert.equal(result.error, 'Google Routes request failed (HTTP 403)');
    assert.doesNotMatch(result.error, new RegExp(API_KEY));
  }
});

test('Google Routes endpoint must be HTTPS and credential-free', () => {
  assert.throws(
    () => createGoogleTrafficSource({ apiKey: API_KEY, endpoint: 'http://routes.example.test/compute' }),
    /HTTPS/,
  );
  assert.throws(
    () => createGoogleTrafficSource({ apiKey: API_KEY, endpoint: 'https://user:pass@routes.example.test/compute' }),
    /credentials/,
  );
});
