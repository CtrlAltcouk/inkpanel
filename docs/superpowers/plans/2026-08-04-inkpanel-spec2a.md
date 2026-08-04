# inkpanel Spec 2a Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the single-device config page into a two-tab UI that manages several panels, sets location by city name, forces renders, and updates the server itself.

**Architecture:** Server gains a geocoding proxy, a push endpoint, optional session auth, and a system/update API backed by a systemd path-activated root unit. The browser code splits from one 130-line file into focused modules with hash routing.

**Tech Stack:** Unchanged — Node 22, TypeScript, Express 5, `node --import tsx --test`, vanilla browser JS. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-08-04-inkpanel-spec2a-design.md`

## Global Constraints

- **No new npm dependencies.** Cookie parsing, rate limiting and HMAC signing all use `node:crypto` and hand-written helpers. The project has zero client-side dependencies and that is worth keeping.
- Tests run with `node --import tsx --test`. `npm run test:tz` must stay green across all four zones.
- **`GET /api/devices/:id/frame` and `GET /health` are never authenticated.** Firmware cannot log in. Any auth middleware must exempt them explicitly.
- `INKPANEL_PASSWORD` unset means no auth and no behaviour change. Existing installs must keep working untouched.
- Session cookie lifetime **30 days**. Login rate limit **5 attempts per 15 minutes per IP**. Update-check cache **10 minutes**.
- **A failed self-update must not restart the service.** The old working process keeps running.
- `npm ci` during self-update runs **only if `package-lock.json` changed**.
- The panel stylesheet rule from Spec 1 still stands: `src/render/panel.css.ts` may contain only `#000` and `#fff`. The *browser* UI is unaffected by this — it uses the full CtrlAlt palette.
- Every task ends with a commit.

---

## File Structure

```
src/
  sources/geocode.ts          Open-Meteo geocoding: mapper + fetch
  http/auth.ts                session cookie, login, rate limit, middleware
  http/systemRoutes.ts        version, health, update trigger + status
  system/version.ts           package version + git commit, cached
  system/updateCheck.ts       git ls-remote vs local HEAD, 10-min cache
  system/updateStatus.ts      read/parse data/update-status.json
  render/frameService.ts      + renderNow() bypassing the memo
  devices/types.ts            + locationLabel, lastWakeSeconds
  http/deviceRoutes.ts        + record lastWakeSeconds
  http/manageRoutes.ts        + push endpoint, locationLabel in schema

public/
  index.html                  tab shell
  login.html                  password form
  app.js                      bootstrap + hash routing only
  api.js                      fetch wrappers, 401 redirect
  panels.js                   overview strip + detail form
  settings.js                 system info + update flow
  components.js               field helpers, city picker, pills
  styles.css                  extended, same tokens

scripts/proxmox/
  inkpanel-lxc.sh             + update units, INKPANEL_PASSWORD
  files/inkpanel-update       the root updater script
  files/inkpanel-update.path  systemd path unit
  files/inkpanel-update.service
```

---

### Task 1: Geocoding proxy

**Files:**
- Create: `src/sources/geocode.ts`, `test/sources/geocode.test.ts`, `test/fixtures/geocode.ts`
- Modify: `src/http/manageRoutes.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `interface GeocodeResult { label: string; latitude: number; longitude: number; timezone: string; countryCode: string }`
  - `mapGeocode(raw: unknown): GeocodeResult[]`
  - `geocode(query: string, signal: AbortSignal): Promise<GeocodeResult[]>`
  - `GET /api/geocode?q=<query>` → `{ results: GeocodeResult[] }`

- [ ] **Step 1: Write the fixture**

Create `test/fixtures/geocode.ts`:

```ts
/** Trimmed but structurally faithful Open-Meteo geocoding response. */
export const MILTON_KEYNES = {
  results: [
    {
      id: 2642465, name: 'Milton Keynes', latitude: 52.04172, longitude: -0.75583,
      country_code: 'GB', admin1: 'England', admin2: 'Milton Keynes',
      timezone: 'Europe/London', country: 'United Kingdom', population: 229941,
    },
    {
      id: 2642466, name: 'Milton Keynes Village', latitude: 52.0417, longitude: -0.7,
      country_code: 'GB', admin1: 'England', timezone: 'Europe/London',
    },
  ],
};

/** A city with no admin1, which is common outside large countries. */
export const NO_ADMIN1 = {
  results: [
    { id: 1, name: 'Monaco', latitude: 43.73, longitude: 7.42, country_code: 'MC', timezone: 'Europe/Monaco' },
  ],
};

/** Open-Meteo omits `results` entirely when nothing matches. */
export const NO_MATCHES = { generationtime_ms: 0.4 };
```

- [ ] **Step 2: Write the failing test**

Create `test/sources/geocode.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapGeocode } from '../../src/sources/geocode.ts';
import { MILTON_KEYNES, NO_ADMIN1, NO_MATCHES } from '../fixtures/geocode.ts';

test('builds a readable label from name, region and country', () => {
  const [first] = mapGeocode(MILTON_KEYNES);
  assert.equal(first?.label, 'Milton Keynes, England, GB');
  assert.equal(first?.latitude, 52.04172);
  assert.equal(first?.longitude, -0.75583);
  assert.equal(first?.timezone, 'Europe/London');
  assert.equal(first?.countryCode, 'GB');
});

test('returns every match, in order', () => {
  const results = mapGeocode(MILTON_KEYNES);
  assert.equal(results.length, 2);
  assert.equal(results[1]?.label, 'Milton Keynes Village, England, GB');
});

test('omits a missing region rather than leaving a gap', () => {
  const [only] = mapGeocode(NO_ADMIN1);
  assert.equal(only?.label, 'Monaco, MC', 'no empty comma-space run');
});

test('an absent results key is no matches, not an error', () => {
  assert.deepEqual(mapGeocode(NO_MATCHES), []);
  assert.deepEqual(mapGeocode({}), []);
});

test('drops entries missing coordinates or timezone rather than emitting NaN', () => {
  const broken = { results: [{ name: 'Nowhere', country_code: 'XX' }] };
  assert.deepEqual(mapGeocode(broken), []);
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
npm test -- --test-name-pattern="builds a readable label"
```

Expected: FAIL — cannot resolve `src/sources/geocode.ts`.

- [ ] **Step 4: Write the implementation**

Create `src/sources/geocode.ts`:

```ts
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
```

- [ ] **Step 5: Add the route**

In `src/http/manageRoutes.ts`, add the import:

```ts
import { geocode } from '../sources/geocode.ts';
```

And add this route inside `manageRoutes`, before the `return router;`:

```ts
  router.get('/geocode', async (req, res) => {
    const query = String(req.query.q ?? '').trim();
    if (query.length < 2) {
      res.status(400).json({ error: 'query must be at least 2 characters' });
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      res.json({ results: await geocode(query, controller.signal) });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'geocoding failed' });
    } finally {
      clearTimeout(timer);
    }
  });
```

- [ ] **Step 6: Write the route test**

Append to `test/http/manageRoutes.test.ts`:

```ts
test('geocode rejects a too-short query without calling upstream', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/geocode?q=m`);
    assert.equal(res.status, 400);
  });
});

test('geocode returns labelled results', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/geocode?q=milton%20keynes`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { results: Array<{ label: string; timezone: string }> };
    assert.ok(body.results.length > 0, 'live Open-Meteo lookup returned nothing');
    assert.match(body.results[0]!.label, /Milton Keynes/);
    assert.equal(body.results[0]!.timezone, 'Europe/London');
  });
});
```

> This one test does hit the network. Open-Meteo needs no key and the endpoint is
> stable; if it ever becomes flaky in CI, it is the only test to quarantine.

- [ ] **Step 7: Run the tests**

```bash
npm test && npm run check
```

Expected: 5 mapper tests plus 2 route tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/sources/geocode.ts src/http/manageRoutes.ts test/sources/geocode.test.ts test/fixtures/geocode.ts test/http/manageRoutes.test.ts
git commit -m "feat: add geocoding proxy for the city picker"
```

---

### Task 2: Device model additions

**Files:**
- Modify: `src/devices/types.ts`, `src/http/deviceRoutes.ts`, `src/http/manageRoutes.ts`
- Modify: `test/devices/store.test.ts`

**Interfaces:**
- Consumes: `DeviceRecord`, `defaultDevice` from Spec 1
- Produces: `DeviceRecord.locationLabel: string`, `DeviceRecord.lastWakeSeconds: number | null`

- [ ] **Step 1: Write the failing test**

Append to `test/devices/store.test.ts`:

```ts
test('new devices carry the Spec 2a fields with safe defaults', async () => {
  await withStore(async (store) => {
    const device = await store.getOrCreate('esp32-new');
    assert.equal(device.locationLabel, '');
    assert.equal(device.lastWakeSeconds, null);
  });
});

test('a config file written before Spec 2a still loads', async () => {
  await withStore(async (store, path) => {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(path), { recursive: true });
    // A record with none of the new fields, as Spec 1 would have written it.
    await writeFile(path, JSON.stringify({
      devices: [{ id: 'esp32-old', name: 'Old panel', claimed: true }],
    }), 'utf8');

    const device = await store.get('esp32-old');
    assert.equal(device?.name, 'Old panel', 'existing data survives');
    // Missing fields read as undefined; callers must tolerate that rather than
    // the store rewriting every record on load.
    assert.equal(device?.locationLabel ?? '', '');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- --test-name-pattern="Spec 2a fields"
```

Expected: FAIL — `locationLabel` is undefined, not `''`.

- [ ] **Step 3: Add the fields**

In `src/devices/types.ts`, add to the `DeviceRecord` interface after `panelProfileId`:

```ts
  /** Human-readable location from the city picker, e.g. "Milton Keynes, England, GB". */
  locationLabel: string;
```

And after `lastFirmwareVersion`:

```ts
  /**
   * What the device was last told to sleep for. Combined with lastSeenAt this
   * gives the next expected check-in, which Push reports back to the user.
   */
  lastWakeSeconds: number | null;
```

In `defaultDevice()`, add `locationLabel: '',` after `panelProfileId` and
`lastWakeSeconds: null,` after `lastFirmwareVersion`.

- [ ] **Step 4: Record the wake interval on each check-in**

In `src/http/deviceRoutes.ts`, the telemetry update currently runs before the
wake is computed. Move it after, and include the interval. Replace this block:

