import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/http/app.ts';
import { DeviceStore, DeviceStoreError } from '../../src/devices/store.ts';
import type { FrameService } from '../../src/render/frameService.ts';
import { DeviceEnrolmentLimiter } from '../../src/http/deviceEnrolment.ts';
import { HomeAssistantClient } from '../../src/homeAssistant/client.ts';
import { homeAssistantEnrolmentDefaults } from '../../src/homeAssistant/enrolment.ts';
import { currentDeviceRecordSchema } from '../../src/devices/schema.ts';

const ETAG = 'a'.repeat(32);

function firmwareId(value: number): string {
  return `esp32-${value.toString(16).padStart(6, '0')}`;
}

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
  fn: (base: string, store: DeviceStore, configPath: string) => Promise<void>,
  options: {
    frames?: FrameService;
    limiter?: DeviceEnrolmentLimiter;
    trustProxy?: boolean | number | string;
    password?: string | null;
    homeAssistantClient?: HomeAssistantClient;
    homeAssistantMode?: boolean;
    prepare?: (store: DeviceStore, configPath: string) => Promise<void>;
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-http-'));
  const configPath = join(dir, 'config.json');
  const store = new DeviceStore(configPath);
  await options.prepare?.(store, configPath);
  const app = createApp({
    store, frames: options.frames ?? stubFrames(), publicBaseUrl: 'http://test.local:8080',
    runtimeState: { httpsPort: null },
    dataDir: dir, firmwareDir: dir,
    auth: { password: options.password ?? null, secret: randomBytes(32) },
    trustProxy: options.trustProxy,
    enrolmentLimiter: options.limiter,
    homeAssistantClient: options.homeAssistantClient,
    enrolmentDefaults: homeAssistantEnrolmentDefaults(
      options.homeAssistantMode ?? false,
      options.homeAssistantClient ?? new HomeAssistantClient({ enabled: false }),
    ),
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await fn(`http://127.0.0.1:${port}`, store, configPath);
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
    const res = await fetch(`${base}/api/devices/esp32-a1b2c3/frame`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/octet-stream');
    assert.equal((await res.arrayBuffer()).byteLength, 48000);
    assert.equal((await store.get('esp32-a1b2c3'))?.claimed, false, 'auto-registered as unclaimed');
  });
});

const haConfig = {
  version: '2026.8.1', latitude: -36.85, longitude: 174.76,
  time_zone: 'Pacific/Auckland', location_name: 'My HA home',
  supervisor_token: 'never-persist-supervisor-token',
};
const haLocation = {
  latitude: haConfig.latitude, longitude: haConfig.longitude,
  timezone: haConfig.time_zone, locationLabel: haConfig.location_name,
};

test('HA first enrolment seeds full-size and Mini location without credentials or profile changes', async () => {
  let requests = 0;
  const homeAssistantClient = new HomeAssistantClient({
    enabled: true, token: haConfig.supervisor_token,
    fetchImpl: async () => { requests += 1; return Response.json(haConfig); },
  });
  await withServer(async (base, store, configPath) => {
    for (const [id, profile, slots] of [
      ['esp32-000001', 'wft0583-800x480-mono', 4],
      ['esp32-000002', 'ssd1681-200x200-mono', 1],
    ] as const) {
      const res = await fetch(`${base}/api/devices/${id}/frame`, {
        headers: { 'X-InkPanel-Profile': profile },
      });
      assert.equal(res.status, 200);
      assert.doesNotMatch(await res.text(), /never-persist-supervisor-token/);
      assert.doesNotMatch(JSON.stringify([...res.headers]), /never-persist-supervisor-token/);
      const device = currentDeviceRecordSchema.parse(await store.get(id));
      for (const key of ['latitude', 'longitude', 'timezone', 'locationLabel'] as const) {
        assert.equal(device[key], haLocation[key]);
      }
      assert.equal(device.panelProfileId, profile);
      assert.equal(device.dashboardSections.length, slots);
    }
    assert.equal(requests, 2);
    assert.doesNotMatch(await readFile(configPath, 'utf8'), /supervisor_token|never-persist-supervisor-token/);
  }, { homeAssistantClient, homeAssistantMode: true });
});

test('known HA panels preserve manual location and work without another HA request', async () => {
  let requests = 0;
  let config = haConfig;
  let offline = false;
  const homeAssistantClient = new HomeAssistantClient({
    enabled: true, token: haConfig.supervisor_token,
    fetchImpl: async () => {
      requests += 1;
      if (offline) throw new Error(haConfig.supervisor_token);
      return Response.json(config);
    },
  });
  await withServer(async (base, store) => {
    const url = `${base}/api/devices/esp32-000001/frame`;
    assert.equal((await fetch(url)).status, 200);
    const manual = { latitude: 40.71, longitude: -74, timezone: 'America/New_York', locationLabel: 'Office' };
    await store.update('esp32-000001', { ...manual, claimed: true });
    config = { ...haConfig, latitude: 48.85, longitude: 2.35, time_zone: 'Europe/Paris' };
    assert.equal((await fetch(url)).status, 200);
    offline = true;
    assert.equal((await fetch(url)).status, 200);
    assert.equal(requests, 1, 'known devices must not fetch installation config');
    const device = (await store.get('esp32-000001'))!;
    for (const key of ['latitude', 'longitude', 'timezone', 'locationLabel'] as const) {
      assert.equal(device[key], manual[key]);
    }
  }, { homeAssistantClient, homeAssistantMode: true });
});

