# inkpanel Spec 2b Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fill the panel's two reserved quadrants — train departures bottom-left, Milton Keynes bin collections bottom-right.

**Architecture:** Two new sources implementing the existing `Source<TConfig, TData>` interface, run through the existing `runSource` for timeout, disk cache and stale fallback. A bundled CRS station list avoids a network call for the picker. The train transport is deliberately the last task, because the protocol is not yet known.

**Tech Stack:** Unchanged — Node 22, TypeScript, Express 5, `node --import tsx --test`, vanilla browser ESM.

**Spec:** `docs/superpowers/specs/2026-08-05-inkpanel-spec2b-design.md`

## Global Constraints

- **No new npm dependencies**, with one possible exception: if the train API turns out to be SOAP-only, a single XML parser may be added in Task 8, and only there. Everything else in this plan is dependency-free.
- Server imports use `.ts` extensions; browser modules are plain ESM with `.js`. Both deliberate.
- `npm test` and `npm run test:tz` must report the **same count** and stay green across UTC, Europe/London, America/New_York and Pacific/Auckland.
- **`src/render/panel.css.ts` may contain only `#000` and `#fff`.** No greys, no `rgba`, no `opacity`. Dimmed appearances use hatch or dot patterns. A test enforces this.
- **No test may call the real National Rail or MK council APIs.** Both are fixture-driven. A suite that fails offline or depends on a council's uptime is worse than no suite.
- `GET /api/devices/:id/frame` and `GET /health` stay reachable without a session.
- A source's `fetch` **may** throw — `runSource` catches, and never rejects. It turns any failure into `stale` (when the disk cache has something) or `error`; the template renders both. Follow `openMeteo.ts`: throw an `Error` whose message is worth reading, because it reaches the settings page. What must never happen is a source failure taking down the render.
- `SourceResult` is a tagged union, not a bare payload: return `{ status: 'ok', data, fetchedAt: new Date().toISOString() }`.
- Every task ends with a commit.

---

## File Structure

```
src/sources/stations.json    ~2,500 CRS codes, committed, generated once
scripts/build-stations.mjs   one-shot generator, kept for regeneration

src/sources/stations.ts      CRS lookup and search, no network
src/sources/bins.ts          UPRN → BinsData
src/sources/train.ts         origin+destination → TrainData  (Task 8)
src/model/dashboard.ts       + BinsData, TrainData
src/render/template.ts       + the two quadrants
src/render/panel.css.ts      + bin swatch patterns, departure rows
src/render/frameService.ts   + both sources in fetchAll
src/devices/types.ts         + trainOriginCrs, trainDestinationCrs, binsUprn
src/http/manageRoutes.ts     + validation, + GET /api/stations?q=

public/stationPicker.js      CRS type-ahead, mirrors cityPicker's contract
public/panels.js             + the three new fields

test/fixtures/bins.ts        captured real MK responses
test/fixtures/train.ts       TrainData fixtures for rendering
```

---

### Task 1: Bundled station list

**Files:**
- Create: `scripts/build-stations.mjs`, `src/sources/stations.json`, `src/sources/stations.ts`, `test/sources/stations.test.ts`

> **It must not go in `data/`.** `.gitignore` excludes both `/data/` and
> `data/` — that directory is the runtime device registry and frame cache, and
> `DATA_DIR` relocates it in the LXC install. A station list committed there
> would be silently refused by `git add` and then be missing on every deploy.
> It lives beside its only consumer instead, read relative to the module. There
> is no build step (tsx runs the TypeScript directly), so nothing needs to copy
> it.

**Interfaces:**
- Consumes: nothing
- Produces:
  - `interface Station { crs: string; name: string }`
  - `findStation(crs: string): Station | null`
  - `searchStations(query: string, limit?: number): Station[]`
  - `stationCount(): number`

- [ ] **Step 1: Generate the station list**

Create `scripts/build-stations.mjs`. It fetches a public CRS dataset, normalises
it, and writes `src/sources/stations.json`. Kept in the repo so the list can be
regenerated when stations change (roughly annually).

```js
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
```

Run it:

```bash
node scripts/build-stations.mjs
```

Expected: a count between 2000 and 4000, and `MKC` resolving to something
containing "Milton Keynes". **If the source URL is dead**, find any public list
of CRS/name pairs and adapt the field mapping — the verification block is the
contract, not the URL.

Commit `src/sources/stations.json`. It is data the product needs, not a build
artefact. Confirm git will actually take it —
`git check-ignore -v src/sources/stations.json` must print nothing.

- [ ] **Step 2: Write the failing test**

Create `test/sources/stations.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findStation, searchStations, stationCount } from '../../src/sources/stations.ts';

test('the bundled list is present and plausible', () => {
  const count = stationCount();
  assert.ok(count > 2000 && count < 4000, `expected 2000-4000 stations, got ${count}`);
});

test('finds a station by CRS, case-insensitively', () => {
  assert.match(findStation('MKC')?.name ?? '', /Milton Keynes/);
  assert.match(findStation('mkc')?.name ?? '', /Milton Keynes/);
  assert.equal(findStation('EUS')?.name, findStation('eus')?.name);
});

test('an unknown CRS is null, not a throw', () => {
  assert.equal(findStation('ZZZ'), null);
  assert.equal(findStation(''), null);
  assert.equal(findStation('TOOLONG'), null);
});

test('searches by name fragment', () => {
  const hits = searchStations('milton keynes');
  assert.ok(hits.length >= 1);
  assert.ok(hits.some((s) => s.crs === 'MKC'));
});

test('searches by CRS too, so typing a known code finds it', () => {
  const hits = searchStations('EUS');
  assert.equal(hits[0]?.crs, 'EUS', 'an exact CRS match sorts first');
});

test('caps results so the picker never renders hundreds of rows', () => {
  assert.ok(searchStations('e').length <= 8);
  assert.equal(searchStations('e', 3).length, 3);
});

test('a query matching nothing returns empty, not everything', () => {
  assert.deepEqual(searchStations('zzzzzzzz'), []);
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
npm test -- --test-name-pattern="bundled list is present"
```

Expected: FAIL — cannot resolve `src/sources/stations.ts`.

- [ ] **Step 4: Write the implementation**

Create `src/sources/stations.ts`:

```ts
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
```

- [ ] **Step 5: Run the tests**

```bash
npm test && npm run check
```

Expected: 7 station tests pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/build-stations.mjs src/sources/stations.json src/sources/stations.ts test/sources/stations.test.ts
git commit -m "feat: bundle the CRS station list for the picker"
```

---

### Task 2: Bin collections source

> **This task begins by capturing a real response.** MK's endpoint is
> undocumented and its JSON shape is not known in advance. Writing a mapper
> against an invented fixture would produce code for data that does not exist.

**Files:**
- Create: `scripts/capture-bins.mjs`, `test/fixtures/bins.ts`, `src/sources/bins.ts`, `test/sources/bins.test.ts`

**Interfaces:**
- Consumes: `Source`, `SourceResult` from `src/sources/types.ts`
- Produces:
  - `interface BinCollection { date: string; types: BinType[] }`
  - `type BinType = 'recycling' | 'food' | 'garden' | 'general'`
  - `interface BinsData { next: BinCollection | null; rawLabels: string[] }`
  - `normaliseBinType(label: string): BinType`
  - `mapBins(raw: unknown, today: Date): BinsData`
  - `binsSource: Source<{ uprn: string }, BinsData>`

- [ ] **Step 1: Capture a real response**

Create `scripts/capture-bins.mjs`:

```js
#!/usr/bin/env node
/**
 * Capture a real Milton Keynes bin-collection response, to be saved as a test
 * fixture.
 *
 * This endpoint is undocumented — it is the API behind the council's own web
 * form. The `id` below is a form identifier baked into that form and can change
 * without notice. If this script starts failing, that is the first thing to
 * check.
 *
 * Run: node scripts/capture-bins.mjs <UPRN>
 */
const uprn = process.argv[2];
if (!uprn) {
  console.error('usage: node scripts/capture-bins.mjs <UPRN>');
  process.exit(1);
}

const SESSION_URL =
  'https://mycouncil.milton-keynes.gov.uk/authapi/isauthenticated' +
  '?uri=https%253A%252F%252Fmycouncil.milton-keynes.gov.uk%252Fen%252Fservice%252FWaste_Collection_Round_Checker' +
  '&hostname=mycouncil.milton-keynes.gov.uk&withCredentials=true';

const sessionRes = await fetch(SESSION_URL);
if (!sessionRes.ok) throw new Error(`session responded ${sessionRes.status}`);
const sid = (await sessionRes.json())['auth-session'];
if (!sid) throw new Error('no auth-session in the session response');

const params = new URLSearchParams({
  id: '64d9feda3a507',
  repeat_against: '',
  noRetry: 'false',
  getOnlyTokens: 'undefined',
  log_id: '',
  app_name: 'AF-Renderer::Self',
  _: String(Date.now()),
  sid,
});

const res = await fetch(`https://mycouncil.milton-keynes.gov.uk/apibroker/runLookup?${params}`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': 'Mozilla/5.0',
    'X-Requested-With': 'XMLHttpRequest',
    Referer: 'https://mycouncil.milton-keynes.gov.uk/fillform/?iframe_id=fillform-frame-1&db_id=',
  },
  body: JSON.stringify({ formValues: { 'Section 1': { uprnCore: { value: uprn } } } }),
});

