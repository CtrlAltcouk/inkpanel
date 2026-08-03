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
