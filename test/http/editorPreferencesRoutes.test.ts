import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceStore } from '../../src/devices/store.ts';
import { editorPreferencesRoutes } from '../../src/http/editorPreferencesRoutes.ts';

async function withServer(fn: (base: string, store: DeviceStore) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-editor-pref-http-'));
  const store = new DeviceStore(join(dir, 'config.json'));
  await store.getOrCreate('esp32-a');
  await store.getOrCreate('esp32-b');

  const app = express();
  app.use(express.json());
  app.use('/api', editorPreferencesRoutes(store, dir));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await fn(`http://127.0.0.1:${port}`, store);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const slots = [
  [
    { type: 'calendar', version: 1, config: { calendarUrls: ['https://calendar.example/private.ics'] } },
    { type: 'bins', version: 1, config: { uprn: '25006645' } },
  ],
  [{ type: 'octopus', version: 1, config: { tariffCode: 'E-1R-AGILE-24-10-01-C' } }],
  [],
  [],
];

test('remembered dashboard settings round-trip per device and become shared fallbacks', async () => {
  await withServer(async (base) => {
    const empty = await fetch(`${base}/api/dashboard-editor/esp32-a`);
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), { shared: [], slots: [[], [], [], []] });

    const saved = await fetch(`${base}/api/dashboard-editor/esp32-a`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slots }),
    });
    assert.equal(saved.status, 200);
    const savedBody = await saved.json() as { shared: Array<{ type: string }>; slots: unknown[] };
    assert.equal(savedBody.slots.length, 4);
    assert.ok(savedBody.shared.some((widget) => widget.type === 'calendar'));
    assert.ok(savedBody.shared.some((widget) => widget.type === 'bins'));
    assert.ok(savedBody.shared.some((widget) => widget.type === 'octopus'));

    const other = await fetch(`${base}/api/dashboard-editor/esp32-b`);
    assert.equal(other.status, 200);
    const otherBody = await other.json() as { shared: Array<{ type: string }>; slots: unknown[] };
    assert.deepEqual(otherBody.slots, [[], [], [], []]);
    assert.ok(otherBody.shared.some((widget) => widget.type === 'bins'));
  });
});

test('remembered dashboard API rejects malformed drafts and unknown devices', async () => {
  await withServer(async (base) => {
    const malformed = await fetch(`${base}/api/dashboard-editor/esp32-a`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slots: [[{ type: 'future-widget', version: 1, config: {} }], [], [], []] }),
    });
    assert.equal(malformed.status, 400);

    const missing = await fetch(`${base}/api/dashboard-editor/esp32-missing`);
    assert.equal(missing.status, 404);
  });
});
