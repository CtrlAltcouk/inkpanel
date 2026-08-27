import { z } from 'zod';
import { createHash } from 'node:crypto';
import { isValidTimezone } from '../devices/schema.ts';
import { todoEntityIdSchema, homeAssistantTodoListsSchema, homeAssistantTodoResponseSchema } from './todoSchemas.ts';
import type { TodoData } from '../model/dashboard.ts';
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

export interface HomeAssistantTodoDiscovery {
  supported: boolean;
  available: boolean;
  lists: Array<{ entityId: string; name: string }>;
  error: string | null;
}

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

/** Only these validated installation fields may seed a new panel. */
export interface HomeAssistantInstallationLocation {
  latitude: number;
  longitude: number;
  timezone: string;
  locationLabel: string;
}

// Location validation is stricter than the diagnostic probe: diagnostics can
// still report Core's version when its location is unsuitable for enrolment.
const installationConfigSchema = configSchema.extend({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  time_zone: z.string().trim().min(1).max(255).refine(isValidTimezone),
  location_name: z.string().trim().min(1),
});

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

  private async request<T>(path: string, schema: z.ZodType<T>, label: string, externalSignal?: AbortSignal,
    options: { method: 'POST'; body: Record<string, unknown> } | { method?: 'GET' } = {},
  ): Promise<HomeAssistantResult<T>> {
    if (!this.enabled) return { available: false, error: 'Home Assistant is not enabled' };
    if (!this.baseUrl) return { available: false, error: this.configurationError ?? 'Home Assistant configuration is invalid' };
    if (!this.token) return { available: false, error: 'Supervisor token is unavailable' };
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = externalSignal ? AbortSignal.any([externalSignal, timeout]) : timeout;
    try {
      const response = await this.fetchImpl(new URL(path, this.baseUrl), {
        method: options.method ?? 'GET',
        redirect: 'error',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.token}`,
          ...(options.method === 'POST' ? { 'content-type': 'application/json' } : {}),
        },
        ...(options.method === 'POST' ? { body: JSON.stringify(options.body) } : {}),
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

  async installationLocation(signal?: AbortSignal): Promise<HomeAssistantResult<HomeAssistantInstallationLocation>> {
    const result = await this.request('config', installationConfigSchema, 'installation config', signal);
    if (!result.available) return result;
    // Explicit projection: arbitrary HA config metadata/credentials never leave
    // this server-only boundary or become part of a DeviceRecord.
    return { available: true, data: {
      latitude: result.data.latitude,
      longitude: result.data.longitude,
      timezone: result.data.time_zone,
      locationLabel: result.data.location_name,
    } };
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

  async listTodoLists(signal?: AbortSignal): Promise<HomeAssistantTodoDiscovery> {
    const result = await this.request('states', homeAssistantTodoListsSchema, 'To Do discovery', signal);
    return { supported: this.enabled, available: result.available,
      lists: result.available ? result.data : [],
      error: result.available || !this.enabled ? null : result.error };
  }

  async getTodoItems(entityId: string, signal?: AbortSignal): Promise<HomeAssistantResult<TodoData>> {
    if (!todoEntityIdSchema.safeParse(entityId).success) {
      return { available: false, error: 'invalid Home Assistant To Do entity ID' };
    }
    return this.request('services/todo/get_items?return_response', homeAssistantTodoResponseSchema(entityId),
      'To Do items', signal, { method: 'POST', body: { entity_id: entityId, status: 'needs_action' } });
  }
}

export function isHomeAssistantMode(raw: string | undefined): boolean {
  return raw?.trim() === '1';
}
