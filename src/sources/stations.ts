import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Station {
  crs: string;
  name: string;
}

// Resolved relative to this module, not the working directory — the server is
// started by systemd with an arbitrary cwd.
const here = dirname(fileURLToPath(import.meta.url));

// Read once at module load. The file is ~100KB and never changes at runtime,
// so parsing it per request would be pure waste.
const stations: Station[] = JSON.parse(
  readFileSync(join(here, 'stations.json'), 'utf8'),
) as Station[];

const byCrs = new Map(stations.map((s) => [s.crs, s]));

export function stationCount(): number {
  return stations.length;
}

export function findStation(crs: string): Station | null {
  if (!/^[A-Za-z]{3}$/.test(crs)) return null;
  return byCrs.get(crs.toUpperCase()) ?? null;
}

const DEFAULT_LIMIT = 8;

/**
 * Match on name fragment or CRS. An exact CRS match sorts first, so typing a
 * code you already know lands on it rather than burying it under name matches.
 */
export function searchStations(query: string, limit = DEFAULT_LIMIT): Station[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];

  const matches = stations.filter(
    (s) => s.name.toLowerCase().includes(needle) || s.crs.toLowerCase().includes(needle),
  );

  matches.sort((a, b) => {
    const aExact = a.crs.toLowerCase() === needle ? 0 : 1;
    const bExact = b.crs.toLowerCase() === needle ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact;
    return a.name.localeCompare(b.name);
  });

  return matches.slice(0, limit);
}
