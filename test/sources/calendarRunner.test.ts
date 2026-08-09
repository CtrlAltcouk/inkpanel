import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCalendars } from '../../src/sources/calendarRunner.ts';
import { SourceCache, sourceCacheKey } from '../../src/sources/cache.ts';
import { createCalendarTextFetcher, type CalendarHttpResponse } from '../../src/sources/calendarHttp.ts';
import { createIcalFeedSource, type IcalFeedConfig } from '../../src/sources/ical.ts';
import { runSource } from '../../src/sources/runner.ts';
import type { Source, SourceResult } from '../../src/sources/types.ts';
import * as fx from '../fixtures/ics.ts';

const NOW = new Date('2026-08-03T07:00:00.000Z');
const TZ = 'Europe/London';
const A = 'https://a.example/private-a/basic.ics?secret=alpha';
const B = 'https://b.example/private-b/basic.ics?secret=bravo';
const C = 'https://c.example/private-c/basic.ics?secret=charlie';

function httpResponse(statusCode: number, chunks: string[]): CalendarHttpResponse {
  return {
    statusCode,
    headers: {},
    body: (async function* () {
      for (const chunk of chunks) yield Buffer.from(chunk);
    })(),
    destroy: () => {},
  };
}

function source(handler: (url: string) => SourceResult<string> | Promise<SourceResult<string>>): Source<IcalFeedConfig, string> {
  return { id: 'ical', fetch: (config) => Promise.resolve(handler(config.url)) };
}

const ok = (data: string, fetchedAt = '2026-08-03T07:00:00.000Z'): SourceResult<string> => ({
  status: 'ok', data, fetchedAt,
});
const failed = (error = 'calendar feed unavailable'): SourceResult<string> => ({ status: 'error', error });

