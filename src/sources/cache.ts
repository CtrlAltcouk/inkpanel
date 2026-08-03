import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface CacheEntry<T> {
  data: T;
  fetchedAt: string;
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
    const tmp = `${this.path(key)}.tmp`;
    await writeFile(tmp, JSON.stringify(entry), 'utf8');
    await rename(tmp, this.path(key));
  }
}