```ts
    // Record telemetry before rendering, so a render failure still logs the visit.
    await store.update(id, {
      lastSeenAt: new Date().toISOString(),
      lastBatteryVolts: batteryVolts ?? device.lastBatteryVolts,
      lastFirmwareVersion: req.get('x-firmware-version') ?? device.lastFirmwareVersion,
    });

    const wake = nextWakeSeconds({ now: new Date(), device, batteryVolts });
```

with:

```ts
    const wake = nextWakeSeconds({ now: new Date(), device, batteryVolts });

    // Record telemetry before rendering, so a render failure still logs the
    // visit. lastWakeSeconds is stored alongside so Push can say when the panel
    // will next collect a frame.
    await store.update(id, {
      lastSeenAt: new Date().toISOString(),
      lastBatteryVolts: batteryVolts ?? device.lastBatteryVolts,
      lastFirmwareVersion: req.get('x-firmware-version') ?? device.lastFirmwareVersion,
      lastWakeSeconds: wake,
    });
```

- [ ] **Step 5: Allow the label through the config API**

In `src/http/manageRoutes.ts`, add to `patchSchema` after `longitude`:

```ts
    locationLabel: z.string().max(120).optional(),
```

- [ ] **Step 6: Assert the wake interval is recorded**

Append to `test/http/deviceRoutes.test.ts`:

```ts
test('records the wake interval it handed out', async () => {
  await withServer(async (base, store) => {
    await claim(store, 'esp32-1');
    const res = await fetch(`${base}/api/devices/esp32-1/frame`);
    const handed = Number(res.headers.get('x-next-wake-seconds'));
    assert.equal((await store.get('esp32-1'))?.lastWakeSeconds, handed,
      'what we told the device must match what we remember telling it');
  });
});
```

- [ ] **Step 7: Run the tests**

```bash
npm test && npm run check
```

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/devices/types.ts src/http/deviceRoutes.ts src/http/manageRoutes.ts test/devices/store.test.ts test/http/deviceRoutes.test.ts
git commit -m "feat: add locationLabel and lastWakeSeconds to the device record"
```

---

### Task 3: Push endpoint

**Files:**
- Create: `src/devices/nextCheckIn.ts`, `test/devices/nextCheckIn.test.ts`
- Modify: `src/render/frameService.ts`, `src/http/manageRoutes.ts`, `test/http/manageRoutes.test.ts`

**Interfaces:**
- Consumes: `DeviceRecord` (Task 2), `FrameService`, `Frame` from Spec 1
- Produces:
  - `nextCheckIn(device: DeviceRecord, now: Date): { willAppearBy: string | null; overdueSince: string | null }`
  - `FrameService.renderNow(device: DeviceRecord, batteryVolts: number | null): Promise<Frame>`
  - `POST /api/devices/:id/push` → `{ etag, renderedAt, willAppearBy, overdueSince }`

- [ ] **Step 1: Write the failing test**

Create `test/devices/nextCheckIn.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextCheckIn } from '../../src/devices/nextCheckIn.ts';
import { defaultDevice } from '../../src/devices/types.ts';

const now = new Date('2026-08-04T12:00:00.000Z');

test('reports when the panel will next collect a frame', () => {
  const device = {
    ...defaultDevice('esp32-1'),
    lastSeenAt: '2026-08-04T11:55:00.000Z',
    lastWakeSeconds: 900,
  };
  const { willAppearBy, overdueSince } = nextCheckIn(device, now);
  assert.equal(willAppearBy, '2026-08-04T12:10:00.000Z', '11:55 plus 15 minutes');
  assert.equal(overdueSince, null);
});

test('reports overdue when the check-in has been missed', () => {
  const device = {
    ...defaultDevice('esp32-1'),
    lastSeenAt: '2026-08-04T11:00:00.000Z',
    lastWakeSeconds: 900,
  };
  const { willAppearBy, overdueSince } = nextCheckIn(device, now);
  assert.equal(willAppearBy, null);
  assert.equal(overdueSince, '2026-08-04T11:15:00.000Z');
});

test('a device that has never checked in has no prediction', () => {
  const { willAppearBy, overdueSince } = nextCheckIn(defaultDevice('esp32-new'), now);
  assert.equal(willAppearBy, null);
  assert.equal(overdueSince, null, 'unknown is not the same as overdue');
});

test('a device seen but with no recorded interval has no prediction', () => {
  const device = { ...defaultDevice('esp32-1'), lastSeenAt: '2026-08-04T11:55:00.000Z' };
  assert.deepEqual(nextCheckIn(device, now), { willAppearBy: null, overdueSince: null });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- --test-name-pattern="will next collect"
```

Expected: FAIL — cannot resolve `src/devices/nextCheckIn.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/devices/nextCheckIn.ts`:

```ts
import type { DeviceRecord } from './types.ts';

export interface CheckInEstimate {
  /** ISO instant the panel should next collect a frame, if it is on schedule. */
  willAppearBy: string | null;
  /** ISO instant it was expected, if that moment has already passed. */
  overdueSince: string | null;
}

/**
 * When will this panel next pick something up?
 *
 * The device sleeps with its radio off, so nothing can be pushed to it. The
 * best the server can say is when it expects the next check-in, derived from
 * when it last appeared and what it was told to sleep for.
 *
 * A device with no history returns nulls throughout — unknown is deliberately
 * distinct from overdue.
 */
export function nextCheckIn(device: DeviceRecord, now: Date): CheckInEstimate {
  if (!device.lastSeenAt || device.lastWakeSeconds === null || device.lastWakeSeconds === undefined) {
    return { willAppearBy: null, overdueSince: null };
  }

  const due = new Date(new Date(device.lastSeenAt).getTime() + device.lastWakeSeconds * 1000);
  if (Number.isNaN(due.getTime())) return { willAppearBy: null, overdueSince: null };

  return due.getTime() > now.getTime()
    ? { willAppearBy: due.toISOString(), overdueSince: null }
    : { willAppearBy: null, overdueSince: due.toISOString() };
}
```

- [ ] **Step 4: Add renderNow to the frame service**

In `src/render/frameService.ts`, add this method immediately after `frameFor`:

```ts
  /**
   * Render unconditionally, ignoring the memo.
   *
   * frameFor returns the cached frame when the content hash is unchanged, which
   * is exactly right for devices and exactly wrong for a user who has pressed
   * Push and expects to see something happen.
   */
  async renderNow(device: DeviceRecord, batteryVolts: number | null): Promise<Frame> {
    this.memo.delete(device.id);
    return this.frameFor(device, batteryVolts);
  }
```

- [ ] **Step 5: Add the push route**

In `src/http/manageRoutes.ts`, add the import:

```ts
import { nextCheckIn } from '../devices/nextCheckIn.ts';
```

And add this route before `return router;`:

```ts
  router.post('/devices/:id/push', async (req, res) => {
    const device = await store.get(req.params.id);
    if (!device) {
      res.status(404).json({ error: 'unknown device' });
      return;
    }

    try {
      const frame = await frames.renderNow(device, device.lastBatteryVolts);
      res.json({
        etag: frame.etag,
        renderedAt: frame.renderedAt,
        ...nextCheckIn(device, new Date()),
      });
    } catch (err) {
      res.status(503).json({ error: err instanceof Error ? err.message : 'render failed' });
    }
  });
```

- [ ] **Step 6: Write the route test**

Append to `test/http/manageRoutes.test.ts`:

```ts
test('push renders and reports when the panel will collect it', async () => {
  await withServer(async (base, store) => {
    await store.getOrCreate('esp32-1');
    await store.update('esp32-1', {
      claimed: true,
      lastSeenAt: new Date(Date.now() - 60_000).toISOString(),
      lastWakeSeconds: 900,
    });

    const res = await fetch(`${base}/api/devices/esp32-1/push`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { etag: string; willAppearBy: string | null };
    assert.match(body.etag, /^[0-9a-f]{32}$/);
    assert.ok(body.willAppearBy, 'a recently seen device has a predicted next wake');
  });
});

test('push 404s for an unknown device', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/devices/ghost/push`, { method: 'POST' });
    assert.equal(res.status, 404);
  });
});
```

- [ ] **Step 7: Run the tests**

```bash
npm test && npm run check
```

Expected: 4 `nextCheckIn` tests plus 2 route tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/devices/nextCheckIn.ts src/render/frameService.ts src/http/manageRoutes.ts test/devices/nextCheckIn.test.ts test/http/manageRoutes.test.ts
git commit -m "feat: add push endpoint that forces a render and reports arrival"
```

---

### Task 4: Optional password authentication

**Files:**
- Create: `src/http/auth.ts`, `test/http/auth.test.ts`, `public/login.html`
- Modify: `src/http/app.ts`, `src/index.ts`, `README.md`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `loadOrCreateSecret(path: string): Promise<Buffer>`
  - `signSession(secret: Buffer, expiresAtMs: number): string`
  - `verifySession(secret: Buffer, token: string, nowMs: number): boolean`
  - `parseCookies(header: string | undefined): Record<string, string>`
  - `createAuth(opts: { password: string | null; secret: Buffer }): { middleware: RequestHandler; router: Router }`
  - `AppDeps.auth?: { password: string | null; secret: Buffer }`

- [ ] **Step 1: Write the failing test**

Create `test/http/auth.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadOrCreateSecret, signSession, verifySession, parseCookies,
} from '../../src/http/auth.ts';

const SECRET = Buffer.from('a'.repeat(64), 'hex');
const NOW = 1_785_000_000_000;

test('a freshly signed session verifies', () => {
  const token = signSession(SECRET, NOW + 1000);
  assert.equal(verifySession(SECRET, token, NOW), true);
});

test('an expired session does not verify', () => {
  const token = signSession(SECRET, NOW - 1);
  assert.equal(verifySession(SECRET, token, NOW), false);
});

test('a tampered payload does not verify', () => {
  const token = signSession(SECRET, NOW + 1000);
  const [payload, sig] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ exp: NOW + 999_999_999 })).toString('base64url');
  assert.notEqual(forged, payload);
  assert.equal(verifySession(SECRET, `${forged}.${sig}`, NOW), false);
});

test('a different secret does not verify', () => {
  const token = signSession(SECRET, NOW + 1000);
  assert.equal(verifySession(Buffer.from('b'.repeat(64), 'hex'), token, NOW), false);
});

test('malformed tokens are rejected rather than throwing', () => {
  for (const bad of ['', 'nodot', 'a.b.c', '.', 'x.y']) {
    assert.equal(verifySession(SECRET, bad, NOW), false, `"${bad}" must not throw or pass`);
  }
});

