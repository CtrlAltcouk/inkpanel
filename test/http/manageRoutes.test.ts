import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/http/app.ts';
import { DeviceStore } from '../../src/devices/store.ts';
import type { FrameService } from '../../src/render/frameService.ts';
import { MILTON_KEYNES } from '../fixtures/geocode.ts';

const frames = {
  frameFor: async () => ({ buffer: Buffer.alloc(48000, 0), etag: 'c'.repeat(32), renderedAt: '2026-08-03T07:42:00.000Z' }),
  enrolmentFrame: async () => ({ buffer: Buffer.alloc(48000, 0), etag: 'd'.repeat(32), renderedAt: '2026-08-03T07:42:00.000Z' }),
  previewHtml: async () => '<html><body>preview</body></html>',
  renderNow: async () => ({ buffer: Buffer.alloc(48000, 0), etag: 'e'.repeat(32), renderedAt: '2026-08-03T07:42:00.000Z' }),
  sourceIssues: () => [],
  renderedDeviceCount: () => 0,
  warmUp: async () => {},
} as unknown as FrameService;

async function withServer(fn: (base: string, store: DeviceStore) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-mgmt-'));
  const store = new DeviceStore(join(dir, 'config.json'));
  const server = createApp({
    store, frames, publicBaseUrl: 'http://test.local:8080', dataDir: dir, firmwareDir: dir,
    auth: { password: null, secret: randomBytes(32) },
  }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await fn(`http://127.0.0.1:${port}`, store);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('lists devices', async () => {
  await withServer(async (base, store) => {
    await store.getOrCreate('esp32-1');
    const res = await fetch(`${base}/api/devices`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { devices: Array<{ id: string }> };
    assert.equal(body.devices[0]?.id, 'esp32-1');
  });
});

test('updates and claims a device', async () => {
  await withServer(async (base, store) => {
    await store.getOrCreate('esp32-1');
    const res = await fetch(`${base}/api/devices/esp32-1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Desk panel', claimed: true, latitude: 52.04, longitude: -0.76 }),
    });
    assert.equal(res.status, 200);
    const device = await store.get('esp32-1');
    assert.equal(device?.name, 'Desk panel');
    assert.equal(device?.claimed, true);
  });
});

test('rejects invalid config instead of corrupting the store', async () => {
  await withServer(async (base, store) => {
    await store.getOrCreate('esp32-1');
    const res = await fetch(`${base}/api/devices/esp32-1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ latitude: 'not a number', activeIntervalSeconds: -5 }),
    });
    assert.equal(res.status, 400);
    assert.equal((await store.get('esp32-1'))?.name, 'Unnamed panel', 'unchanged');
  });
});

test('rejects unknown fields rather than silently ignoring them', async () => {
  await withServer(async (base, store) => {
    await store.getOrCreate('esp32-1');
    const res = await fetch(`${base}/api/devices/esp32-1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lastEtag: 'forged' }),
    });
    assert.equal(res.status, 400, 'telemetry fields are not user-writable');
  });
});

test('rejects a non-URL calendar entry', async () => {
  await withServer(async (base, store) => {
    await store.getOrCreate('esp32-1');
    const res = await fetch(`${base}/api/devices/esp32-1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ calendarUrls: ['not a url'] }),
    });
    assert.equal(res.status, 400);
  });
});

test('rejects an invalid IANA timezone', async () => {
  await withServer(async (base, store) => {
    await store.getOrCreate('esp32-1');
    const res = await fetch(`${base}/api/devices/esp32-1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ timezone: 'Not/A_Timezone' }),
    });
    assert.equal(res.status, 400);
    assert.equal((await store.get('esp32-1'))?.timezone, 'Europe/London');
  });
});

test('serves preview HTML and a PNG of the real output', async () => {
  await withServer(async (base, store) => {
    await store.getOrCreate('esp32-1');
    const html = await fetch(`${base}/api/devices/esp32-1/preview`);
    assert.match(html.headers.get('content-type') ?? '', /text\/html/);

    const png = await fetch(`${base}/api/devices/esp32-1/render.png`);
    assert.equal(png.headers.get('content-type'), 'image/png');
    const bytes = Buffer.from(await png.arrayBuffer());
    assert.deepEqual(bytes.subarray(0, 4), Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'PNG magic');
  });
});

test('health reports device count and liveness', async () => {
  await withServer(async (base, store) => {
    await store.getOrCreate('esp32-1');
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; devices: number };
    assert.equal(body.status, 'ok');
    assert.equal(body.devices, 1);
  });
});

test('404s for an unknown device', async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/api/devices/ghost`)).status, 404);
    assert.equal((await fetch(`${base}/api/devices/ghost/preview`)).status, 404);
  });
});

/**
 * Swap globalThis.fetch for the duration of a test.
 *
 * Requests to Open-Meteo are answered from a fixture; everything else — the
 * test client talking to our own server — passes through untouched.
 */
async function withStubbedGeocoding(payload: unknown, fn: () => Promise<void>) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('geocoding-api.open-meteo.com')) {
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return realFetch(input, init);
  }) as typeof globalThis.fetch;

  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

/**
 * Swap globalThis.fetch for the duration of a test.
 *
 * Requests to Open-Meteo fail the test; everything else — the test client
 * talking to our own server — passes through untouched.
 */
async function withRejectedGeocoding(fn: () => Promise<void>) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('geocoding-api.open-meteo.com')) {
      throw new Error('Test must not call geocoding-api.open-meteo.com');
    }
    return realFetch(input, init);
  }) as typeof globalThis.fetch;

  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('geocode rejects a too-short query without calling upstream', async () => {
  await withRejectedGeocoding(async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/geocode?q=m`);
      assert.equal(res.status, 400);
    });
  });
});

test('geocode returns labelled results', async () => {
  await withStubbedGeocoding(MILTON_KEYNES, async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/geocode?q=milton%20keynes`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { results: Array<{ label: string; timezone: string }> };
      assert.equal(body.results[0]?.label, 'Milton Keynes, England, GB');
      assert.equal(body.results[0]?.timezone, 'Europe/London');
    });
  });
});

