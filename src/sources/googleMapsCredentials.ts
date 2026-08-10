import { readOptionalSecretFile, writeSecretFile } from './credentialFile.ts';

const API_KEY = /^[\x21-\x7e]{16,256}$/;

export function validateGoogleMapsApiKey(value: string): string {
  const trimmed = value.trim();
  if (!API_KEY.test(trimmed)) {
    throw new Error('Google Maps API key must be 16-256 non-whitespace ASCII characters');
  }
  return trimmed;
}

export interface GoogleMapsCredentialStatus {
  configured: boolean;
  managed: boolean;
}

export class GoogleMapsCredentialStore {
  private managedKey: string | null = null;
  private readonly fallbackKey: string | null;

  constructor(private readonly path: string, environmentKey?: string) {
    const fallback = environmentKey?.trim() ?? '';
    this.fallbackKey = fallback ? validateGoogleMapsApiKey(fallback) : null;
  }

  async load(): Promise<void> {
    const raw = await readOptionalSecretFile(this.path);
    this.managedKey = raw === null ? null : validateGoogleMapsApiKey(raw);
  }

  current(): string | null {
    return this.managedKey ?? this.fallbackKey;
  }

  status(): GoogleMapsCredentialStatus {
    return { configured: this.current() !== null, managed: this.managedKey !== null };
  }

  async set(value: string): Promise<void> {
    const key = validateGoogleMapsApiKey(value);
    await writeSecretFile(this.path, `${key}\n`);
    this.managedKey = key;
  }
}
