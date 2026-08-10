import { z } from 'zod';
import type { Source, SourceResult } from './types.ts';

const MAX_RESPONSE_BYTES = 512 * 1024;
const HALF_HOUR_MS = 30 * 60 * 1000;
const LOOKAHEAD_MS = 24 * 60 * 60 * 1000;
export const OCTOPUS_API_BASE_URL = 'https://api.octopus.energy/v1/';

export interface OctopusAgileConfig {
  tariffCode: string;
}

export interface OctopusRateSlot {
  validFrom: string;
  validTo: string;
  /** Pence per kWh including VAT. Agile prices may legitimately be negative. */
  pencePerKwh: number;
}

/** Raw rate window kept in SourceCache so a stale response can be re-evaluated as time moves on. */
export interface OctopusRateWindow {
  slots: OctopusRateSlot[];
}

/** Only the visible result is promoted into DashboardData/content hashing. */
export interface OctopusAgileData {
  cheapest: OctopusRateSlot;
  isCurrent: boolean;
}

export interface OctopusAgileSourceOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  maxResponseBytes?: number;
  now?: () => Date;
}

const responseSchema = z.object({ results: z.array(z.unknown()) });
const rateSchema = z.object({
  value_inc_vat: z.number().finite(),
  valid_from: z.string(),
  valid_to: z.string(),
});

function apiRoot(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('Octopus API base URL must use HTTPS');
  if (url.username || url.password) throw new Error('Octopus API base URL must not contain credentials');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

/**
 * A single-register electricity tariff encodes its product between E-1R- and
 * the final regional GSP letter, e.g. E-1R-AGILE-24-10-01-C -> AGILE-24-10-01.
 */
export function parseOctopusAgileTariffCode(raw: string): {
  tariffCode: string;
  productCode: string;
} {
  const tariffCode = raw.trim().toUpperCase();
  const match = /^E-1R-(AGILE-[A-Z0-9-]+)-([A-Z])$/.exec(tariffCode);
  if (!match) {
    throw new Error('Octopus Agile tariff code must look like E-1R-AGILE-24-10-01-C');
  }
  return { tariffCode, productCode: match[1]! };
}

function requestWindow(now: Date): { from: Date; to: Date } {
  const fromMs = Math.floor(now.getTime() / HALF_HOUR_MS) * HALF_HOUR_MS;
  const from = new Date(fromMs);
  return { from, to: new Date(fromMs + LOOKAHEAD_MS) };
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    throw new Error('Octopus response exceeded size limit');
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
        throw new Error('Octopus response exceeded size limit');
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

function parseSlot(candidate: unknown, nowMs: number): OctopusRateSlot | null {
  const parsed = rateSchema.safeParse(candidate);
  if (!parsed.success) return null;

  const validFromMs = Date.parse(parsed.data.valid_from);
  const validToMs = Date.parse(parsed.data.valid_to);
  if (!Number.isFinite(validFromMs) || !Number.isFinite(validToMs) || validToMs <= validFromMs) {
    return null;
  }
  if (validToMs <= nowMs) return null;

  return {
    validFrom: new Date(validFromMs).toISOString(),
    validTo: new Date(validToMs).toISOString(),
    pencePerKwh: parsed.data.value_inc_vat,
  };
}

/**
 * Select the cheapest slot that has not fully passed. This is deliberately
 * separate from fetch() so stale cached windows are re-evaluated at each render
 * and can never keep advertising an already-expired cheapest period.
 */
export function cheapestUpcomingOctopus(
  window: OctopusRateWindow,
  now: Date = new Date(),
): OctopusAgileData | null {
  const nowMs = now.getTime();
  const upcoming = window.slots.filter((slot) => Date.parse(slot.validTo) > nowMs);
  if (upcoming.length === 0) return null;

  let cheapest = upcoming[0]!;
  for (const slot of upcoming.slice(1)) {
    if (slot.pencePerKwh < cheapest.pencePerKwh
        || (slot.pencePerKwh === cheapest.pencePerKwh
          && Date.parse(slot.validFrom) < Date.parse(cheapest.validFrom))) {
      cheapest = slot;
    }
  }

  const fromMs = Date.parse(cheapest.validFrom);
  const toMs = Date.parse(cheapest.validTo);
  return { cheapest, isCurrent: fromMs <= nowMs && nowMs < toMs };
}

export function createOctopusAgileSource(
  options: OctopusAgileSourceOptions = {},
): Source<OctopusAgileConfig, OctopusRateWindow> {
  const baseUrl = apiRoot((options.baseUrl ?? OCTOPUS_API_BASE_URL).trim());
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  const now = options.now ?? (() => new Date());
  if (!Number.isInteger(maxBytes) || maxBytes < 1024) throw new Error('invalid Octopus response size limit');

  return {
    id: 'octopus',
    async fetch(config, signal): Promise<SourceResult<OctopusRateWindow>> {
      let tariff;
      try {
        tariff = parseOctopusAgileTariffCode(config.tariffCode);
      } catch (err) {
        return { status: 'error', error: err instanceof Error ? err.message : 'invalid Octopus Agile tariff code' };
      }

      const current = now();
      const period = requestWindow(current);
      const url = new URL(
        `products/${encodeURIComponent(tariff.productCode)}/electricity-tariffs/${encodeURIComponent(tariff.tariffCode)}/standard-unit-rates/`,
        baseUrl,
      );
      url.searchParams.set('period_from', period.from.toISOString());
      url.searchParams.set('period_to', period.to.toISOString());

      const response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'error',
        signal,
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        return { status: 'error', error: `Octopus Agile request failed (HTTP ${response.status})` };
      }
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
      if (!contentType.includes('application/json') && !contentType.includes('+json')) {
        return { status: 'error', error: 'Octopus returned a non-JSON response' };
      }

      let json: unknown;
      try {
        json = JSON.parse(await readBoundedText(response, maxBytes));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          status: 'error',
          error: message.startsWith('Octopus ') ? message : 'Octopus returned invalid JSON',
        };
      }

      const parsed = responseSchema.safeParse(json);
      if (!parsed.success) return { status: 'error', error: 'Octopus returned an invalid Agile price response' };

      const nowMs = current.getTime();
      const slots = parsed.data.results
        .map((candidate) => parseSlot(candidate, nowMs))
        .filter((slot): slot is OctopusRateSlot => slot !== null)
        .sort((a, b) => Date.parse(a.validFrom) - Date.parse(b.validFrom));
      if (slots.length === 0) {
        return { status: 'error', error: 'Octopus returned no upcoming Agile prices' };
      }

      return { status: 'ok', data: { slots }, fetchedAt: new Date().toISOString() };
    },
  };
}

export const octopusAgileSource = createOctopusAgileSource();
