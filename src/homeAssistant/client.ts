import { z } from 'zod';

export type HomeAssistantMode = 'standalone' | 'home-assistant-app';

export interface HomeAssistantStatus {
  available: boolean;
  mode: HomeAssistantMode;
  version: string | null;
  locationName: string | null;
  timeZone: string | null;
  error: string | null;
}

export interface HomeAssistantClientOptions {
  enabled: boolean;
  baseUrl?: string;
  token?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const configSchema = z.object({
  version: z.string().min(1),
  location_name: z.string().min(1),
  time_zone: z.string().min(1),
}).passthrough();

function standaloneStatus(): HomeAssistantStatus {
  return {
    available: false,
    mode: 'standalone',
    version: null,
    locationName: null,
    timeZone: null,
    error: null,
  };
}

function unavailable(error: string): HomeAssistantStatus {
  return {
    available: false,
    mode: 'home-assistant-app',
    version: null,
    locationName: null,
    timeZone: null,
    error,
  };
}

function normalizeBaseUrl(value: string): URL {
  const url = new URL(value.endsWith('/') ? value : `${value}/`);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Home Assistant base URL must use HTTP or HTTPS');
  }
  if (url.username || url.password) {
    throw new Error('Home Assistant base URL must not contain credentials');
  }
  return url;
}

/** Shared, server-only client for the Supervisor-proxied Home Assistant API. */
export class HomeAssistantClient {
  private readonly enabled: boolean;
  private readonly baseUrl: URL | null;
  private readonly configurationError: string | null;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: HomeAssistantClientOptions) {
    this.enabled = options.enabled;
    this.configurationError = null;
    try {
      this.baseUrl = normalizeBaseUrl(
        options.enabled ? (options.baseUrl ?? 'http://supervisor/core/api/') : 'http://supervisor/core/api/',
      );
    } catch {
      this.baseUrl = null;
      this.configurationError = 'Home Assistant base URL is invalid';
    }
    this.token = options.token?.trim() ?? '';
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  async status(externalSignal?: AbortSignal): Promise<HomeAssistantStatus> {
    if (!this.enabled) return standaloneStatus();
    if (!this.baseUrl) return unavailable(this.configurationError ?? 'Home Assistant configuration is invalid');
    if (!this.token) return unavailable('Supervisor token is unavailable');

    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = externalSignal ? AbortSignal.any([externalSignal, timeout]) : timeout;
    try {
      const response = await this.fetchImpl(new URL('config', this.baseUrl), {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.token}`,
        },
        signal,
      });
      if (!response.ok) return unavailable(`Home Assistant request failed (${response.status})`);
      const parsed = configSchema.safeParse(await response.json());
      if (!parsed.success) return unavailable('Home Assistant returned an invalid config response');
      return {
        available: true,
        mode: 'home-assistant-app',
        version: parsed.data.version,
        locationName: parsed.data.location_name,
        timeZone: parsed.data.time_zone,
        error: null,
      };
    } catch (err) {
      if (externalSignal?.aborted) return unavailable('Home Assistant request was cancelled');
      if (timeout.aborted) return unavailable('Home Assistant request timed out');
      return unavailable('Home Assistant is unavailable');
    }
  }
}

export function isHomeAssistantMode(raw: string | undefined): boolean {
  return raw?.trim() === '1';
}
