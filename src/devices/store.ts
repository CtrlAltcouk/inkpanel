import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { defaultDevice, type DeviceRecord } from './types.ts';

interface StoreFile {
  devices: DeviceRecord[];
}

/**
 * A JSON file written atomically. Chosen over SQLite because writes are rare,
 * one process owns it, and it stays human-readable and diffable.
 */
export class DeviceStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  private async read(): Promise<StoreFile> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as StoreFile;
      return { devices: Array.isArray(parsed.devices) ? parsed.devices : [] };
    } catch {
      // Missing or corrupt: start empty rather than refusing to boot.
      return { devices: [] };
    }
  }

  private async write(file: StoreFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(file, null, 2), 'utf8');
    await rename(tmp, this.path);
  }

  /**
   * Serialise mutations. Two devices waking at once — or one device retrying —
   * would otherwise read-modify-write over each other and lose a record.
   */
  private mutate<T>(fn: (file: StoreFile) => Promise<T> | T): Promise<T> {
    const next = this.queue.then(async () => {
      const file = await this.read();
      const result = await fn(file);
      await this.write(file);
      return result;
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  async list(): Promise<DeviceRecord[]> {
    return (await this.read()).devices;
  }

  async get(id: string): Promise<DeviceRecord | null> {
    return (await this.read()).devices.find((d) => d.id === id) ?? null;
  }

  async getOrCreate(id: string): Promise<DeviceRecord> {
    return this.mutate((file) => {
      const existing = file.devices.find((d) => d.id === id);
      if (existing) return existing;
      const created = defaultDevice(id);
      file.devices.push(created);
      return created;
    });
  }

  async update(id: string, patch: Partial<DeviceRecord>): Promise<DeviceRecord> {
    return this.mutate((file) => {
      const index = file.devices.findIndex((d) => d.id === id);
      if (index === -1) throw new Error(`unknown device: ${id}`);
      // id last, so a patch can never rename a device out from under itself.
      const updated = { ...file.devices[index]!, ...patch, id };
      file.devices[index] = updated;
      return updated;
    });
  }
}

export { defaultDevice };
export type { DeviceRecord };
