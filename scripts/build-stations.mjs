#!/usr/bin/env node
/**
 * Build src/sources/stations.json — the CRS list the picker filters against.
 *
 * Not in data/ — that directory is gitignored runtime state (device registry,
 * frame cache) and is relocated by DATA_DIR on a real install.
 *
 * Bundled rather than fetched at runtime: the picker then filters instantly,
 * works offline, and costs no API quota. Station codes change perhaps once a
 * year, and a slightly stale entry is a far smaller problem than a lookup that
 * can fail while someone is configuring their panel.
 *
 * Run: node scripts/build-stations.mjs
 */
import { writeFile } from 'node:fs/promises';

// A public CRS dataset. If this URL rots, any list of { crs, name } pairs will
// do — the verification below is what actually matters, not the source.
const SOURCE = 'https://raw.githubusercontent.com/davwheat/uk-railway-stations/main/stations.json';

const res = await fetch(SOURCE);
if (!res.ok) throw new Error(`${SOURCE} responded ${res.status}`);
const raw = await res.json();

const stations = raw
  .map((s) => ({
    crs: String(s.crsCode ?? s.crs ?? '').toUpperCase().trim(),
    name: String(s.stationName ?? s.name ?? '').trim(),
  }))
  .filter((s) => /^[A-Z]{3}$/.test(s.crs) && s.name.length > 0)
  .sort((a, b) => a.name.localeCompare(b.name));

// Verify before writing. A silently truncated or reshaped upstream would
// otherwise ship an empty picker.
const byCrs = new Map(stations.map((s) => [s.crs, s]));
for (const required of ['MKC', 'EUS', 'BHM']) {
  if (!byCrs.has(required)) throw new Error(`expected ${required} in the dataset`);
}
if (stations.length < 2000 || stations.length > 4000) {
  throw new Error(`expected 2000-4000 stations, got ${stations.length}`);
}

await writeFile('src/sources/stations.json', `${JSON.stringify(stations, null, 0)}\n`, 'utf8');
console.log(`wrote src/sources/stations.json: ${stations.length} stations`);
console.log(`  MKC = ${byCrs.get('MKC').name}`);
console.log(`  EUS = ${byCrs.get('EUS').name}`);
