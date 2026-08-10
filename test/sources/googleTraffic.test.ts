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

test('Google traffic source requests TRAFFIC_AWARE driving route and retains returned durations', async () => {
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
          duration: '2160s',
          staticDuration: '1440s',
          distanceMeters: 28968,
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
  assert.match(seenHeaders.get('X-Goog-FieldMask') ?? '', /routes\.duration/);
  assert.deepEqual(seenBody, {
    origin: { address: 'Milton Keynes' },
    destination: { address: 'London Euston' },
    travelMode: 'DRIVE',
    routingPreference: 'TRAFFIC_AWARE',
    languageCode: 'en-GB',
    units: 'IMPERIAL',
  });
  assert.equal(result.data.durationMinutes, 36);
  assert.equal(result.data.staticDurationMinutes, 24);
  assert.equal(result.data.distanceMiles, 18);
  assert.equal(result.data.description, 'A5 and M1');
  assert.equal('delayMinutes' in result.data, false, 'do not create a derived Google Maps metric');
});

test('Google traffic source preserves provider warnings for display', async () => {
  const source = createGoogleTrafficSource({
    apiKey: API_KEY,
    fetchImpl: (async () => jsonResponse({
      routes: [{ duration: '600s', staticDuration: '540s', warnings: ['Private road restrictions may apply'] }],
    })) as typeof fetch,
  });
  const result = await source.fetch(
    { origin: 'A', destination: 'B' },
    new AbortController().signal,
  );
  assert.equal(result.status, 'ok');
  if (result.status === 'ok') assert.equal(result.data.warning, 'Private road restrictions may apply');
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
