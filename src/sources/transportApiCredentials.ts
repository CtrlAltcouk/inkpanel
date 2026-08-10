import { readOptionalSecretFile, writeSecretFile } from './credentialFile.ts';

const CREDENTIAL = /^[\x21-\x7e]{4,256}$/;

export interface TransportApiCredentials {
  appId: string;
  appKey: string;
}

export interface TransportApiCredentialStatus {
  configured: boolean;
  managed: boolean;
}

function validatePart(value: string, label: string): string {
  const trimmed = value.trim();
  if (!CREDENTIAL.test(trimmed)) {
    throw new Error(`${label} must be 4-256 non-whitespace ASCII characters`);
  }
  return trimmed;
}

export function validateTransportApiCredentials(value: TransportApiCredentials): TransportApiCredentials {
  return {
    appId: validatePart(value.appId, 'TransportAPI app ID'),
    appKey: validatePart(value.appKey, 'TransportAPI app key'),
  };
}

/** Browser-managed TransportAPI credentials; status is readable, values are not. */
export class TransportApiCredentialStore {
  private managed: TransportApiCredentials | null = null;
  private readonly fallback: TransportApiCredentials | null;

  constructor(
    private readonly path: string,
    environmentAppId?: string,
    environmentAppKey?: string,
  ) {
    const appId = environmentAppId?.trim() ?? '';
    const appKey = environmentAppKey?.trim() ?? '';
    if (Boolean(appId) !== Boolean(appKey)) {
      throw new Error('TransportAPI requires both TRANSPORTAPI_APP_ID and TRANSPORTAPI_APP_KEY');
    }
    this.fallback = appId && appKey
      ? validateTransportApiCredentials({ appId, appKey })
      : null;
  }

  async load(): Promise<void> {
    const raw = await readOptionalSecretFile(this.path);
    if (raw === null) {
      this.managed = null;
      return;
    }
    const parsed = JSON.parse(raw) as Partial<TransportApiCredentials>;
    this.managed = validateTransportApiCredentials({
      appId: String(parsed.appId ?? ''),
      appKey: String(parsed.appKey ?? ''),
    });
  }

  current(): TransportApiCredentials | null {
    return this.managed ?? this.fallback;
  }

  status(): TransportApiCredentialStatus {
    return { configured: this.current() !== null, managed: this.managed !== null };
  }

  async set(value: TransportApiCredentials): Promise<void> {
    const credentials = validateTransportApiCredentials(value);
    await writeSecretFile(this.path, `${JSON.stringify(credentials)}\n`);
    this.managed = credentials;
  }
}