test('geocode reports upstream failure as 502 rather than an empty list', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('geocoding-api.open-meteo.com')) {
      return new Response('upstream exploded', { status: 500 });
    }
    return realFetch(input, init);
  }) as typeof globalThis.fetch;

  try {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/geocode?q=milton`);
      assert.equal(res.status, 502, 'no results and cannot look up are different things');
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('serves the config UI and its fonts', async () => {
  await withServer(async (base) => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /inkpanel/);

    const css = await fetch(`${base}/vendor/colors_and_type.css`);
    assert.equal(css.status, 200, 'the vendored design system must be reachable');
    assert.match(await css.text(), /--brand-pink:\s*#f7a4a2/);

    const font = await fetch(`${base}/vendor/fonts/dela-gothic-one-latin-400-normal.woff2`);
    assert.equal(font.status, 200, 'served from @fontsource, not a committed TTF');
  });
});

test('push renders and reports when the panel will collect it', async () => {
  await withServer(async (base, store) => {
    await store.getOrCreate('esp32-1');
    await store.update('esp32-1', {
      claimed: true,
      lastSeenAt: new Date(Date.now() - 60_000).toISOString(),
      lastWakeSeconds: 900,
    });

    const res = await fetch(`${base}/api/devices/esp32-1/push`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { etag: string; willAppearBy: string | null };
    assert.match(body.etag, /^[0-9a-f]{32}$/);
    assert.ok(body.willAppearBy, 'a recently seen device has a predicted next wake');
  });
});

test('push renders the enrolment frame for an unclaimed device', async () => {
  await withServer(async (base, store) => {
    await store.getOrCreate('esp32-1');
    assert.equal((await store.get('esp32-1'))?.claimed, false, 'precondition: device is unclaimed');

    const res = await fetch(`${base}/api/devices/esp32-1/push`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { etag: string };
    assert.equal(
      body.etag,
      'd'.repeat(32),
      'an unclaimed device is still showing its enrolment screen; push must not render the dashboard it cannot display',
    );
  });
});

test('push 404s for an unknown device', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/devices/ghost/push`, { method: 'POST' });
    assert.equal(res.status, 404);
  });
});

test('accepts a known CRS pair', async () => {
  await withServer(async (base, store) => {
    await store.getOrCreate('esp32-1');
    const res = await fetch(`${base}/api/devices/esp32-1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trainOriginCrs: 'mkc', trainDestinationCrs: 'EUS' }),
    });
    assert.equal(res.status, 200);
    const saved = await store.get('esp32-1');
    assert.equal(saved?.trainOriginCrs, 'MKC', 'stored uppercase regardless of what was typed');
    assert.equal(saved?.trainDestinationCrs, 'EUS');
  });
});

test('rejects a CRS that is well-formed but does not exist', async () => {
  await withServer(async (base, store) => {
    await store.getOrCreate('esp32-1');
    const res = await fetch(`${base}/api/devices/esp32-1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trainOriginCrs: 'ZZZ' }),
    });
    // Three letters is not enough — an unknown code would fail silently at
    // fetch time, hours later, as "Trains unavailable".
    assert.equal(res.status, 400);
  });
});

test('empty CRS fields are allowed — they mean trains are switched off', async () => {
  await withServer(async (base, store) => {
    await store.getOrCreate('esp32-1');
    const res = await fetch(`${base}/api/devices/esp32-1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trainOriginCrs: '', trainDestinationCrs: '' }),
    });
    assert.equal(res.status, 200);
  });
});

test('accepts a valid UPRN', async () => {
  await withServer(async (base, store) => {
    await store.getOrCreate('esp32-1');
    const res = await fetch(`${base}/api/devices/esp32-1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ binsUprn: '100080152345' }),
    });
    assert.equal(res.status, 200);
    assert.equal((await store.get('esp32-1'))?.binsUprn, '100080152345');
  });
});

test('rejects a UPRN that is not digits', async () => {
  await withServer(async (base, store) => {
    await store.getOrCreate('esp32-1');
    const res = await fetch(`${base}/api/devices/esp32-1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ binsUprn: 'not-a-uprn' }),
    });
    assert.equal(res.status, 400);
  });
});

test('an empty UPRN is allowed — it means bins are switched off', async () => {
  await withServer(async (base, store) => {
    await store.getOrCreate('esp32-1');
    const res = await fetch(`${base}/api/devices/esp32-1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ binsUprn: '' }),
    });
    assert.equal(res.status, 200);
  });
});

test('system info reports version and device count', async () => {
  await withServer(async (base, store) => {
    await store.getOrCreate('esp32-1');
    const res = await fetch(`${base}/api/system/info`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      version: string;
      deviceCount: number;
      update: { state: string };
      sources: { issues: unknown[]; renderedDevices: number; totalDevices: number };
    };
    assert.match(body.version, /^\d+\.\d+\.\d+$/);
    assert.equal(body.deviceCount, 1);
    assert.ok(['current', 'behind', 'unknown'].includes(body.update.state));

    // The stub FrameService reports zero rendered devices — the "haven't
    // looked yet" state. An empty issues array alone must not read as "all
    // healthy": totalDevices (1) outstripping renderedDevices (0) is what
    // says so.
    assert.deepEqual(body.sources.issues, []);
    assert.equal(body.sources.renderedDevices, 0);
    assert.equal(body.sources.totalDevices, 1);
  });
});
