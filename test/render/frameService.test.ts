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
  const bundle: SourceBundle = { calendar: { today: [], tomorrow: [] }, weather: null, sourceHealth: OK_HEALTH };
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
  const bundle: SourceBundle = { calendar: { today: [], tomorrow: [] }, weather: null, sourceHealth: OK_HEALTH };
  await withService(async () => bundle, async (service, counts) => {
    const device = { ...defaultDevice('esp32-test'), claimed: true };
    await service.frameFor(device, 4.02);
    await service.frameFor(device, 4.021);
    assert.equal(counts.screenshots, 1, 'only the rounded percent is drawn');
  });
});

test('separate devices keep separate memos', async () => {
  const bundle: SourceBundle = { calendar: { today: [], tomorrow: [] }, weather: null, sourceHealth: OK_HEALTH };
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
  const bundle: SourceBundle = { calendar: { today: [], tomorrow: [] }, weather: null, sourceHealth: OK_HEALTH };
  await withService(async () => bundle, async (service, counts) => {
    const device = { ...defaultDevice('esp32-test'), claimed: true };

    await service.frameFor(device, 4.0);
    assert.equal(counts.screenshots, 1);

    await service.renderNow(device, 4.0);
    assert.equal(counts.screenshots, 2, 'Push must re-rasterise even though frameFor would have served the memo');
  });
});

test('renderNow does not change contentChangedAt when content is unchanged', async () => {
  const bundle: SourceBundle = { calendar: { today: [], tomorrow: [] }, weather: null, sourceHealth: OK_HEALTH };
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
  const bundle: SourceBundle = { calendar: { today: [], tomorrow: [] }, weather: null, sourceHealth: OK_HEALTH };
  await withService(async () => bundle, async (service) => {
    assert.equal(service.renderedDeviceCount(), 0, 'nothing has been checked');
    assert.deepEqual(service.sourceIssues(), [], 'an empty issues list here means "unknown", not "healthy"');
  });
});

test('devices that have been rendered and are healthy count as coverage with no issues', async () => {
  const bundle: SourceBundle = { calendar: { today: [], tomorrow: [] }, weather: null, sourceHealth: OK_HEALTH };
  await withService(async () => bundle, async (service) => {
    await service.frameFor({ ...defaultDevice('panel-a'), claimed: true }, 4.0);
    await service.frameFor({ ...defaultDevice('panel-b'), claimed: true }, 4.0);

    assert.equal(service.renderedDeviceCount(), 2, 'both devices were actually checked');
    assert.deepEqual(service.sourceIssues(), [], 'genuinely healthy this time, not merely unchecked');
  });
});

test('a failing source is reported without hiding that the device was checked', async () => {
  const bundle: SourceBundle = { calendar: { today: [], tomorrow: [] }, weather: null, sourceHealth: FAILING_HEALTH };
  await withService(async () => bundle, async (service) => {
    await service.frameFor({ ...defaultDevice('panel-a'), claimed: true }, 4.0);

    assert.equal(service.renderedDeviceCount(), 1);
    assert.deepEqual(service.sourceIssues(), [
      { deviceId: 'panel-a', sourceId: 'weather', status: 'error', error: 'timed out' },
    ]);
  });
});