if (!res.ok) throw new Error(`lookup responded ${res.status}`);
console.log(JSON.stringify(await res.json(), null, 2));
```

Run it with the repo owner's UPRN and save the output:

```bash
node scripts/capture-bins.mjs <UPRN> > /tmp/bins-raw.json
```

**Read the captured JSON before writing any mapper.** Note where the collection
dates live, what the bin descriptions look like verbatim, and what a response
with no upcoming collection looks like. Then write `test/fixtures/bins.ts`
exporting the real captured shape, with the UPRN and any address details
redacted — a fixture is committed to a public repo.

If the endpoint has changed and the capture fails, **stop and report it**. The
whole task depends on this working, and guessing the shape is worse than
pausing.

- [ ] **Step 2: Write the failing test**

Create `test/sources/bins.test.ts`. Adapt the fixture references to the real
shape captured above; the assertions describe behaviour that must hold whatever
that shape is.

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapBins, normaliseBinType } from '../../src/sources/bins.ts';
import { REAL_RESPONSE, NO_COLLECTIONS } from '../fixtures/bins.ts';

const TODAY = new Date('2026-08-04T09:00:00.000Z');

test('normalises council wording to known bin types', () => {
  assert.equal(normaliseBinType('Recycling Sacks'), 'recycling');
  assert.equal(normaliseBinType('Mixed Recycling'), 'recycling');
  assert.equal(normaliseBinType('Food Waste Caddy'), 'food');
  assert.equal(normaliseBinType('Garden Waste'), 'garden');
  assert.equal(normaliseBinType('Green Waste'), 'garden');
  assert.equal(normaliseBinType('Refuse'), 'general');
});

test('an unrecognised description falls back to general rather than vanishing', () => {
  // Putting the wrong bin out is bad; not being told about a bin is worse.
  assert.equal(normaliseBinType('Some New Scheme 2027'), 'general');
});

test('extracts the next collection from a real response', () => {
  const data = mapBins(REAL_RESPONSE, TODAY);
  assert.ok(data.next, 'a real response has an upcoming collection');
  assert.match(data.next.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(data.next.types.length > 0);
});

test('the next collection is the soonest one not in the past', () => {
  const data = mapBins(REAL_RESPONSE, TODAY);
  assert.ok(data.next.date >= '2026-08-04', 'never returns a date already gone');
});

test('keeps the original labels so the panel can print what the council said', () => {
  const data = mapBins(REAL_RESPONSE, TODAY);
  assert.ok(data.rawLabels.length > 0);
});

test('no upcoming collection is null, not a throw', () => {
  assert.equal(mapBins(NO_COLLECTIONS, TODAY).next, null);
});

test('a malformed response throws rather than reporting no bins', () => {
  // "The API changed" and "you have no collections" must not look identical.
  assert.throws(() => mapBins({ nonsense: true }, TODAY), /malformed/i);
  assert.throws(() => mapBins(null, TODAY), /malformed/i);
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
npm test -- --test-name-pattern="normalises council wording"
```

Expected: FAIL — cannot resolve `src/sources/bins.ts`.

- [ ] **Step 4: Write the implementation**

Create `src/sources/bins.ts`. The parsing of `raw` into `{ date, labels }` pairs
must match the captured shape; everything else below is fixed.

```ts
import type { Source, SourceResult } from './types.ts';

export type BinType = 'recycling' | 'food' | 'garden' | 'general';

export interface BinCollection {
  /** ISO date, YYYY-MM-DD. */
  date: string;
  types: BinType[];
}

export interface BinsData {
  next: BinCollection | null;
  /** The council's own wording, for display. */
  rawLabels: string[];
}

/**
 * Map free-text council wording to a known type.
 *
 * The council returns descriptive strings that can change without notice, so
 * matching is by keyword rather than exact value. Anything unrecognised becomes
 * `general` and is still rendered: showing an unfamiliar bin is better than
 * silently dropping one that needs putting out.
 */
export function normaliseBinType(label: string): BinType {
  const text = label.toLowerCase();
  if (text.includes('recycl')) return 'recycling';
  if (text.includes('food')) return 'food';
  if (text.includes('garden') || text.includes('green')) return 'garden';
  return 'general';
}

const SESSION_URL =
  'https://mycouncil.milton-keynes.gov.uk/authapi/isauthenticated' +
  '?uri=https%253A%252F%252Fmycouncil.milton-keynes.gov.uk%252Fen%252Fservice%252FWaste_Collection_Round_Checker' +
  '&hostname=mycouncil.milton-keynes.gov.uk&withCredentials=true';

const LOOKUP_URL = 'https://mycouncil.milton-keynes.gov.uk/apibroker/runLookup';

// A form identifier baked into the council's own web form. Undocumented and
// liable to change without notice — the first thing to check when bins break.
const FORM_ID = '64d9feda3a507';

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function mapBins(raw: unknown, today: Date): BinsData {
  // Replace this extraction with whatever the captured response requires. It
  // must produce an array of { date: 'YYYY-MM-DD', label: string }.
  const rows = extractRows(raw);

  const cutoff = isoDate(today);
  const upcoming = rows.filter((r) => r.date >= cutoff).sort((a, b) => a.date.localeCompare(b.date));
  if (upcoming.length === 0) return { next: null, rawLabels: [] };

  const nextDate = upcoming[0]!.date;
  const sameDay = upcoming.filter((r) => r.date === nextDate);
  const types = [...new Set(sameDay.map((r) => normaliseBinType(r.label)))];

  return { next: { date: nextDate, types }, rawLabels: sameDay.map((r) => r.label) };
}

export const binsSource: Source<{ uprn: string }, BinsData> = {
  id: 'bins',
  async fetch(config, signal): Promise<SourceResult<BinsData>> {
    if (!config.uprn) return { status: 'error', error: 'no UPRN configured' };

    try {
      const sessionRes = await globalThis.fetch(SESSION_URL, { signal });
      if (!sessionRes.ok) throw new Error(`session responded ${sessionRes.status}`);
      const sid = ((await sessionRes.json()) as { 'auth-session'?: string })['auth-session'];
      if (!sid) throw new Error('no auth-session returned');

      const params = new URLSearchParams({
        id: FORM_ID,
        repeat_against: '',
        noRetry: 'false',
        getOnlyTokens: 'undefined',
        log_id: '',
        app_name: 'AF-Renderer::Self',
        _: String(Date.now()),
        sid,
      });

      const res = await globalThis.fetch(`${LOOKUP_URL}?${params}`, {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 'Mozilla/5.0',
          'X-Requested-With': 'XMLHttpRequest',
          Referer: 'https://mycouncil.milton-keynes.gov.uk/fillform/?iframe_id=fillform-frame-1&db_id=',
        },
        body: JSON.stringify({ formValues: { 'Section 1': { uprnCore: { value: config.uprn } } } }),
      });
      if (!res.ok) throw new Error(`bin lookup responded ${res.status}`);

      return {
        status: 'ok',
        data: mapBins(await res.json(), new Date()),
        fetchedAt: new Date().toISOString(),
      };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },
};
```

`extractRows` is the one part that depends on the captured shape. Write it to
match, and **throw an `Error` containing the word "malformed"** when the shape is
not what is expected — the test above requires that, because a schema change must
not read as "no collections".

- [ ] **Step 5: Run the tests**

```bash
npm test && npm run check
```

Expected: 7 bins tests pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/capture-bins.mjs src/sources/bins.ts test/sources/bins.test.ts test/fixtures/bins.ts
git commit -m "feat: add Milton Keynes bin collection source"
```

---

### Task 3: Render the bins quadrant

**Files:**
- Modify: `src/model/dashboard.ts`, `src/render/template.ts`, `src/render/panel.css.ts`, `src/model/hash.ts`
- Modify: `test/render/template.test.ts`, `test/model/hash.test.ts`

**Interfaces:**
- Consumes: `BinsData`, `BinCollection`, `BinType` from Task 2
- Produces: `DashboardData.bins: BinsData | null`, rendered in the bottom-right cell

- [ ] **Step 1: Write the failing test**

Append to `test/render/template.test.ts`. The existing `data` fixture in that
file gains `bins: null`; these tests clone and override it.

```ts
test('renders the next bin collection with its types', () => {
  const withBins = structuredClone(data);
  withBins.bins = {
    next: { date: '2026-08-06', types: ['recycling', 'food'] },
    rawLabels: ['Mixed Recycling', 'Food Waste Caddy'],
  };
  withBins.sourceHealth = [{ id: 'bins', status: 'ok', fetchedAt: '2026-08-04T07:00:00.000Z', error: null }];

  const html = renderHtml(withBins, WFT0583, '');
  assert.match(html, /WED 6 AUG/i, 'the date is the headline');
  assert.match(html, /Mixed Recycling/, 'the council wording is shown, not our normalised type');
  assert.match(html, /Food Waste Caddy/);
  assert.match(html, /bin--recycling/, 'each type gets its own swatch class');
  assert.match(html, /bin--food/);
});

test('bins with no upcoming collection says so rather than looking broken', () => {
  const quiet = structuredClone(data);
  quiet.bins = { next: null, rawLabels: [] };
  quiet.sourceHealth = [{ id: 'bins', status: 'ok', fetchedAt: '2026-08-04T07:00:00.000Z', error: null }];

  const html = renderHtml(quiet, WFT0583, '');
  assert.match(html, /No collection scheduled/);
  assert.doesNotMatch(html, /Bins unavailable/, 'a successful fetch is not a failure');
});

test('bins unavailable is distinct from bins not set up', () => {
  const failed = structuredClone(data);
  failed.bins = null;
  failed.sourceHealth = [{ id: 'bins', status: 'error', fetchedAt: null, error: 'lookup responded 500' }];
  assert.match(renderHtml(failed, WFT0583, ''), /Bins unavailable/);

  const unset = structuredClone(data);
  unset.bins = null;
  unset.sourceHealth = [];
  assert.match(renderHtml(unset, WFT0583, ''), /Bins &mdash; not set up|Bins — not set up/);
});