test('failed HA first enrolment is retryable, persists nothing and refunds capacity', async () => {
  for (const failure of ['http', 'network', 'malformed'] as const) {
    let recovered = false;
    const homeAssistantClient = new HomeAssistantClient({
      enabled: true, token: haConfig.supervisor_token,
      fetchImpl: async () => {
        if (recovered) return Response.json(haConfig);
        if (failure === 'network') throw new Error(haConfig.supervisor_token);
        if (failure === 'http') return new Response(haConfig.supervisor_token, { status: 503 });
        return Response.json({ ...haConfig, latitude: 999 });
      },
    });
    await withServer(async (base, store, configPath) => {
      const url = `${base}/api/devices/esp32-000001/frame`;
      const res = await fetch(url);
      assert.equal(res.status, 503, failure);
      assert.equal(res.headers.get('retry-after'), '300');
      assert.equal(res.headers.get('x-next-wake-seconds'), '300');
      assert.deepEqual(await res.json(), { error: 'device enrolment defaults temporarily unavailable' });
      assert.deepEqual(await store.list(), []);
      await assert.rejects(stat(configPath), { code: 'ENOENT' });
      recovered = true;
      assert.equal((await fetch(url)).status, 200);
      assert.equal((await store.get('esp32-000001'))?.latitude, haLocation.latitude);
    }, {
      homeAssistantClient, homeAssistantMode: true,
      limiter: new DeviceEnrolmentLimiter({ perIpLimit: 1, globalLimit: 1 }),
    });
  }
});

test('standalone enrolment retains historical location defaults and never calls HA', async () => {
  const homeAssistantClient = new HomeAssistantClient({
    enabled: true, token: 'unused', fetchImpl: async () => { assert.fail('standalone must not request HA config'); },
  });
  await withServer(async (base, store) => {
    assert.equal((await fetch(`${base}/api/devices/esp32-000001/frame`)).status, 200);
    const device = (await store.get('esp32-000001'))!;
    assert.equal(device.latitude, 52.04);
    assert.equal(device.longitude, -0.76);
    assert.equal(device.timezone, 'Europe/London');
    assert.equal(device.dashboardSections.length, 4);
  }, { homeAssistantClient, homeAssistantMode: false });
});

test('unclaimed devices are told to come back quickly', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/devices/esp32-a1b2c3/frame`);
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
  }, { frames: failing });
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
  }, { frames: failing });
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

test('unknown legacy, uppercase, and malformed IDs cannot auto-enrol or create config', async () => {
  const limiter = new DeviceEnrolmentLimiter({ perIpLimit: 1, globalLimit: 1 });
  await withServer(async (base, store, configPath) => {
    for (const id of ['test-panel', 'ESP32-A1B2C3', 'esp32-a1b2', 'esp32-a1b2c3d4']) {
      const res = await fetch(`${base}/api/devices/${id}/frame`);
      assert.equal(res.status, 404, id);
    }
    assert.deepEqual(await store.list(), []);
    await assert.rejects(stat(configPath), { code: 'ENOENT' }, 'rejections must not write config.json');

    const valid = await fetch(`${base}/api/devices/esp32-a1b2c3/frame`);
    assert.equal(valid.status, 200, 'invalid attempts did not consume the sole creation slot');
  }, { limiter });
});

test('an existing custom ID stays compatible and bypasses exhausted enrolment limits', async () => {
  const limiter = new DeviceEnrolmentLimiter({ perIpLimit: 1, globalLimit: 1 });
  await withServer(async (base, store) => {
    await store.getOrCreate('test-panel');

    assert.equal((await fetch(`${base}/api/devices/test-panel/frame`)).status, 200);
    assert.equal((await fetch(`${base}/api/devices/esp32-000001/frame`)).status, 200,
      'known device did not consume creation capacity');
    assert.equal((await fetch(`${base}/api/devices/test-panel/frame`)).status, 200,
      'known device remains available after global capacity is exhausted');
    assert.equal((await fetch(`${base}/api/devices/esp32-000002/frame`)).status, 429);
  }, { limiter });
});

test('per-IP creation limit returns Retry-After and resets after one hour', async () => {
  let now = 10_000;
  const limiter = new DeviceEnrolmentLimiter({ now: () => now });
  await withServer(async (base) => {
    for (let id = 1; id <= 5; id += 1) {
      assert.equal((await fetch(`${base}/api/devices/${firmwareId(id)}/frame`)).status, 200);
    }
    const limited = await fetch(`${base}/api/devices/${firmwareId(6)}/frame`);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '3600');
    assert.deepEqual(await limited.json(), { error: 'device enrolment rate limit exceeded' });

    now += 60 * 60 * 1000;
    assert.equal((await fetch(`${base}/api/devices/${firmwareId(6)}/frame`)).status, 200);
  }, { limiter });
});

test('global creation limit stops rotating trusted-proxy client IPs at twenty', async () => {
  const limiter = new DeviceEnrolmentLimiter();
  await withServer(async (base) => {
    for (let id = 1; id <= 20; id += 1) {
      const res = await fetch(`${base}/api/devices/${firmwareId(id)}/frame`, {
        headers: { 'x-forwarded-for': `198.51.100.${id}` },
      });
      assert.equal(res.status, 200, `creation ${id}`);
    }
    const limited = await fetch(`${base}/api/devices/${firmwareId(21)}/frame`, {
      headers: { 'x-forwarded-for': '198.51.100.21' },
    });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
  }, { limiter, trustProxy: true });
});

test('untrusted X-Forwarded-For does not bypass the req.ip client limit', async () => {
  const limiter = new DeviceEnrolmentLimiter({ perIpLimit: 1, globalLimit: 3 });
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/api/devices/esp32-000001/frame`, {
      headers: { 'x-forwarded-for': '198.51.100.1' },
    })).status, 200);
    assert.equal((await fetch(`${base}/api/devices/esp32-000002/frame`, {
      headers: { 'x-forwarded-for': '198.51.100.2' },
    })).status, 429, 'Express ignores forwarded addresses when trust proxy is disabled');
  }, { limiter });
});

