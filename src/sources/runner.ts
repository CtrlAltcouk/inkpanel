import type { SourceHealth } from '../model/dashboard.ts';
import type { SourceCache } from './cache.ts';
import type { Source } from './types.ts';

export interface RunOutcome<T> {
  data: T | null;
  health: SourceHealth;
}

/**
 * Run a source with a timeout, falling back to cached data on failure.
 * This function never rejects: a render must always be possible.
 */
export async function runSource<TConfig, TData>(
  source: Source<TConfig, TData>,
  config: TConfig,
  cache: SourceCache,
  timeoutMs: number,
): Promise<RunOutcome<TData>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let error: string;
  try {
    const result = await source.fetch(config, controller.signal);
    if (result.status === 'ok') {
      await cache.write(source.id, result.data);
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

  const cached = await cache.read<TData>(source.id);
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
