import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HomeAssistantClient } from '../../src/homeAssistant/client.ts';

const token = 'supervisor-secret-not-for-output';
const response = (items: unknown[] = []) => ({ changed_states: [{ attributes: { token } }], service_response: { 'todo.home': { items } } });
const item = (summary: string, status = 'needs_action') => ({ summary, status, uid: token, description: token, due: token });

test('To Do discovery filters states and projects safe friendly/fallback names', async () => {
  const client = new HomeAssistantClient({ enabled: true, token, fetchImpl: async (url, init) => {
    assert.equal(String(url), 'http://supervisor/core/api/states');
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${token}`);
    return Response.json([
      { entity_id: 'sensor.secret', attributes: { token } },
      { entity_id: 'todo.home', attributes: { friendly_name: ' Home tasks ', token }, state: '2' },
      { entity_id: 'todo.shopping_list', attributes: { friendly_name: 123, token } },
      { entity_id: 'todo.work', attributes: {} },
    ]);
  } });
  assert.deepEqual(await client.listTodoLists(), { supported: true, available: true, error: null, lists: [
    { entityId: 'todo.home', name: 'Home tasks' }, { entityId: 'todo.shopping_list', name: 'shopping list' },
    { entityId: 'todo.work', name: 'work' },
  ] });
});

test('To Do discovery is unsupported offline and rejects malformed responses safely', async () => {
  const disabled = new HomeAssistantClient({ enabled: false, fetchImpl: async () => { assert.fail('no standalone HA fetch'); } });
  assert.deepEqual(await disabled.listTodoLists(), { supported: false, available: false, lists: [], error: null });
  for (const body of [{ states: [] }, [null], [{ attributes: {} }], [{ entity_id: 'todo.bad/path' }]]) {
    const client = new HomeAssistantClient({ enabled: true, token, fetchImpl: async () => Response.json(body) });
    assert.deepEqual(await client.listTodoLists(), { supported: true, available: false, lists: [], error: 'Home Assistant returned an invalid To Do discovery response' });
  }
  const offline = new HomeAssistantClient({ enabled: true, token, fetchImpl: async () => { throw new Error(token); } });
  assert.equal((await offline.listTodoLists()).error, 'Home Assistant is unavailable');
});

test('get_items posts needs_action with return_response, preserves order and projects five texts only', async () => {
  const client = new HomeAssistantClient({ enabled: true, baseUrl: 'http://ha.test/api', token, fetchImpl: async (url, init) => {
    assert.equal(String(url), 'http://ha.test/api/services/todo/get_items?return_response');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${token}`);
    assert.equal(new Headers(init?.headers).get('content-type'), 'application/json');
    assert.deepEqual(JSON.parse(String(init?.body)), { entity_id: 'todo.home', status: 'needs_action' });
    return Response.json(response([item(' Done ', 'completed'), ...[' Z ', 'A', 'C', 'B', 'E', 'Hidden'].map((text) => item(text))]));
  } });
  assert.deepEqual(await client.getTodoItems('todo.home'), { available: true, data: { items: ['Z', 'A', 'C', 'B', 'E'] } });
});

test('get_items validates IDs before HTTP and rejects malformed service data', async () => {
  let calls = 0;
  let body: unknown = response();
  const client = new HomeAssistantClient({ enabled: true, token, fetchImpl: async () => { calls++; return Response.json(body); } });
  for (const id of ['', 'calendar.home', 'todo.A', 'todo.x/../../services', 'todo.x?token=secret', `todo.${'a'.repeat(256)}`]) {
    assert.equal((await client.getTodoItems(id)).available, false);
  }
  assert.equal(calls, 0);
  assert.deepEqual(await client.getTodoItems('todo.home'), { available: true, data: { items: [] } });
  for (const invalid of [[], {}, { ...response(), changed_states: null },
    { changed_states: [], service_response: { 'todo.other': { items: [] } } },
    response([item(' ')]), response([item('Text', 'unknown')]), response([{ summary: 'Text' }]),
    response([{ summary: 12, status: 'needs_action' }]), response([null]),
  ]) {
    body = invalid;
    assert.deepEqual(await client.getTodoItems('todo.home'), { available: false, error: 'Home Assistant returned an invalid To Do items response' });
  }
});

test('POST service errors, timeouts and caller cancellation are safe and retryable', async () => {
  for (const status of [400, 401, 404, 500, 503]) {
    const client = new HomeAssistantClient({ enabled: true, token, fetchImpl: async () => new Response(token, { status }) });
    assert.deepEqual(await client.getTodoItems('todo.home'), { available: false, error: `Home Assistant request failed (${status})` });
  }
  const client = new HomeAssistantClient({ enabled: true, token, timeoutMs: 10,
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(token)), 500);
      const abort = () => { clearTimeout(timer); reject(new Error(token)); };
      if (init?.signal?.aborted) abort();
      else init?.signal?.addEventListener('abort', abort, { once: true });
    }),
  });
  assert.deepEqual(await client.getTodoItems('todo.home'), { available: false, error: 'Home Assistant request timed out' });
  assert.deepEqual(await client.getTodoItems('todo.home', AbortSignal.abort()), { available: false, error: 'Home Assistant request was cancelled' });
});