test('a stale bin collection is shown with its age, not hidden', () => {
  const stale = structuredClone(data);
  stale.bins = { next: { date: '2026-08-06', types: ['general'] }, rawLabels: ['Refuse'] };
  stale.sourceHealth = [{ id: 'bins', status: 'stale', fetchedAt: '2026-08-04T03:10:00.000Z', error: 'timeout' }];

  const html = renderHtml(stale, WFT0583, '');
  assert.match(html, /Refuse/, 'stale data is still useful');
  assert.match(html, /04:10/, 'but its age is shown');
});

test('an unrecognised bin label still renders', () => {
  const odd = structuredClone(data);
  odd.bins = { next: { date: '2026-08-06', types: ['general'] }, rawLabels: ['Some New Scheme 2027'] };
  odd.sourceHealth = [{ id: 'bins', status: 'ok', fetchedAt: '2026-08-04T07:00:00.000Z', error: null }];
  assert.match(renderHtml(odd, WFT0583, ''), /Some New Scheme 2027/);
});
```

Append to `test/model/hash.test.ts`:

```ts
test('changes when the bin collection changes', () => {
  const a = contentHash(sample());
  const b = contentHash(sample({
    bins: { next: { date: '2026-08-13', types: ['general'] }, rawLabels: ['Refuse'] },
  }));
  assert.notEqual(a, b, 'the collection date is drawn on the panel');
});
```

The `sample()` helper in that file gains `bins: null`.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- --test-name-pattern="renders the next bin collection"
```

Expected: FAIL — `bins` is not a property of `DashboardData`.

- [ ] **Step 3: Extend the model**

In `src/model/dashboard.ts`, add the import and the field:

```ts
import type { BinsData } from '../sources/bins.ts';
```

Add to `DashboardData`, after `weather`:

```ts
  bins: BinsData | null;
```

Re-export the type so consumers do not reach into `sources/`:

```ts
export type { BinsData, BinCollection, BinType } from '../sources/bins.ts';
```

In `src/model/hash.ts`, add `bins: data.bins,` to the `visible` object. The
collection date and types are drawn on the panel, so a change must produce a new
frame.

- [ ] **Step 4: Add the swatch patterns**

In `src/render/panel.css.ts`, add before the `.footer` rule. **Only `#000` and
`#fff` — the no-greys test enforces this**, and it is what makes thresholding
lossless.

```css
.bin-date{font-size:30px;line-height:1;margin-bottom:8px;}
.bin-row{display:flex;align-items:center;gap:9px;font-size:15px;margin-bottom:6px;}
.bin-swatch{width:13px;height:13px;border:2px solid #000;flex:none;}

/* Bin types are told apart by pattern, not colour — the panel has no colour.
   Each pattern is built only from pure black and white so thresholding is
   exact rather than a judgement call. */
.bin--general{background:#000;}
.bin--recycling{background:linear-gradient(90deg,#000 0 50%,#fff 50% 100%);}
.bin--food{background-image:radial-gradient(#000 40%,#fff 40%);background-size:4px 4px;}
.bin--garden{background-image:repeating-linear-gradient(45deg,#000 0 2px,#fff 2px 5px);}
```

- [ ] **Step 5: Render the quadrant**

In `src/render/template.ts`, add above `renderHtml`:

```ts
const BIN_DATE_FORMAT: Intl.DateTimeFormatOptions = {
  weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
};

function binsCell(data: DashboardData): string {
  const health = data.sourceHealth.find((s) => s.id === 'bins');

  // Not configured and broken are different things and must read differently.
  if (!health) return emptySlot('Bins — not set up');
  if (!data.bins) return emptySlot('Bins unavailable');
  if (!data.bins.next) return emptySlot('No collection scheduled');

  const when = new Intl.DateTimeFormat('en-GB', BIN_DATE_FORMAT)
    .format(new Date(`${data.bins.next.date}T12:00:00.000Z`))
    .toUpperCase();

  // Pair each council label with a swatch, falling back to the collection's
  // own types when labels and types disagree in length.
  const rows = data.bins.rawLabels.length > 0
    ? data.bins.rawLabels.map((label, i) => ({
        label,
        type: data.bins!.next!.types[i] ?? data.bins!.next!.types[0] ?? 'general',
      }))
    : data.bins.next.types.map((type) => ({ label: type, type }));

  const list = rows
    .map((r) => `<div class="bin-row"><span class="bin-swatch bin--${esc(r.type)}"></span><span>${esc(r.label)}</span></div>`)
    .join('');

  return `<div class="bin-date disp">${esc(when)}</div>${list}`;
}
```

Replace the bottom-right cell:

```ts
  <div class="cell cell--br">
    <div class="label">Bins${staleBadge(data, 'bins')}</div>
    ${binsCell(data)}
  </div>
```

- [ ] **Step 6: Run the tests**

```bash
npm test && npm run check && npm run test:tz
```

Expected: 5 template tests and 1 hash test pass; the no-greys guard still
passes; counts match between `npm test` and `npm run test:tz`.

- [ ] **Step 7: Commit**

```bash
git add src/model/dashboard.ts src/model/hash.ts src/render/template.ts src/render/panel.css.ts test/render/template.test.ts test/model/hash.test.ts
git commit -m "feat: render bin collections in the bottom-right quadrant"
```

---

### Task 4: Wire bins in and make it configurable

**Files:**
- Modify: `src/devices/types.ts`, `src/render/frameService.ts`, `src/http/manageRoutes.ts`, `public/panels.js`
- Modify: `test/devices/store.test.ts`, `test/http/manageRoutes.test.ts`, `test/render/frameService.test.ts`

**Interfaces:**
- Consumes: `binsSource` (Task 2), `DashboardData.bins` (Task 3)
- Produces: `DeviceRecord.binsUprn: string`, bins in `SourceBundle`

- [ ] **Step 1: Write the failing test**

Append to `test/devices/store.test.ts`:

```ts
test('new devices start with no UPRN configured', async () => {
  await withStore(async (store) => {
    assert.equal((await store.getOrCreate('esp32-new')).binsUprn, '');
  });
});
```

Append to `test/http/manageRoutes.test.ts`:

```ts
test('accepts a valid UPRN', async () => {
  await withServer(async (base, store) => {
    await store.getOrCreate('esp32-1');
    const res = await fetch(`${base}/api/devices/esp32-1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ binsUprn: '100080152345' }),
    });
    assert.equal(res.status, 200);
    assert.equal((await store.get('esp32-1'))?.binsUprn, '100080152345');
  });
});

