import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface CacheEntry<T> {
  data: T;
  fetchedAt: string;
}

/**
 * Recursively sort object keys before hashing source configuration.
 *
 * Array order is deliberately preserved: source configs such as calendar URL
 * lists may attach meaning to ordering, while object property insertion order
 * must not create a different cache identity for otherwise identical config.
 */
function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, canonicalValue(nested)]),
    );
  }
  return value;
}

/**
 * A cache key is scoped to one device, one source implementation and the exact
 * source configuration that produced the data.
 *
 * Only the source id and a digest reach the filename. Device ids and config
 * values (including private calendar URLs) are part of the digest but are not
 * exposed on disk. `v2` intentionally invalidates the old global `<source>.json`
 * cache files rather than risking cross-device stale fallback after upgrade.
 */
export function sourceCacheKey(deviceId: string, sourceId: string, config: unknown): string {
  const canonical = JSON.stringify(canonicalValue({ deviceId, sourceId, config }));
  const digest = createHash('sha256').update(canonical).digest('hex');
  return `v2-${sourceId}-${digest}`;
}

/** Last-good values on disk, so a failed fetch degrades to stale rather than blank. */
export class SourceCache {
  constructor(private readonly dir: string) {}

  private path(key: string): string {
    return join(this.dir, `${key.replace(/[^a-z0-9_-]/gi, '_')}.json`);
  }

  async read<T>(key: string): Promise<CacheEntry<T> | null> {
    try {
      return JSON.parse(await readFile(this.path(key), 'utf8')) as CacheEntry<T>;
    } catch {
      // Missing or corrupt is the same thing to a caller: there is no cache.
      return null;
    }
  }

  async write<T>(key: string, data: T): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const entry: CacheEntry<T> = { data, fetchedAt: new Date().toISOString() };
    const destination = this.path(key);

    // Every writer gets its own temporary file. The old `<key>.tmp` name let
    // simultaneous renders overwrite/rename each other's staging file.
    // Keeping the temp in the same directory preserves atomic rename semantics.
    const tmp = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    let published = false;
    try {
      await writeFile(tmp, JSON.stringify(entry), 'utf8');
      await rename(tmp, destination);
      published = true;
    } finally {
      if (!published) await unlink(tmp).catch(() => undefined);
    }
  }
}