test('DeviceStore creation failure refunds reserved capacity', async () => {
  const limiter = new DeviceEnrolmentLimiter({ perIpLimit: 1, globalLimit: 1 });
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/api/devices/esp32-000001/frame`)).status, 503);
    assert.equal((await fetch(`${base}/api/devices/esp32-000002/frame`)).status, 200,
      'failed mutation did not permanently consume capacity');
  }, {
    limiter,
    prepare: async (store) => {
      const create = store.getOrCreateWithStatus.bind(store);
      let fail = true;
      store.getOrCreateWithStatus = async (id) => {
        if (fail) {
          fail = false;
          throw new DeviceStoreError('config_io', 'simulated creation failure');
        }
        return create(id);
      };
    },
  });
});

test('concurrent same-ID enrolment persists once and refunds the duplicate reservation', async () => {
  const limiter = new DeviceEnrolmentLimiter({ perIpLimit: 2, globalLimit: 2 });
  const target = 'esp32-000001';
  await withServer(async (base, store) => {
    const results = await Promise.all([
      fetch(`${base}/api/devices/${target}/frame`),
      fetch(`${base}/api/devices/${target}/frame`),
    ]);
    assert.deepEqual(results.map(({ status }) => status), [200, 200]);
    assert.equal((await store.list()).filter(({ id }) => id === target).length, 1);

    assert.equal((await fetch(`${base}/api/devices/esp32-000002/frame`)).status, 200,
      'duplicate request refunded its reservation');
    assert.equal((await fetch(`${base}/api/devices/esp32-000003/frame`)).status, 429,
      'exactly two distinct successful creations remain counted');
  }, {
    limiter,
    prepare: async (store) => {
      const get = store.get.bind(store);
      let arrivals = 0;
      let release!: () => void;
      const bothUnknown = new Promise<void>((resolve) => { release = resolve; });
      store.get = async (id) => {
        const result = await get(id);
        if (id === target && result === null && arrivals < 2) {
          arrivals += 1;
          if (arrivals === 2) release();
          await bothUnknown;
        }
        return result;
      };
    },
  });
});

test('HEAD never creates an unknown device but remains available for an existing legacy ID', async () => {
  await withServer(async (base, store, configPath) => {
    const unknown = await fetch(`${base}/api/devices/esp32-a1b2c3/frame`, { method: 'HEAD' });
    assert.equal(unknown.status, 404);
    assert.equal(await store.get('esp32-a1b2c3'), null);
    await assert.rejects(stat(configPath), { code: 'ENOENT' });

    await store.getOrCreate('test-panel');
    assert.equal((await fetch(`${base}/api/devices/test-panel/frame`, { method: 'HEAD' })).status, 200);
  });
});

test('corrupt and future-version stores fail closed without replacement on auto-enrolment', async () => {
  for (const [contents, statusCode] of [
    ['{ not json', 'config_corrupt'],
    ['{"schemaVersion":99,"devices":[],"future":true}\n', 'config_unsupported_version'],
  ] as const) {
    await withServer(async (base, _store, configPath) => {
      const res = await fetch(`${base}/api/devices/esp32-a1b2c3/frame`);
      assert.equal(res.status, 503);
      assert.equal((await res.json() as { code: string }).code, statusCode);
      assert.equal(await readFile(configPath, 'utf8'), contents);
    }, { prepare: async (_store, configPath) => writeFile(configPath, contents, 'utf8') });
  }
});
