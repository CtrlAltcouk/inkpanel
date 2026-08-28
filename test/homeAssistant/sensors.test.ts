import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HomeAssistantClient } from '../../src/homeAssistant/client.ts';
import { homeAssistantSensorStateSchema } from '../../src/homeAssistant/sensorSchemas.ts';

const SECRET = 'do-not-expose-supervisor-token';
const state = (entity_id = 'sensor.living_room', overrides = {}) => ({
  entity_id, state: ' 21.40 ', last_changed: 'private-time',
  attributes: { friendly_name: ' Living Room ', unit_of_measurement: ' °C ', device_class: ' temperature ', secret: SECRET },
  ...overrides,
});

test('sensor discovery projects only bounded safe sensor fields, deduplicates and ignores malformed sensors', async () => {
  const client = new HomeAssistantClient({ enabled: true, token: SECRET, fetchImpl: async (url, init) => {
    assert.equal(String(url), 'http://supervisor/core/api/states');
    assert.equal(init?.method, 'GET');
    assert.equal((init?.headers as Record<string, string>).authorization, `Bearer ${SECRET}`);
    return Response.json([
      state(), state(), state('light.kitchen'), state('binary_sensor.door'),
      state('sensor.battery_level', { state: '89', attributes: {} }),
      state('sensor.bad/name'), state('sensor.too_long', { state: 'x'.repeat(256) }),
      state('sensor.number', { state: 123 }), state('sensor.bad_attributes', { attributes: [] }),
    ]);
  } });
  const result = await client.listSensors();
  assert.equal(result.supported, true);
  assert.equal(result.available, true);
  assert.equal(result.entities.length, 2);
  assert.deepEqual(result.entities.find((entry) => entry.entityId === 'sensor.living_room'), {
    entityId: 'sensor.living_room', name: 'Living Room', state: '21.40', unit: '°C', deviceClass: 'temperature',
  });
  assert.deepEqual(result.entities.find((entry) => entry.entityId === 'sensor.battery_level'), {
    entityId: 'sensor.battery_level', name: 'battery level', state: '89', unit: null, deviceClass: null,
  });
  assert.doesNotMatch(JSON.stringify(result), /do-not-expose|last_changed|attributes|private-time/);
});

test('malformed discovery envelopes and HA errors fail safely without erasing capability', async () => {
  for (const payload of [{ states: [] }, [null], [{ entity_id: 1 }]]) {
    const result = await new HomeAssistantClient({ enabled: true, token: SECRET, fetchImpl: async () => Response.json(payload) }).listSensors();
    assert.equal(result.supported, true);
    assert.equal(result.available, false);
    assert.deepEqual(result.entities, []);
    assert.match(result.error!, /invalid sensor discovery/);
  }
  const failed = await new HomeAssistantClient({ enabled: true, token: SECRET, fetchImpl: async () => { throw new Error(SECRET); } }).listSensors();
  assert.deepEqual(failed, { supported: true, available: false, entities: [], error: 'Home Assistant is unavailable' });
  const disabled = await new HomeAssistantClient({ enabled: false, fetchImpl: async () => { throw new Error('must not fetch'); } }).listSensors();
  assert.deepEqual(disabled, { supported: false, available: false, entities: [], error: null });
});

test('individual sensor reads validate identity before a GET to the encoded state endpoint', async () => {
  const calls: string[] = [];
  const client = new HomeAssistantClient({ enabled: true, token: SECRET, fetchImpl: async (url, init) => {
    calls.push(String(url));
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'error');
    return Response.json(state());
  } });
  for (const id of ['light.living_room', 'sensor.a/../../config', 'sensor.a?x=1', 'sensor.A', 'sensor.', `sensor.${'a'.repeat(250)}`]) {
    assert.equal((await client.getSensorState(id)).available, false);
  }
  assert.equal(calls.length, 0);
  const result = await client.getSensorState('sensor.living_room');
  assert.deepEqual(calls, [`http://supervisor/core/api/states/${encodeURIComponent('sensor.living_room')}`]);
  assert.equal(result.available, true);
  if (result.available) assert.deepEqual(result.data, {
    entityId: 'sensor.living_room', name: 'Living Room', state: '21.40', unit: '°C', deviceClass: 'temperature', available: true,
  });
  assert.equal((await client.getSensorState('sensor.other')).available, false, 'a mismatched response cannot supply another sensor');
});

test('sensor strings retain HA units and mark unknown/unavailable/invalid numeric placeholders honestly', () => {
  for (const value of ['unknown', 'unavailable', 'NaN', 'undefined', 'null']) {
    assert.equal(homeAssistantSensorStateSchema.parse(state(undefined, { state: value })).available, false);
  }
  for (const value of ['-21.40', '0', '312', 'online']) {
    const result = homeAssistantSensorStateSchema.parse(state(undefined, { state: value }));
    assert.equal(result.state, value);
    assert.equal(result.available, true);
  }
  const fallback = homeAssistantSensorStateSchema.parse(state(undefined, {
    attributes: { friendly_name: 123, unit_of_measurement: 'x'.repeat(33), device_class: ['temperature'] },
  }));
  assert.equal(fallback.name, 'living room');
  assert.equal(fallback.unit, null);
  assert.equal(fallback.deviceClass, null);
});

test('individual sensor errors, timeouts and cancellation never expose upstream secrets', async () => {
  for (const status of [404, 401, 500, 503]) {
    const result = await new HomeAssistantClient({ enabled: true, token: SECRET, fetchImpl: async () => new Response(SECRET, { status }) }).getSensorState('sensor.living_room');
    assert.equal(result.available, false);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET));
  }
  const fetchImpl: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
    if (init?.signal?.aborted) reject(new Error(SECRET));
    else init?.signal?.addEventListener('abort', () => reject(new Error(SECRET)), { once: true });
  });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const client = new HomeAssistantClient({ enabled: true, token: SECRET, timeoutMs: 10, fetchImpl });
    const timedOut = await client.getSensorState('sensor.living_room');
    assert.deepEqual(timedOut, { available: false, error: 'Home Assistant request timed out' });
    const controller = new AbortController(); controller.abort();
    assert.deepEqual(await client.getSensorState('sensor.living_room', controller.signal), { available: false, error: 'Home Assistant request was cancelled' });
  } finally { clearTimeout(keepAlive); }
});
