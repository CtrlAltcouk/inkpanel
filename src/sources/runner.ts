import type { SourceHealth } from '../model/dashboard.ts';
import { sourceCacheKey, type SourceCache } from './cache.ts';
import type { Source } from './types.ts';

export interface RunOutcome<T> {
  data: T | null;
  health: SourceHealth;
}

export interface RunSourceOptions {
  deviceId: string;
  timeoutMs: number;
}

/**
 * Run a source with a timeout, falling back only to cached data produced for
 * the same device and the same source configuration.
 *
 * This function never rejects: a render must always be possible.
 */
export async function runSource<TConfig, TData>(
  source: Source<TConfig, TData>,
  config: TConfig,
  cache: SourceCache,
  options: RunSourceOptions,
): Promise<RunOutcome<TData>> {
  const key = sourceCacheKey(options.deviceId, source.id, config);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  let error: string;
  try {
    const result = await source.fetch(config, controller.signal);
    if (result.status === 'ok') {
      await cache.write(key, result.data);
      return {
        data: result.data,
        health: { id: source.id, status: 'ok', fetchedAt: result.fetchedAt, error: null },
      };
    }
    error = result.error;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
  }

  const cached = await cache.read<TData>(key);
  if (cached) {
    return {
      data: cached.data,
      health: { id: source.id, status: 'stale', fetchedAt: cached.fetchedAt, error },
    };
  }
  return {
    data: null,
    health: { id: source.id, status: 'error', fetchedAt: null, error },
  };
}

/**
 * Run a source with the same timeout/error boundary as runSource but without
 * writing or reading persistent SourceCache data.
 *
 * This is for providers whose terms do not permit InkPanel's normal stale-data
 * cache. It deliberately returns an error instead of replaying an older
 * response when the live request fails.
 */
export async function runLiveSource<TConfig, TData>(
  source: Source<TConfig, TData>,
  config: TConfig,
  options: RunSourceOptions,
): Promise<RunOutcome<TData>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const result = await source.fetch(config, controller.signal);
    if (result.status === 'ok') {
      return {
        data: result.data,
        health: { id: source.id, status: 'ok', fetchedAt: result.fetchedAt, error: null },
      };
    }
    return {
      data: null,
      health: { id: source.id, status: 'error', fetchedAt: null, error: result.error },
    };
  } catch (err) {
    return {
      data: null,
      health: {
        id: source.id,
        status: 'error',
        fetchedAt: null,
        error: err instanceof Error ? err.message : String(err),
      },
    };
  } finally {
    clearTimeout(timer);
  }
}