test('rejects a UPRN that is not digits', async () => {
  await withServer(async (base, store) => {
    await store.getOrCreate('esp32-1');
    const res = await fetch(`${base}/api/devices/esp32-1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ binsUprn: 'not-a-uprn' }),
    });
    assert.equal(res.status, 400);
  });
});

test('an empty UPRN is allowed — it means bins are switched off', async () => {
  await withServer(async (base, store) => {
    await store.getOrCreate('esp32-1');
    const res = await fetch(`${base}/api/devices/esp32-1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ binsUprn: '' }),
    });
    assert.equal(res.status, 200);
  });
});
```

Append to `test/render/frameService.test.ts`:

```ts
test('a device with no UPRN does not report bins as broken', async () => {
  const bundle: SourceBundle = {
    calendar: { today: [], tomorrow: [] }, weather: null, bins: null, sourceHealth: [],
  };
  await withService(async () => bundle, async (service) => {
    const device = { ...defaultDevice('esp32-test'), claimed: true };
    const frame = await service.frameFor(device, 4.0);
    assert.equal(frame.buffer.length, 48000);
    // Not configured is silence, not an error. The panel says "not set up".
    assert.equal(service.sourceIssues().length, 0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- --test-name-pattern="no UPRN configured"
```

Expected: FAIL — `binsUprn` is undefined, not `''`.

- [ ] **Step 3: Add the field**

In `src/devices/types.ts`, add to `DeviceRecord` after `locationLabel`:

```ts
  /** Unique Property Reference Number for bin collections. Empty disables bins. */
  binsUprn: string;
```

And `binsUprn: '',` to `defaultDevice()`.

- [ ] **Step 4: Validate it**

In `src/http/manageRoutes.ts`, add to `patchSchema` after `locationLabel`:

```ts
    // Empty is valid and means "bins off". A UPRN is up to 12 digits.
    binsUprn: z.string().regex(/^\d{0,12}$/, 'UPRN must be up to 12 digits').optional(),
```

- [ ] **Step 5: Fetch it**

In `src/render/frameService.ts`, add the import:

```ts
import { binsSource } from '../sources/bins.ts';
import type { BinsData } from '../sources/bins.ts';
```

Add `bins: BinsData | null;` to `SourceBundle`.

In `fetchAll`, run bins alongside the others — but **only when a UPRN is set**,
so an unconfigured device produces silence rather than a permanent error:

```ts
    const [calendar, weather, bins] = await Promise.all([
      runSource(icalSource, { urls: device.calendarUrls, timezone: device.timezone }, this.deps.cache, SOURCE_TIMEOUT_MS),
      runSource(openMeteoSource, { latitude: device.latitude, longitude: device.longitude, timezone: device.timezone }, this.deps.cache, SOURCE_TIMEOUT_MS),
      device.binsUprn
        ? runSource(binsSource, { uprn: device.binsUprn }, this.deps.cache, SOURCE_TIMEOUT_MS)
        : Promise.resolve(null),
    ]);

    return {
      calendar: calendar.data,
      weather: weather.data,
      bins: bins?.data ?? null,
      // An unconfigured source contributes no health entry at all, so the
      // template can tell "not set up" from "failed".
      sourceHealth: [calendar.health, weather.health, ...(bins ? [bins.health] : [])],
    };
```

Add `bins: bundle.bins,` to the object `buildData` returns.

- [ ] **Step 6: Add the config field**

In `public/panels.js`, inside `detail()` after the Calendar section:

```js
      <h3>Bins</h3>
      ${field(device.id, 'binsUprn', 'UPRN', device.binsUprn)}
      <p class="meta">Milton Keynes only. Find your UPRN at
        <a href="https://www.findmyaddress.co.uk" target="_blank" rel="noreferrer">findmyaddress.co.uk</a>.
        Leave blank to hide the bins panel.</p>
```

And in `save()`'s body: `binsUprn: raw.binsUprn,`.

- [ ] **Step 7: Run the tests**

```bash
npm test && npm run check && npm run test:tz
```

Expected: all pass, counts match.

- [ ] **Step 8: Verify in a browser**

```bash
npm start
```

Open `http://localhost:8080`, paste a real UPRN, save, and check the preview
image shows a real collection date. Then clear it and confirm the quadrant reads
**"Bins — not set up"** rather than "Bins unavailable" — those must not look the
same.

- [ ] **Step 9: Commit**

```bash
git add src/devices/types.ts src/render/frameService.ts src/http/manageRoutes.ts public/panels.js test/
git commit -m "feat: wire bins into the render and make the UPRN configurable"
```

---

### Task 5: Train model, normalisation and quadrant

> This task deliberately contains **no network code**. It builds everything the
> train feature needs except the transport, so that Task 7 — the only part that
> depends on the unresolved protocol question — is as small as possible.

**Files:**
- Create: `src/sources/train.ts`, `test/sources/train.test.ts`, `test/fixtures/train.ts`
- Modify: `src/model/dashboard.ts`, `src/model/hash.ts`, `src/render/template.ts`, `src/render/panel.css.ts`, `test/render/template.test.ts`

**Interfaces:**
- Consumes: `findStation` from Task 1
- Produces:
  - `interface RawDeparture { scheduled: string; expected: string | null; platform: string | null }`
  - `type DepartureStatus = 'on-time' | 'delayed' | 'cancelled'`
  - `interface TrainDeparture { scheduled: string; expected: string | null; status: DepartureStatus; delayMinutes: number | null; platform: string | null }`
  - `interface TrainData { originCrs: string; originName: string; destinationCrs: string; destinationName: string; departures: TrainDeparture[] }`
  - `buildDepartures(raw: RawDeparture[], limit?: number): TrainDeparture[]`
  - `buildTrainData(originCrs, destinationCrs, raw): TrainData`
  - `DashboardData.train: TrainData | null`

- [ ] **Step 1: Write the failing normalisation test**

`RawDeparture` is the protocol-neutral middle. Both candidate transports supply
exactly these three things — Darwin calls them `std`, `etd` and `platform` — so
normalising from this shape is genuinely independent of the answer in Task 7,
not a guess about it.

Create `test/sources/train.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDepartures, buildTrainData } from '../../src/sources/train.ts';

test('an on-time departure carries no expected time', () => {
  const [d] = buildDepartures([{ scheduled: '07:42', expected: 'On time', platform: '3' }]);
  assert.equal(d?.status, 'on-time');
  assert.equal(d?.expected, null, 'nothing to show beside the scheduled time');
  assert.equal(d?.delayMinutes, 0);
  assert.equal(d?.platform, '3');
});

test('a null expected time is treated as on time, not as an error', () => {
  // Darwin omits etd on some services. Absent is not the same as broken.
  assert.equal(buildDepartures([{ scheduled: '07:42', expected: null, platform: null }])[0]?.status, 'on-time');
});

test('an expected time later than scheduled is a delay, with the minutes computed', () => {
  const [d] = buildDepartures([{ scheduled: '07:58', expected: '08:01', platform: '1' }]);
  assert.equal(d?.status, 'delayed');
  assert.equal(d?.expected, '08:01');
  assert.equal(d?.delayMinutes, 3);
});

test('a delay across midnight is 9 minutes, not 1431', () => {
  // Naive subtraction gives 7 - 1438 = -1431. The panel would show a nonsense
  // number on the one service most likely to be delayed.
  const [d] = buildDepartures([{ scheduled: '23:58', expected: '00:07', platform: null }]);
  assert.equal(d?.status, 'delayed');
  assert.equal(d?.delayMinutes, 9);
});

test('an expected time equal to or earlier than scheduled is on time', () => {
  assert.equal(buildDepartures([{ scheduled: '07:42', expected: '07:42', platform: null }])[0]?.status, 'on-time');
  assert.equal(buildDepartures([{ scheduled: '07:42', expected: '07:40', platform: null }])[0]?.status, 'on-time');
});

test('a cancelled service is cancelled regardless of wording', () => {
  for (const wording of ['Cancelled', 'CANCELLED', 'Cancelled at Rugby']) {
    const [d] = buildDepartures([{ scheduled: '08:34', expected: wording, platform: '2' }]);
    assert.equal(d?.status, 'cancelled', wording);
  }
});

test('"Delayed" with no replacement time is a delay of unknown length', () => {
  const [d] = buildDepartures([{ scheduled: '08:34', expected: 'Delayed', platform: null }]);
  assert.equal(d?.status, 'delayed');
  assert.equal(d?.delayMinutes, null, 'unknown is null, never 0 — 0 would render "0 late"');
  assert.equal(d?.expected, null);
});

test('caps at three departures, because that is what the cell fits', () => {
  const many = ['07:42', '08:01', '08:19', '08:34', '08:50'].map((scheduled) => ({
    scheduled, expected: 'On time', platform: null,
  }));
  assert.equal(buildDepartures(many).length, 3);
  assert.equal(buildDepartures(many, 2).length, 2);
});

test('fewer than three departures is valid, not an error', () => {
  assert.equal(buildDepartures([{ scheduled: '23:47', expected: 'On time', platform: '1' }]).length, 1);
  assert.deepEqual(buildDepartures([]), []);
});

test('a departure with an unparseable scheduled time is dropped, not rendered', () => {
  const out = buildDepartures([
    { scheduled: 'nonsense', expected: 'On time', platform: null },
    { scheduled: '07:42', expected: 'On time', platform: null },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.scheduled, '07:42');
});

test('an empty platform string becomes null so the column is omitted', () => {
  assert.equal(buildDepartures([{ scheduled: '07:42', expected: 'On time', platform: '  ' }])[0]?.platform, null);
});

test('buildTrainData resolves station names from the bundled list', () => {
  const data = buildTrainData('MKC', 'EUS', [{ scheduled: '07:42', expected: 'On time', platform: '3' }]);
  assert.equal(data.originCrs, 'MKC');
  assert.match(data.originName, /Milton Keynes/);
  assert.match(data.destinationName, /Euston/);
  assert.equal(data.departures.length, 1);
});

test('an unknown CRS falls back to the code itself rather than blank', () => {
  const data = buildTrainData('ZZZ', 'QQQ', []);
  assert.equal(data.originName, 'ZZZ', 'a code is more useful than an empty heading');
  assert.equal(data.destinationName, 'QQQ');
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- --test-name-pattern="on-time departure carries no expected"
```

Expected: FAIL — cannot resolve `src/sources/train.ts`.

- [ ] **Step 3: Write the normalisation**

Create `src/sources/train.ts`:

```ts
import { findStation } from './stations.ts';

/**
 * A departure as published, before interpretation.
 *
 * This is the seam the transport plugs into. Both candidate protocols supply
 * these same three fields — Darwin names them std / etd / platform — so
 * everything below is independent of how they were fetched.
 */
export interface RawDeparture {
  /** Scheduled departure, 'HH:MM'. */
  scheduled: string;
  /** 'On time' | 'Cancelled' | 'Delayed' | 'HH:MM' | null. */
  expected: string | null;
  platform: string | null;
}

export type DepartureStatus = 'on-time' | 'delayed' | 'cancelled';

export interface TrainDeparture {
  scheduled: string;
  /** The revised time, set only when it differs from `scheduled`. */
  expected: string | null;
  status: DepartureStatus;
  /** Null when the operator says "Delayed" without saying by how long. */
  delayMinutes: number | null;
  platform: string | null;
}

export interface TrainData {
  originCrs: string;
  originName: string;
  destinationCrs: string;
  destinationName: string;
  departures: TrainDeparture[];
}

/** The cell fits three rows at a size readable at arm's length. */
const MAX_DEPARTURES = 3;

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function minutesOfDay(value: string): number | null {
  const match = HHMM.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Difference in minutes, allowing for the clock rolling past midnight.
 *
 * A service scheduled 23:58 and expected 00:07 is nine minutes late, not
 * 1,431 minutes early. Late-night services are among the most likely to be
 * delayed, so this is the ordinary case rather than an edge case.
 */
function delayBetween(scheduled: number, expected: number): number {
  const diff = expected - scheduled;
  return diff < -720 ? diff + 1440 : diff;
}

export function buildDepartures(raw: RawDeparture[], limit = MAX_DEPARTURES): TrainDeparture[] {
  const out: TrainDeparture[] = [];

  for (const item of raw) {
    const scheduledMinutes = minutesOfDay(item.scheduled);
    // A row we cannot place in time is worse than a missing row.
    if (scheduledMinutes === null) continue;

    const scheduled = item.scheduled.trim();
    const platform = item.platform?.trim() ? item.platform.trim() : null;
    const status = (item.expected ?? '').trim();

    if (/cancel/i.test(status)) {
      out.push({ scheduled, expected: null, status: 'cancelled', delayMinutes: null, platform });
    } else {
      const expectedMinutes = minutesOfDay(status);
      if (expectedMinutes === null) {
        // Either 'On time', absent, or a free-text disruption note. Only an
        // explicit 'Delayed' is treated as a delay; anything else we cannot
        // interpret is shown as on time rather than as alarming nonsense.
        const delayed = /delay/i.test(status);
        out.push({
          scheduled,
          expected: null,
          status: delayed ? 'delayed' : 'on-time',
          // Unknown must be null, never 0 — 0 would render as "0 late".
          delayMinutes: delayed ? null : 0,
          platform,
        });
      } else {
        const delay = delayBetween(scheduledMinutes, expectedMinutes);
        out.push(
          delay > 0
            ? { scheduled, expected: status, status: 'delayed', delayMinutes: delay, platform }
            : { scheduled, expected: null, status: 'on-time', delayMinutes: 0, platform },
        );
      }
    }

    if (out.length === limit) break;
  }

  return out;
}

export function buildTrainData(
  originCrs: string,
  destinationCrs: string,
  raw: RawDeparture[],
): TrainData {
  const origin = findStation(originCrs);
  const destination = findStation(destinationCrs);
  return {
    originCrs: originCrs.toUpperCase(),
    originName: origin?.name ?? originCrs.toUpperCase(),
    destinationCrs: destinationCrs.toUpperCase(),
    destinationName: destination?.name ?? destinationCrs.toUpperCase(),
    departures: buildDepartures(raw),
  };
}
```

- [ ] **Step 4: Run the normalisation tests**

```bash
npm test -- --test-name-pattern="departure|buildTrainData|midnight|cancelled|caps at three"
```

Expected: 13 tests pass.

- [ ] **Step 5: Write the failing template test**

Create `test/fixtures/train.ts`:

```ts
import type { TrainData } from '../../src/sources/train.ts';

/** A morning board with one of each status — the render's worst case. */
export const mixedBoard: TrainData = {
  originCrs: 'MKC',
  originName: 'Milton Keynes Central',
  destinationCrs: 'EUS',
  destinationName: 'London Euston',
  departures: [
    { scheduled: '07:42', expected: null, status: 'on-time', delayMinutes: 0, platform: '3' },
    { scheduled: '07:58', expected: '08:01', status: 'delayed', delayMinutes: 9, platform: '1' },
    { scheduled: '08:19', expected: null, status: 'cancelled', delayMinutes: null, platform: null },
  ],
};
```

Append to `test/render/template.test.ts`, importing `mixedBoard` from
`../fixtures/train.ts`. As in Task 3, the shared `data` fixture gains
`train: null` and these tests clone and override it.

```ts
test('renders departures with times, statuses and platforms', () => {
  const withTrains = structuredClone(data);
  withTrains.train = structuredClone(mixedBoard);
  withTrains.sourceHealth = [{ id: 'train', status: 'ok', fetchedAt: '2026-08-04T07:40:00.000Z', error: null }];

  const html = renderHtml(withTrains, WFT0583, '');
  assert.match(html, /MILTON KEYNES CENTRAL|Milton Keynes Central/i, 'the route is the heading');
  assert.match(html, /London Euston/i);
  assert.match(html, /07:42/);
  assert.match(html, /On time/);
  assert.match(html, /Plat 3/);
});

test('a delayed service shows the new time large and the old struck through', () => {
  const withTrains = structuredClone(data);
  withTrains.train = structuredClone(mixedBoard);
  withTrains.sourceHealth = [{ id: 'train', status: 'ok', fetchedAt: '2026-08-04T07:40:00.000Z', error: null }];

  const html = renderHtml(withTrains, WFT0583, '');
  // The panel has no colour, so the strike-through is the whole signal.
  assert.match(html, /dep-time[^>]*>08:01/, 'the time you must act on is the big one');
  assert.match(html, /dep-was[^>]*>07:58/, 'the original is struck through beside it');
  assert.match(html, /9 late/);
});

test('a cancelled service says so and shows no platform', () => {
  const withTrains = structuredClone(data);
  withTrains.train = structuredClone(mixedBoard);
  withTrains.sourceHealth = [{ id: 'train', status: 'ok', fetchedAt: '2026-08-04T07:40:00.000Z', error: null }];

  const html = renderHtml(withTrains, WFT0583, '');
  assert.match(html, /Cancelled/);
  // A platform for a train that is not running would send someone to it.
  assert.doesNotMatch(html, /Plat\s*&mdash;|Plat\s*—/);
});

test('no departures is different from trains unavailable', () => {
  const quiet = structuredClone(data);
  quiet.train = { ...structuredClone(mixedBoard), departures: [] };
  quiet.sourceHealth = [{ id: 'train', status: 'ok', fetchedAt: '2026-08-04T23:40:00.000Z', error: null }];
  const html = renderHtml(quiet, WFT0583, '');
  assert.match(html, /No departures/);
  assert.doesNotMatch(html, /Trains unavailable/);
});

test('trains unavailable is distinct from trains not set up', () => {
  const failed = structuredClone(data);
  failed.train = null;
  failed.sourceHealth = [{ id: 'train', status: 'error', fetchedAt: null, error: 'timeout' }];
  assert.match(renderHtml(failed, WFT0583, ''), /Trains unavailable/);

  const unset = structuredClone(data);
  unset.train = null;
  unset.sourceHealth = [];
  assert.match(renderHtml(unset, WFT0583, ''), /Trains &mdash; not set up|Trains — not set up/);
});

test('a single departure renders — late at night that is the whole board', () => {
  const late = structuredClone(data);
  late.train = {
    ...structuredClone(mixedBoard),
    departures: [{ scheduled: '23:47', expected: null, status: 'on-time', delayMinutes: 0, platform: '1' }],
  };
  late.sourceHealth = [{ id: 'train', status: 'ok', fetchedAt: '2026-08-04T23:00:00.000Z', error: null }];
  assert.match(renderHtml(late, WFT0583, ''), /23:47/);
});
```

Append to `test/model/hash.test.ts`:

```ts
test('changes when a departure is delayed', () => {
  const onTime = sample({ train: structuredClone(mixedBoard) });
  const delayed = structuredClone(mixedBoard);
  delayed.departures[0] = { scheduled: '07:42', expected: '07:55', status: 'delayed', delayMinutes: 13, platform: '3' };

  // This is exactly why §4 of the spec accepts more frequent refreshes: live
  // times are drawn on the panel, so they must be part of the hash.
  assert.notEqual(contentHash(onTime), contentHash(sample({ train: delayed })));
});
```

The `sample()` helper gains `train: null`.

- [ ] **Step 6: Run the template test to verify it fails**

```bash
npm test -- --test-name-pattern="renders departures with times"
```

Expected: FAIL — `train` is not a property of `DashboardData`.

- [ ] **Step 7: Extend the model**

In `src/model/dashboard.ts`, add the import, the field after `bins`, and the
re-export:

```ts
import type { TrainData } from '../sources/train.ts';
```

```ts
  train: TrainData | null;
```

```ts
export type { TrainData, TrainDeparture, DepartureStatus } from '../sources/train.ts';
```

In `src/model/hash.ts`, add `train: data.train,` to the `visible` object.

- [ ] **Step 8: Add the departure styles**

In `src/render/panel.css.ts`, beside the bin rules from Task 3. Pure black and
white only, as ever:

```css
.dep{display:flex;gap:12px;align-items:baseline;margin-bottom:7px;}
.dep-time{font-size:21px;font-weight:700;width:62px;font-variant-numeric:tabular-nums;}
.dep-status{font-size:12px;}
.dep-platform{font-size:12px;margin-left:auto;font-variant-numeric:tabular-nums;}
.dep-was{text-decoration:line-through;}
```

- [ ] **Step 9: Render the quadrant**

In `src/render/template.ts`, add above `renderHtml`:

```ts
function departureRow(departure: TrainDeparture): string {
  // For a delay the revised time is the one to act on, so it takes the large
  // slot and the original is struck through in the status beside it.
  const headline = departure.status === 'delayed' && departure.expected
    ? departure.expected
    : departure.scheduled;

  let status: string;
  if (departure.status === 'cancelled') {
    status = 'Cancelled';
  } else if (departure.status === 'delayed') {
    status = departure.expected
      ? `<span class="dep-was">${esc(departure.scheduled)}</span> ${departure.delayMinutes} late`
      : 'Delayed';
  } else {
    status = 'On time';
  }

  const timeClass = departure.status === 'cancelled' ? 'dep-time dep-was' : 'dep-time';

  // No platform for a cancelled service — printing one sends someone to it.
  // An absent platform omits the column rather than rendering an empty one.
  const platform = departure.status !== 'cancelled' && departure.platform
    ? `<span class="dep-platform">Plat ${esc(departure.platform)}</span>`
    : '';

  return `<div class="dep"><span class="${timeClass}">${esc(headline)}</span><span class="dep-status">${status}</span>${platform}</div>`;
}

function trainLabel(data: DashboardData): string {
  if (!data.train) return 'Trains';
  return `${esc(data.train.originCrs)} &rarr; ${esc(data.train.destinationName)}`;
}

function trainCell(data: DashboardData): string {
  const health = data.sourceHealth.find((s) => s.id === 'train');

  if (!health) return emptySlot('Trains — not set up');
  if (!data.train) return emptySlot('Trains unavailable');
  // A successful fetch that found nothing is not a failure. It happens every
  // night, and "No departures" is the true answer.
  if (data.train.departures.length === 0) return emptySlot('No departures');

  return data.train.departures.map(departureRow).join('');
}
```

Import `TrainDeparture` at the top of the file, then replace the bottom-left
cell:

```ts
  <div class="cell cell--bl">
    <div class="label">${trainLabel(data)}${staleBadge(data, 'train')}</div>
    ${trainCell(data)}
  </div>
```

- [ ] **Step 10: Run everything**

```bash
npm test && npm run check && npm run test:tz
```

Expected: all pass; the no-greys guard still passes; `npm test` and
`npm run test:tz` report the same count.

- [ ] **Step 11: Commit**

```bash
git add src/sources/train.ts src/model/dashboard.ts src/model/hash.ts src/render/template.ts src/render/panel.css.ts test/
git commit -m "feat: normalise and render train departures, without the transport"
```

---

### Task 6: Train configuration and the station picker

**Files:**
- Create: `public/stationPicker.js`, `test/sources/stationRoutes.test.ts`
- Modify: `src/devices/types.ts`, `src/http/manageRoutes.ts`, `public/panels.js`, `public/app.css`
- Modify: `test/http/manageRoutes.test.ts`, `test/devices/store.test.ts`

**Interfaces:**
- Consumes: `searchStations`, `findStation` (Task 1)
- Produces:
  - `DeviceRecord.trainOriginCrs: string`, `DeviceRecord.trainDestinationCrs: string`
  - `GET /api/stations?q=` → `{ results: Station[] }`
  - `renderStationPicker(container, { id, field, label, value })` from `public/stationPicker.js`

- [ ] **Step 1: Write the failing tests**

Create `test/sources/stationRoutes.test.ts` — reuse the `withServer` helper the
existing `test/http/manageRoutes.test.ts` uses:

```ts
test('searches stations over HTTP', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/stations?q=milton%20keynes`);
    assert.equal(res.status, 200);
    const { results } = await res.json();
    assert.ok(results.some((s: { crs: string }) => s.crs === 'MKC'));
  });
});