async function withCache(fn: (cache: SourceCache, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-calendar-runs-'));
  try {
    await fn(new SourceCache(dir), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function options(feedSource: Source<IcalFeedConfig, string>, deviceId = 'panel-a') {
  return { deviceId, timeoutMs: 1000, now: NOW, source: feedSource };
}

test('one failed feed cannot discard healthy calendar data', async () => {
  await withCache(async (cache) => {
    const outcome = await runCalendars(
      [A, B], TZ, cache,
      options(source((url) => url === A ? ok(fx.SINGLE_TIMED) : failed())),
    );
    assert.equal(outcome.health.status, 'error');
    assert.equal(outcome.health.error, '1 of 2 calendar feeds unavailable');
    assert.deepEqual(outcome.data?.today.map((event) => event.title), ['Team standup']);
  });
});

test('a failed feed uses only its own stale raw cache while healthy peers stay live', async () => {
  await withCache(async (cache) => {
    await runCalendars([A, B], TZ, cache, options(source((url) =>
      url === A ? ok(fx.TOMORROW) : ok(fx.WEEKLY))));

    const outcome = await runCalendars(
      [A, B], TZ, cache,
      options(source((url) => url === A ? ok(fx.SINGLE_TIMED) : failed('B failed'))),
    );
    assert.equal(outcome.health.status, 'stale');
    assert.equal(outcome.health.error, '1 using cached data');
    assert.deepEqual(
      outcome.data?.today.map((event) => event.title),
      ['Team standup', 'Daily sync'],
      'A is current while only B falls back to B cache',
    );
    assert.equal(outcome.data?.tomorrow.some((event) => event.title === 'Train to Euston'), false,
      'A must not fall back to its previous value when its live fetch succeeds');
  });
});

test('three feeds with one failure return available events and one aggregate health item', async () => {
  await withCache(async (cache) => {
    const outcome = await runCalendars(
      [A, B, C], TZ, cache,
      options(source((url) => url === A ? ok(fx.SINGLE_TIMED) : url === B ? failed() : ok(fx.TOMORROW))),
    );
    assert.equal(outcome.health.id, 'ical');
    assert.equal(outcome.health.status, 'error');
    assert.equal(outcome.health.error, '1 of 3 calendar feeds unavailable');
    assert.equal(outcome.data?.today.length, 1);
    assert.equal(outcome.data?.tomorrow.length, 1);
  });
});

test('all failed feeds return null without caches and stale combined data with caches', async () => {
  await withCache(async (cache) => {
    const noCache = await runCalendars([A, B], TZ, cache, options(source(() => failed())));
    assert.equal(noCache.data, null);
    assert.equal(noCache.health.status, 'error');

    await runCalendars(
      [A, B], TZ, cache,
      options(source((url) => ok(url === A ? fx.SINGLE_TIMED : fx.TOMORROW))),
    );
    const cached = await runCalendars([A, B], TZ, cache, options(source(() => failed())));
    assert.equal(cached.health.status, 'stale');
    assert.equal(cached.health.error, '2 using cached data');
    assert.equal(cached.data?.today.length, 1);
    assert.equal(cached.data?.tomorrow.length, 1);
  });
});

test('unavailable and cached feeds produce error health with partial stale data', async () => {
  await withCache(async (cache) => {
    await runCalendars([B], TZ, cache, options(source(() => ok(fx.TOMORROW))));
    const outcome = await runCalendars([A, B], TZ, cache, options(source(() => failed())));
    assert.equal(outcome.health.status, 'error');
    assert.equal(outcome.health.error, '1 of 2 calendar feeds unavailable; 1 using cached data');
    assert.deepEqual(outcome.data?.tomorrow.map((event) => event.title), ['Train to Euston']);
  });
});

test('configured duplicate URLs fetch once and feeds run concurrently in deterministic order', async () => {
  await withCache(async (cache) => {
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    const feedSource = source((url) => new Promise<SourceResult<string>>((resolve) => {
      started.push(url);
      releases.set(url, () => resolve(ok(url === A ? fx.SINGLE_TIMED : fx.TOMORROW)));
    }));

    const running = runCalendars([A, A, B], TZ, cache, options(feedSource));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started, [A, B], 'exact duplicates are removed before concurrent fetch');
    releases.get(B)?.();
    releases.get(A)?.();
    const outcome = await running;
    assert.equal(outcome.health.status, 'ok');
    assert.equal(outcome.data?.today[0]?.title, 'Team standup');
    assert.equal(outcome.data?.tomorrow[0]?.title, 'Train to Euston');
  });
});

test('raw per-feed cache keys remain device/config isolated and private on disk', async () => {
  await withCache(async (cache, dir) => {
    const feedSource = source(() => ok(fx.SINGLE_TIMED));
    await runCalendars([A, B], TZ, cache, options(feedSource, 'panel-a'));
    await runCalendars([A], TZ, cache, options(feedSource, 'panel-b'));
    const files = await readdir(dir);
    assert.equal(files.length, 3);
    assert.ok(files.every((name) => /^v2-ical-[a-f0-9]{64}\.json$/.test(name)));
    assert.ok(files.every((name) => !name.includes('secret') && !name.includes('example')));
    assert.notEqual(sourceCacheKey('panel-a', 'ical', { url: A }), sourceCacheKey('panel-b', 'ical', { url: A }));
    assert.notEqual(sourceCacheKey('panel-a', 'ical', { url: A }), sourceCacheKey('panel-a', 'ical', { url: B }));
  });
});

test('malformed or non-calendar text never replaces last-good raw ICS', async () => {
  await withCache(async (cache) => {
    let body = fx.SINGLE_TIMED;
    const feedSource = createIcalFeedSource(async () => body);
    const config = { url: A };
    await runSource(feedSource, config, cache, { deviceId: 'panel-a', timeoutMs: 1000 });

    for (body of [
      '<html>Google calendar public page</html>',
      'BEGIN:VCALENDAR\nBROKEN\nEND:VCALENDAR',
    ]) {
      const outcome = await runSource(feedSource, config, cache, { deviceId: 'panel-a', timeoutMs: 1000 });
      assert.equal(outcome.health.status, 'stale');
      assert.equal(outcome.data, fx.SINGLE_TIMED, 'invalid response must not overwrite last-good raw ICS');
    }
  });
});

test('a malformed feed does not take a healthy feed down', async () => {
  await withCache(async (cache) => {
    const feedSource = createIcalFeedSource(async (url) =>
      url === A ? fx.SINGLE_TIMED : 'BEGIN:VCALENDAR\nBROKEN\nEND:VCALENDAR');
    const outcome = await runCalendars([A, B], TZ, cache, options(feedSource));
    assert.equal(outcome.health.status, 'error');
    assert.equal(outcome.health.error, '1 of 2 calendar feeds unavailable');
    assert.deepEqual(outcome.data?.today.map((event) => event.title), ['Team standup']);
  });
});

test('HTTP/size failures are not cached and valid ICS is cached', async () => {
  await withCache(async (cache) => {
    const config = { url: A };
    for (const mode of ['http-error', 'oversized'] as const) {
      const fetchText = createCalendarTextFetcher({
        allowPrivateNetworks: false,
        maxBodyBytes: 8,
        resolver: async () => [{ address: '93.184.216.34', family: 4 }],
        transport: async () => mode === 'http-error'
          ? httpResponse(500, [])
          : httpResponse(200, ['12345678', '9']),
      });
      const failing = createIcalFeedSource(fetchText);
      const outcome = await runSource(failing, config, cache, { deviceId: 'panel-a', timeoutMs: 1000 });
      assert.equal(outcome.data, null);
      assert.equal(await cache.read(sourceCacheKey('panel-a', 'ical', config)), null);
    }

    const valid = createIcalFeedSource(async () => fx.EMPTY);
    const outcome = await runSource(valid, config, cache, { deviceId: 'panel-a', timeoutMs: 1000 });
    assert.equal(outcome.health.status, 'ok');
    assert.equal(outcome.data, fx.EMPTY);
    assert.equal((await cache.read<string>(sourceCacheKey('panel-a', 'ical', config)))?.data, fx.EMPTY);
  });
});

test('mixed live/stale health reports the oldest contributing fetchedAt', async () => {
  await withCache(async (cache) => {
    await runCalendars([B], TZ, cache, options(source(() => ok(fx.TOMORROW))));
    const cacheTime = (await cache.read<string>(sourceCacheKey('panel-a', 'ical', { url: B })))!.fetchedAt;
    const liveTime = new Date(Date.parse(cacheTime) + 60_000).toISOString();
    const outcome = await runCalendars(
      [A, B], TZ, cache,
      options(source((url) => url === A ? ok(fx.SINGLE_TIMED, liveTime) : failed())),
    );
    assert.equal(outcome.health.status, 'stale');
    assert.equal(outcome.health.fetchedAt, cacheTime);
  });
});

test('stale raw ICS is re-expanded for the current day instead of replaying yesterday expansion', async () => {
  await withCache(async (cache) => {
    const dayBefore = new Date('2026-08-02T07:00:00.000Z');
    const first = await runCalendars(
      [A], TZ, cache,
      { ...options(source(() => ok(fx.SINGLE_TIMED))), now: dayBefore },
    );
    assert.equal(first.data?.today.length, 0);
    assert.equal(first.data?.tomorrow[0]?.title, 'Team standup');

    const nextDay = await runCalendars([A], TZ, cache, options(source(() => failed())));
    assert.equal(nextDay.health.status, 'stale');
    assert.equal(nextDay.data?.today[0]?.title, 'Team standup');
    assert.equal(nextDay.data?.tomorrow.length, 0);
  });
});

test('aggregate health never exposes secret calendar paths or query strings', async () => {
  await withCache(async (cache) => {
    const outcome = await runCalendars([A, B], TZ, cache, options(source(() => failed(`failed ${A}`))));
    assert.equal(outcome.health.error, '2 of 2 calendar feeds unavailable');
    assert.doesNotMatch(outcome.health.error ?? '', /private-a|secret=alpha/);

    const feedSource = createIcalFeedSource(async () => {
      throw new Error(`transport accidentally included ${A}`);
    });
    const direct = await feedSource.fetch({ url: A }, new AbortController().signal);
    assert.equal(direct.status, 'error');
    if (direct.status === 'error') assert.doesNotMatch(direct.error, /private-a|secret=alpha/);
  });
});
