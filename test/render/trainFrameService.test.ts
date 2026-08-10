import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FrameService } from '../../src/render/frameService.ts';
import { SourceCache } from '../../src/sources/cache.ts';
import { defaultDevice } from '../../src/devices/types.ts';
import type { Source } from '../../src/sources/types.ts';
import type { WeatherData } from '../../src/model/dashboard.ts';
import type { TrainSourceConfig } from '../../src/sources/nationalRailTrain.ts';
import { buildTrainData, type TrainData } from '../../src/sources/train.ts';
import type { Renderer } from '../../src/render/browser.ts';
import { WEATHER } from '../fixtures/dashboard.ts';

type DashboardSections = ReturnType<typeof defaultDevice>['dashboardSections'];
type DashboardWidget = DashboardSections[number];

function sections(
  first: DashboardWidget,
  second: DashboardWidget,
  third: DashboardWidget,
  fourth: DashboardWidget,
): DashboardSections {
  return [first, second, third, fourth];
}

function weatherSource(): Source<{ latitude: number; longitude: number; timezone: string }, WeatherData> {
  return {
    id: 'weather',
    async fetch() { return { status: 'ok', data: WEATHER, fetchedAt: '2026-08-10T12:00:00.000Z' }; },
  };
}

async function withFrameService(
  trainSource: Source<TrainSourceConfig, TrainData> | undefined,
  fn: (service: FrameService) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-trains-frame-'));
  try {
    const service = new FrameService({
      renderer: {} as Renderer,
      cache: new SourceCache(dir),
      weatherSource: weatherSource(),
      trainSource,
    });
    await fn(service);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function trainWidget(originCrs: string, destinationCrs: string) {
  return { type: 'trains' as const, version: 1 as const, config: { originCrs, destinationCrs } };
}

function emptyWidget() {
  return { type: 'empty' as const, version: 1 as const, config: {} };
}

test('an unconfigured Train widget performs no train request', async () => {
  let calls = 0;
  const trains: Source<TrainSourceConfig, TrainData> = {
    id: 'trains',
    async fetch() { calls += 1; throw new Error('must not be called'); },
  };
  await withFrameService(trains, async (service) => {
    const empty = emptyWidget();
    const device = {
      ...defaultDevice('esp32-train-unconfigured'),
      dashboardSections: sections(trainWidget('', ''), empty, structuredClone(empty), structuredClone(empty)),
    };
    const html = await service.previewHtml(device);
    assert.equal(calls, 0);
    assert.match(html, /Trains — not set up/);
    assert.doesNotMatch(html, /Trains unavailable/);
  });
});

test('a configured Train widget loads and renders live TrainData', async () => {
  const seen: TrainSourceConfig[] = [];
  const trains: Source<TrainSourceConfig, TrainData> = {
    id: 'trains',
    async fetch(config) {
      seen.push(structuredClone(config));
      return {
        status: 'ok',
        data: buildTrainData(config.originCrs, config.destinationCrs, [
          { scheduled: '16:42', expected: 'On time', platform: '4' },
          { scheduled: '16:55', expected: '17:02', platform: '2' },
        ]),
        fetchedAt: '2026-08-10T15:30:00.000Z',
      };
    },
  };
  await withFrameService(trains, async (service) => {
    const empty = emptyWidget();
    const device = {
      ...defaultDevice('esp32-train-live'),
      dashboardSections: sections(trainWidget('MKC', 'EUS'), empty, structuredClone(empty), structuredClone(empty)),
    };
    const html = await service.previewHtml(device);
    assert.deepEqual(seen, [{ originCrs: 'MKC', destinationCrs: 'EUS' }]);
    assert.match(html, /MKC &rarr; London Euston/);
    assert.match(html, /16:42/);
    assert.match(html, /On time/);
    assert.match(html, /17:02/);
    assert.match(html, /7 late/);
    assert.match(html, /Plat 4/);
  });
});

test('configured Train widget is unavailable when the server has no RDM transport', async () => {
  await withFrameService(undefined, async (service) => {
    const empty = emptyWidget();
    const device = {
      ...defaultDevice('esp32-train-no-server-config'),
      dashboardSections: sections(trainWidget('MKC', 'EUS'), empty, structuredClone(empty), structuredClone(empty)),
    };
    const html = await service.previewHtml(device);
    assert.match(html, /Trains unavailable/);
    assert.doesNotMatch(html, /Trains — not set up/);
  });
});

test('identical Train widgets dedupe within a render, while different routes stay independent', async () => {
  const calls: string[] = [];
  const trains: Source<TrainSourceConfig, TrainData> = {
    id: 'trains',
    async fetch(config) {
      calls.push(`${config.originCrs}->${config.destinationCrs}`);
      return {
        status: 'ok',
        data: buildTrainData(config.originCrs, config.destinationCrs, []),
        fetchedAt: '2026-08-10T15:30:00.000Z',
      };
    },
  };
  await withFrameService(trains, async (service) => {
    const same = trainWidget('MKC', 'EUS');
    const different = trainWidget('EUS', 'MKC');
    const device = {
      ...defaultDevice('esp32-train-dedupe'),
      dashboardSections: sections(same, structuredClone(same), different, emptyWidget()),
    };
    await service.previewHtml(device);
    assert.deepEqual(calls.sort(), ['EUS->MKC', 'MKC->EUS']);
  });
});

test('stale fallback is scoped to the same device and exact train route', async () => {
  let fail = false;
  const trains: Source<TrainSourceConfig, TrainData> = {
    id: 'trains',
    async fetch(config) {
      if (fail) return { status: 'error', error: 'upstream unavailable' };
      return {
        status: 'ok',
        data: buildTrainData(config.originCrs, config.destinationCrs, [
          { scheduled: '18:10', expected: 'On time', platform: '5' },
        ]),
        fetchedAt: '2026-08-10T15:30:00.000Z',
      };
    },
  };
  await withFrameService(trains, async (service) => {
    const empty = emptyWidget();
    const device = defaultDevice('esp32-train-cache');
    const routeA = {
      ...device,
      dashboardSections: sections(trainWidget('MKC', 'EUS'), empty, structuredClone(empty), structuredClone(empty)),
    };
    assert.match(await service.previewHtml(routeA), /18:10/);

    fail = true;
    const routeB = {
      ...device,
      dashboardSections: sections(trainWidget('EUS', 'MKC'), empty, structuredClone(empty), structuredClone(empty)),
    };
    const differentRoute = await service.previewHtml(routeB);
    assert.match(differentRoute, /Trains unavailable/);
    assert.doesNotMatch(differentRoute, /18:10/);

    const sameRoute = await service.previewHtml(routeA);
    assert.match(sameRoute, /18:10/, 'same route may use its own last-good cached board');
    assert.match(sameRoute, /from \d{2}:\d{2}/, 'cached train data is visibly marked stale');
  });
});
