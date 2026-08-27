import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HomeAssistantClient, isHomeAssistantMode } from '../../src/homeAssistant/client.ts';

const installationConfig = {
  version: '2026.8.1', latitude: -36.85, longitude: 174.76,
  time_zone: 'Pacific/Auckland', location_name: 'Home',
};

test('installation location validates config and exposes only device location fields', async () => {
  const client = new HomeAssistantClient({
    enabled: true, token: 'super-secret-token',
    fetchImpl: async (input, init) => {
      assert.equal(String(input), 'http://supervisor/core/api/config');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer super-secret-token');
      return Response.json({ ...installationConfig, token: 'super-secret-token', extra: 'not a device field' });
    },
  });
  assert.deepEqual(await client.installationLocation(), { available: true, data: {
    latitude: -36.85, longitude: 174.76, timezone: 'Pacific/Auckland', locationLabel: 'Home',
  } });
  assert.equal((await client.status()).version, '2026.8.1', 'diagnostic probe remains available');
});

test('malformed installation location is rejected without reflecting input or credentials', async () => {
  for (const patch of [
    { latitude: -91 }, { latitude: 91 }, { latitude: '52.04' }, { latitude: null },
    { latitude: undefined }, { latitude: Infinity }, { latitude: NaN },
    { longitude: -181 }, { longitude: 181 }, { longitude: '0' }, { longitude: undefined },
    { time_zone: '' }, { time_zone: '  ' }, { time_zone: 'Invalid/secret-token' },
    { location_name: '' }, { location_name: '  ' }, { location_name: null }, { version: null },
  ]) {
    const client = new HomeAssistantClient({
      enabled: true, token: 'secret-token',
      fetchImpl: async () => Response.json({ ...installationConfig, ...patch }),
    });
    assert.deepEqual(await client.installationLocation(), {
      available: false, error: 'Home Assistant returned an invalid installation config response',
    });
  }
});

test('installation location accepts coordinate boundaries and trims names', async () => {
  for (const [latitude, longitude] of [[-90, -180], [90, 180], [0, 0]]) {
    const client = new HomeAssistantClient({
      enabled: true, token: 'secret', fetchImpl: async () => Response.json({
        ...installationConfig, latitude, longitude, location_name: ' Home ', time_zone: ' UTC ',
      }),
    });
    assert.deepEqual(await client.installationLocation(), { available: true, data: {
      latitude, longitude, locationLabel: 'Home', timezone: 'UTC',
    } });
  }
});

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
