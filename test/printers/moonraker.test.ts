import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MOONRAKER_OBJECT_QUERY, MoonrakerClient } from '../../src/printers/moonraker.ts';
import type { PrinterConnection } from '../../src/printers/store.ts';

const connection: PrinterConnection = {
  id: '11111111-1111-4111-8111-111111111111', name: 'Voron 2.4',
  baseUrl: 'http://printer.local/moonraker', apiKey: 'top-secret',
};

test('queries the official object shape with X-Api-Key and normalizes printing plus metadata ETA', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = new MoonrakerClient(async (input, init) => {
    requests.push({ url: String(input), init });
    if (String(input).includes('/server/files/metadata')) return Response.json({ result: { estimated_time: 5000 } });
    return Response.json({ result: { status: {
      webhooks: { state: 'ready', state_message: 'Printer is ready' },
      print_stats: { state: 'printing', filename: 'jobs/Benchy.gcode', print_duration: 680, info: { current_layer: 10, total_layer: 100 } },
      virtual_sdcard: { progress: 0.2 }, display_status: { progress: 0.684 },
      extruder: { temperature: 219.6, target: 220 }, heater_bed: { temperature: 59.6, target: 60 },
    } } });
  }, 1000);
  const result = await client.query(connection);
  assert.equal(requests[0]?.url, 'http://printer.local/moonraker/printer/objects/query');
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), MOONRAKER_OBJECT_QUERY);
  assert.equal(new Headers(requests[0]?.init?.headers).get('X-Api-Key'), 'top-secret');
  assert.match(requests[1]?.url ?? '', /metadata\?filename=jobs%2FBenchy\.gcode/);
  assert.deepEqual(result, {
    name: 'Voron 2.4', state: 'printing', filename: 'Benchy.gcode', progressPercent: 68,
    elapsedSeconds: 680, remainingSeconds: 4320, currentLayer: 10, totalLayers: 100,
    nozzle: { current: 220, target: 220 }, bed: { current: 60, target: 60 }, message: null,
  });
});

test('omits the key header, falls back to virtual_sdcard, clamps progress, and tolerates optional objects', async () => {
  const headers: Headers[] = [];
  const client = new MoonrakerClient(async (_input, init) => {
    headers.push(new Headers(init?.headers));
    return Response.json({ result: { status: {
      print_stats: { state: 'paused', filename: 'cube.gcode', print_duration: 12, info: {} },
      virtual_sdcard: { progress: 1.8 }, extruder: { temperature: 25, target: 0 },
    } } });
  });
  const result = await client.query({ ...connection, apiKey: null, baseUrl: 'http://printer.local' });
  assert.equal(headers.every((header) => header.get('X-Api-Key') === null), true);
  assert.equal(result.state, 'paused');
  assert.equal(result.progressPercent, 100);
  assert.equal(result.bed, null);
  assert.equal(result.currentLayer, null);
  assert.equal(result.remainingSeconds, null);
});

test('maps print_stats states and webhooks failures intentionally', async () => {
  for (const [raw, expected] of [['complete', 'complete'], ['cancelled', 'cancelled'], ['error', 'error'], ['standby', 'idle']] as const) {
    const client = new MoonrakerClient(async () => Response.json({ result: { status: { webhooks: { state: 'ready' }, print_stats: { state: raw } } } }));
    assert.equal((await client.query({ ...connection, apiKey: null })).state, expected);
  }
  const failed = new MoonrakerClient(async () => Response.json({ result: { status: { webhooks: { state: 'shutdown', state_message: 'MCU lost' }, print_stats: { state: 'printing' } } } }));
  assert.deepEqual((await failed.query({ ...connection, apiKey: null })).state, 'error');
});

test('rejects malformed responses and reports network failure without URL or key disclosure', async () => {
  const malformed = new MoonrakerClient(async () => Response.json({ result: { status: {} } }));
  await assert.rejects(() => malformed.query(connection), /no printer status/);
  const offline = new MoonrakerClient(async () => { throw new Error(`leak ${connection.apiKey} ${connection.baseUrl}`); });
  await assert.rejects(() => offline.query(connection), (err: unknown) => {
    assert.equal(err instanceof Error ? err.message : '', 'Moonraker unavailable');
    return true;
  });
});
