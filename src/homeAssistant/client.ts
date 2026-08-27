import { z } from 'zod';
import { createHash } from 'node:crypto';
import {
  calendarEntityIdSchema, homeAssistantCalendarListSchema, homeAssistantCalendarEventsSchema,
  type HomeAssistantCalendarEvent,
} from './calendarSchemas.ts';

export type HomeAssistantResult<T> = { available: true; data: T } | { available: false; error: string };
export interface HomeAssistantCalendarDiscovery {
  supported: boolean;
  available: boolean;
  calendars: Array<{ entityId: string; name: string }>;
  error: string | null;
}

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

  /** Instance identity only; never credentials. A disabled/unconfigured client cannot replay HA cache. */
  get calendarCacheScope(): string | null {
    return this.enabled && this.baseUrl && this.token
      ? createHash('sha256').update(this.baseUrl.href).digest('hex') : null;
  }

  private async request<T>(path: string, schema: z.ZodType<T>, label: string, externalSignal?: AbortSignal): Promise<HomeAssistantResult<T>> {
    if (!this.enabled) return { available: false, error: 'Home Assistant is not enabled' };
    if (!this.baseUrl) return { available: false, error: this.configurationError ?? 'Home Assistant configuration is invalid' };
    if (!this.token) return { available: false, error: 'Supervisor token is unavailable' };
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = externalSignal ? AbortSignal.any([externalSignal, timeout]) : timeout;
    try {
      const response = await this.fetchImpl(new URL(path, this.baseUrl), {
        method: 'GET',
        redirect: 'error',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.token}`,
        },
        signal,
      });
      if (!response.ok) return { available: false, error: `Home Assistant request failed (${response.status})` };
      const parsed = schema.safeParse(await response.json());
      if (!parsed.success) return { available: false, error: `Home Assistant returned an invalid ${label} response` };
      return { available: true, data: parsed.data };
    } catch {
      if (externalSignal?.aborted) return { available: false, error: 'Home Assistant request was cancelled' };
      if (timeout.aborted) return { available: false, error: 'Home Assistant request timed out' };
      return { available: false, error: 'Home Assistant is unavailable' };
    }
  }

  async status(externalSignal?: AbortSignal): Promise<HomeAssistantStatus> {
    if (!this.enabled) return standaloneStatus();
    const result = await this.request('config', configSchema, 'config', externalSignal);
    if (!result.available) return unavailable(result.error);
    return {
      available: true, mode: 'home-assistant-app', version: result.data.version,
      locationName: result.data.location_name, timeZone: result.data.time_zone, error: null,
    };
  }

  async listCalendars(signal?: AbortSignal): Promise<HomeAssistantCalendarDiscovery> {
    const result = await this.request('calendars', homeAssistantCalendarListSchema, 'calendars', signal);
    return {
      supported: this.enabled, available: result.available,
      calendars: result.available
        ? [...new Map(result.data.map((calendar) => [calendar.entity_id, {
            entityId: calendar.entity_id, name: calendar.name,
          }])).values()].sort((a, b) => a.name.localeCompare(b.name) || a.entityId.localeCompare(b.entityId))
        : [],
      error: result.available || !this.enabled ? null : result.error,
    };
  }

  async getCalendarEvents(entityId: string, start: string, end: string, signal?: AbortSignal): Promise<HomeAssistantResult<HomeAssistantCalendarEvent[]>> {
    if (!calendarEntityIdSchema.safeParse(entityId).success) {
      return { available: false, error: 'invalid Home Assistant calendar entity ID' };
    }
    const timestamps = z.iso.datetime({ offset: true });
    if (!timestamps.safeParse(start).success || !timestamps.safeParse(end).success || Date.parse(end) <= Date.parse(start)) {
      return { available: false, error: 'invalid Home Assistant calendar time range' };
    }
    const query = new URLSearchParams({ start, end });
    return this.request(`calendars/${encodeURIComponent(entityId)}?${query}`, homeAssistantCalendarEventsSchema, 'calendar events', signal);
  }
}

export function isHomeAssistantMode(raw: string | undefined): boolean {
  return raw?.trim() === '1';
}
