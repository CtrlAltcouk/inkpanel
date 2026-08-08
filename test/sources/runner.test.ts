import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceCache, sourceCacheKey } from '../../src/sources/cache.ts';
import { runSource } from '../../src/sources/runner.ts';
import type { Source } from '../../src/sources/types.ts';

async function withCache(fn: (cache: SourceCache, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-'));
  try {
    await fn(new SourceCache(dir), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

interface TestConfig {
  feed: string;
  nested?: { beta: number; alpha: number };
}

const ok: Source<TestConfig, string> = {
  id: 'good',
  async fetch(config) {
    return { status: 'ok', data: `fresh:${config.feed}`, fetchedAt: '2026-08-03T07:00:00.000Z' };
  },
};

const broken: Source<TestConfig, string> = {
  id: 'good',
  async fetch() {
    return { status: 'error', error: 'upstream exploded' };
  },
};

const hangs: Source<TestConfig, string> = {
  id: 'slow',
  fetch(_c, signal) {
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  },
};

const options = (deviceId = 'esp32-aabbcc', timeoutMs = 1000) => ({ deviceId, timeoutMs });

test('reports ok and writes a device/config-scoped cache entry on success', async () => {
  await withCache(async (cache) => {
    const config = { feed: 'calendar-a' };
    const result = await runSource(ok, config, cache, options());
    assert.equal(result.data, 'fresh:calendar-a');
    assert.equal(result.health.status, 'ok');
    assert.equal(result.health.id, 'good');

    const key = sourceCacheKey('esp32-aabbcc', 'good', config);
    assert.equal((await cache.read<string>(key))?.data, 'fresh:calendar-a');
  });
});

test('falls back to cached data only for the same device and same config', async () => {
  await withCache(async (cache) => {
    const config = { feed: 'calendar-a' };
    await runSource(ok, config, cache, options('panel-a'));
    const result = await runSource(broken, config, cache, options('panel-a'));
    assert.equal(result.data, 'fresh:calendar-a', 'serves the last good value for the identical scope');
    assert.equal(result.health.status, 'stale');
    assert.match(result.health.error ?? '', /exploded/);
    assert.ok(result.health.fetchedAt, 'stale data carries the age of what it is serving');
  });
});

test('cache for panel A can never satisfy panel B', async () => {
  await withCache(async (cache) => {
    const config = { feed: 'private-calendar' };
    await runSource(ok, config, cache, options('panel-a'));

    const panelB = await runSource(broken, config, cache, options('panel-b'));
    assert.equal(panelB.data, null);
    assert.equal(panelB.health.status, 'error');
  });
});

test('cache for config A can never satisfy a changed config on the same panel', async () => {
  await withCache(async (cache) => {
    await runSource(ok, { feed: 'old-calendar' }, cache, options('panel-a'));

    const changed = await runSource(broken, { feed: 'new-calendar' }, cache, options('panel-a'));
    assert.equal(changed.data, null);
    assert.equal(changed.health.status, 'error');
  });
});

test('canonical config hashing ignores object property insertion order', () => {
  const first = sourceCacheKey('panel-a', 'weather', {
    timezone: 'Europe/London',
    location: { longitude: -0.76, latitude: 52.04 },
  });
  const second = sourceCacheKey('panel-a', 'weather', {
    location: { latitude: 52.04, longitude: -0.76 },
    timezone: 'Europe/London',
  });
  assert.equal(first, second);
});

test('cache filenames do not expose device ids or private config values', () => {
  const key = sourceCacheKey('esp32-secret-device', 'ical', {
    urls: ['https://calendar.example/private-token-123/basic.ics'],
    timezone: 'Europe/London',
  });
  assert.match(key, /^v2-ical-[a-f0-9]{64}$/);
  assert.doesNotMatch(key, /secret-device|private-token|calendar\.example/);
});

test('reports error when there is no matching cache to fall back on', async () => {
  await withCache(async (cache) => {
    const result = await runSource(broken, { feed: 'none' }, cache, options());
    assert.equal(result.data, null);
    assert.equal(result.health.status, 'error');
    assert.equal(result.health.fetchedAt, null);
  });
});

test('times out a hanging source instead of blocking the render', async () => {
  await withCache(async (cache) => {
    const started = Date.now();
    const result = await runSource(hangs, { feed: 'slow' }, cache, options('panel-a', 50));
    assert.equal(result.health.status, 'error');
    assert.equal(result.data, null);
    assert.ok(Date.now() - started < 1000, 'must not wait for the hanging promise');
  });
});

test('never throws, whatever the source does', async () => {
  await withCache(async (cache) => {
    const explodes: Source<TestConfig, string> = {
      id: 'throws',
      async fetch() { throw new Error('unhandled'); },
    };
    const result = await runSource(explodes, { feed: 'x' }, cache, options());
    assert.equal(result.health.status, 'error');
    assert.match(result.health.error ?? '', /unhandled/);
  });
});

test('a missing cache file is treated as no cache', async () => {
  await withCache(async (cache) => {
    assert.equal((await cache.read<string>('missing-key')), null);
  });
});

test('cache survives a round trip through disk', async () => {
  await withCache(async (cache) => {
    await cache.write('roundtrip', { nested: { value: 42 } });
    const entry = await cache.read<{ nested: { value: number } }>('roundtrip');
    assert.equal(entry?.data.nested.value, 42);
    assert.match(entry!.fetchedAt, /^\d{4}-\d{2}-\d{2}T/);
  });
});

test('concurrent writes to one cache key do not collide on a shared temp file', async () => {
  await withCache(async (cache, dir) => {
    await Promise.all(Array.from({ length: 40 }, (_, value) => cache.write('same-key', value)));

    const entry = await cache.read<number>('same-key');
    assert.ok(entry !== null);
    assert.ok(entry.data >= 0 && entry.data < 40, 'one complete writer wins atomically');

    const files = await readdir(dir);
    assert.deepEqual(files.filter((file) => file.endsWith('.tmp')), []);
  });
});
