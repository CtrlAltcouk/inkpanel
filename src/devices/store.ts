import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { defaultDevice, type DeviceRecord } from './types.ts';
import {
  CURRENT_DEVICE_STORE_SCHEMA_VERSION,
  currentDeviceRecordSchema,
  currentDeviceStoreSchema,
  parseDeviceStoreFile,
  UnsupportedDeviceStoreVersionError,
  type CurrentDeviceStoreFile,
} from './schema.ts';

export type DeviceStoreErrorCode =
  | 'config_corrupt'
  | 'config_invalid'
  | 'config_io'
  | 'config_unsupported_version';

/**
 * A storage failure that callers must not reinterpret as an empty installation.
 *
 * `config_corrupt` means the original file was readable but could not safely be
 * interpreted as an InkPanel store. `config_unsupported_version` protects a
 * valid file created by newer InkPanel code. `config_invalid` refuses a bad
 * prospective mutation, and `config_io` represents filesystem failure. Every
 * code is a fail-closed condition.
 */
export class DeviceStoreError extends Error {
  readonly name = 'DeviceStoreError';

  constructor(
    readonly code: DeviceStoreErrorCode,
    message: string,
    readonly backupPath: string | null = null,
  ) {
    super(message);
  }
}

function errnoCode(err: unknown): string | null {
  if (typeof err !== 'object' || err === null || !('code' in err)) return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function validationReason(err: unknown): string {
  if (!(err instanceof Error) || !('issues' in err) || !Array.isArray(err.issues)) {
    return 'invalid configuration structure';
  }
  return err.issues
    .map((issue: { path?: PropertyKey[]; message?: string }) => {
      const path = issue.path?.map(String).join('.') || 'configuration';
      return `${path}: ${issue.message ?? 'invalid value'}`;
    })
    .join('; ');
}

/**
 * A JSON file written atomically. Chosen over SQLite because writes are rare,
 * one process owns it, and it stays human-readable and diffable.
 */
export class DeviceStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  /**
   * Keep an exact, content-addressed copy of a corrupt file without touching
   * the original. The digest makes repeated reads/restarts idempotent for the
   * same damaged bytes while preserving a new snapshot if the corruption later
   * changes. Failure to create the diagnostic copy must never hide the primary
   * corruption error; the original file is already preserved in place.
   */
  private async preserveCorrupt(raw: Buffer): Promise<string | null> {
    const digest = createHash('sha256').update(raw).digest('hex').slice(0, 16);
    const backup = `${this.path}.corrupt-${digest}`;
    try {
      await copyFile(this.path, backup, fsConstants.COPYFILE_EXCL);
      return backup;
    } catch (err) {
      if (errnoCode(err) === 'EEXIST') return backup;
      return null;
    }
  }

  private async corruption(raw: Buffer, reason: string): Promise<never> {
    const backup = await this.preserveCorrupt(raw);
    const backupNote = backup ? ` Diagnostic copy: ${basename(backup)}.` : '';
    throw new DeviceStoreError(
      'config_corrupt',
      `device configuration is corrupt (${reason}); the original file was left untouched.${backupNote}`,
      backup,
    );
  }

  private async read(): Promise<CurrentDeviceStoreFile> {
    let raw: Buffer;
    try {
      raw = await readFile(this.path);
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') {
        // This is the one and only condition that means a genuinely new install.
        return { schemaVersion: CURRENT_DEVICE_STORE_SCHEMA_VERSION, devices: [] };
      }
      const code = errnoCode(err) ?? 'I/O error';
      throw new DeviceStoreError(
        'config_io',
        `could not read device configuration (${code}); no configuration changes were made`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8')) as unknown;
    } catch {
      return this.corruption(raw, 'invalid JSON');
    }

    try {
      return parseDeviceStoreFile(parsed);
    } catch (err) {
      if (err instanceof UnsupportedDeviceStoreVersionError) {
        throw new DeviceStoreError(
          'config_unsupported_version',
          `device configuration schema version ${err.version} was created by a newer InkPanel version; upgrade InkPanel before making configuration changes`,
        );
      }
      return this.corruption(raw, validationReason(err));
    }
  }

  private async write(file: CurrentDeviceStoreFile): Promise<void> {
    const validation = currentDeviceStoreSchema.safeParse(file);
    if (!validation.success) {
      throw new DeviceStoreError(
        'config_invalid',
        `refusing to write invalid device configuration (${validationReason(validation.error)})`,
      );
    }
    try {
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      await writeFile(tmp, JSON.stringify(validation.data, null, 2), 'utf8');
      await rename(tmp, this.path);
    } catch (err) {
      const code = errnoCode(err) ?? 'I/O error';
      throw new DeviceStoreError(
        'config_io',
        `could not write device configuration (${code}); the requested change was not committed`,
      );
    }
  }

  /**
   * Serialise mutations. Two devices waking at once — or one device retrying —
   * would otherwise read-modify-write over each other and lose a record.
   *
   * The read happens before the mutation callback and write. A corrupt or
   * unreadable store therefore rejects here and can never flow into a fresh
   * empty StoreFile that gets written over the original configuration.
   */
  private mutate<T>(fn: (file: CurrentDeviceStoreFile) => Promise<T> | T): Promise<T> {
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
      const validation = currentDeviceRecordSchema.safeParse(defaultDevice(id));
      if (!validation.success) {
        throw new DeviceStoreError(
          'config_invalid',
          `refusing to create invalid device (${validationReason(validation.error)})`,
        );
      }
      const created = validation.data;
      file.devices.push(created);
      return created;
    });
  }

  async update(id: string, patch: Partial<DeviceRecord>): Promise<DeviceRecord> {
    return this.mutate((file) => {
      const index = file.devices.findIndex((d) => d.id === id);
      if (index === -1) throw new Error(`unknown device: ${id}`);
      // id last, so a patch can never rename a device out from under itself.
      const validation = currentDeviceRecordSchema.safeParse({
        ...file.devices[index]!,
        ...patch,
        id,
      });
      if (!validation.success) {
        throw new DeviceStoreError(
          'config_invalid',
          `refusing to update device with invalid values (${validationReason(validation.error)})`,
        );
      }
      const updated = validation.data;
      file.devices[index] = updated;
      return updated;
    });
  }
}

export { defaultDevice };
export type { DeviceRecord };
