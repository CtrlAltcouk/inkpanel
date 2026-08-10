import { z } from 'zod';
import type { Source, SourceResult } from './types.ts';
import type { TransportApiCredentialStore, TransportApiCredentials } from './transportApiCredentials.ts';

const MAX_RESPONSE_BYTES = 512 * 1024;
const DEFAULT_LIMIT = 8;
export const TRANSPORT_API_BASE_URL = 'https://transportapi.com/v3/uk/';

export interface BusSourceConfig {
  stopCode: string;
  stopLabel: string;
  routeFilter: string;
}

export type BusDepartureStatus = 'live' | 'scheduled' | 'cancelled';

export interface BusDeparture {
  line: string;
  destination: string;
  scheduled: string | null;
  expected: string | null;
  status: BusDepartureStatus;
}

export interface BusData {
  stopCode: string;
  stopName: string;
  departures: BusDeparture[];
}

export interface BusStopSearchResult {
  stopCode: string;
  name: string;
  locality: string | null;
}

export interface TransportApiBusSourceOptions {
  credentials: TransportApiCredentials;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  maxResponseBytes?: number;
  limit?: number;
}

const stopCodeSchema = z.string().trim().regex(/^[A-Za-z0-9]{3,32}$/, 'invalid ATCO stop code');
const rawDepartureSchema = z.object({
  line: z.union([z.string(), z.number()]).optional(),
  line_name: z.union([z.string(), z.number()]).optional(),
  direction: z.string().nullable().optional(),
  destination_name: z.string().nullable().optional(),
  aimed_departure_time: z.string().nullable().optional(),
  expected_departure_time: z.string().nullable().optional(),
  best_departure_estimate: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
});
const rawBoardSchema = z.object({
  name: z.string().optional(),
  stop_name: z.string().optional(),
  atcocode: z.string().optional(),
  departures: z.record(z.string(), z.array(z.unknown())),
});
const rawPlacesSchema = z.object({
  member: z.array(z.unknown()).optional(),
});
const rawPlaceSchema = z.object({
  type: z.string().optional(),
  name: z.string(),
  atcocode: z.string().optional(),
  stop_code: z.string().optional(),
  description: z.string().nullable().optional(),
  locality: z.string().nullable().optional(),
});

function apiRoot(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('TransportAPI base URL must use HTTPS');
  if (url.username || url.password) throw new Error('TransportAPI base URL must not contain credentials');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

function authHeaders(credentials: TransportApiCredentials): HeadersInit {
  return {
    Accept: 'application/json',
    'X-App-Id': credentials.appId,
    'X-App-Key': credentials.appKey,
  };
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    throw new Error('TransportAPI response exceeded size limit');
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
        throw new Error('TransportAPI response exceeded size limit');
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

async function readJson(response: Response, maxBytes: number): Promise<unknown> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.includes('application/json') && !contentType.includes('+json')) {
    throw new Error('TransportAPI returned a non-JSON response');
  }
  try {
    return JSON.parse(await readBoundedText(response, maxBytes));
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('TransportAPI ')) throw err;
    throw new Error('TransportAPI returned invalid JSON');
  }
}

function cancelled(...values: Array<string | null | undefined>): boolean {
  return values.some((value) => value?.toLowerCase().includes('cancel'));
}

function mapDeparture(candidate: unknown): BusDeparture | null {
  const parsed = rawDepartureSchema.safeParse(candidate);
  if (!parsed.success) return null;
  const row = parsed.data;
  const line = String(row.line_name ?? row.line ?? '').trim();
  const destination = (row.direction ?? row.destination_name ?? '').trim();
  const scheduled = row.aimed_departure_time?.trim() || null;
  const best = row.best_departure_estimate?.trim() || row.expected_departure_time?.trim() || null;
  const isCancelled = cancelled(row.status, best);
  const expected = isCancelled ? null : (best || scheduled);
  if (!line || !destination || (!scheduled && !expected && !isCancelled)) return null;
  const hasRealtime = Boolean(
    row.expected_departure_time?.trim()
    || (row.best_departure_estimate?.trim() && row.best_departure_estimate.trim() !== scheduled),
  );
  return {
    line,
    destination,
    scheduled,
    expected,
    status: isCancelled ? 'cancelled' : (hasRealtime ? 'live' : 'scheduled'),
  };
}

