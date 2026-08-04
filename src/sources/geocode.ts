import { z } from 'zod';

export interface GeocodeResult {
  label: string;
  latitude: number;
  longitude: number;
  timezone: string;
  countryCode: string;
}

// Open-Meteo omits `results` entirely when nothing matches, so the array is
// optional rather than empty. Individual entries are validated one at a time so
// a single malformed row does not discard the whole response.
const entrySchema = z.object({
  name: z.string(),
  latitude: z.number(),
  longitude: z.number(),
  timezone: z.string(),
  country_code: z.string().optional(),
  admin1: z.string().optional(),
});

const responseSchema = z.object({
  results: z.array(z.unknown()).optional(),
});

export function mapGeocode(raw: unknown): GeocodeResult[] {
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success || !parsed.data.results) return [];

  const out: GeocodeResult[] = [];
  for (const entry of parsed.data.results) {
    const row = entrySchema.safeParse(entry);
    if (!row.success) continue;

    const { name, latitude, longitude, timezone, country_code, admin1 } = row.data;
    out.push({
      // filter(Boolean) rather than template interpolation: a missing region
      // would otherwise leave "Monaco, , MC".
      label: [name, admin1, country_code].filter(Boolean).join(', '),
      latitude,
      longitude,
      timezone,
      countryCode: country_code ?? '',
    });
  }
  return out;
}

export async function geocode(query: string, signal: AbortSignal): Promise<GeocodeResult[]> {
  const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
  url.searchParams.set('name', query);
  url.searchParams.set('count', '8');
  url.searchParams.set('language', 'en');
  url.searchParams.set('format', 'json');

  const res = await globalThis.fetch(url, { signal });
  if (!res.ok) throw new Error(`geocoding responded ${res.status}`);
  return mapGeocode(await res.json());
}
