import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceCache } from '../../src/sources/cache.ts';
import { runSource } from '../../src/sources/runner.ts';
import type { Source } from '../../src/sources/types.ts';

async function withCache(fn: (cache: SourceCache) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-'));
  try {
    await fn(new SourceCache(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const ok: Source<null, string> = {
  id: 'good',
  async fetch() {
    return { status: 'ok', data: 'fresh', fetchedAt: '2026-08-03T07:00:00.000Z' };
  },
};

const broken: Source<null, string> = {
  id: 'good', // same id so it reads the same cache key
  async fetch() {
    return { status: 'error', error: 'upstream exploded' };
  },
};

const hangs: Source<null, string> = {
  id: 'slow',
  fetch(_c, signal) {
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  },
};

test('reports ok and writes the cache on success', async () => {
  await withCache(async (cache) => {
    const result = await runSource(ok, null, cache, 1000);
    assert.equal(result.data, 'fresh');
    assert.equal(result.health.status, 'ok');
    assert.equal(result.health.id, 'good');
    assert.equal((await cache.read<string>('good'))?.data, 'fresh');
  });
});

test('falls back to cached data and reports stale', async () => {
  await withCache(async (cache) => {
    await runSource(ok, null, cache, 1000);
    const result = await runSource(broken, null, cache, 1000);
    assert.equal(result.data, 'fresh', 'serves the last good value');
    assert.equal(result.health.status, 'stale');
    assert.match(result.health.error ?? '', /exploded/);
    assert.ok(result.health.fetchedAt, 'stale data carries the age of what it is serving');
  });
});

test('reports error when there is no cache to fall back on', async () => {
  await withCache(async (cache) => {
    const result = await runSource(broken, null, cache, 1000);
    assert.equal(result.data, null);
    assert.equal(result.health.status, 'error');
    assert.equal(result.health.fetchedAt, null);
  });
});

test('times out a hanging source instead of blocking the render', async () => {
  await withCache(async (cache) => {
    const started = Date.now();
    const result = await runSource(hangs, null, cache, 50);
    assert.equal(result.health.status, 'error');
    assert.equal(result.data, null);
    assert.ok(Date.now() - started < 1000, 'must not wait for the hanging promise');
  });
});

test('never throws, whatever the source does', async () => {
  await withCache(async (cache) => {
    const explodes: Source<null, string> = {
      id: 'throws',
      async fetch() { throw new Error('unhandled'); },
    };
    const result = await runSource(explodes, null, cache, 1000);
    assert.equal(result.health.status, 'error');
    assert.match(result.health.error ?? '', /unhandled/);
  });
});

test('a corrupt cache file is treated as no cache', async () => {
  await withCache(async (cache) => {
    // Write valid data, then a later read of garbage must not throw.
    await cache.write('good', 'fresh');
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
