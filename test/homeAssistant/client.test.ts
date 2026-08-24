import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HomeAssistantClient, isHomeAssistantMode } from '../../src/homeAssistant/client.ts';

test('standalone mode is explicitly unavailable without making a request', async () => {
  let calls = 0;
  const client = new HomeAssistantClient({
    enabled: false,
    fetchImpl: async () => { calls += 1; throw new Error('must not fetch'); },
  });
  assert.deepEqual(await client.status(), {
    available: false, mode: 'standalone', version: null,
    locationName: null, timeZone: null, error: null,
  });
  assert.equal(calls, 0);
  assert.equal(isHomeAssistantMode('1'), true);
  assert.equal(isHomeAssistantMode('true'), false);
  assert.equal((await new HomeAssistantClient({ enabled: false, baseUrl: 'not a URL' }).status()).mode, 'standalone');
});

test('the shared client uses the Supervisor bearer token and normalizes /config', async () => {
  let requestedUrl = '';
  let authorization = '';
  const client = new HomeAssistantClient({
    enabled: true,
    token: 'super-secret-token',
    fetchImpl: async (input, init) => {
      requestedUrl = String(input);
      authorization = new Headers(init?.headers).get('authorization') ?? '';
      return Response.json({ version: '2026.8.1', location_name: 'Home', time_zone: 'Europe/London' });
    },
  });
  assert.deepEqual(await client.status(), {
    available: true, mode: 'home-assistant-app', version: '2026.8.1',
    locationName: 'Home', timeZone: 'Europe/London', error: null,
  });
  assert.equal(requestedUrl, 'http://supervisor/core/api/config');
  assert.equal(authorization, 'Bearer super-secret-token');
});

test('missing credentials and failures produce safe status without reflecting secrets', async () => {
  const missing = new HomeAssistantClient({ enabled: true });
  assert.match((await missing.status()).error ?? '', /token is unavailable/i);

  const token = 'never-reflect-this-token';
  const failed = new HomeAssistantClient({
    enabled: true,
    token,
    fetchImpl: async () => new Response('denied', { status: 401 }),
  });
  const status = await failed.status();
  assert.equal(status.available, false);
  assert.equal(status.error, 'Home Assistant request failed (401)');
  assert.doesNotMatch(JSON.stringify(status), new RegExp(token));
  assert.equal((await new HomeAssistantClient({ enabled: true, baseUrl: 'file:///secret', token }).status()).error,
    'Home Assistant base URL is invalid');
});

test('Home Assistant calls have a bounded timeout', async () => {
  const client = new HomeAssistantClient({
    enabled: true,
    token: 'secret',
    timeoutMs: 5,
    fetchImpl: async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }),
  });
  assert.equal((await client.status()).error, 'Home Assistant request timed out');
});
