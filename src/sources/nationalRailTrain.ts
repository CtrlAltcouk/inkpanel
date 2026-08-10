import { z } from 'zod';
import { buildTrainData, type TrainData } from './train.ts';
import type { Source, SourceResult } from './types.ts';

const MAX_RESPONSE_BYTES = 512 * 1024;
const DEFAULT_ROWS = 8;

export interface TrainSourceConfig {
  originCrs: string;
  destinationCrs: string;
}

export interface NationalRailTrainSourceOptions {
  /** API root from the subscribed RDM product specification. Must be HTTPS. */
  baseUrl: string;
  /** Header name issued/documented by the subscribed RDM product. */
  authHeaderName?: string;
  /** Complete header value. Kept in this source closure; never part of cache config. */
  authHeaderValue: string;
  fetchImpl?: typeof fetch;
  maxResponseBytes?: number;
  numRows?: number;
}

const crsSchema = z.string().regex(/^[A-Z]{3}$/, 'CRS must be three uppercase letters');
const headerNameSchema = z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, 'invalid HTTP header name');

const rawBoardSchema = z.object({
  trainServices: z.array(z.unknown()).nullable().optional(),
});

const rawServiceSchema = z.object({
  std: z.string(),
  etd: z.string().nullable().optional(),
  platform: z.union([z.string(), z.number()]).nullable().optional(),
  isCancelled: z.boolean().optional(),
});

function apiRoot(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('National Rail API base URL must use HTTPS');
  if (url.username || url.password) throw new Error('National Rail API base URL must not contain credentials');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

function requestUrl(baseUrl: URL, config: TrainSourceConfig, numRows: number): URL {
  const url = new URL(`GetDepartureBoard/${encodeURIComponent(config.originCrs)}`, baseUrl);
  url.searchParams.set('numRows', String(numRows));
  url.searchParams.set('filterCrs', config.destinationCrs);
  url.searchParams.set('filterType', 'to');
  url.searchParams.set('timeOffset', '0');
  url.searchParams.set('timeWindow', '120');
  return url;
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    throw new Error('National Rail response exceeded size limit');
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
        throw new Error('National Rail response exceeded size limit');
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

function mapBoard(originCrs: string, destinationCrs: string, parsed: z.infer<typeof rawBoardSchema>): TrainData {
  const raw = [];
  for (const candidate of parsed.trainServices ?? []) {
    const service = rawServiceSchema.safeParse(candidate);
    if (!service.success) continue;
    raw.push({
      scheduled: service.data.std,
      expected: service.data.isCancelled ? 'Cancelled' : (service.data.etd ?? null),
      platform: service.data.platform === null || service.data.platform === undefined
        ? null
        : String(service.data.platform),
    });
  }
  return buildTrainData(originCrs, destinationCrs, raw);
}

export function createNationalRailTrainSource(options: NationalRailTrainSourceOptions): Source<TrainSourceConfig, TrainData> {
  const baseUrl = apiRoot(options.baseUrl.trim());
  const authHeaderName = headerNameSchema.parse((options.authHeaderName ?? 'Authorization').trim());
  const authHeaderValue = options.authHeaderValue.trim();
  if (!authHeaderValue) throw new Error('National Rail API auth value is required');
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  const numRows = options.numRows ?? DEFAULT_ROWS;
  if (!Number.isInteger(maxBytes) || maxBytes < 1024) throw new Error('invalid National Rail response size limit');
  if (!Number.isInteger(numRows) || numRows < 1 || numRows > 50) throw new Error('invalid National Rail row count');

  return {
    id: 'trains',
    async fetch(config, signal): Promise<SourceResult<TrainData>> {
      const route = {
        originCrs: crsSchema.parse(config.originCrs.toUpperCase()),
        destinationCrs: crsSchema.parse(config.destinationCrs.toUpperCase()),
      };
      const url = requestUrl(baseUrl, route, numRows);
      const response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'error',
        signal,
        headers: {
          Accept: 'application/json',
          [authHeaderName]: authHeaderValue,
        },
      });

      if (!response.ok) {
        return { status: 'error', error: `National Rail request failed (HTTP ${response.status})` };
      }
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
      if (!contentType.includes('application/json') && !contentType.includes('+json')) {
        return { status: 'error', error: 'National Rail returned a non-JSON response' };
      }

      let json: unknown;
      try {
        json = JSON.parse(await readBoundedText(response, maxBytes));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { status: 'error', error: message.startsWith('National Rail ') ? message : 'National Rail returned invalid JSON' };
      }
      const board = rawBoardSchema.safeParse(json);
      if (!board.success) return { status: 'error', error: 'National Rail returned an invalid departure board' };

      return {
        status: 'ok',
        data: mapBoard(route.originCrs, route.destinationCrs, board.data),
        fetchedAt: new Date().toISOString(),
      };
    },
  };
}