test('parses cookies, tolerating spaces and missing headers', () => {
  assert.deepEqual(parseCookies('a=1; b=2'), { a: '1', b: '2' });
  assert.deepEqual(parseCookies('only=one'), { only: 'one' });
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies(''), {});
  assert.equal(parseCookies('v=a%3Db').v, 'a=b', 'values are URI-decoded');
});

test('the secret persists and is not world-readable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-secret-'));
  try {
    const path = join(dir, '.session-secret');
    const first = await loadOrCreateSecret(path);
    const second = await loadOrCreateSecret(path);
    assert.equal(first.length, 32);
    assert.deepEqual(first, second, 'must reuse, not regenerate — sessions survive restarts');

    if (process.platform !== 'win32') {
      const mode = (await stat(path)).mode & 0o777;
      assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- --test-name-pattern="freshly signed session"
```

Expected: FAIL — cannot resolve `src/http/auth.ts`.

- [ ] **Step 3: Write the auth module**

Create `src/http/auth.ts`:

```ts
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Router, type RequestHandler } from 'express';

const COOKIE_NAME = 'inkpanel_session';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const RATE_MAX = 5;
const RATE_WINDOW_MS = 15 * 60 * 1000;

/** Load the HMAC secret, generating one on first run. */
export async function loadOrCreateSecret(path: string): Promise<Buffer> {
  try {
    const existing = await readFile(path);
    if (existing.length >= 32) return existing.subarray(0, 32);
  } catch {
    // fall through and create
  }
  const secret = randomBytes(32);
  await mkdir(dirname(path), { recursive: true });
  // Sessions are only as private as this file.
  await writeFile(path, secret, { mode: 0o600 });
  return secret;
}

function hmac(secret: Buffer, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function signSession(secret: Buffer, expiresAtMs: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: expiresAtMs })).toString('base64url');
  return `${payload}.${hmac(secret, payload)}`;
}

export function verifySession(secret: Buffer, token: string, nowMs: number): boolean {
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payload, signature] = parts as [string, string];
  if (!payload || !signature) return false;

  const expected = Buffer.from(hmac(secret, payload));
  const supplied = Buffer.from(signature);
  // Length check first: timingSafeEqual throws on a mismatch.
  if (expected.length !== supplied.length) return false;
  if (!timingSafeEqual(expected, supplied)) return false;

  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: number };
    return typeof exp === 'number' && exp > nowMs;
  } catch {
    return false;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const pair of header.split(';')) {
    const index = pair.indexOf('=');
    if (index < 1) continue;
    const key = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

/** Paths under /api that must work without a session. */
function isExempt(method: string, path: string): boolean {
  // Firmware cannot log in.
  if (method === 'GET' && /^\/devices\/[^/]+\/frame$/.test(path)) return true;
  // Otherwise nobody could ever authenticate.
  if (path === '/auth/login') return true;
  return false;
}

export interface AuthOptions {
  /** Null disables authentication entirely. */
  password: string | null;
  secret: Buffer;
}

export function createAuth(options: AuthOptions): { middleware: RequestHandler; router: Router } {
  const attempts = new Map<string, { count: number; resetAt: number }>();

  const middleware: RequestHandler = (req, res, next) => {
    if (!options.password) return next();
    if (isExempt(req.method, req.path)) return next();

    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (token && verifySession(options.secret, token, Date.now())) return next();

    res.status(401).json({ error: 'authentication required' });
  };

  const router = Router();

  router.post('/auth/login', (req, res) => {
    if (!options.password) {
      res.json({ ok: true, authRequired: false });
      return;
    }

    const ip = req.ip ?? 'unknown';
    const now = Date.now();
    const record = attempts.get(ip);
    if (record && record.resetAt > now && record.count >= RATE_MAX) {
      res.status(429).json({ error: 'too many attempts, try again later' });
      return;
    }

    const supplied = String((req.body as { password?: unknown })?.password ?? '');
    const expected = Buffer.from(options.password);
    const given = Buffer.from(supplied);
    const ok = expected.length === given.length && timingSafeEqual(expected, given);

    if (!ok) {
      const next = record && record.resetAt > now
        ? { count: record.count + 1, resetAt: record.resetAt }
        : { count: 1, resetAt: now + RATE_WINDOW_MS };
      attempts.set(ip, next);
      res.status(401).json({ error: 'incorrect password' });
      return;
    }

    attempts.delete(ip);
    res.cookie(COOKIE_NAME, signSession(options.secret, now + SESSION_MS), {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: SESSION_MS,
      path: '/',
    });
    res.json({ ok: true, authRequired: true });
  });

  router.post('/auth/logout', (_req, res) => {
    res.clearCookie(COOKIE_NAME, { path: '/' });
    res.json({ ok: true });
  });

  router.get('/auth/state', (_req, res) => {
    res.json({ authRequired: Boolean(options.password) });
  });

  return { middleware, router };
}
```

- [ ] **Step 4: Wire it into the app**

In `src/http/app.ts`, add the import and extend `AppDeps`:

```ts
import { createAuth, type AuthOptions } from './auth.ts';
```

```ts
export interface AppDeps {
  store: DeviceStore;
  frames: FrameService;
  publicBaseUrl: string;
  auth?: AuthOptions;
}
```

Then inside `createApp`, replace the two `app.use('/api', ...)` lines with:

```ts
  const auth = createAuth(deps.auth ?? { password: null, secret: Buffer.alloc(32) });

  // Login must be reachable before the gate; the gate exempts it too, but
  // mounting first keeps the ordering obvious.
  app.use('/api', auth.router);
  app.use('/api', auth.middleware);

  // Device routes first: both mount under /api and :id/frame must win.
  app.use('/api', deviceRoutes(deps.store, deps.frames, deps.publicBaseUrl));
  app.use('/api', manageRoutes(deps.store, deps.frames, deps.publicBaseUrl));
```

- [ ] **Step 5: Supply the password and secret at startup**

In `src/index.ts`, add the import:

```ts
import { loadOrCreateSecret } from './http/auth.ts';
```

And inside `main()`, before `createApp`:

```ts
  const password = process.env.INKPANEL_PASSWORD?.trim() || null;
  const secret = await loadOrCreateSecret(join(dataDir, '.session-secret'));
```

Pass it through: `createApp({ store, frames, publicBaseUrl, auth: { password, secret } })`.

And add to the startup log, after the data directory line:

```ts
    console.log(password ? 'authentication: enabled' : 'authentication: disabled (no INKPANEL_PASSWORD)');
```

- [ ] **Step 6: Write the login page**

Create `public/login.html`:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>inkpanel — sign in</title>
<link rel="stylesheet" href="./styles.css">
</head>
<body class="login-page">
  <form class="card login-card" id="form">
    <p class="eyebrow">CtrlAlt</p>
    <h1>inkpanel</h1>
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" autofocus>
    <button type="submit">Sign in</button>
    <p class="error" id="error" hidden></p>
  </form>
<script type="module">
const form = document.getElementById('form');
const error = document.getElementById('error');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  error.hidden = true;

  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: document.getElementById('password').value }),
  });

  if (res.ok) {
    location.href = '/';
    return;
  }
  const body = await res.json().catch(() => ({ error: res.statusText }));
  error.textContent = body.error ?? 'Sign in failed';
  error.hidden = false;
});
</script>
</body>
</html>
```

Add to `public/styles.css`:

```css
.login-page { display: flex; align-items: center; justify-content: center; min-height: 100vh; }
.login-card { width: 100%; max-width: 320px; }
.login-card h1 { font-family: var(--font-display); font-size: var(--fs-2xl); margin: 0 0 var(--sp-4); }
.login-card button { width: 100%; }
```

- [ ] **Step 7: Write the gating tests**

Append to `test/http/auth.test.ts`:

```ts
import { createApp } from '../../src/http/app.ts';
import { DeviceStore } from '../../src/devices/store.ts';
import type { FrameService } from '../../src/render/frameService.ts';

const frames = {
  frameFor: async () => ({ buffer: Buffer.alloc(48000, 0), etag: 'e'.repeat(32), renderedAt: '2026-08-04T00:00:00.000Z' }),
  enrolmentFrame: async () => ({ buffer: Buffer.alloc(48000, 0), etag: 'f'.repeat(32), renderedAt: '2026-08-04T00:00:00.000Z' }),
  previewHtml: async () => '<html></html>',
  renderNow: async () => ({ buffer: Buffer.alloc(48000, 0), etag: 'e'.repeat(32), renderedAt: '2026-08-04T00:00:00.000Z' }),
} as unknown as FrameService;

async function withApp(password: string | null, fn: (base: string, store: DeviceStore) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-auth-'));
  const store = new DeviceStore(join(dir, 'config.json'));
  const app = createApp({
    store, frames, publicBaseUrl: 'http://test:8080',
    auth: { password, secret: SECRET },
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await fn(`http://127.0.0.1:${port}`, store);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('no password means nothing is gated', async () => {
  await withApp(null, async (base) => {
    assert.equal((await fetch(`${base}/api/devices`)).status, 200);
  });
});

test('a password gates the management API', async () => {
  await withApp('hunter2', async (base) => {
    assert.equal((await fetch(`${base}/api/devices`)).status, 401);
  });
});

test('the frame endpoint stays open even with a password set', async () => {
  await withApp('hunter2', async (base) => {
    const res = await fetch(`${base}/api/devices/esp32-1/frame`);
    assert.equal(res.status, 200, 'firmware cannot log in');
    assert.equal((await res.arrayBuffer()).byteLength, 48000);
  });
});

test('health stays open even with a password set', async () => {
  await withApp('hunter2', async (base) => {
    assert.equal((await fetch(`${base}/health`)).status, 200);
  });
});

test('logging in yields a cookie that unlocks the API', async () => {
  await withApp('hunter2', async (base) => {
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'hunter2' }),
    });
    assert.equal(login.status, 200);

    const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
    assert.match(cookie, /^inkpanel_session=/);

    const res = await fetch(`${base}/api/devices`, { headers: { cookie } });
    assert.equal(res.status, 200);
  });
});

test('a wrong password is rejected', async () => {
  await withApp('hunter2', async (base) => {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'wrong' }),
    });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('set-cookie'), null, 'no cookie on failure');
  });
});

test('repeated wrong passwords are rate-limited', async () => {
  await withApp('hunter2', async (base) => {
    const attempt = () => fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'wrong' }),
    });
    for (let i = 0; i < 5; i++) assert.equal((await attempt()).status, 401);
    assert.equal((await attempt()).status, 429, 'sixth attempt is throttled');
  });
});
```

- [ ] **Step 8: Document the limitation**

In `README.md`, replace the Security section with:

```markdown
## Security

