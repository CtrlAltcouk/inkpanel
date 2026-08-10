import { z } from 'zod';
import type { GoogleMapsCredentialStore } from './googleMapsCredentials.ts';
import type { Source, SourceResult } from './types.ts';

const MAX_RESPONSE_BYTES = 256 * 1024;
export const GOOGLE_ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';

export interface TrafficSourceConfig {
  origin: string;
  destination: string;
}

export interface TrafficData {
  origin: string;
  destination: string;
  durationMinutes: number;
  staticDurationMinutes: number;
  delayMinutes: number;
  distanceMiles: number | null;
  description: string | null;
  warning: string | null;
}

export interface GoogleTrafficSourceOptions {
  apiKey: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  maxResponseBytes?: number;
}

const rawRouteSchema = z.object({
  duration: z.string(),
  staticDuration: z.string(),
  distanceMeters: z.number().nonnegative().optional(),
  description: z.string().nullable().optional(),
  warnings: z.array(z.string()).optional(),
});
const rawResponseSchema = z.object({ routes: z.array(z.unknown()) });

function endpointUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('Google Routes endpoint must use HTTPS');
  if (url.username || url.password) throw new Error('Google Routes endpoint must not contain credentials');
  return url;
}

function durationSeconds(value: string): number {
  const match = /^(\d+(?:\.\d+)?)s$/.exec(value);
  if (!match) throw new Error('Google Routes returned an invalid duration');
  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error('Google Routes returned an invalid duration');
  return seconds;
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    throw new Error('Google Routes response exceeded size limit');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('Google Routes response exceeded size limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export function createGoogleTrafficSource(options: GoogleTrafficSourceOptions): Source<TrafficSourceConfig, TrafficData> {
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new Error('Google Maps Routes API key is required');
  const endpoint = endpointUrl((options.endpoint ?? GOOGLE_ROUTES_URL).trim());
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes < 1024) throw new Error('invalid Google Routes response size limit');

  return {
    id: 'traffic',
    async fetch(config, signal): Promise<SourceResult<TrafficData>> {
      const origin = config.origin.trim();
      const destination = config.destination.trim();
      if (!origin || !destination) return { status: 'error', error: 'Traffic route requires both From and To' };
      if (origin.length > 200 || destination.length > 200) return { status: 'error', error: 'Traffic route address is too long' };

      const response = await fetchImpl(endpoint, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': 'routes.duration,routes.staticDuration,routes.distanceMeters,routes.description,routes.warnings',
        },
        body: JSON.stringify({
          origin: { address: origin },
          destination: { address: destination },
          travelMode: 'DRIVE',
          routingPreference: 'TRAFFIC_AWARE',
          languageCode: 'en-GB',
          units: 'IMPERIAL',
        }),
      });
      if (!response.ok) return { status: 'error', error: `Google Routes request failed (HTTP ${response.status})` };
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
      if (!contentType.includes('application/json') && !contentType.includes('+json')) {
        return { status: 'error', error: 'Google Routes returned a non-JSON response' };
      }

      let json: unknown;
      try {
        json = JSON.parse(await readBoundedText(response, maxBytes));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { status: 'error', error: message.startsWith('Google Routes ') ? message : 'Google Routes returned invalid JSON' };
      }
      const parsed = rawResponseSchema.safeParse(json);
      if (!parsed.success || parsed.data.routes.length === 0) {
        return { status: 'error', error: 'Google Routes returned no usable route' };
      }
      const route = rawRouteSchema.safeParse(parsed.data.routes[0]);
      if (!route.success) return { status: 'error', error: 'Google Routes returned an invalid route' };

      let duration: number;
      let staticDuration: number;
      try {
        duration = durationSeconds(route.data.duration);
        staticDuration = durationSeconds(route.data.staticDuration);
      } catch (err) {
        return { status: 'error', error: err instanceof Error ? err.message : 'Google Routes returned an invalid duration' };
      }
      const durationMinutes = Math.max(0, Math.round(duration / 60));
      const staticDurationMinutes = Math.max(0, Math.round(staticDuration / 60));
      return {
        status: 'ok',
        data: {
          origin,
          destination,
          durationMinutes,
          staticDurationMinutes,
          delayMinutes: Math.max(0, durationMinutes - staticDurationMinutes),
          distanceMiles: route.data.distanceMeters === undefined
            ? null
            : Math.round((route.data.distanceMeters / 1609.344) * 10) / 10,
          description: route.data.description?.trim() || null,
          warning: route.data.warnings?.[0]?.trim() || null,
        },
        fetchedAt: new Date().toISOString(),
      };
    },
  };
}

export function createManagedGoogleTrafficSource(
  credentials: GoogleMapsCredentialStore,
  options: Omit<GoogleTrafficSourceOptions, 'apiKey'> = {},
): Source<TrafficSourceConfig, TrafficData> {
  return {
    id: 'traffic',
    async fetch(config, signal) {
      const apiKey = credentials.current();
      if (!apiKey) return { status: 'error', error: 'Google traffic is not configured on this server' };
      return createGoogleTrafficSource({ apiKey, ...options }).fetch(config, signal);
    },
  };
}