test('an empty query returns an empty list rather than 2,500 stations', async () => {
  await withServer(async (base) => {
    const { results } = await (await fetch(`${base}/api/stations?q=`)).json();
    assert.deepEqual(results, []);
  });
});
```

Append to `test/http/manageRoutes.test.ts`:

```ts
test('accepts a known CRS pair', async () => {
  await withServer(async (base, store) => {
    await store.getOrCreate('esp32-1');
    const res = await fetch(`${base}/api/devices/esp32-1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trainOriginCrs: 'mkc', trainDestinationCrs: 'EUS' }),
    });
    assert.equal(res.status, 200);
    const saved = await store.get('esp32-1');
    assert.equal(saved?.trainOriginCrs, 'MKC', 'stored uppercase regardless of what was typed');
    assert.equal(saved?.trainDestinationCrs, 'EUS');
  });
});

test('rejects a CRS that is well-formed but does not exist', async () => {
  await withServer(async (base, store) => {
    await store.getOrCreate('esp32-1');
    const res = await fetch(`${base}/api/devices/esp32-1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trainOriginCrs: 'ZZZ' }),
    });
    // Three letters is not enough — an unknown code would fail silently at
    // fetch time, hours later, as "Trains unavailable".
    assert.equal(res.status, 400);
  });
});