By default there is **no authentication** — anyone who can reach the server can
read your calendar as a rendered image and change any panel's configuration.

Set `INKPANEL_PASSWORD` to require a login. Two endpoints stay open regardless:
`/api/devices/:id/frame`, because firmware cannot log in, and `/health`, so
monitoring does not need credentials.

**The password travels in clear text.** This is plain HTTP, so the password and
the session cookie are readable by anyone able to capture packets on your
network. It is protection against casual access — a guest on your WiFi, someone
idly poking at the address — and **not** against a hostile network.

**Do not expose this to the internet.** If you need remote access, put it behind
a VPN or a reverse proxy that terminates TLS and does its own authentication.
```

- [ ] **Step 9: Run the tests**

```bash
npm test && npm run check
```

Expected: 7 crypto/cookie tests plus 7 gating tests pass.

- [ ] **Step 10: Commit**

```bash
git add src/http/auth.ts src/http/app.ts src/index.ts public/login.html public/styles.css test/http/auth.test.ts README.md
git commit -m "feat: add optional password authentication"
```

---

### Task 5: System information API

**Files:**
- Create: `src/system/version.ts`, `src/system/updateCheck.ts`, `src/http/systemRoutes.ts`
- Create: `test/system/version.test.ts`, `test/system/updateCheck.test.ts`
- Modify: `src/http/app.ts`

**Interfaces:**
- Consumes: `DeviceStore`
- Produces:
  - `readVersion(): Promise<{ version: string; commit: string | null }>`
  - `checkForUpdate(now: number): Promise<{ state: 'current' | 'behind' | 'unknown'; local: string | null; remote: string | null; error?: string }>`
  - `systemRoutes(store: DeviceStore, dataDir: string): Router`
  - `GET /api/system/info`

- [ ] **Step 1: Write the failing test**

Create `test/system/version.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readVersion } from '../../src/system/version.ts';

test('reports the package version', async () => {
  const { version } = await readVersion();
  assert.match(version, /^\d+\.\d+\.\d+$/);
});

test('reports a short commit sha when run inside a git checkout', async () => {
  const { commit } = await readVersion();
  // Null is legitimate — a tarball deployment has no .git — so accept either,
  // but reject a malformed value.
  if (commit !== null) assert.match(commit, /^[0-9a-f]{7,40}$/);
});

test('caches, so repeated calls do not spawn git repeatedly', async () => {
  const a = await readVersion();
  const b = await readVersion();
  assert.deepEqual(a, b);
});
```

Create `test/system/updateCheck.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareRefs } from '../../src/system/updateCheck.ts';

test('identical refs are current', () => {
  assert.equal(compareRefs('abc123', 'abc123').state, 'current');
});

test('differing refs mean an update is available', () => {
  assert.equal(compareRefs('abc123', 'def456').state, 'behind');
});

test('a missing ref is unknown, never "current"', () => {
  assert.equal(compareRefs(null, 'def456').state, 'unknown');
  assert.equal(compareRefs('abc123', null).state, 'unknown');
  assert.equal(compareRefs(null, null).state, 'unknown');
});