export function createTransportApiBusSource(options: TransportApiBusSourceOptions): Source<BusSourceConfig, BusData> {
  const baseUrl = apiRoot((options.baseUrl ?? TRANSPORT_API_BASE_URL).trim());
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  const limit = options.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(maxBytes) || maxBytes < 1024) throw new Error('invalid TransportAPI response size limit');
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('invalid TransportAPI row count');

  return {
    id: 'bus',
    async fetch(config, signal): Promise<SourceResult<BusData>> {
      const stopCode = stopCodeSchema.parse(config.stopCode);
      const url = new URL(`bus/stop/${encodeURIComponent(stopCode)}/live.json`, baseUrl);
      url.searchParams.set('group', 'no');
      url.searchParams.set('nextbuses', 'yes');
      url.searchParams.set('limit', String(limit));
      const response = await fetchImpl(url, {
        method: 'GET', redirect: 'error', signal, headers: authHeaders(options.credentials),
      });
      if (!response.ok) return { status: 'error', error: `TransportAPI bus request failed (HTTP ${response.status})` };

      let json: unknown;
      try {
        json = await readJson(response, maxBytes);
      } catch (err) {
        return { status: 'error', error: err instanceof Error ? err.message : 'TransportAPI bus response failed' };
      }
      const board = rawBoardSchema.safeParse(json);
      if (!board.success) return { status: 'error', error: 'TransportAPI returned an invalid bus departure board' };

      const candidates = board.data.departures.all
        ?? Object.values(board.data.departures).flat();
      const routeFilter = config.routeFilter.trim().toLowerCase();
      const departures = candidates
        .map(mapDeparture)
        .filter((row): row is BusDeparture => row !== null)
        .filter((row) => !routeFilter || row.line.toLowerCase() === routeFilter)
        .slice(0, limit);
      if (candidates.length > 0 && departures.length === 0 && !routeFilter) {
        return { status: 'error', error: 'TransportAPI returned no usable bus departures' };
      }

      return {
        status: 'ok',
        data: {
          stopCode,
          stopName: (board.data.name ?? board.data.stop_name ?? config.stopLabel ?? stopCode).trim() || stopCode,
          departures,
        },
        fetchedAt: new Date().toISOString(),
      };
    },
  };
}

export function createManagedTransportApiBusSource(
  credentials: TransportApiCredentialStore,
  options: Omit<TransportApiBusSourceOptions, 'credentials'> = {},
): Source<BusSourceConfig, BusData> {
  return {
    id: 'bus',
    async fetch(config, signal) {
      const current = credentials.current();
      if (!current) return { status: 'error', error: 'Bus live departures are not configured on this server' };
      return createTransportApiBusSource({ credentials: current, ...options }).fetch(config, signal);
    },
  };
}

export async function searchTransportApiBusStops(
  credentials: TransportApiCredentialStore,
  query: string,
  signal: AbortSignal,
  options: { baseUrl?: string; fetchImpl?: typeof fetch; maxResponseBytes?: number } = {},
): Promise<BusStopSearchResult[]> {
  const current = credentials.current();
  if (!current) throw new Error('TransportAPI credentials are not configured');
  const q = query.trim();
  if (q.length < 2 || q.length > 80) throw new Error('bus stop query must be 2-80 characters');
  const baseUrl = apiRoot((options.baseUrl ?? TRANSPORT_API_BASE_URL).trim());
  const url = new URL('places.json', baseUrl);
  url.searchParams.set('query', q);
  url.searchParams.set('type', 'bus_stop');
  url.searchParams.set('limit', '8');
  const response = await (options.fetchImpl ?? fetch)(url, {
    method: 'GET', redirect: 'error', signal, headers: authHeaders(current),
  });
  if (!response.ok) throw new Error(`TransportAPI places request failed (HTTP ${response.status})`);
  const json = await readJson(response, options.maxResponseBytes ?? MAX_RESPONSE_BYTES);
  const places = rawPlacesSchema.parse(json);
  const results: BusStopSearchResult[] = [];
  const seen = new Set<string>();
  for (const candidate of places.member ?? []) {
    const parsed = rawPlaceSchema.safeParse(candidate);
    if (!parsed.success) continue;
    const stopCode = (parsed.data.atcocode ?? parsed.data.stop_code ?? '').trim();
    if (!stopCode || seen.has(stopCode)) continue;
    seen.add(stopCode);
    results.push({
      stopCode,
      name: parsed.data.name.trim(),
      locality: (parsed.data.locality ?? parsed.data.description ?? '')?.trim() || null,
    });
  }
  return results;
}