test('empty CRS fields are allowed — they mean trains are switched off', async () => {
  await withServer(async (base, store) => {
    await store.getOrCreate('esp32-1');
    const res = await fetch(`${base}/api/devices/esp32-1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trainOriginCrs: '', trainDestinationCrs: '' }),
    });
    assert.equal(res.status, 200);
  });
});
```

Append to `test/devices/store.test.ts`:

```ts
test('new devices start with no route configured', async () => {
  await withStore(async (store) => {
    const device = await store.getOrCreate('esp32-new');
    assert.equal(device.trainOriginCrs, '');
    assert.equal(device.trainDestinationCrs, '');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- --test-name-pattern="searches stations over HTTP"
```

Expected: FAIL — 404, the route does not exist.

- [ ] **Step 3: Add the fields**

In `src/devices/types.ts`, after `binsUprn`:

```ts
  /** Origin station CRS, e.g. 'MKC'. Empty disables departures. */
  trainOriginCrs: string;
  /** Destination station CRS, e.g. 'EUS'. Both are needed for a board. */
  trainDestinationCrs: string;
```

And in `defaultDevice()`: `trainOriginCrs: '', trainDestinationCrs: '',`.

- [ ] **Step 4: Validate and expose the search**

In `src/http/manageRoutes.ts`, add the import:

```ts
import { findStation, searchStations } from '../sources/stations.ts';
```

Add to `patchSchema`. Each field is validated on its own — a partial `PUT` may
carry only one of them, so a cross-field rule would reject legitimate patches.
Origin-without-destination is handled at fetch time in Task 7, where the
quadrant simply stays in its not-configured state:

```ts
    trainOriginCrs: z
      .string()
      .transform((v) => v.trim().toUpperCase())
      .refine((v) => v === '' || findStation(v) !== null, 'unknown station code')
      .optional(),
    trainDestinationCrs: z
      .string()
      .transform((v) => v.trim().toUpperCase())
      .refine((v) => v === '' || findStation(v) !== null, 'unknown station code')
      .optional(),
```

Add the route beside the existing `/api/geocode` handler, so it inherits the
same session handling:

```ts
  router.get('/stations', (req, res) => {
    const query = typeof req.query.q === 'string' ? req.query.q : '';
    // No network, no quota, no failure mode — the list is bundled.
    res.json({ results: searchStations(query) });
  });
```

- [ ] **Step 5: Build the picker**

Create `public/stationPicker.js`. It mirrors `cityPicker.js`'s contract — the
`dataset` seam and, critically, the mousedown fix, which was a real bug there
and would be the identical bug here:

```js
// Contract: like cityPicker, this communicates with the form through
// `container.dataset` rather than a named input — save() in panels.js reads
// dataset.crs and ignores form fields the picker renders. A named <input>
// would be collected by FormData and then silently ignored.
import { getJson } from './api.js';
import { esc } from './components.js';

const DEBOUNCE_MS = 150;
const MIN_CHARS = 2;

/**
 * @param container  element to render into; its dataset carries the result
 * @param options    { id, field, label, value } — `field` is the DeviceRecord
 *                   key, used only for the input id so labels bind correctly
 */
export function renderStationPicker(container, { id, field, label, value }) {
  const inputId = `station-${id}-${field}`;
  container.dataset.crs = value || '';

  container.innerHTML = `
    <label for="${inputId}">${esc(label)}</label>
    <input id="${inputId}" type="text" autocomplete="off" spellcheck="false"
           value="${esc(value || '')}" placeholder="Station name or CRS code">
    <div class="city-results" hidden></div>
    <p class="meta station-current">${value ? `Using ${esc(value)}` : 'Not set'}</p>`;

  const input = container.querySelector(`#${CSS.escape(inputId)}`);
  const results = container.querySelector('.city-results');
  const currentLine = container.querySelector('.station-current');
  let sequence = 0;
  let timer = null;

  function choose(station) {
    container.dataset.crs = station.crs;
    input.value = `${station.name} (${station.crs})`;
    results.hidden = true;
    currentLine.textContent = `Will save ${station.crs} — ${station.name}`;
  }

  async function search(query) {
    const mine = ++sequence;
    try {
      const { results: found } = await getJson(`/api/stations?q=${encodeURIComponent(query)}`);
      if (mine !== sequence) return; // superseded keystroke

      if (found.length === 0) {
        results.innerHTML = '<div class="city-empty">No matches</div>';
        results.hidden = false;
        return;
      }

      results.innerHTML = found
        .map((s, i) => `<button type="button" class="city-option" data-index="${i}">${esc(s.name)} (${esc(s.crs)})</button>`)
        .join('');
      results.hidden = false;
      results.querySelectorAll('.city-option').forEach((button) => {
        button.addEventListener('click', () => choose(found[Number(button.dataset.index)]));
      });
    } catch {
      if (mine !== sequence) return;
      results.innerHTML = '<div class="city-empty">Lookup failed</div>';
      results.hidden = false;
    }
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    // Clearing the box clears the choice — otherwise an emptied field would
    // silently keep saving the station it used to hold.
    if (input.value.trim() === '') container.dataset.crs = '';
    const query = input.value.trim();
    if (query.length < MIN_CHARS) {
      sequence += 1;
      results.hidden = true;
      return;
    }
    timer = setTimeout(() => void search(query), DEBOUNCE_MS);
  });

  // Same fix as cityPicker.js, for the same measured reason: mousedown moves
  // focus off the input, blur hides the list, and by mouseup the option is no
  // longer hit-testable — so no click event is ever generated and choosing a
  // station does nothing. preventDefault stops focus moving at all. Keyboard
  // selection is unaffected.
  results.addEventListener('mousedown', (event) => event.preventDefault());
  input.addEventListener('blur', () => { results.hidden = true; });
}
```

- [ ] **Step 6: Put it in the form**

In `public/panels.js`, import it beside the city picker:

```js
import { renderStationPicker } from './stationPicker.js';
```

In `detail()`, after the Bins section from Task 4:

```js
      <h3>Trains</h3>
      <div class="station-picker" data-field="trainOriginCrs"></div>
      <div class="station-picker" data-field="trainDestinationCrs"></div>
      <p class="meta">Both stations are needed. Leave either blank to hide the departures panel.</p>
```

Then, wherever `detail()` already mounts the city picker onto the built
fragment, mount these too:

```js
  scratch.querySelectorAll('.station-picker').forEach((container) => {
    const field = container.dataset.field;
    renderStationPicker(container, {
      id: device.id,
      field,
      label: field === 'trainOriginCrs' ? 'From' : 'To',
      value: device[field] || '',
    });
  });
```

And in `save()`, read the dataset seam rather than the visible text — the input
shows `Milton Keynes Central (MKC)`, which is not a CRS code:

```js
  const origin = form.querySelector('[data-field="trainOriginCrs"]');
  const destination = form.querySelector('[data-field="trainDestinationCrs"]');
  body.trainOriginCrs = origin?.dataset.crs ?? '';
  body.trainDestinationCrs = destination?.dataset.crs ?? '';
```

- [ ] **Step 7: Run the tests**

```bash
npm test && npm run check
```

Expected: all pass.

- [ ] **Step 8: Verify the picker in a browser**

This is the step that catches the class of bug the city picker had. A synthetic
`click` dispatched at the element **does not reproduce it** — the bug only
appears with a real mousedown/mouseup pair.

```bash
npm start
```

At `http://localhost:8080`: type `milton` into **From**, and **click the result
with the mouse**. The line beneath must change to `Will save MKC — Milton Keynes
Central`. Repeat for **To** with `euston`. Save, reload the page, and confirm
both fields still show the stations — a value that does not survive a reload was
never stored.

- [ ] **Step 9: Commit**

```bash
git add src/devices/types.ts src/http/manageRoutes.ts public/stationPicker.js public/panels.js public/app.css test/
git commit -m "feat: add train route configuration and a bundled station picker"
```

---

### Task 7: The train transport

> **Do not start this task until the protocol is known.** Everything else is
> already built and tested; this task is only the fetch. Step 1 decides which of
> two branches to follow, and the branches differ only inside
> `src/sources/train.ts`.

**Files:**
- Modify: `src/sources/train.ts`, `src/render/frameService.ts`, `src/index.ts`, `docs/configuration.md`
- Create: `test/fixtures/trainResponse.ts`
- Modify: `test/sources/train.test.ts`, `test/render/frameService.test.ts`

**Interfaces:**
- Consumes: `buildTrainData` (Task 5), `DeviceRecord.trainOriginCrs` (Task 6)
- Produces: `trainSource: Source<TrainConfig, TrainData>` where
  `interface TrainConfig { originCrs: string; destinationCrs: string; apiKey: string }`

- [ ] **Step 1: Determine the protocol and capture a real response**

Sign in to the Rail Data Marketplace and open the Live Departure Boards product.
If it offers a REST/JSON endpoint, follow **Branch A**. If the only transport is
SOAP, follow **Branch B**.

Record the answer in `docs/superpowers/specs/2026-08-05-inkpanel-spec2b-design.md`
§8, replacing "Open item" with what was found. That section exists precisely to
be closed.

Save one real response to `test/fixtures/trainResponse.ts` as an exported
string (SOAP) or object (JSON). **Redact the API key from the fixture before
committing it** — captured responses routinely echo request headers back.

- [ ] **Step 2: Add the API key to configuration**

The key is a server-wide credential, not a per-device setting — the spec's §6
lists only the three device fields and does not mention it, which is a gap this
step closes. It belongs with the other secrets, never in the repo.

In `src/index.ts`, beside the existing env reads:

```ts
  const trainApiKey = process.env.TRAIN_API_KEY?.trim() || '';
```

and pass it into the frame service:

```ts
  const frames = new FrameService({
    renderer,
    cache: new SourceCache(join(dataDir, 'cache')),
    trainApiKey,
  });
```

In `src/render/frameService.ts`, add to `FrameDeps`:

```ts
  /** Rail Data Marketplace key. Empty disables departures server-wide. */
  trainApiKey?: string;
```

Document `TRAIN_API_KEY` in `docs/configuration.md` alongside
`INKPANEL_PASSWORD`, noting that without it the trains quadrant stays in its
not-configured state.

- [ ] **Step 3 — Branch A (REST/JSON): write the failing mapper test**

Append to `test/sources/train.test.ts`:

```ts
import { mapTrainResponse } from '../../src/sources/train.ts';
import { departureBoardJson } from '../fixtures/trainResponse.ts';

test('maps a real departure board response', () => {
  const raw = mapTrainResponse(departureBoardJson);
  assert.ok(raw.length > 0, 'the fixture should contain services');
  assert.match(raw[0]!.scheduled, /^\d{2}:\d{2}$/);
});

test('a board with no services maps to an empty array, not a throw', () => {
  assert.deepEqual(mapTrainResponse({ trainServices: null }), []);
  assert.deepEqual(mapTrainResponse({}), []);
  assert.deepEqual(mapTrainResponse(null), []);
});
```

Then add to `src/sources/train.ts`, adjusting the field names to match the
captured fixture:

```ts
/**
 * Reduce a departure board response to `RawDeparture[]`.
 *
 * Every field is treated as optional. This is a live third-party feed, and a
 * missing property must produce a shorter board rather than a crash that takes
 * the whole panel with it.
 */
export function mapTrainResponse(body: unknown): RawDeparture[] {
  const services = (body as { trainServices?: unknown })?.trainServices;
  if (!Array.isArray(services)) return [];

  return services.map((service) => {
    const s = service as { std?: unknown; etd?: unknown; platform?: unknown };
    return {
      scheduled: typeof s.std === 'string' ? s.std : '',
      expected: typeof s.etd === 'string' ? s.etd : null,
      platform: typeof s.platform === 'string' ? s.platform : null,
    };
  });
}
```

`buildDepartures` already drops rows whose `scheduled` will not parse, so a
malformed service is discarded rather than rendered.

Now the transport:

```ts
import type { Source, SourceResult } from './types.ts';

export interface TrainConfig {
  originCrs: string;
  destinationCrs: string;
  apiKey: string;
}

// Confirm this against the Rail Data Marketplace product page — it is the one
// value in this file that cannot be derived from anything already in the repo.
const ENDPOINT = 'https://api1.raildata.org.uk/1010-live-departure-board-dep/LDBWS/api/20220120/GetDepBoardWithDetails';

export const trainSource: Source<TrainConfig, TrainData> = {
  id: 'train',
  async fetch(config, signal): Promise<SourceResult<TrainData>> {
    const url = `${ENDPOINT}/${encodeURIComponent(config.originCrs)}?filterCrs=${encodeURIComponent(config.destinationCrs)}&filterType=to&numRows=10`;

    const res = await fetch(url, {
      signal,
      headers: { 'x-apikey': config.apiKey, Accept: 'application/json' },
    });

    // Name the likely cause. This message reaches the settings page, where
    // "responded 403" alone tells someone nothing about what to do next.
    if (res.status === 401 || res.status === 403) {
      throw new Error(`departures responded ${res.status} — check TRAIN_API_KEY`);
    }
    if (!res.ok) throw new Error(`departures responded ${res.status}`);

    return {
      status: 'ok',
      data: buildTrainData(config.originCrs, config.destinationCrs, mapTrainResponse(await res.json())),
      fetchedAt: new Date().toISOString(),
    };
  },
};
```

- [ ] **Step 3 — Branch B (SOAP only): add the parser and write the failing test**

Only if Step 1 found no REST transport. This is the single dependency exception
the Global Constraints allow, and the reason is recorded here at the point of
the exception: hand-rolled extraction from a live XML feed would be the most
fragile code in the repo.

```bash
npm install fast-xml-parser@^4.5.0
```

Append to `test/sources/train.test.ts`:

```ts
import { mapTrainResponse } from '../../src/sources/train.ts';
import { departureBoardXml } from '../fixtures/trainResponse.ts';

test('maps a real Darwin SOAP response', () => {
  const raw = mapTrainResponse(departureBoardXml);
  assert.ok(raw.length > 0, 'the fixture should contain services');
  assert.match(raw[0]!.scheduled, /^\d{2}:\d{2}$/);
});

test('a SOAP body with no services maps to an empty array, not a throw', () => {
  assert.deepEqual(mapTrainResponse('<s:Envelope xmlns:s="x"><s:Body/></s:Envelope>'), []);
  assert.deepEqual(mapTrainResponse(''), []);
});

test('a single service is an array of one, not a bare object', () => {
  // XML has no arrays. A board with exactly one train parses to an object
  // where a busier board parses to a list, and `.map` on the object throws —
  // so the quiet late-night case is the one that breaks in production.
  const one = mapTrainResponse(departureBoardXml.replace(/(<lt5:service>[\s\S]*?<\/lt5:service>)[\s\S]*(?=<\/lt5:trainServices>)/, '$1'));
  assert.equal(one.length, 1);
});
```

Then in `src/sources/train.ts`:

```ts
import { XMLParser } from 'fast-xml-parser';
import type { Source, SourceResult } from './types.ts';

export interface TrainConfig {
  originCrs: string;
  destinationCrs: string;
  apiKey: string;
}

const ENDPOINT = 'https://lite.realtime.nationalrail.co.uk/OpenLDBWS/ldb11.asmx';
const LDB_NS = 'http://thalesgroup.com/RTTI/2021-11-01/ldb/';
const TOKEN_NS = 'http://thalesgroup.com/RTTI/2013-11-28/Token/types';

// removeNSPrefix collapses lt5:/lt4:/soap: prefixes, which vary by Darwin
// version — matching on them would break at the next schema bump.
const parser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, parseTagValue: false });

function soapRequest(config: TrainConfig): string {
  return `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:typ="${TOKEN_NS}" xmlns:ldb="${LDB_NS}">
  <soap:Header><typ:AccessToken><typ:TokenValue>${config.apiKey}</typ:TokenValue></typ:AccessToken></soap:Header>
  <soap:Body><ldb:GetDepartureBoardRequest>
    <ldb:numRows>10</ldb:numRows>
    <ldb:crs>${config.originCrs}</ldb:crs>
    <ldb:filterCrs>${config.destinationCrs}</ldb:filterCrs>
    <ldb:filterType>to</ldb:filterType>
  </ldb:GetDepartureBoardRequest></soap:Body>
</soap:Envelope>`;
}

/** Reduce a Darwin SOAP envelope to `RawDeparture[]`. Never throws. */
export function mapTrainResponse(xml: string): RawDeparture[] {
  if (!xml.trim()) return [];

  const parsed = parser.parse(xml) as Record<string, any>;
  const services =
    parsed?.Envelope?.Body?.GetDepartureBoardResponse?.GetStationBoardResult?.trainServices?.service;
  if (!services) return [];

  // XML has no arrays: one service parses to an object, several to a list.
  const list = Array.isArray(services) ? services : [services];

  return list.map((s: Record<string, unknown>) => ({
    scheduled: typeof s.std === 'string' ? s.std : '',
    expected: typeof s.etd === 'string' ? s.etd : null,
    platform: typeof s.platform === 'string' ? s.platform : null,
  }));
}

export const trainSource: Source<TrainConfig, TrainData> = {
  id: 'train',
  async fetch(config, signal): Promise<SourceResult<TrainData>> {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `${LDB_NS}GetDepartureBoard` },
      body: soapRequest(config),
    });

    // SOAP faults arrive as 500 with the reason in the body, so surface it —
    // a bare "responded 500" on the settings page is not actionable.
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const fault = /<faultstring>([^<]*)<\/faultstring>/.exec(body)?.[1];
      throw new Error(`departures responded ${res.status}${fault ? ` — ${fault}` : ''}`);
    }

    return {
      status: 'ok',
      data: buildTrainData(config.originCrs, config.destinationCrs, mapTrainResponse(await res.text())),
      fetchedAt: new Date().toISOString(),
    };
  },
};
```

The API key is interpolated into XML. It is a hex token from the marketplace,
so it contains nothing that needs escaping — but if a key ever arrives
containing `<` or `&`, escape it here rather than discovering a malformed
envelope at runtime.

- [ ] **Step 4: Run the mapper tests**

```bash
npm test -- --test-name-pattern="maps a real|no services"
```

Expected: PASS against the captured fixture, and no network access — the
mapper takes a value, not a URL.

- [ ] **Step 5: Wire it into the frame service**

Both branches converge here. In `src/render/frameService.ts`:

```ts
import { trainSource } from '../sources/train.ts';
import type { TrainData } from '../sources/train.ts';
```

Add `train: TrainData | null;` to `SourceBundle`, then in `fetchAll`:

```ts
    // Trains need an origin, a destination and a server key. Any one missing
    // means the feature is not configured, which contributes no health entry
    // and leaves the quadrant reading "Trains — not set up".
    const trainReady = Boolean(
      device.trainOriginCrs && device.trainDestinationCrs && this.deps.trainApiKey,
    );

    const [calendar, weather, bins, train] = await Promise.all([
      runSource(icalSource, { urls: device.calendarUrls, timezone: device.timezone }, this.deps.cache, SOURCE_TIMEOUT_MS),
      runSource(openMeteoSource, { latitude: device.latitude, longitude: device.longitude, timezone: device.timezone }, this.deps.cache, SOURCE_TIMEOUT_MS),
      device.binsUprn
        ? runSource(binsSource, { uprn: device.binsUprn }, this.deps.cache, SOURCE_TIMEOUT_MS)
        : Promise.resolve(null),
      trainReady
        ? runSource(
            trainSource,
            {
              originCrs: device.trainOriginCrs,
              destinationCrs: device.trainDestinationCrs,
              apiKey: this.deps.trainApiKey!,
            },
            this.deps.cache,
            SOURCE_TIMEOUT_MS,
          )
        : Promise.resolve(null),
    ]);
```

and return:

```ts
    return {
      calendar: calendar.data,
      weather: weather.data,
      bins: bins?.data ?? null,
      train: train?.data ?? null,
      // An unconfigured source contributes no health entry at all, which is
      // how the template tells "not set up" from "failed".
      sourceHealth: [
        calendar.health,
        weather.health,
        ...(bins ? [bins.health] : []),
        ...(train ? [train.health] : []),
      ],
    };
```

Add `train: bundle.train,` to the object `buildData` returns.

- [ ] **Step 6: Test the wiring**

Append to `test/render/frameService.test.ts`:

```ts
test('a device with a route but no server key does not report trains as broken', async () => {
  // A missing key is a server that has not been set up, not a failure. The
  // panel must say "not set up" rather than flashing an error every 15 minutes.
  const bundle: SourceBundle = {
    calendar: { today: [], tomorrow: [] }, weather: null, bins: null, train: null, sourceHealth: [],
  };
  await withService(async () => bundle, async (service) => {
    const device = { ...defaultDevice('esp32-test'), claimed: true, trainOriginCrs: 'MKC', trainDestinationCrs: 'EUS' };
    const frame = await service.frameFor(device, 4.0);
    assert.equal(frame.buffer.length, 48000);
    assert.equal(service.sourceIssues().length, 0);
  });
});
```

And the contract row from spec §7 — a failing feed must fall back to the last
good board rather than blanking the quadrant:

```ts
test('a departures failure degrades to the cached board, not to nothing', async () => {
  await withCache(async (cache) => {
    const good = buildTrainData('MKC', 'EUS', [{ scheduled: '07:42', expected: 'On time', platform: '3' }]);
    await cache.write('train', good);

    const failing = {
      id: 'train',
      fetch: async () => { throw new Error('national rail is having a day'); },
    };

    const outcome = await runSource(failing, {}, cache, 8000);
    assert.equal(outcome.health.status, 'stale');
    assert.equal(outcome.data?.departures[0]?.scheduled, '07:42', 'yesterday-ish beats blank');
    assert.match(outcome.health.error ?? '', /having a day/, 'the real cause reaches the settings page');
  });
});
```

Every existing `SourceBundle` literal in the test files now needs
`train: null` as well as the `bins: null` added in Task 4. `npm run check`
will list them all.

- [ ] **Step 7: Run everything**

```bash
npm test && npm run check && npm run test:tz
```

Expected: all pass, counts match. **No test may reach the network** — if the
suite slows noticeably or fails offline, a fixture has been replaced by a live
call.

- [ ] **Step 8: Verify against the real API**

```bash
TRAIN_API_KEY=<your key> npm start
```

Set a route of `MKC` → `EUS`, save, and check the preview shows real departure
times that match [nationalrail.co.uk](https://www.nationalrail.co.uk). Then stop
the server, restart it **without** `TRAIN_API_KEY`, and confirm the quadrant
reads "Trains — not set up" rather than "Trains unavailable".

- [ ] **Step 9: Commit**

```bash
git add src/sources/train.ts src/render/frameService.ts src/index.ts docs/configuration.md test/ package.json package-lock.json
git commit -m "feat: fetch live departures and wire trains into the render"
```

If Branch B was taken, say so in the commit body along with why the dependency
was added — the exception should be findable from the history, not only from
this plan.

---

### Task 8: Goldens and documentation

**Files:**
- Modify: `test/render/golden.test.ts`, `docs/configuration.md`, `README.md`
- Create: `test/golden/full-panel.png` (or the repo's existing golden format)

**Interfaces:**
- Consumes: everything above
- Produces: no code — this task closes the spec

- [ ] **Step 1: Extend the golden to a fully populated panel**

Spec §7 requires golden coverage of a panel with all four quadrants populated.
The existing golden fixture leaves the bottom two empty, so it would not catch a
quadrant that renders as a blank box.

In `test/render/golden.test.ts`, extend the fixture the golden is rendered from:

```ts
  bins: {
    next: { date: '2026-08-06', types: ['recycling', 'food'] },
    rawLabels: ['Mixed Recycling', 'Food Waste Caddy'],
  },
  train: mixedBoard,
  sourceHealth: [
    { id: 'ical', status: 'ok', fetchedAt: '2026-08-04T07:00:00.000Z', error: null },
    { id: 'weather', status: 'ok', fetchedAt: '2026-08-04T07:00:00.000Z', error: null },
    { id: 'bins', status: 'ok', fetchedAt: '2026-08-04T07:00:00.000Z', error: null },
    { id: 'train', status: 'ok', fetchedAt: '2026-08-04T07:40:00.000Z', error: null },
  ],
```

importing `mixedBoard` from `../fixtures/train.ts`. Every field is fixed —
nothing derived from `Date.now()` — or the golden will differ on every run.

Regenerate with the repo's existing golden command, then **open the PNG and look
at it**. A byte-comparison test passes happily against an image with overlapping
text; the reason to have a golden at all is that a person checks it once.

> The existing golden was generated on Windows and font rasterisation differs
> between platforms, so the checked-in image is only authoritative on the
> machine that produced it. Regenerate on the same platform the current golden
> was made on, or the diff will be noise. This is a known open item from Spec 1,
> not something introduced here.

- [ ] **Step 2: Document the new configuration**

In `docs/configuration.md`, add a row per field:

| Setting | Where | Notes |
|---|---|---|
| `binsUprn` | Panel settings | Milton Keynes only. Find yours at findmyaddress.co.uk. Blank hides the quadrant. |
| `trainOriginCrs` / `trainDestinationCrs` | Panel settings | Chosen with the station picker. Both needed. |
| `TRAIN_API_KEY` | Environment | Rail Data Marketplace key. Server-wide. Without it, departures stay off. |

State plainly that **the MK bins endpoint is undocumented and may break without
notice**, and that when it does the panel shows "Bins unavailable" rather than a
stale date. Someone running this in a year needs to know that is expected
behaviour and where to look — `scripts/capture-bins.mjs` is the diagnostic.

- [ ] **Step 3: Update the README**

The feature list still describes two quadrants as "coming soon". Replace that
with trains and bins, and note that bins are Milton Keynes-specific — this repo
is public, and someone in Leeds should learn that from the README rather than
from an empty panel.

- [ ] **Step 4: Full verification**

```bash
npm test && npm run check && npm run test:tz
```

Expected: green, and `npm test` and `npm run test:tz` report identical counts.

- [ ] **Step 5: Commit**

```bash
git add test/ docs/ README.md
git commit -m "docs: document trains and bins, extend golden coverage"
```

---

## Notes for the implementer

**Two tasks depend on data that does not exist yet.** Task 2 begins by capturing
a real MK bins response and Task 7 begins by capturing a real departure board.
If either capture fails, **stop and report it** rather than inventing a fixture.
A mapper written against imagined JSON is worse than no mapper: it passes its
own tests and fails on the only input that matters.

**Order matters in one place only.** Tasks 1–6 can proceed immediately. Task 7
must wait for the protocol answer. If that answer is delayed, Tasks 1–6 still
deliver a working bins quadrant and a trains quadrant that correctly reads "not
set up".

**The city picker bug is the one to learn from.** A synthetic `click` dispatched
at an element passes while real mouse use fails, because the list has already
hidden by mouseup. Task 6's browser check exists for that reason and should not
be substituted with a scripted test.

