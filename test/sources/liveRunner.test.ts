import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runLiveSource } from '../../src/sources/runner.ts';
import type { Source } from '../../src/sources/types.ts';

test('runLiveSource returns an error rather than replaying persistent stale data', async () => {
  const source: Source<{ route: string }, { minutes: number }> = {
    id: 'traffic',
    async fetch() {
      return { status: 'error', error: 'provider unavailable' };
    },
  };

  const result = await runLiveSource(source, { route: 'home-work' }, { deviceId: 'panel-a', timeoutMs: 1000 });
  assert.deepEqual(result, {
    data: null,
    health: { id: 'traffic', status: 'error', fetchedAt: null, error: 'provider unavailable' },
  });
});

test('runLiveSource returns live data and health without a cache dependency', async () => {
  const source: Source<{}, { minutes: number }> = {
    id: 'traffic',
    async fetch() {
      return { status: 'ok', data: { minutes: 27 }, fetchedAt: '2026-08-10T19:00:00.000Z' };
    },
  };

  const result = await runLiveSource(source, {}, { deviceId: 'panel-a', timeoutMs: 1000 });
  assert.deepEqual(result, {
    data: { minutes: 27 },
    health: { id: 'traffic', status: 'ok', fetchedAt: '2026-08-10T19:00:00.000Z', error: null },
  });
});
