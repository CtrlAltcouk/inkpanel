import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createNationalRailTrainSource, type TrainSourceConfig } from './nationalRailTrain.ts';
import type { TrainData } from './train.ts';
import type { Source } from './types.ts';

const API_KEY = /^[\x21-\x7e]{16,256}$/;

export function validateNationalRailApiKey(value: string): string {
  const trimmed = value.trim();
  if (!API_KEY.test(trimmed)) {
    throw new Error('National Rail API key must be 16-256 non-whitespace ASCII characters');
  }
  return trimmed;
}

export interface NationalRailCredentialStatus {
  configured: boolean;
  managed: boolean;
}

/**
 * Runtime-managed National Rail Consumer key.
 *
 * The browser can replace this secret, but can never read it back. A key from
 * the process environment remains a fallback for existing deployments; a
 * managed key takes precedence so changing it in the Web UI works immediately
 * without rewriting systemd environment files or restarting InkPanel.
 */
export class NationalRailCredentialStore {
  private managedKey: string | null = null;
  private readonly fallbackKey: string | null;

  constructor(private readonly path: string, environmentKey?: string) {
    const fallback = environmentKey?.trim() ?? '';
    this.fallbackKey = fallback ? validateNationalRailApiKey(fallback) : null;
  }

  async load(): Promise<void> {
    try {
      const value = (await readFile(this.path, 'utf8')).trim();
      this.managedKey = validateNationalRailApiKey(value);
      if (process.platform !== 'win32') await chmod(this.path, 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.managedKey = null;
        return;
      }
      throw err;
    }
  }

  current(): string | null {
    return this.managedKey ?? this.fallbackKey;
  }

  status(): NationalRailCredentialStatus {
    return { configured: this.current() !== null, managed: this.managedKey !== null };
  }

  async set(value: string): Promise<void> {
    const key = validateNationalRailApiKey(value);
    await mkdir(dirname(this.path), { recursive: true });
    const temp = `${this.path}.tmp-${process.pid}-${Date.now()}`;
    try {
      await writeFile(temp, `${key}\n`, { mode: 0o600 });
      if (process.platform !== 'win32') await chmod(temp, 0o600);
      await rename(temp, this.path);
      if (process.platform !== 'win32') await chmod(this.path, 0o600);
      this.managedKey = key;
    } catch (err) {
      await unlink(temp).catch(() => undefined);
      throw err;
    }
  }
}

export function createManagedNationalRailTrainSource(
  credentials: NationalRailCredentialStore,
  options: { baseUrl?: string } = {},
): Source<TrainSourceConfig, TrainData> {
  return {
    id: 'trains',
    async fetch(config, signal) {
      const apiKey = credentials.current();
      if (!apiKey) {
        return {
          status: 'error',
          error: 'National Rail live departures are not configured on this server',
        };
      }
      return createNationalRailTrainSource({
        apiKey,
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      }).fetch(config, signal);
    },
  };
}
