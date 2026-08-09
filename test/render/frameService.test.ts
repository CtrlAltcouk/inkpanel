import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FrameService, type SourceBundle } from '../../src/render/frameService.ts';
import { batteryPercent } from '../../src/devices/battery.ts';
import { SourceCache } from '../../src/sources/cache.ts';
import { Renderer } from '../../src/render/browser.ts';
import { defaultDevice } from '../../src/devices/types.ts';
import { MK_FORECAST } from '../fixtures/openMeteo.ts';

const OK_HEALTH = [{ id: 'ical', status: 'ok' as const, fetchedAt: '2026-08-03T07:00:00.000Z', error: null }];
const FAILING_HEALTH = [
  { id: 'ical', status: 'ok' as const, fetchedAt: '2026-08-03T07:00:00.000Z', error: null },
  { id: 'weather', status: 'error' as const, fetchedAt: null, error: 'timed out' },
];

async function withService(
  fetchData: (() => Promise<SourceBundle>) | (() => never),
  fn: (service: FrameService, counts: { screenshots: number }) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-frame-'));
  const renderer = new Renderer();
  const counts = { screenshots: 0 };
  const counting = {
    screenshot: (html: string, profile: Parameters<Renderer['screenshot']>[1]) => {
      counts.screenshots++;
      return renderer.screenshot(html, profile);
    },
    close: () => renderer.close(),
  } as unknown as Renderer;

  try {
    await fn(new FrameService({ renderer: counting, cache: new SourceCache(dir), fetchData }), counts);
  } finally {
    await renderer.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('maps battery volts to a percentage', () => {
  assert.equal(batteryPercent(4.2), 100);
  assert.equal(batteryPercent(3.3), 0);
  assert.equal(batteryPercent(5.0), 100, 'clamped');
  assert.equal(batteryPercent(2.0), 0, 'clamped');
  assert.equal(batteryPercent(null), null);
  assert.equal(batteryPercent(0), null, 'no battery connected reads as zero');
});

test('produces a full-size buffer and skips Chromium when nothing changed', async () => {
  const bundle: SourceBundle = { calendar: { today: [], tomorrow: [] }, weather: null, bins: null, sourceHealth: OK_HEALTH };
  await withService(async () => bundle, async (service, counts) => {
    const device = { ...defaultDevice('esp32-test'), claimed: true };

    const first = await service.frameFor(device, 4.0);
    assert.equal(first.buffer.length, 48000);
    assert.match(first.etag, /^[0-9a-f]{32}$/);
    assert.equal(counts.screenshots, 1);

    const second = await service.frameFor(device, 4.0);
    assert.equal(second.etag, first.etag, 'unchanged content keeps its ETag');
    assert.equal(counts.screenshots, 1, 'Chromium must not run again');
  });
});

test('re-renders when the content actually changes', async () => {
  let title = 'Standup';
  const fetchData = async (): Promise<SourceBundle> => ({
    calendar: {
      today: [{ uid: '1', title, start: '2026-08-03T08:30:00.000Z', end: '2026-08-03T08:45:00.000Z', allDay: false }],
      tomorrow: [],
    },
    weather: null,
    bins: null,
    sourceHealth: OK_HEALTH,
  });

  await withService(fetchData, async (service, counts) => {
    const device = { ...defaultDevice('esp32-test'), claimed: true };
    const first = await service.frameFor(device, 4.0);
    title = 'Standup MOVED';
    const second = await service.frameFor(device, 4.0);

    assert.notEqual(second.etag, first.etag);
    assert.equal(counts.screenshots, 2);
  });
});

test('a battery change that does not move the percent does not re-render', async () => {
  const bundle: SourceBundle = { calendar: { today: [], tomorrow: [] }, weather: null, bins: null, sourceHealth: OK_HEALTH };
  await withService(async () => bundle, async (service, counts) => {
    const device = { ...defaultDevice('esp32-test'), claimed: true };
    await service.frameFor(device, 4.02);
    await service.frameFor(device, 4.021);
    assert.equal(counts.screenshots, 1, 'only the rounded percent is drawn');
  });
});

test('separate devices keep separate memos', async () => {
  const bundle: SourceBundle = { calendar: { today: [], tomorrow: [] }, weather: null, bins: null, sourceHealth: OK_HEALTH };
  await withService(async () => bundle, async (service, counts) => {
    await service.frameFor({ ...defaultDevice('panel-a'), claimed: true }, 4.0);
    await service.frameFor({ ...defaultDevice('panel-b'), claimed: true }, 4.0);
    assert.equal(counts.screenshots, 2, 'one device must not serve another a cached frame');
  });
});

test('memoises the enrolment frame', async () => {
  await withService(
    (() => { throw new Error('sources must not be called for enrolment'); }) as () => never,
    async (service, counts) => {
      const device = defaultDevice('esp32-a1b2c3');
      const first = await service.enrolmentFrame(device, 'http://192.168.1.20:8080');
      const second = await service.enrolmentFrame(device, 'http://192.168.1.20:8080');

      assert.equal(second.etag, first.etag);
      // An unclaimed device polls every 60s. Re-rendering each time would mean
      // a Chromium launch a minute, and a cold one can outlast the panel's
      // HTTP read timeout.
      assert.equal(counts.screenshots, 1, 'must not re-render an unchanged enrolment screen');
    },
  );
});

test('a different server URL produces a different enrolment frame', async () => {
  await withService(
    (() => { throw new Error('sources must not be called for enrolment'); }) as () => never,
    async (service, counts) => {
      const device = defaultDevice('esp32-a1b2c3');
      const a = await service.enrolmentFrame(device, 'http://192.168.1.20:8080');
      const b = await service.enrolmentFrame(device, 'http://10.0.0.5:8080');

      assert.notEqual(a.etag, b.etag, 'the URL is printed on the screen');
      assert.equal(counts.screenshots, 2);
    },
  );
});

test('renderNow re-rasterises even when content is unchanged', async () => {
  const bundle: SourceBundle = { calendar: { today: [], tomorrow: [] }, weather: null, bins: null, sourceHealth: OK_HEALTH };
  await withService(async () => bundle, async (service, counts) => {
    const device = { ...defaultDevice('esp32-test'), claimed: true };

    await service.frameFor(device, 4.0);
    assert.equal(counts.screenshots, 1);

    await service.renderNow(device, 4.0);
    assert.equal(counts.screenshots, 2, 'Push must re-rasterise even though frameFor would have served the memo');
  });
});

test('renderNow does not change contentChangedAt when content is unchanged', async () => {
  const bundle: SourceBundle = { calendar: { today: [], tomorrow: [] }, weather: null, bins: null, sourceHealth: OK_HEALTH };
  await withService(async () => bundle, async (service) => {
    const device = { ...defaultDevice('esp32-test'), claimed: true };

    const first = await service.frameFor(device, 4.0);
    const pushed = await service.renderNow(device, 4.0);

    assert.equal(
      pushed.contentChangedAt,
      first.contentChangedAt,
      'pressing Push on unchanged content must not relabel it as freshly changed',
    );
  });
});

test('renderNow updates contentChangedAt when content genuinely changed', async () => {
  let title = 'Standup';
  const fetchData = async (): Promise<SourceBundle> => ({
    calendar: {
      today: [{ uid: '1', title, start: '2026-08-03T08:30:00.000Z', end: '2026-08-03T08:45:00.000Z', allDay: false }],
      tomorrow: [],
    },
    weather: null,
    bins: null,
    sourceHealth: OK_HEALTH,
  });

  await withService(fetchData, async (service) => {
    const device = { ...defaultDevice('esp32-test'), claimed: true };

    const first = await service.frameFor(device, 4.0);
    title = 'Standup MOVED';
    const pushed = await service.renderNow(device, 4.0);

    assert.notEqual(
      pushed.contentChangedAt,
      first.contentChangedAt,
      'a genuine content change must still move the timestamp, even via Push',
    );
  });
});

test('renders an enrolment frame in the normal format', async () => {
  await withService(
    (() => { throw new Error('sources must not be called for enrolment'); }) as () => never,
    async (service) => {
      const frame = await service.enrolmentFrame(defaultDevice('esp32-a1b2c3'), 'http://192.168.1.20:8080');
      assert.equal(frame.buffer.length, 48000, 'firmware needs no special case');
      assert.match(frame.etag, /^[0-9a-f]{32}$/);
    },
  );
});

// sourceIssues() alone cannot distinguish "every source is healthy" from
// "nothing has been rendered yet" — both read as []. renderedDeviceCount()
// is what lets a caller (e.g. /api/system/info) tell the two apart.
test('nothing rendered yet reports zero coverage, not a clean bill of health', async () => {
  const bundle: SourceBundle = { calendar: { today: [], tomorrow: [] }, weather: null, bins: null, sourceHealth: OK_HEALTH };
  await withService(async () => bundle, async (service) => {
    assert.equal(service.renderedDeviceCount(), 0, 'nothing has been checked');
    assert.deepEqual(service.sourceIssues(), [], 'an empty issues list here means "unknown", not "healthy"');
  });
});

test('devices that have been rendered and are healthy count as coverage with no issues', async () => {
  const bundle: SourceBundle = { calendar: { today: [], tomorrow: [] }, weather: null, bins: null, sourceHealth: OK_HEALTH };
  await withService(async () => bundle, async (service) => {
    await service.frameFor({ ...defaultDevice('panel-a'), claimed: true }, 4.0);
    await service.frameFor({ ...defaultDevice('panel-b'), claimed: true }, 4.0);

    assert.equal(service.renderedDeviceCount(), 2, 'both devices were actually checked');
    assert.deepEqual(service.sourceIssues(), [], 'genuinely healthy this time, not merely unchecked');
  });
});

test('a device with no UPRN does not report bins as broken', async () => {
  const bundle: SourceBundle = {
    calendar: { today: [], tomorrow: [] }, weather: null, bins: null, sourceHealth: [],
  };
  await withService(async () => bundle, async (service) => {
    const device = { ...defaultDevice('esp32-test'), claimed: true };
    const frame = await service.frameFor(device, 4.0);
    assert.equal(frame.buffer.length, 48000);
    // Not configured is silence, not an error. The panel says "not set up".
    assert.equal(service.sourceIssues().length, 0);
  });
});

test('bins data from the bundle reaches the rendered output, not a hardcoded null', async () => {
  const bundle: SourceBundle = {
    calendar: { today: [], tomorrow: [] },
    weather: null,
    bins: { next: { date: '2026-08-10', types: ['recycling'] }, rawLabels: ['Collect Recycling Red'] },
    sourceHealth: [{ id: 'bins', status: 'ok', fetchedAt: '2026-08-03T07:00:00.000Z', error: null }],
  };
  await withService(async () => bundle, async (service) => {
    const device = { ...defaultDevice('esp32-test'), claimed: true };
    const html = await service.previewHtml(device);
    assert.equal((html.match(/Collect Recycling Red/g) ?? []).length, 1, 'the real collection reaches the page');
    assert.equal(
      (html.match(/<div class="slot--empty"><span>Bins (—|unavailable)/g) ?? []).length,
      0,
      'a healthy bins fetch must not fall back to an empty slot',
    );
  });
});

// The test above stubs fetchData, so it never actually exercises fetchAll's
// own guard — it would pass identically even if that guard were deleted.
// This one runs the real (non-stubbed) fetchAll, with only network calls
// faked out, so a regression in the guard itself is caught: either by the
// stray call to the council's API being rejected, or — since bins.ts also
// short-circuits on an empty UPRN before ever reaching the network — by the
// rendered markup falling back to "unavailable" once a spurious 'bins'
// health entry appears.
test('the real fetchAll pipeline never calls the Milton Keynes bin API when no UPRN is configured', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-frame-real-'));
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('milton-keynes.gov.uk')) {
      throw new Error('must not call the Milton Keynes bin API when no UPRN is configured');
    }
    if (url.includes('api.open-meteo.com')) {
      return new Response(JSON.stringify(MK_FORECAST), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof globalThis.fetch;

  try {
    // previewHtml builds the frame's HTML without touching deps.renderer, so
    // a stub is enough here — no Chromium needed to prove fetchAll's wiring.
    const service = new FrameService({ renderer: {} as Renderer, cache: new SourceCache(dir) });
    const device = { ...defaultDevice('esp32-real'), claimed: true };
    const html = await service.previewHtml(device);
    assert.equal(
      (html.match(/<div class="slot--empty"><span>Bins — not set up<\/span><\/div>/g) ?? []).length,
      1,
      'an unconfigured device must show "not set up", not "unavailable"',
    );
  } finally {
    globalThis.fetch = realFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test('a failing source is reported without hiding that the device was checked', async () => {
  const bundle: SourceBundle = { calendar: { today: [], tomorrow: [] }, weather: null, bins: null, sourceHealth: FAILING_HEALTH };
  await withService(async () => bundle, async (service) => {
    await service.frameFor({ ...defaultDevice('panel-a'), claimed: true }, 4.0);

    assert.equal(service.renderedDeviceCount(), 1);
    assert.deepEqual(service.sourceIssues(), [
      { deviceId: 'panel-a', sourceId: 'weather', status: 'error', error: 'timed out' },
    ]);
  });
});

test('partial calendar data still renders when aggregate calendar health is error', async () => {
  const bundle: SourceBundle = {
    calendar: {
      today: [{
        uid: 'partial-1',
        title: 'Healthy feed event',
        start: '2026-08-03T08:30:00.000Z',
        end: '2026-08-03T09:00:00.000Z',
        allDay: false,
      }],
      tomorrow: [],
    },
    weather: null,
    bins: null,
    sourceHealth: [{
      id: 'ical',
      status: 'error',
      fetchedAt: '2026-08-03T07:00:00.000Z',
      error: '1 of 3 calendar feeds unavailable',
    }],
  };
  await withService(async () => bundle, async (service) => {
    const device = { ...defaultDevice('panel-a'), claimed: true };
    const html = await service.previewHtml(device);
    assert.match(html, /Healthy feed event/);
    assert.equal((await service.frameFor(device, 4.0)).buffer.length, 48000);
    assert.deepEqual(service.sourceIssues(), [{
      deviceId: 'panel-a',
      sourceId: 'ical',
      status: 'error',
      error: '1 of 3 calendar feeds unavailable',
    }]);
  });
});
