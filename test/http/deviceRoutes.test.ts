import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/http/app.ts';
import { DeviceStore } from '../../src/devices/store.ts';
import type { FrameService } from '../../src/render/frameService.ts';

const ETAG = 'a'.repeat(32);

/** A frame service stub — these tests are about the HTTP contract, not pixels. */
function stubFrames(): FrameService {
  return {
    frameFor: async () => ({ buffer: Buffer.alloc(48000, 0), etag: ETAG, renderedAt: '2026-08-03T07:42:00.000Z' }),
    enrolmentFrame: async () => ({ buffer: Buffer.alloc(48000, 1), etag: 'b'.repeat(32), renderedAt: '2026-08-03T07:42:00.000Z' }),
    previewHtml: async () => '<html></html>',
    sourceIssues: () => [],
    renderedDeviceCount: () => 0,
    warmUp: async () => {},
  } as unknown as FrameService;
}

async function withServer(
  fn: (base: string, store: DeviceStore) => Promise<void>,
  frames: FrameService = stubFrames(),
) {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-http-'));
  const store = new DeviceStore(join(dir, 'config.json'));
  const app = createApp({
    store, frames, publicBaseUrl: 'http://test.local:8080', dataDir: dir, firmwareDir: dir,
    auth: { password: null, secret: randomBytes(32) },
  });
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

async function claim(store: DeviceStore, id: string) {
  await store.getOrCreate(id);
  // Quiet hours off, so X-Next-Wake-Seconds is deterministically the active
  // interval. The route computes the wake from `new Date()`, so with the
  // default 23:00-06:00 window these tests asserted 900 but got the seconds
  // until 06:00 for seven hours of every night — red overnight, green by
  // morning, for reasons having nothing to do with the code under test.
  // Quiet-hours behaviour itself is covered properly in
  // test/schedule/nextWake.test.ts, which injects `now` instead of reading it.
  await store.update(id, { claimed: true, quietHoursStart: 0, quietHoursEnd: 0 });
}

test('serves an enrolment frame for an unknown device', async () => {
  await withServer(async (base, store) => {
    const res = await fetch(`${base}/api/devices/esp32-new/frame`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/octet-stream');
    assert.equal((await res.arrayBuffer()).byteLength, 48000);
    assert.equal((await store.get('esp32-new'))?.claimed, false, 'auto-registered as unclaimed');
  });
});

test('unclaimed devices are told to come back quickly', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/devices/esp32-new/frame`);
    assert.equal(res.headers.get('x-next-wake-seconds'), '60');
  });
});

test('serves a full frame with an ETag once claimed', async () => {
  await withServer(async (base, store) => {
    await claim(store, 'esp32-1');
    const res = await fetch(`${base}/api/devices/esp32-1/frame`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('etag'), `"${ETAG}"`);
    assert.equal(res.headers.get('x-next-wake-seconds'), '900');
    assert.equal((await res.arrayBuffer()).byteLength, 48000);
  });
});

test('returns 304 when the device already has the frame', async () => {
  await withServer(async (base, store) => {
    await claim(store, 'esp32-1');
    const res = await fetch(`${base}/api/devices/esp32-1/frame`, {
      headers: { 'if-none-match': `"${ETAG}"` },
    });
    assert.equal(res.status, 304);
    assert.equal(res.headers.get('x-next-wake-seconds'), '900');
    assert.equal((await res.arrayBuffer()).byteLength, 0, '304 must carry no body');
  });
});

test('a stale ETag still gets a full frame', async () => {
  await withServer(async (base, store) => {
    await claim(store, 'esp32-1');
    const res = await fetch(`${base}/api/devices/esp32-1/frame`, {
      headers: { 'if-none-match': '"stale-etag-value"' },
    });
    assert.equal(res.status, 200);
    assert.equal((await res.arrayBuffer()).byteLength, 48000);
  });
});

test('records battery, firmware and last-seen from request headers', async () => {
  await withServer(async (base, store) => {
    await claim(store, 'esp32-1');
    await fetch(`${base}/api/devices/esp32-1/frame`, {
      headers: { 'x-battery-voltage': '3.94', 'x-firmware-version': '0.1.0', 'x-wake-reason': 'timer' },
    });
    const device = await store.get('esp32-1');
    assert.equal(device?.lastBatteryVolts, 3.94);
    assert.equal(device?.lastFirmwareVersion, '0.1.0');
    assert.ok(device?.lastSeenAt);
    assert.equal(device?.lastEtag, ETAG);
  });
});

test('a garbage battery header does not corrupt the record', async () => {
  await withServer(async (base, store) => {
    await claim(store, 'esp32-1');
    await fetch(`${base}/api/devices/esp32-1/frame`, {
      headers: { 'x-battery-voltage': 'not-a-number' },
    });
    assert.equal((await store.get('esp32-1'))?.lastBatteryVolts, null);
  });
});

test('low battery lengthens the reported wake interval', async () => {
  await withServer(async (base, store) => {
    await claim(store, 'esp32-1');
    const res = await fetch(`${base}/api/devices/esp32-1/frame`, {
      headers: { 'x-battery-voltage': '3.2' },
    });
    assert.equal(res.headers.get('x-next-wake-seconds'), '21600');
  });
});

test('rejects a malformed device id rather than creating junk records', async () => {
  await withServer(async (base, store) => {
    const res = await fetch(`${base}/api/devices/..%2Fetc/frame`);
    assert.equal(res.status, 400);
    assert.deepEqual(await store.list(), []);
  });
});

test('returns 503 with a retry interval when rendering fails', async () => {
  const failing = {
    frameFor: async () => { throw new Error('chromium died'); },
    enrolmentFrame: async () => { throw new Error('chromium died'); },
    previewHtml: async () => '',
  } as unknown as FrameService;

  await withServer(async (base, store) => {
    await claim(store, 'esp32-1');
    const res = await fetch(`${base}/api/devices/esp32-1/frame`);
    assert.equal(res.status, 503);
    assert.ok(Number(res.headers.get('x-next-wake-seconds')) > 0, 'device still needs a schedule');
  }, failing);
});

test('a failed render stores the same retry interval it sends', async () => {
  const failing = {
    frameFor: async () => { throw new Error('chromium died'); },
    enrolmentFrame: async () => { throw new Error('chromium died'); },
    previewHtml: async () => '',
  } as unknown as FrameService;

  await withServer(async (base, store) => {
    await claim(store, 'esp32-1');
    const res = await fetch(`${base}/api/devices/esp32-1/frame`);
    assert.equal(res.status, 503);
    const handed = Number(res.headers.get('x-next-wake-seconds'));
    assert.equal((await store.get('esp32-1'))?.lastWakeSeconds, handed,
      'stored lastWakeSeconds must match the retry interval actually sent, not the pre-failure value');
  }, failing);
});

test('records the wake interval it handed out', async () => {
  await withServer(async (base, store) => {
    await claim(store, 'esp32-1');
    const res = await fetch(`${base}/api/devices/esp32-1/frame`);
    const handed = Number(res.headers.get('x-next-wake-seconds'));
    assert.equal((await store.get('esp32-1'))?.lastWakeSeconds, handed,
      'what we told the device must match what we remember telling it');
  });
});
