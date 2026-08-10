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
import type { BusData, BusSourceConfig } from '../../src/sources/transportApiBus.ts';
import type { TrafficData, TrafficSourceConfig } from '../../src/sources/googleTraffic.ts';
import type { Renderer } from '../../src/render/browser.ts';
import { WEATHER } from '../fixtures/dashboard.ts';

type DashboardSections = ReturnType<typeof defaultDevice>['dashboardSections'];
type DashboardWidget = DashboardSections[number];

function sections(first: DashboardWidget, second: DashboardWidget, third: DashboardWidget, fourth: DashboardWidget): DashboardSections {
  return [first, second, third, fourth];
}
function emptyWidget() { return { type: 'empty' as const, version: 1 as const, config: {} }; }
function busWidget(stopCode: string, stopLabel = 'Central Station', routeFilter = '') {
  return { type: 'bus' as const, version: 1 as const, config: { stopCode, stopLabel, routeFilter } };
}
function trafficWidget(origin: string, destination: string) {
  return { type: 'traffic' as const, version: 1 as const, config: { origin, destination } };
}
function weatherSource(): Source<{ latitude: number; longitude: number; timezone: string }, WeatherData> {
  return { id: 'weather', async fetch() { return { status: 'ok', data: WEATHER, fetchedAt: '2026-08-10T19:00:00.000Z' }; } };
}

async function withService(
  busSource: Source<BusSourceConfig, BusData> | undefined,
  trafficSource: Source<TrafficSourceConfig, TrafficData> | undefined,
  fn: (service: FrameService) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-bus-traffic-frame-'));
  try {
    const service = new FrameService({
      renderer: {} as Renderer,
      cache: new SourceCache(dir),
      weatherSource: weatherSource(),
      busSource,
      trafficSource,
    });
    await fn(service);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const BUS_DATA: BusData = {
  stopCode: '049000000001', stopName: 'Central Station',
  departures: [{ line: '6', destination: 'Lakes Estate', scheduled: '20:24', expected: '20:28', status: 'live' }],
};
const TRAFFIC_DATA: TrafficData = {
  origin: 'MK9 1EA', destination: 'London Euston',
  durationMinutes: 36, staticDurationMinutes: 24,
  distanceMiles: 50, description: 'A5 and M1', warning: null,
};

test('unconfigured Bus and Traffic widgets make no provider requests', async () => {
  let busCalls = 0;
  let trafficCalls = 0;
  const bus: Source<BusSourceConfig, BusData> = { id: 'bus', async fetch() { busCalls += 1; throw new Error('must not run'); } };
  const traffic: Source<TrafficSourceConfig, TrafficData> = { id: 'traffic', async fetch() { trafficCalls += 1; throw new Error('must not run'); } };
  await withService(bus, traffic, async (service) => {
    const empty = emptyWidget();
    const device = {
      ...defaultDevice('esp32-bus-traffic-empty'),
      dashboardSections: sections(busWidget('', ''), trafficWidget('', ''), empty, structuredClone(empty)),
    };
    const html = await service.previewHtml(device);
    assert.equal(busCalls, 0);
    assert.equal(trafficCalls, 0);
    assert.match(html, /Bus — not set up/);
    assert.match(html, /Traffic — not set up/);
  });
});

test('configured Bus and Traffic widgets fetch and render independently', async () => {
  const busSeen: BusSourceConfig[] = [];
  const trafficSeen: TrafficSourceConfig[] = [];
  const bus: Source<BusSourceConfig, BusData> = {
    id: 'bus', async fetch(config) { busSeen.push(structuredClone(config)); return { status: 'ok', data: BUS_DATA, fetchedAt: '2026-08-10T19:00:00.000Z' }; },
  };
  const traffic: Source<TrafficSourceConfig, TrafficData> = {
    id: 'traffic', async fetch(config) { trafficSeen.push(structuredClone(config)); return { status: 'ok', data: TRAFFIC_DATA, fetchedAt: '2026-08-10T19:00:00.000Z' }; },
  };
  await withService(bus, traffic, async (service) => {
    const empty = emptyWidget();
    const device = {
      ...defaultDevice('esp32-bus-traffic-live'),
      dashboardSections: sections(busWidget('049000000001', 'Central Station', '6'), trafficWidget('MK9 1EA', 'London Euston'), empty, structuredClone(empty)),
    };
    const html = await service.previewHtml(device);
    assert.deepEqual(busSeen, [{ stopCode: '049000000001', stopLabel: 'Central Station', routeFilter: '6' }]);
    assert.deepEqual(trafficSeen, [{ origin: 'MK9 1EA', destination: 'London Euston' }]);
    assert.match(html, /Lakes Estate/);
    assert.match(html, /36 min/);
    assert.match(html, /No live traffic: 24 min/);
    assert.match(html, /Google Maps/);
  });
});

test('same-render duplicate Bus and Traffic widgets dedupe exact configs', async () => {
  let busCalls = 0;
  let trafficCalls = 0;
  const bus: Source<BusSourceConfig, BusData> = {
    id: 'bus', async fetch() { busCalls += 1; return { status: 'ok', data: BUS_DATA, fetchedAt: '2026-08-10T19:00:00.000Z' }; },
  };
  const traffic: Source<TrafficSourceConfig, TrafficData> = {
    id: 'traffic', async fetch() { trafficCalls += 1; return { status: 'ok', data: TRAFFIC_DATA, fetchedAt: '2026-08-10T19:00:00.000Z' }; },
  };
  await withService(bus, traffic, async (service) => {
    const busConfig = busWidget('049000000001');
    const trafficConfig = trafficWidget('MK9 1EA', 'London Euston');
    const device = {
      ...defaultDevice('esp32-bus-traffic-dedupe'),
      dashboardSections: sections(busConfig, structuredClone(busConfig), trafficConfig, structuredClone(trafficConfig)),
    };
    await service.previewHtml(device);
    assert.equal(busCalls, 1);
    assert.equal(trafficCalls, 1);
  });
});

test('Bus may use its own stale cache but Google Traffic never replays a failed previous response', async () => {
  let fail = false;
  const bus: Source<BusSourceConfig, BusData> = {
    id: 'bus', async fetch() { return fail ? { status: 'error', error: 'bus unavailable' } : { status: 'ok', data: BUS_DATA, fetchedAt: '2026-08-10T19:00:00.000Z' }; },
  };
  const traffic: Source<TrafficSourceConfig, TrafficData> = {
    id: 'traffic', async fetch() { return fail ? { status: 'error', error: 'traffic unavailable' } : { status: 'ok', data: TRAFFIC_DATA, fetchedAt: '2026-08-10T19:00:00.000Z' }; },
  };
  await withService(bus, traffic, async (service) => {
    const empty = emptyWidget();
    const device = {
      ...defaultDevice('esp32-cache-policy'),
      dashboardSections: sections(busWidget('049000000001'), trafficWidget('MK9 1EA', 'London Euston'), empty, structuredClone(empty)),
    };
    const live = await service.previewHtml(device);
    assert.match(live, /Lakes Estate/);
    assert.match(live, /36 min/);

    fail = true;
    const failed = await service.previewHtml(device);
    assert.match(failed, /Lakes Estate/, 'Bus may use its same-device same-config stale cache');
    assert.match(failed, /from \d{2}:\d{2}/, 'stale Bus data is visibly marked');
    assert.match(failed, /Traffic unavailable/);
    assert.doesNotMatch(failed, /36 min/, 'Google traffic result must not be replayed after provider failure');
  });
});