test('short and long forms of the same commit are current', () => {
  assert.equal(compareRefs('abc1234', 'abc1234def567890').state, 'current',
    'git rev-parse --short and ls-remote return different lengths');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- --test-name-pattern="reports the package version"
```

Expected: FAIL — cannot resolve `src/system/version.ts`.

- [ ] **Step 3: Write version.ts**

Create `src/system/version.ts`:

```ts
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface VersionInfo {
  version: string;
  /** Short commit SHA, or null when not a git checkout. */
  commit: string | null;
}

// Neither value changes while the process runs, so resolve once.
let cached: Promise<VersionInfo> | null = null;

async function resolve(): Promise<VersionInfo> {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string };

  let commit: string | null = null;
  try {
    const { stdout } = await run('git', ['rev-parse', '--short', 'HEAD'], { cwd: root });
    commit = stdout.trim() || null;
  } catch {
    // A tarball deployment has no .git, and that is not an error.
  }

  return { version: pkg.version, commit };
}

export function readVersion(): Promise<VersionInfo> {
  cached ??= resolve();
  return cached;
}
```

- [ ] **Step 4: Write updateCheck.ts**

Create `src/system/updateCheck.ts`:

```ts
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const CACHE_MS = 10 * 60 * 1000;

export type UpdateState = 'current' | 'behind' | 'unknown';

export interface UpdateInfo {
  state: UpdateState;
  local: string | null;
  remote: string | null;
  checkedAt: string;
  error?: string;
}

/**
 * Compare a local short SHA against a remote full SHA.
 *
 * "unknown" is deliberately distinct from "current": failing to reach GitHub
 * must not be reported as being up to date.
 */
export function compareRefs(local: string | null, remote: string | null): { state: UpdateState } {
  if (!local || !remote) return { state: 'unknown' };
  const shortest = Math.min(local.length, remote.length);
  return { state: local.slice(0, shortest) === remote.slice(0, shortest) ? 'current' : 'behind' };
}

let cache: { at: number; info: UpdateInfo } | null = null;

export async function checkForUpdate(force = false): Promise<UpdateInfo> {
  const now = Date.now();
  if (!force && cache && now - cache.at < CACHE_MS) return cache.info;

  let local: string | null = null;
  let remote: string | null = null;
  let error: string | undefined;

  try {
    local = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim() || null;
    // ls-remote reads only; it does not touch the working tree or refs.
    const { stdout } = await run('git', ['ls-remote', 'origin', 'HEAD'], { cwd: root, timeout: 15000 });
    remote = stdout.split(/\s+/)[0]?.trim() || null;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const info: UpdateInfo = {
    ...compareRefs(local, remote),
    local: local ? local.slice(0, 7) : null,
    remote: remote ? remote.slice(0, 7) : null,
    checkedAt: new Date(now).toISOString(),
    ...(error ? { error } : {}),
  };

  cache = { at: now, info };
  return info;
}
```

- [ ] **Step 5a: Expose source health from the frame service**

The spec requires the settings tab to show per-source health. `FrameService`
already computes it on every render but discards it; retain it on the memo.

In `src/render/frameService.ts`, add `health: SourceHealth[]` to the `Memo`
interface:

```ts
interface Memo {
  hash: string;
  frame: Frame;
  contentChangedAt: string;
  health: SourceHealth[];
}
```

In `frameFor`, include it when storing:

```ts
    this.memo.set(device.id, { hash, frame, contentChangedAt, health: bundle.sourceHealth });
```

And add this method after `renderNow`:

```ts
  /**
   * Sources not currently reporting ok, across every device rendered so far.
   *
   * Safe to read from the memo: source status is part of the content hash, so
   * a status change always forces a re-render and therefore a fresh entry.
   */
  sourceIssues(): Array<{ deviceId: string; sourceId: string; status: string; error: string | null }> {
    const issues = [];
    for (const [deviceId, memo] of this.memo) {
      for (const source of memo.health) {
        if (source.status !== 'ok') {
          issues.push({ deviceId, sourceId: source.id, status: source.status, error: source.error });
        }
      }
    }
    return issues;
  }
```

- [ ] **Step 5b: Write the system routes**

Create `src/http/systemRoutes.ts`:

```ts
import { statfs } from 'node:fs/promises';
import { Router } from 'express';
import type { DeviceStore } from '../devices/store.ts';
import type { FrameService } from '../render/frameService.ts';
import { readVersion } from '../system/version.ts';
import { checkForUpdate } from '../system/updateCheck.ts';

export function systemRoutes(store: DeviceStore, frames: FrameService, dataDir: string): Router {
  const router = Router();

  router.get('/system/info', async (req, res) => {
    const [version, update, devices] = await Promise.all([
      readVersion(),
      checkForUpdate(req.query.refresh === '1'),
      store.list(),
    ]);

    let freeBytes: number | null = null;
    try {
      const fs = await statfs(dataDir);
      freeBytes = fs.bavail * fs.bsize;
    } catch {
      // Not fatal; the panel does not stop working because we cannot stat a disk.
    }

    res.json({
      version: version.version,
      commit: version.commit,
      uptimeSeconds: Math.round(process.uptime()),
      deviceCount: devices.length,
      dataDir,
      freeBytes,
      update,
      sourceIssues: frames.sourceIssues(),
    });
  });

  return router;
}
```

- [ ] **Step 6: Mount it, and fix the existing test helpers**

In `src/http/app.ts`, extend `AppDeps` with `dataDir: string`, import
`systemRoutes`, and mount it alongside the others:

```ts
  app.use('/api', systemRoutes(deps.store, deps.frames, deps.dataDir));
```

In `src/index.ts`, pass `dataDir` into `createApp`.

**`dataDir` is now required**, so every existing `createApp` call must supply it
or the typecheck fails. Update all three test helpers — they each already have a
temp `dir` in scope:

- `test/http/deviceRoutes.test.ts` → `createApp({ store, frames, publicBaseUrl: '…', dataDir: dir })`
- `test/http/manageRoutes.test.ts` → same
- `test/http/auth.test.ts` → same, alongside the existing `auth` option

Their frame-service stubs also need a `sourceIssues: () => []` entry, since
`systemRoutes` now calls it.

- [ ] **Step 7: Write the route test**

Append to `test/http/manageRoutes.test.ts` (its `withServer` helper needs
`dataDir` adding to the `createApp` call — use `dir`):

```ts
test('system info reports version and device count', async () => {
  await withServer(async (base, store) => {
    await store.getOrCreate('esp32-1');
    const res = await fetch(`${base}/api/system/info`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { version: string; deviceCount: number; update: { state: string } };
    assert.match(body.version, /^\d+\.\d+\.\d+$/);
    assert.equal(body.deviceCount, 1);
    assert.ok(['current', 'behind', 'unknown'].includes(body.update.state));
  });
});
```

- [ ] **Step 8: Run the tests**

```bash
npm test && npm run check
```

Expected: 3 version tests, 4 compareRefs tests, 1 route test pass.

- [ ] **Step 9: Commit**

```bash
git add src/system src/http/systemRoutes.ts src/http/app.ts src/index.ts test/system test/http/manageRoutes.test.ts
git commit -m "feat: add system info API with read-only update check"
```

---

### Task 6: Self-update API and updater

**Files:**
- Create: `src/system/updateStatus.ts`, `test/system/updateStatus.test.ts`
- Create: `scripts/proxmox/files/inkpanel-update`, `scripts/proxmox/files/inkpanel-update.path`, `scripts/proxmox/files/inkpanel-update.service`
- Modify: `src/http/systemRoutes.ts`, `docs/deployment.md`

**Interfaces:**
- Consumes: `dataDir` from Task 5
- Produces:
  - `type UpdatePhase = 'idle' | 'running' | 'success' | 'failed'`
  - `interface UpdateStatus { state: UpdatePhase; startedAt: string | null; finishedAt: string | null; log: string[]; error: string | null }`
  - `parseUpdateStatus(raw: string | null): UpdateStatus`
  - `readUpdateStatus(dataDir: string): Promise<UpdateStatus>`
  - `requestUpdate(dataDir: string): Promise<void>`
  - `POST /api/system/update` → `202 { requestedAt }`
  - `GET /api/system/update/status` → `200 UpdateStatus`

- [ ] **Step 1: Write the failing test**

Create `test/system/updateStatus.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseUpdateStatus, readUpdateStatus, requestUpdate } from '../../src/system/updateStatus.ts';

test('an absent status file is idle, not an error', () => {
  const status = parseUpdateStatus(null);
  assert.equal(status.state, 'idle');
  assert.deepEqual(status.log, []);
  assert.equal(status.error, null);
});

test('parses a running status', () => {
  const status = parseUpdateStatus(JSON.stringify({
    state: 'running', startedAt: '2026-08-04T12:00:00.000Z', finishedAt: null,
    log: ['Already up to date.'], error: null,
  }));
  assert.equal(status.state, 'running');
  assert.equal(status.log[0], 'Already up to date.');
});

test('parses a failed status with its error', () => {
  const status = parseUpdateStatus(JSON.stringify({
    state: 'failed', startedAt: '2026-08-04T12:00:00.000Z',
    finishedAt: '2026-08-04T12:00:09.000Z', log: [], error: 'npm ci exited 1',
  }));
  assert.equal(status.state, 'failed');
  assert.match(status.error ?? '', /npm ci/);
});

test('truncated or malformed JSON reads as idle rather than throwing', () => {
  // The updater writes this file while the UI polls it, so a partial read is
  // an expected event, not a bug.
  assert.equal(parseUpdateStatus('{"state":"run').state, 'idle');
  assert.equal(parseUpdateStatus('').state, 'idle');
  assert.equal(parseUpdateStatus('null').state, 'idle');
});

test('an unrecognised state is treated as idle', () => {
  assert.equal(parseUpdateStatus(JSON.stringify({ state: 'exploding' })).state, 'idle');
});

test('requesting an update creates the flag file the systemd path unit watches', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-update-'));
  try {
    await requestUpdate(dir);
    const flag = await readFile(join(dir, '.update-requested'), 'utf8');
    assert.match(flag, /^\d{4}-\d{2}-\d{2}T/, 'contains the request timestamp');
    assert.equal((await readUpdateStatus(dir)).state, 'idle', 'no status until the updater runs');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- --test-name-pattern="absent status file is idle"
```

Expected: FAIL — cannot resolve `src/system/updateStatus.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/system/updateStatus.ts`:

```ts
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type UpdatePhase = 'idle' | 'running' | 'success' | 'failed';

export interface UpdateStatus {
  state: UpdatePhase;
  startedAt: string | null;
  finishedAt: string | null;
  log: string[];
  error: string | null;
}

const IDLE: UpdateStatus = {
  state: 'idle', startedAt: null, finishedAt: null, log: [], error: null,
};

const PHASES: readonly string[] = ['idle', 'running', 'success', 'failed'];

export const FLAG_FILE = '.update-requested';
export const STATUS_FILE = 'update-status.json';

/**
 * The updater writes this file while the UI polls it, so a partial or absent
 * read is expected rather than exceptional. Anything unparseable is idle.
 */
export function parseUpdateStatus(raw: string | null): UpdateStatus {
  if (!raw) return IDLE;
  try {
    const parsed = JSON.parse(raw) as Partial<UpdateStatus> | null;
    if (!parsed || typeof parsed !== 'object') return IDLE;
    if (!PHASES.includes(String(parsed.state))) return IDLE;

    return {
      state: parsed.state as UpdatePhase,
      startedAt: parsed.startedAt ?? null,
      finishedAt: parsed.finishedAt ?? null,
      log: Array.isArray(parsed.log) ? parsed.log.map(String) : [],
      error: parsed.error ?? null,
    };
  } catch {
    return IDLE;
  }
}

export async function readUpdateStatus(dataDir: string): Promise<UpdateStatus> {
  try {
    return parseUpdateStatus(await readFile(join(dataDir, STATUS_FILE), 'utf8'));
  } catch {
    return IDLE;
  }
}

/**
 * Ask for an update by creating a flag file.
 *
 * This is the whole of the application's involvement. A systemd path unit
 * notices the file and runs the updater as root — the app has no ability to
 * influence what that script does, only that it runs.
 */
export async function requestUpdate(dataDir: string): Promise<void> {
  await writeFile(join(dataDir, FLAG_FILE), new Date().toISOString(), 'utf8');
}
```

- [ ] **Step 4: Add the routes**

In `src/http/systemRoutes.ts`, add the import:

```ts
import { readUpdateStatus, requestUpdate } from '../system/updateStatus.ts';
```

And add these routes before `return router;`:

```ts
  router.post('/system/update', async (_req, res) => {
    const running = await readUpdateStatus(dataDir);
    if (running.state === 'running') {
      res.status(409).json({ error: 'an update is already running' });
      return;
    }

    try {
      await requestUpdate(dataDir);
      res.status(202).json({ requestedAt: new Date().toISOString() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'could not request update' });
    }
  });

  router.get('/system/update/status', async (_req, res) => {
    res.set('Cache-Control', 'no-store').json(await readUpdateStatus(dataDir));
  });
```

- [ ] **Step 5: Write the updater script**

Create `scripts/proxmox/files/inkpanel-update`:

```bash
#!/usr/bin/env bash
#
# Triggered by inkpanel-update.path when the application creates
# /opt/inkpanel/data/.update-requested
#
# Runs as root. Must be root-owned and NOT writable by the inkpanel user — the
# whole point of this arrangement is that the web application can request an
# update but cannot influence what an update does.
#
set -Eeuo pipefail

APP=inkpanel
APP_DIR=/opt/inkpanel
REPO_DIR="$APP_DIR/app"
DATA_DIR="$APP_DIR/data"
FLAG="$DATA_DIR/.update-requested"
STATUS="$DATA_DIR/update-status.json"
LOG_FILE="$(mktemp)"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"

# Clear the flag first: the path unit re-arms on its absence, and leaving it
# would retrigger this script immediately on exit.
rm -f "$FLAG"

write_status() {
  node -e '
const fs = require("fs");
const [, , state, error, logFile, statusFile, startedAt] = process.argv;
let log = [];
try { log = fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).slice(-200); } catch {}
fs.writeFileSync(statusFile, JSON.stringify({
  state,
  startedAt,
  finishedAt: state === "running" ? null : new Date().toISOString(),
  log,
  error: error || null,
}, null, 2));
' "$1" "${2:-}" "$LOG_FILE" "$STATUS" "$STARTED_AT"
  chmod 644 "$STATUS"
}

fail() {
  write_status failed "$1"
  echo "inkpanel-update: FAILED — $1" >&2
  # Deliberately no restart. A broken update must be a no-op, not an outage:
  # the currently running process is still serving.
  exit 1
}
trap 'fail "unexpected error on line $LINENO"' ERR

write_status running

cd "$REPO_DIR"

LOCK_BEFORE="$(sha256sum package-lock.json 2>/dev/null | cut -d" " -f1 || echo none)"

echo "== git pull ==" >>"$LOG_FILE"
runuser -u "$APP" -- git pull --ff-only >>"$LOG_FILE" 2>&1 || fail "git pull failed"
write_status running

LOCK_AFTER="$(sha256sum package-lock.json 2>/dev/null | cut -d" " -f1 || echo none)"

if [[ "$LOCK_BEFORE" != "$LOCK_AFTER" ]]; then
  # npm ci removes node_modules before reinstalling, so a failure here leaves
  # the service unable to start. Only pay that risk when dependencies actually
  # changed — most updates are code-only.
  echo "== npm ci (lockfile changed) ==" >>"$LOG_FILE"
  runuser -u "$APP" -- npm ci --omit=dev >>"$LOG_FILE" 2>&1 || fail "npm ci failed"
else
  echo "== npm ci skipped (lockfile unchanged) ==" >>"$LOG_FILE"
fi
write_status running

echo "== restart ==" >>"$LOG_FILE"
write_status success
systemctl restart "$APP"

rm -f "$LOG_FILE"
```

- [ ] **Step 6: Write the systemd units**

Create `scripts/proxmox/files/inkpanel-update.path`:

```ini
[Unit]
Description=Watch for an inkpanel update request

[Path]
# The application creates this file. It can do nothing else privileged.
PathExists=/opt/inkpanel/data/.update-requested
Unit=inkpanel-update.service

[Install]
WantedBy=multi-user.target
```

Create `scripts/proxmox/files/inkpanel-update.service`:

```ini
[Unit]
Description=Update inkpanel from git
# Separate unit, so restarting inkpanel.service does not kill this mid-flight.

[Service]
Type=oneshot
ExecStart=/usr/local/bin/inkpanel-update
```

- [ ] **Step 7: Document the risk**

Append to `docs/deployment.md`:

```markdown
## Updating from the UI

The Settings tab can update the server. It works by creating a flag file that a
systemd path unit watches; the update itself runs as root in a separate unit the
web application cannot modify. The app is granted no privilege beyond writing a
file in its own data directory.

`npm ci` runs only when `package-lock.json` changed, and **a failed update does
not restart the service** — the running process keeps serving and the UI reports
the failure.

**The risk worth knowing:** self-update can break the service, and the UI that
would fix it *is* the service. If an update leaves it unable to start, recover
from the command line:

```bash
pct exec <CTID> -- journalctl -u inkpanel -n 50 --no-pager
pct exec <CTID> -- cat /opt/inkpanel/data/update-status.json
pct exec <CTID> -- bash -c 'cd /opt/inkpanel/app && runuser -u inkpanel -- git reset --hard HEAD~1 && systemctl restart inkpanel'
```
```

- [ ] **Step 8: Lint the shell scripts in CI**

The updater cannot be unit tested, so a syntax check is the only automated
guard it gets. Add this step to `.github/workflows/ci.yml`, in the `test` job
after `Install dependencies`:

```yaml
      - name: Shell syntax
        run: |
          for script in scripts/proxmox/inkpanel-lxc.sh scripts/proxmox/files/inkpanel-update; do
            echo "checking $script"
            bash -n "$script"
          done
```

- [ ] **Step 9: Run the tests**

```bash
npm test && npm run check && bash -n scripts/proxmox/files/inkpanel-update
```

Expected: 6 status tests pass, typecheck clean, updater syntax OK.

- [ ] **Step 10: Commit**

```bash
git add src/system/updateStatus.ts src/http/systemRoutes.ts scripts/proxmox/files test/system/updateStatus.test.ts docs/deployment.md .github/workflows/ci.yml
git commit -m "feat: add self-update via a systemd path-activated root unit"
```

---

### Task 7: Installer ships the update units

**Files:**
- Modify: `scripts/proxmox/inkpanel-lxc.sh`
- Modify: `test/docker.test.ts`

**Interfaces:**
- Consumes: the files from Task 6
- Produces: a container with `inkpanel-update.path` enabled and `INKPANEL_PASSWORD` documented in its env file

- [ ] **Step 1: Write the failing test**

Append to `test/docker.test.ts` (which already guards deployment invariants):

```ts
test('the installer ships the update units and the password variable', async () => {
  const installer = await readFile(join(root, 'scripts/proxmox/inkpanel-lxc.sh'), 'utf8');

  assert.match(installer, /inkpanel-update\.path/, 'path unit must be installed');
  assert.match(installer, /inkpanel-update\.service/, 'service unit must be installed');
  assert.match(installer, /systemctl enable --now inkpanel-update\.path/, 'path unit must be enabled');
  assert.match(installer, /INKPANEL_PASSWORD/, 'env file must mention the password');

  // The containment argument depends on this: the app must not be able to
  // rewrite the script that runs as root.
  assert.match(installer, /chown root:root \/usr\/local\/bin\/inkpanel-update/);
  assert.match(installer, /chmod 755 \/usr\/local\/bin\/inkpanel-update/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- --test-name-pattern="ships the update units"
```

Expected: FAIL — the installer does not mention `inkpanel-update.path`.

- [ ] **Step 3: Install the units**

In `scripts/proxmox/inkpanel-lxc.sh`, replace the block that writes
`/usr/local/bin/${APP}-update` (added in Spec 1) with this. The manual
convenience command stays; the new units sit alongside it.

```bash
# The update script and units are copied from the repo the container just
# cloned, so they stay in step with the application rather than being
# duplicated inside this installer.
step "installing update units"
run "install -o root -g root -m 755 ${APP_DIR}/app/scripts/proxmox/files/${APP}-update /usr/local/bin/${APP}-update
     chown root:root /usr/local/bin/${APP}-update
     chmod 755 /usr/local/bin/${APP}-update
     install -o root -g root -m 644 ${APP_DIR}/app/scripts/proxmox/files/${APP}-update.path /etc/systemd/system/${APP}-update.path
     install -o root -g root -m 644 ${APP_DIR}/app/scripts/proxmox/files/${APP}-update.service /etc/systemd/system/${APP}-update.service
     systemctl daemon-reload
     systemctl enable --now ${APP}-update.path >/dev/null 2>&1"
```

- [ ] **Step 4: Document the password in the env file**

In the same script, extend the env file that is written:

```bash
run "cat > ${APP_DIR}/${APP}.env <<ENVFILE
# Address panels use to reach this server. Shown on the enrolment screen.
PUBLIC_BASE_URL=http://${CT_IP}:${APP_PORT}

# Uncomment to require a password for the web UI. The panel's own endpoint stays
# open regardless, because firmware cannot log in.
#
# NOTE: this is plain HTTP. The password crosses your LAN in clear text. It
# guards against casual access, not against anyone capturing packets.
#INKPANEL_PASSWORD=change-me
ENVFILE
chown ${APP}:${APP} ${APP_DIR}/${APP}.env"
```

- [ ] **Step 5: Mention it in the summary**

In the final report block, after the Update line:

```bash
  printf '  %s\n' "Password:  edit ${APP_DIR}/${APP}.env, then: pct exec ${CTID} -- systemctl restart ${APP}"
```

- [ ] **Step 6: Run the tests**

```bash
npm test && bash -n scripts/proxmox/inkpanel-lxc.sh
```

Expected: the installer test passes and the script parses.

- [ ] **Step 7: Commit**

```bash
git add scripts/proxmox/inkpanel-lxc.sh test/docker.test.ts
git commit -m "feat(proxmox): install update units and document the password"
```

---

### Task 8: Split the browser code and add the tab shell

Pure refactor plus the centred layout. No behaviour change beyond routing, so it
can be reviewed on its own.

**Files:**
- Create: `public/api.js`, `public/components.js`, `public/panels.js`, `public/settings.js`
- Create: `test/public/components.test.js`
- Rewrite: `public/app.js`, `public/index.html`
- Modify: `public/styles.css`, `package.json`

**Interfaces:**
- Consumes: the APIs from Tasks 1–6
- Produces:
  - `api.js`: `getJson(path)`, `sendJson(method, path, body)`, `ApiError`
  - `components.js`: `esc(v)`, `formatRelative(iso, now)`, `formatVolts(v)`, `field(...)`, `pill(...)`
  - `app.js`: hash router calling `renderPanels(root)` / `renderSettings(root)`

- [ ] **Step 1: Write the failing test**

The browser modules are plain ESM, so the pure helpers can be tested under
`node:test` directly — no DOM, no jsdom dependency. Keep DOM access out of
module top level so this stays true.

Create `test/public/components.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc, formatRelative, formatVolts } from '../../public/components.js';

test('escapes the characters that break markup', () => {
  assert.equal(esc('<script>'), '&lt;script&gt;');
  assert.equal(esc('a & b'), 'a &amp; b');
  assert.equal(esc('say "hi"'), 'say &quot;hi&quot;');
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
});

test('formats recent times in relative terms', () => {
  const now = new Date('2026-08-04T12:00:00.000Z');
  assert.equal(formatRelative('2026-08-04T11:59:30.000Z', now), 'just now');
  assert.equal(formatRelative('2026-08-04T11:55:00.000Z', now), '5m ago');
  assert.equal(formatRelative('2026-08-04T09:00:00.000Z', now), '3h ago');
  assert.equal(formatRelative('2026-08-01T12:00:00.000Z', now), '3d ago');
});

test('a never-seen device reads as never, not as an epoch date', () => {
  assert.equal(formatRelative(null, new Date()), 'never');
  assert.equal(formatRelative('not a date', new Date()), 'never');
});

test('formats battery voltage, tolerating unknown', () => {
  assert.equal(formatVolts(4.02), '4.02 V');
  assert.equal(formatVolts(null), 'unknown');
});
```

Add the file to the test glob in `package.json`:

```json
    "test": "node --import tsx --test \"test/**/*.test.ts\" \"test/**/*.test.js\"",
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- --test-name-pattern="escapes the characters"
```

Expected: FAIL — cannot resolve `public/components.js`.

- [ ] **Step 3: Write the shared helpers**

Create `public/components.js`:

```js
export function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatRelative(iso, now = new Date()) {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'never';

  const seconds = Math.round((now.getTime() - then) / 1000);
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

export function formatVolts(volts) {
  return typeof volts === 'number' ? `${volts.toFixed(2)} V` : 'unknown';
}

export function field(id, name, label, value, type = 'text') {
  const step = type === 'number' ? ' step="any"' : '';
  return `<label for="${esc(id)}-${name}">${esc(label)}</label>
    <input id="${esc(id)}-${name}" name="${name}" type="${type}"${step} value="${esc(value)}">`;
}

export function pill(text, modifier = '') {
  return `<span class="status ${modifier}">${esc(text)}</span>`;
}
```

- [ ] **Step 4: Write the API wrapper**

Create `public/api.js`:

```js
export class ApiError extends Error {
  constructor(message, status, issues) {
    super(message);
    this.status = status;
    this.issues = issues ?? [];
  }
}

async function request(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  // A 401 means the password was set, or the session expired. Either way the
  // only useful action is to send the user to sign in.
  if (res.status === 401) {
    location.href = '/login.html';
    throw new ApiError('authentication required', 401);
  }

  if (!res.ok) {
    const problem = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(problem.error ?? res.statusText, res.status, problem.issues);
  }

  return res.status === 204 ? null : res.json();
}

export const getJson = (path) => request('GET', path);
export const sendJson = (method, path, body) => request(method, path, body);
```

- [ ] **Step 5: Write the shell and router**

Rewrite `public/index.html`:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>inkpanel</title>
<link rel="stylesheet" href="./styles.css">
</head>
<body>
  <div class="shell">
    <p class="eyebrow">CtrlAlt</p>
    <h1>inkpanel</h1>
    <nav class="tabs">
      <a href="#panels" data-tab="panels">Panels</a>
      <a href="#settings" data-tab="settings">Settings</a>
    </nav>
    <main id="view"><p class="empty">Loading…</p></main>
  </div>
  <script type="module" src="./app.js"></script>
</body>
</html>
```

Rewrite `public/app.js`:

```js
import { renderPanels } from './panels.js';
import { renderSettings } from './settings.js';

const view = document.getElementById('view');

const ROUTES = {
  panels: renderPanels,
  settings: renderSettings,
};

async function route() {
  const name = location.hash.replace('#', '') || 'panels';
  const render = ROUTES[name] ?? renderPanels;

  document.querySelectorAll('[data-tab]').forEach((tab) => {
    tab.classList.toggle('on', tab.dataset.tab === name);
  });

  view.innerHTML = '<p class="empty">Loading…</p>';
  try {
    await render(view);
  } catch (err) {
    // ApiError with status 401 already redirected; anything else is worth showing.
    if (err?.status !== 401) {
      view.innerHTML = `<div class="card"><p class="error">${err.message}</p></div>`;
    }
  }
}

window.addEventListener('hashchange', route);
await route();
```

- [ ] **Step 6: Extend the stylesheet**

Add to `public/styles.css`:

```css
body { max-width: none; }

.shell { max-width: 900px; margin: 0 auto; }

.tabs {
  display: flex;
  gap: var(--sp-6);
  border-bottom: 1px solid var(--line-1);
  margin-bottom: var(--sp-6);
}

.tabs a {
  padding: var(--sp-3) 0;
  font-size: var(--fs-sm);
  color: var(--fg-3);
  text-decoration: none;
  border-bottom: 2px solid transparent;
}

.tabs a.on { color: var(--fg-1); font-weight: 600; border-bottom-color: var(--brand-pink); }
.tabs a:hover { color: var(--fg-1); }
```

- [ ] **Step 7: Write placeholder tab modules**

So the shell runs before Tasks 9 and 11 fill them in. Create `public/panels.js`:

```js
export async function renderPanels(root) {
  root.innerHTML = '<div class="card"><p class="empty">Panels tab — Task 9.</p></div>';
}
```

Create `public/settings.js`:

```js
export async function renderSettings(root) {
  root.innerHTML = '<div class="card"><p class="empty">Settings tab — Task 11.</p></div>';
}
```

- [ ] **Step 8: Run the tests and look at it**

```bash
npm test && npm run check
```

Expected: 4 component tests pass.

```bash
npm start
```

Open `http://localhost:8080`. Both tabs should switch, the content should be
centred at 900px, and the active tab should carry a pink underline.

- [ ] **Step 9: Commit**

```bash
git add public package.json test/public
git commit -m "refactor: split browser code into modules with a tab shell"
```

---

### Task 9: Panels tab with overview strip and Push

**Files:**
- Rewrite: `public/panels.js`
- Modify: `public/styles.css`

**Interfaces:**
- Consumes: `getJson`/`sendJson` (Task 8), `esc`/`formatRelative`/`formatVolts`/`field`/`pill` (Task 8), `POST /api/devices/:id/push` (Task 3)
- Produces: `renderPanels(root): Promise<void>`

- [ ] **Step 1: Write the module**

Rewrite `public/panels.js`:

```js
import { getJson, sendJson } from './api.js';
import { esc, formatRelative, formatVolts, field, pill } from './components.js';

let selectedId = null;

function thumbnail(device) {
  const claimedPill = device.claimed
    ? pill('Claimed', 'status--claimed')
    : pill('Unclaimed', 'status--unclaimed');

  return `<button class="panel-card ${device.id === selectedId ? 'on' : ''}" data-select="${esc(device.id)}">
      <img class="panel-thumb" loading="lazy" alt="What ${esc(device.name)} is showing"
           src="/api/devices/${encodeURIComponent(device.id)}/render.png">
      <span class="panel-name">${esc(device.name)}</span>
      <span class="panel-meta">${esc(formatVolts(device.lastBatteryVolts))} · ${esc(formatRelative(device.lastSeenAt))}</span>
      ${claimedPill}
    </button>`;
}

function detail(device) {
  return `<div class="card" id="detail">
    <h2>${esc(device.name)}${device.claimed ? pill('Claimed', 'status--claimed') : pill('Unclaimed', 'status--unclaimed')}</h2>
    <p class="meta">${esc(device.id)} · fw ${esc(device.lastFirmwareVersion ?? 'unknown')}</p>

    <form data-id="${esc(device.id)}">
      <h3>Location</h3>
      <div id="city-picker"></div>
      ${field(device.id, 'timezone', 'Timezone', device.timezone)}

      <h3>Calendar</h3>
      <label for="${esc(device.id)}-cal">Secret iCal URLs, one per line</label>
      <textarea id="${esc(device.id)}-cal" name="calendarUrls" rows="3"
        placeholder="https://calendar.google.com/calendar/ical/.../private-xxxx/basic.ics">${esc((device.calendarUrls ?? []).join('\n'))}</textarea>

      <h3>Refresh schedule</h3>
      <div class="row">
        <div>${field(device.id, 'activeIntervalSeconds', 'Interval (seconds)', device.activeIntervalSeconds, 'number')}</div>
        <div>${field(device.id, 'quietHoursStart', 'Quiet from (hour)', device.quietHoursStart, 'number')}</div>
        <div>${field(device.id, 'quietHoursEnd', 'Quiet until (hour)', device.quietHoursEnd, 'number')}</div>
      </div>

      <label class="checkbox">
        <input type="checkbox" name="claimed" ${device.claimed ? 'checked' : ''}>
        Claimed — show the dashboard instead of the setup screen
      </label>

      <div class="actions">
        <button type="submit">Save</button>
        <button type="button" class="ghost" data-push="${esc(device.id)}">Push</button>
      </div>
      <p class="notice" id="notice" hidden></p>
      <p class="error" id="error" hidden></p>
    </form>

    <h3>What the panel shows</h3>
    <img class="preview" alt="Rendered output for ${esc(device.name)}"
         src="/api/devices/${encodeURIComponent(device.id)}/render.png?t=${Date.now()}">
  </div>`;
}

function pushMessage(result) {
  if (result.willAppearBy) {
    const at = new Date(result.willAppearBy).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `Rendered. Will appear by ${at} — or press KEY1 on the panel for now.`;
  }
  if (result.overdueSince) {
    const since = new Date(result.overdueSince).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `Rendered, but this panel has not checked in since ${since}. It will collect it when it next wakes.`;
  }
  return 'Rendered. Will appear at the panel’s next check-in.';
}

async function save(event, root) {
  event.preventDefault();
  const form = event.target;
  const raw = Object.fromEntries(new FormData(form));
  const picker = form.querySelector('#city-picker');

  const body = {
    timezone: raw.timezone,
    calendarUrls: String(raw.calendarUrls || '').split('\n').map((s) => s.trim()).filter(Boolean),
    activeIntervalSeconds: Number(raw.activeIntervalSeconds),
    quietHoursStart: Number(raw.quietHoursStart),
    quietHoursEnd: Number(raw.quietHoursEnd),
    claimed: form.querySelector('[name=claimed]').checked,
  };

  // The city picker owns three fields at once; it only contributes when a
  // result has actually been chosen.
  if (picker?.dataset.latitude) {
    body.latitude = Number(picker.dataset.latitude);
    body.longitude = Number(picker.dataset.longitude);
    body.locationLabel = picker.dataset.label;
    if (picker.dataset.timezone) body.timezone = picker.dataset.timezone;
  }

  await sendJson('PUT', `/api/devices/${encodeURIComponent(form.dataset.id)}`, body);
  await renderPanels(root);
}

export async function renderPanels(root) {
  const { devices } = await getJson('/api/devices');

  if (devices.length === 0) {
    root.innerHTML = '<div class="card"><p class="empty">No panels yet. Power one on and it will appear here.</p></div>';
    return;
  }

  if (!devices.some((d) => d.id === selectedId)) selectedId = devices[0].id;
  const selected = devices.find((d) => d.id === selectedId);

  root.innerHTML = `<div class="panel-strip">${devices.map(thumbnail).join('')}</div>${detail(selected)}`;

  root.querySelectorAll('[data-select]').forEach((card) => {
    card.addEventListener('click', () => {
      selectedId = card.dataset.select;
      void renderPanels(root);
    });
  });

  const form = root.querySelector('form');
  form.addEventListener('submit', (event) => {
    void save(event, root).catch((err) => {
      const el = root.querySelector('#error');
      const detailText = (err.issues ?? []).map((i) => `${i.path?.join('.') ?? '?'}: ${i.message}`).join('\n');
      el.textContent = `${err.message}${detailText ? `\n${detailText}` : ''}`;
      el.hidden = false;
    });
  });

  root.querySelector('[data-push]').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const notice = root.querySelector('#notice');
    button.disabled = true;
    button.textContent = 'Rendering…';
    try {
      const result = await sendJson('POST', `/api/devices/${encodeURIComponent(button.dataset.push)}/push`);
      notice.textContent = pushMessage(result);
      notice.hidden = false;
      // Cache-bust so the preview reflects the render that just happened.
      root.querySelector('.preview').src =
        `/api/devices/${encodeURIComponent(button.dataset.push)}/render.png?t=${Date.now()}`;
    } finally {
      button.disabled = false;
      button.textContent = 'Push';
    }
  });

  const { renderCityPicker } = await import('./cityPicker.js');
  renderCityPicker(root.querySelector('#city-picker'), selected);
}
```

- [ ] **Step 2: Add a city picker stub**

`panels.js` imports `./cityPicker.js`, which Task 10 writes. Without a stub the
panels tab throws on load and this task cannot be verified on its own.

Create `public/cityPicker.js`:

```js
// Replaced in Task 10. Renders the plain coordinate fields so the panels tab
// is usable and testable before the picker exists.
import { esc } from './components.js';

export function renderCityPicker(container, device) {
  container.innerHTML = `
    <div class="row">
      <div>
        <label for="lat">Latitude</label>
        <input id="lat" name="latitude" type="number" step="any" value="${esc(device.latitude)}">
      </div>
      <div>
        <label for="lon">Longitude</label>
        <input id="lon" name="longitude" type="number" step="any" value="${esc(device.longitude)}">
      </div>
    </div>`;
}
```

- [ ] **Step 3: Add the styles**

Add to `public/styles.css`:

```css
.panel-strip {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: var(--sp-4);
  margin-bottom: var(--sp-6);
}

.panel-card {
  background: var(--bg-2);
  border: 1px solid var(--line-1);
  border-radius: var(--radius-md);
  padding: var(--sp-3);
  cursor: pointer;
  text-align: left;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  margin: 0;
  font-family: var(--font-body);
  color: var(--fg-1);
  transition: border-color var(--dur-fast) var(--ease-out);
}

.panel-card:hover { border-color: var(--line-2); }
.panel-card.on { border-color: var(--brand-pink); }

.panel-thumb {
  width: 100%;
  aspect-ratio: 800 / 480;
  background: #fff;
  border-radius: var(--radius-sm);
  object-fit: contain;
}

.panel-name { font-weight: 700; font-size: var(--fs-base); }
.panel-meta { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--fg-3); }
.panel-card .status { margin-left: 0; align-self: flex-start; }

.actions { display: flex; gap: var(--sp-3); align-items: center; }
button.ghost { background: transparent; color: var(--brand-pink); border: 1px solid var(--brand-pink); }
button.ghost:hover { background: var(--brand-pink-dim); }
button:disabled { opacity: 1; background: var(--bg-3); color: var(--fg-3); cursor: default; }

.notice { color: var(--fg-2); font-size: var(--fs-sm); margin-top: var(--sp-3); }
```

- [ ] **Step 4: Verify in a browser**

```bash
npm start
```

With one panel claimed, check:

- The strip shows a card with a live thumbnail of what the panel is displaying.
- Saving persists and the page re-renders.
- **Push updates the preview image and prints a "will appear by" line.** This is
  the one worth watching: if the preview does not visibly change when you have
  altered something, the memo is not being bypassed.

- [ ] **Step 5: Commit**

```bash
git add public/panels.js public/cityPicker.js public/styles.css
git commit -m "feat: panels tab with overview strip, thumbnails and push"
```

---

### Task 10: City picker

**Files:**
- Rewrite: `public/cityPicker.js` (the coordinate-field stub from Task 9)
- Modify: `public/styles.css`

**Interfaces:**
- Consumes: `getJson` (Task 8), `GET /api/geocode` (Task 1)
- Produces: `renderCityPicker(container, device): void` — same signature as the stub it replaces, writing `dataset.latitude`, `dataset.longitude`, `dataset.label`, `dataset.timezone` on the container for `panels.js` to read on save

- [ ] **Step 1: Write the module**

Replace the contents of `public/cityPicker.js`:

```js
import { getJson } from './api.js';
import { esc } from './components.js';

const DEBOUNCE_MS = 250;
const MIN_CHARS = 2;

export function renderCityPicker(container, device) {
  const current = device.locationLabel || `${device.latitude}, ${device.longitude}`;

  container.innerHTML = `
    <label for="city-input">City</label>
    <input id="city-input" type="text" autocomplete="off" spellcheck="false"
           value="${esc(current)}" placeholder="Start typing a town or city">
    <div class="city-results" hidden></div>
    <p class="meta city-current">Using ${esc(current)}</p>`;

  const input = container.querySelector('#city-input');
  const results = container.querySelector('.city-results');
  const currentLine = container.querySelector('.city-current');
  let timer = null;
  let sequence = 0;

  function choose(result) {
    // panels.js reads these on submit. Storing on the container keeps the
    // picker free of any knowledge of the form around it.
    container.dataset.latitude = String(result.latitude);
    container.dataset.longitude = String(result.longitude);
    container.dataset.label = result.label;
    container.dataset.timezone = result.timezone;

    input.value = result.label;
    results.hidden = true;
    currentLine.textContent = `Will save ${result.label} — timezone ${result.timezone}`;

    // A wrong timezone silently shifts every event time on the panel, so keep
    // the visible field in step with the chosen city.
    const timezoneField = document.querySelector('input[name="timezone"]');
    if (timezoneField) timezoneField.value = result.timezone;
  }

  async function search(query) {
    const mine = ++sequence;
    try {
      const { results: found } = await getJson(`/api/geocode?q=${encodeURIComponent(query)}`);
      // Discard responses from superseded keystrokes.
      if (mine !== sequence) return;

      if (found.length === 0) {
        results.innerHTML = '<div class="city-empty">No matches</div>';
        results.hidden = false;
        return;
      }

      results.innerHTML = found
        .map((r, i) => `<button type="button" class="city-option" data-index="${i}">${esc(r.label)}</button>`)
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
    const query = input.value.trim();
    if (query.length < MIN_CHARS) {
      results.hidden = true;
      return;
    }
    timer = setTimeout(() => void search(query), DEBOUNCE_MS);
  });

  input.addEventListener('blur', () => {
    // Delay so a click on an option registers before the list disappears.
    setTimeout(() => { results.hidden = true; }, 150);
  });
}
```

- [ ] **Step 2: Add the styles**

Add to `public/styles.css`:

```css
#city-picker { position: relative; }

.city-results {
  position: absolute;
  left: 0;
  right: 0;
  z-index: 5;
  background: var(--bg-3);
  border: 1px solid var(--brand-pink);
  border-radius: var(--radius-sm);
  overflow: hidden;
  box-shadow: var(--shadow-md);
}

.city-option {
  display: block;
  width: 100%;
  text-align: left;
  background: transparent;
  color: var(--fg-1);
  border: 0;
  border-bottom: 1px solid var(--line-1);
  border-radius: 0;
  margin: 0;
  padding: var(--sp-3);
  font-size: var(--fs-sm);
  font-weight: 400;
  cursor: pointer;
}

.city-option:last-child { border-bottom: 0; }
.city-option:hover { background: var(--brand-pink-dim); }
.city-empty { padding: var(--sp-3); font-size: var(--fs-sm); color: var(--fg-3); }
.city-current { margin-top: var(--sp-2); }
```

- [ ] **Step 3: Verify in a browser**

```bash
npm start
```

Type "milton" into the City field. Within a moment a list should appear.
Choosing **Milton Keynes, England, GB** should:

- fill the input with the full label,
- change the line beneath to *"Will save … — timezone Europe/London"*,
- **and update the Timezone field to `Europe/London`.**

Save, reload, and confirm the label persisted.

Then type quickly and delete — no stale list should appear after you have
cleared the field, which is what the sequence counter guards against.

- [ ] **Step 4: Commit**

```bash
git add public/cityPicker.js public/styles.css
git commit -m "feat: city picker that also sets the timezone"
```

---

### Task 11: Settings tab and the update flow

**Files:**
- Rewrite: `public/settings.js`
- Modify: `public/styles.css`

**Interfaces:**
- Consumes: `GET /api/system/info`, `POST /api/system/update`, `GET /api/system/update/status` (Tasks 5–6)
- Produces: `renderSettings(root): Promise<void>`

- [ ] **Step 1: Write the module**

Rewrite `public/settings.js`:

```js
import { getJson, sendJson } from './api.js';
import { esc } from './components.js';

const POLL_MS = 2000;
const GIVE_UP_MS = 3 * 60 * 1000;

function formatBytes(bytes) {
  if (typeof bytes !== 'number') return 'unknown';
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB free` : `${Math.round(bytes / 1024 ** 2)} MB free`;
}

function updateLine(update) {
  if (update.state === 'behind') return `Update available (${esc(update.remote)})`;
  if (update.state === 'current') return 'Up to date';
  // Deliberately not "up to date" — failing to check is not the same thing.
  return `Could not check${update.error ? `: ${esc(update.error)}` : ''}`;
}

function view(info) {
  const canUpdate = info.update.state === 'behind';
  return `<div class="card">
    <h2>Server</h2>
    <div class="health">
      <span class="pill">v${esc(info.version)}${info.commit ? ` · ${esc(info.commit)}` : ''}</span>
      <span class="pill">${Math.round(info.uptimeSeconds / 60)}m uptime</span>
      <span class="pill">${info.deviceCount} panel${info.deviceCount === 1 ? '' : 's'}</span>
      <span class="pill">${esc(formatBytes(info.freeBytes))}</span>
    </div>

    <h3>Updates</h3>
    <p class="meta">${updateLine(info.update)}</p>
    <div class="actions">
      <button type="button" id="update" ${canUpdate ? '' : 'disabled'}>
        ${canUpdate ? 'Update now' : 'Nothing to update'}
      </button>
      <button type="button" class="ghost" id="recheck">Check again</button>
    </div>
    <pre class="update-log" id="log" hidden></pre>
    <p class="error" id="error" hidden></p>
  </div>`;
}

/**
 * Poll until the update finishes.
 *
 * The server restarts underneath us partway through, so connection failures are
 * an expected part of a successful update rather than an error condition.
 */
async function pollUntilDone(log) {
  const deadline = Date.now() + GIVE_UP_MS;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));

    let status = null;
    try {
      status = await getJson('/api/system/update/status');
    } catch {
      log.textContent = 'Server restarting…';
      continue;
    }

    if (status.log.length > 0) log.textContent = status.log.join('\n');

    if (status.state === 'success') {
      log.textContent += '\n\nDone. Reloading…';
      setTimeout(() => location.reload(), 1500);
      return;
    }
    if (status.state === 'failed') {
      log.textContent = `${status.log.join('\n')}\n\nFAILED: ${status.error ?? 'unknown'}\n\nThe old version is still running.`;
      return;
    }
  }

  log.textContent += '\n\nGave up waiting. Check: journalctl -u inkpanel -n 50';
}

export async function renderSettings(root) {
  const info = await getJson('/api/system/info');
  root.innerHTML = view(info);

  const log = root.querySelector('#log');
  const error = root.querySelector('#error');

  root.querySelector('#recheck').addEventListener('click', async () => {
    root.innerHTML = '<p class="empty">Checking…</p>';
    await renderSettings(root);
  });

  root.querySelector('#update').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Updating…';
    error.hidden = true;
    log.hidden = false;
    log.textContent = 'Requested…';

    try {
      await sendJson('POST', '/api/system/update');
      await pollUntilDone(log);
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
      button.disabled = false;
      button.textContent = 'Update now';
    }
  });
}
```

- [ ] **Step 2: Add the styles**

Add to `public/styles.css`:

```css
.update-log {
  background: var(--bg-0);
  border: 1px solid var(--line-1);
  border-radius: var(--radius-sm);
  padding: var(--sp-3);
  margin-top: var(--sp-4);
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  color: var(--fg-2);
  max-height: 260px;
  overflow: auto;
  white-space: pre-wrap;
}
```

- [ ] **Step 3: Verify in a browser**

```bash
npm start
```

Open the Settings tab. Version, uptime, panel count and free space should show,
along with the update state. With no network, it must read **"Could not check"**
— *not* "Up to date".

Full update verification needs the LXC, since the systemd units only exist
there. On the container:

1. Commit something trivial and push.
2. Settings should show *Update available*.
3. Press **Update now** — the log streams, the server restarts, the page reloads
   on the new commit.
4. Confirm `pct exec <CTID> -- cat /opt/inkpanel/data/update-status.json` reads
   `"state": "success"`.

- [ ] **Step 4: Commit**

```bash
git add public/settings.js public/styles.css
git commit -m "feat: settings tab with self-update and honest update state"
```

---

## Notes for the implementer

**Tasks 1–7 are server-side and fully testable here.** Tasks 8–11 are browser
code with no headless test rig; their verification is a browser and the steps
listed. That asymmetry is deliberate rather than an oversight — adding jsdom or
Playwright component testing for four small modules would cost more than it
returns, so the pure helpers are unit tested and the DOM wiring is checked by
looking at it.

**Task 6 cannot be fully verified outside the LXC.** The systemd units do not
exist on a dev machine. `bash -n` and the status-file tests are what can be
checked locally; the real test is the container.

**The riskiest change is Task 4.** An auth middleware that accidentally gates
`/api/devices/:id/frame` breaks every panel silently — they will simply stop
updating, showing their last good image, with nothing on screen to say why. The
test for that case exists; do not skip it.



