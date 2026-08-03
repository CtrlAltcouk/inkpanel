# inkpanel Spec 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a server that renders a day-at-a-glance dashboard to a 1-bit image, and firmware that makes a battery-powered ESP32 e-paper panel fetch and display it.

**Architecture:** A Node/TypeScript service fetches calendar and weather, renders an 800×480 HTML page through headless Chromium, thresholds it to 1 bit, and serves the packed 48,000-byte buffer over HTTP. The ESP32 wakes on a timer, fetches with `If-None-Match`, blits only on `200`, and sleeps for a server-dictated interval.

**Tech Stack:** Node 22, TypeScript, Express 5, Playwright, sharp, node-ical, zod, `node --test` via tsx. Firmware is Arduino/C++ on ESP32-S3.

**Spec:** `docs/superpowers/specs/2026-08-03-inkpanel-spec1-design.md`

## Global Constraints

- Node 22+, TypeScript, ESM (`"type": "module"`). Matches the author's existing tooling.
- Test runner is `node --import tsx --test`. No Jest, no Vitest.
- **The panel stylesheet may contain only `#000` and `#fff`.** No greys, no `opacity`, no `rgba`. Dimmed appearances use hatch patterns via `repeating-linear-gradient`.
- Buffer format is fixed: 1 bit per pixel, MSB = leftmost pixel, `1 = black`, 100-byte stride, exactly 48,000 bytes.
- The content hash **must exclude** `generatedAt` and all per-source `fetchedAt` values, or `304` never fires.
- No authentication anywhere. README must state the LAN-only assumption plainly.
- Secrets live in `/data/config.json` or `.env`, never in the repo. Both are gitignored.
- Only the `wft0583-800x480-mono` panel profile ships.
- The `OldV2EPD` init sequence from `EE04_WFT0583CZ61_OldV2_Test` is carried over **verbatim**. It is the old-V2 variant; the current Waveshare V2 driver will not work.
- Every task ends with a commit.

---

## File Structure

```
firmware/inkpanel/            Arduino sketch (replaces the EE04 test sketch)
  inkpanel.ino                setup/loop, wake orchestration
  config.h                    pin map, compile-time defaults
  OldV2EPD.{h,cpp}            panel driver, carried over unchanged
  Provisioning.{h,cpp}        NVS storage + SoftAP captive portal
  FrameClient.{h,cpp}         HTTP fetch, ETag, response handling

src/
  panel/profile.ts            PanelProfile type + WFT0583 constant
  panel/quantise.ts           PNG → threshold → packed buffer
  model/dashboard.ts          DashboardData and its sub-types
  model/hash.ts               content hash excluding volatile fields
  sources/types.ts            Source + SourceResult interfaces
  sources/ical.ts             Google secret-iCal calendar source
  sources/openMeteo.ts        weather source
  sources/runner.ts           parallel fetch, timeout, disk cache, stale fallback
  render/template.ts          DashboardData → HTML string
  render/panel.css.ts         the panel stylesheet (black/white only)
  render/browser.ts           long-lived Chromium wrapper
  render/frameService.ts      orchestration: data → html → png → buffer + ETag
  devices/store.ts            atomic JSON device registry
  devices/types.ts            DeviceRecord
  schedule/nextWake.ts        pure scheduling function
  http/deviceRoutes.ts        GET /api/devices/:id/frame
  http/manageRoutes.ts        list/update/preview/render.png/health
  http/app.ts                 Express wiring
  index.ts                    entrypoint
  tools/fakeDevice.ts         CLI that speaks the device protocol

public/                       config UI (consumes ctrlalt colors_and_type.css)
test/fixtures/                .ics and Open-Meteo JSON fixtures, golden PNGs
```

---

### Task 1: Measure EE04 deep-sleep current (hardware spike)

> **This task requires physical hardware and a multimeter. An agent cannot do it — it is for the repo owner.** Tasks 2–16 do not depend on the result and can proceed in parallel. Only Task 18's interval defaults depend on it.

**Files:**
- Create: `docs/hardware/sleep-current.md`

**Interfaces:**
- Consumes: nothing
- Produces: a measured idle current in µA, recorded in the doc, which Task 18 reads to pick default wake intervals.

- [ ] **Step 1: Write the minimal sleep sketch**

Create `firmware/spikes/sleep_current/sleep_current.ino`:

```cpp
#include <Arduino.h>
#include <esp_sleep.h>

// Pins from the EE04 test sketch.
constexpr int EPD_ENABLE = 43;

void setup() {
  // Drive the panel rail off before sleeping — this is the whole point.
  pinMode(EPD_ENABLE, OUTPUT);
  digitalWrite(EPD_ENABLE, LOW);

  esp_sleep_enable_timer_wakeup(300ULL * 1000000ULL);  // 5 minutes
  esp_deep_sleep_start();
}

void loop() {}
```

- [ ] **Step 2: Measure**

Flash it, then power the board from a bench supply or battery through a multimeter in series on the positive lead, set to µA. Record the steady-state current once the board settles (allow 30 s).

Measure three configurations:
1. As above (panel rail off).
2. With `digitalWrite(EPD_ENABLE, HIGH)` — panel powered during sleep.
3. USB disconnected, battery only — USB-serial chips draw current and will dominate the reading if left connected.

Configuration 3 is the real number.

- [ ] **Step 3: Record the result and its consequence**

Create `docs/hardware/sleep-current.md` with the three readings, the date, and the meter used. Then state the consequence explicitly:

- Under ~100 µA — the spec's months-long estimate holds. Use the planned defaults.
- 100 µA to 1 mA — expect weeks. Lengthen intervals and note it in the README.
- Over 1 mA — battery life is days. **Stop and investigate hardware** before building firmware around a false assumption: look for a power LED to cut, or a regulator that stays enabled.

- [ ] **Step 4: Commit**

```bash
git add firmware/spikes/sleep_current docs/hardware/sleep-current.md
git commit -m "spike: measure EE04 deep-sleep current"
```

---

### Task 2: Project scaffolding

**Files:**
- Create: `package.json`, `tsconfig.json`, `.env.example`, `src/index.ts`, `test/smoke.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: a working `npm test` and `npm run check`. All later tasks assume these exist.

- [ ] **Step 1: Write the failing test**

Create `test/smoke.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { version } from '../src/index.ts';

test('exposes a version string', () => {
  assert.equal(typeof version, 'string');
  assert.match(version, /^\d+\.\d+\.\d+$/);
});
```

- [ ] **Step 2: Create the package manifest**

Create `package.json`:

```json
{
  "name": "inkpanel",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "tsx src/index.ts",
    "check": "tsc -p tsconfig.json --noEmit",
    "test": "node --import tsx --test \"test/**/*.test.ts\"",
    "fake-device": "tsx src/tools/fakeDevice.ts"
  },
  "dependencies": {
    "dotenv": "^17.4.2",
    "express": "^5.2.1",
    "node-ical": "^0.27.1",
    "playwright": "^1.56.0",
    "sharp": "^0.35.3",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@types/express": "^5.0.6",
    "@types/node": "^24.13.2",
    "tsx": "^4.23.0",
    "typescript": "~6.0.2"
  }
}
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
npm install && npm test
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/index.ts`.

Two npm warnings are expected and harmless:

- **`allow-scripts`** on `sharp` and `esbuild`. Newer npm blocks install scripts
  by default. Neither package needs them — both ship prebuilt binaries as
  optional dependencies. Verify rather than assume, with
  `node -e "import('sharp').then(s=>console.log('ok'))"`.
- **Deprecation notices** from transitive dependencies.

`npm audit` should report **0 vulnerabilities**. If it flags `sharp` or
`node-ical`, the pinned versions above have drifted — both had advisories in
their previous majors (libvips CVEs, and a `uuid` bounds check reached through
`node-ical`, which parses feeds fetched from the internet). Upgrade rather than
suppress.

- [ ] **Step 4: Write the minimal implementation**

Create `src/index.ts`:

```ts
export const version = '0.1.0';
```

Create `.env.example`:

```
# Port the server listens on
PORT=8080
# Absolute path for device registry and frame cache
DATA_DIR=./data
# Printed on the enrolment screen. Falls back to the bound LAN IP.
PUBLIC_BASE_URL=
```

- [ ] **Step 5: Run the tests and typecheck**

```bash
npm test && npm run check
```

Expected: 1 test passing, no type errors.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json .env.example src/index.ts test/smoke.test.ts
git commit -m "chore: scaffold TypeScript service with node:test"
```

---

### Task 3: Panel profile and quantiser

This is the contract with the firmware. Get the bit order wrong and the panel shows garbage that is miserable to debug from the hardware end — so it gets hand-computed assertions.

**Files:**
- Create: `src/panel/profile.ts`, `src/panel/quantise.ts`, `test/panel/quantise.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `interface PanelProfile { id: string; width: number; height: number; bitDepth: 1; bitOrder: 'msb-first'; inkBit: 1; stride: number; bytes: number }`
  - `const WFT0583: PanelProfile`
  - `packGrayscale(gray: Uint8Array, profile: PanelProfile, threshold?: number): Buffer`
  - `quantisePng(png: Buffer, profile: PanelProfile): Promise<Buffer>`

- [ ] **Step 1: Write the failing test**

Create `test/panel/quantise.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packGrayscale } from '../../src/panel/quantise.ts';
import type { PanelProfile } from '../../src/panel/profile.ts';
import { WFT0583 } from '../../src/panel/profile.ts';

// A tiny 8x1 profile so the expected byte can be worked out by hand.
const TINY: PanelProfile = {
  id: 'tiny-8x1', width: 8, height: 1,
  bitDepth: 1, bitOrder: 'msb-first', inkBit: 1,
  stride: 1, bytes: 1,
};

test('packs MSB-first with 1 = black', () => {
  // Luminance 0 is black, 255 is white.
  // Pixels:      B    W    W    W    B    B    W    B
  const gray = Uint8Array.from([0, 255, 255, 255, 0, 0, 255, 0]);
  // Expected bits: 1 0 0 0 1 1 0 1  = 0x8D
  const packed = packGrayscale(gray, TINY);
  assert.equal(packed.length, 1);
  assert.equal(packed[0], 0x8d);
});

test('thresholds at the midpoint', () => {
  const gray = Uint8Array.from([127, 128, 0, 0, 0, 0, 0, 0]);
  // 127 < 128 → black (1); 128 is not < 128 → white (0)
  // bits: 1 0 1 1 1 1 1 1 = 0xBF
  assert.equal(packGrayscale(gray, TINY)[0], 0xbf);
});

test('WFT0583 profile matches the wire format the firmware expects', () => {
  assert.equal(WFT0583.width, 800);
  assert.equal(WFT0583.height, 480);
  assert.equal(WFT0583.stride, 100);
  assert.equal(WFT0583.bytes, 48000);
  assert.equal(WFT0583.inkBit, 1);
  assert.equal(WFT0583.bitOrder, 'msb-first');
});

test('produces exactly one full buffer for the real panel', () => {
  const gray = new Uint8Array(800 * 480).fill(255);
  const packed = packGrayscale(gray, WFT0583);
  assert.equal(packed.length, 48000);
  assert.ok(packed.every((b) => b === 0x00), 'an all-white page must pack to all zero bits');
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- --test-name-pattern="packs MSB-first"
```

Expected: FAIL — cannot resolve `src/panel/quantise.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/panel/profile.ts`:

```ts
export interface PanelProfile {
  id: string;
  width: number;
  height: number;
  bitDepth: 1;
  bitOrder: 'msb-first';
  /** Bit value that means "ink on paper". */
  inkBit: 1;
  /** Bytes per row. */
  stride: number;
  /** Total packed buffer size. */
  bytes: number;
}

/**
 * Good Display GDEW075T7 / flex WFT0583CZ61, driven by the Waveshare old-V2
 * sequence. This layout is byte-for-byte what MonoCanvas already uses, so the
 * firmware copies the response straight into the framebuffer.
 */
export const WFT0583: PanelProfile = {
  id: 'wft0583-800x480-mono',
  width: 800,
  height: 480,
  bitDepth: 1,
  bitOrder: 'msb-first',
  inkBit: 1,
  stride: 100,
  bytes: 48000,
};

export const PROFILES: Record<string, PanelProfile> = {
  [WFT0583.id]: WFT0583,
};
```

Create `src/panel/quantise.ts`:

```ts
import sharp from 'sharp';
import type { PanelProfile } from './profile.ts';

/** Luminance below this is ink. */
export const DEFAULT_THRESHOLD = 128;

/**
 * Pack 8-bit greyscale into the panel's 1-bit format.
 * MSB of each byte is the leftmost pixel; a set bit means black.
 */
export function packGrayscale(
  gray: Uint8Array,
  profile: PanelProfile,
  threshold: number = DEFAULT_THRESHOLD,
): Buffer {
  const expected = profile.width * profile.height;
  if (gray.length !== expected) {
    throw new Error(`expected ${expected} greyscale pixels, received ${gray.length}`);
  }

  const out = Buffer.alloc(profile.bytes, 0);
  for (let y = 0; y < profile.height; y++) {
    const rowStart = y * profile.width;
    const byteRow = y * profile.stride;
    for (let x = 0; x < profile.width; x++) {
      if (gray[rowStart + x]! < threshold) {
        out[byteRow + (x >> 3)]! |= 0x80 >> (x & 7);
      }
    }
  }
  return out;
}

/** Decode a PNG, flatten onto white, reduce to greyscale, then pack. */
export async function quantisePng(png: Buffer, profile: PanelProfile): Promise<Buffer> {
  const { data, info } = await sharp(png)
    .flatten({ background: '#ffffff' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (info.width !== profile.width || info.height !== profile.height) {
    throw new Error(
      `image is ${info.width}x${info.height}, profile expects ${profile.width}x${profile.height}`,
    );
  }
  if (info.channels !== 1) {
    throw new Error(`expected 1 channel after greyscale, got ${info.channels}`);
  }

  return packGrayscale(new Uint8Array(data), profile);
}
```

- [ ] **Step 4: Run the tests**

```bash
npm test && npm run check
```

Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/panel test/panel
git commit -m "feat: add panel profile and 1-bit quantiser"
```

---

### Task 4: Domain model and content hash

The hash is what makes `304` work. If it includes a timestamp, the panel flashes forever.

**Files:**
- Create: `src/model/dashboard.ts`, `src/model/hash.ts`, `test/model/hash.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `CalendarEvent { uid: string; title: string; start: string; end: string; allDay: boolean }`
  - `CalendarData { today: CalendarEvent[]; tomorrow: CalendarEvent[] }`
  - `DayForecast { weekday: string; highC: number; lowC: number; conditionText: string }`
  - `WeatherData { currentTempC, conditionText, highC, lowC, precipProbability, windKph, windDirection, sunrise, sunset, forecast }`
  - `SourceHealth { id: string; status: 'ok' | 'stale' | 'error'; fetchedAt: string | null; error: string | null }`
  - `DashboardData { generatedAt, contentChangedAt, timezone, today, calendar, weather, sourceHealth, battery }`
  - `contentHash(data: DashboardData): string`

- [ ] **Step 1: Write the failing test**

Create `test/model/hash.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentHash } from '../../src/model/hash.ts';
import type { DashboardData } from '../../src/model/dashboard.ts';

function sample(overrides: Partial<DashboardData> = {}): DashboardData {
  return {
    generatedAt: '2026-08-03T07:42:00.000Z',
    contentChangedAt: '2026-08-03T07:42:00.000Z',
    timezone: 'Europe/London',
    today: { iso: '2026-08-03', weekdayLong: 'Monday', dayOfMonth: 3, monthLong: 'August' },
    calendar: {
      today: [{ uid: 'a', title: 'Standup', start: '2026-08-03T08:30:00.000Z', end: '2026-08-03T08:45:00.000Z', allDay: false }],
      tomorrow: [],
    },
    weather: {
      currentTempC: 22, conditionText: 'Partly cloudy', highC: 24, lowC: 13,
      precipProbability: 10, windKph: 13, windDirection: 'NW',
      sunrise: '2026-08-03T04:34:00.000Z', sunset: '2026-08-03T19:47:00.000Z',
      forecast: [{ weekday: 'TUE', highC: 24, lowC: 14, conditionText: 'Sunny' }],
    },
    sourceHealth: [{ id: 'ical', status: 'ok', fetchedAt: '2026-08-03T07:42:00.000Z', error: null }],
    battery: { volts: 4.02, percent: 87 },
    ...overrides,
  };
}

test('ignores generatedAt so unchanged content keeps its ETag', () => {
  const a = contentHash(sample());
  const b = contentHash(sample({ generatedAt: '2026-08-03T09:15:00.000Z' }));
  assert.equal(a, b);
});

test('ignores per-source fetchedAt', () => {
  const a = contentHash(sample());
  const b = contentHash(sample({
    sourceHealth: [{ id: 'ical', status: 'ok', fetchedAt: '2026-08-03T09:15:00.000Z', error: null }],
  }));
  assert.equal(a, b);
});

test('changes when an event changes', () => {
  const a = contentHash(sample());
  const b = contentHash(sample({
    calendar: { today: [{ uid: 'a', title: 'Standup MOVED', start: '2026-08-03T08:30:00.000Z', end: '2026-08-03T08:45:00.000Z', allDay: false }], tomorrow: [] },
  }));
  assert.notEqual(a, b);
});

test('changes when a source degrades to stale', () => {
  const a = contentHash(sample());
  const b = contentHash(sample({
    sourceHealth: [{ id: 'ical', status: 'stale', fetchedAt: null, error: 'timeout' }],
  }));
  assert.notEqual(a, b, 'a stale badge is visible on the panel, so it must change the hash');
});

test('changes when the battery percent changes', () => {
  const a = contentHash(sample());
  const b = contentHash(sample({ battery: { volts: 3.6, percent: 42 } }));
  assert.notEqual(a, b, 'battery is rendered in the footer');
});

test('ignores battery volts when percent is unchanged', () => {
  const a = contentHash(sample());
  const b = contentHash(sample({ battery: { volts: 4.05, percent: 87 } }));
  assert.equal(a, b, 'volts are not rendered, only percent');
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- --test-name-pattern="ignores generatedAt"
```

Expected: FAIL — cannot resolve `src/model/hash.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/model/dashboard.ts`:

```ts
export interface CalendarEvent {
  uid: string;
  title: string;
  /** ISO 8601 instant. */
  start: string;
  end: string;
  allDay: boolean;
}

export interface CalendarData {
  today: CalendarEvent[];
  tomorrow: CalendarEvent[];
}

export interface DayForecast {
  /** Three-letter uppercase weekday, e.g. "TUE". */
  weekday: string;
  highC: number;
  lowC: number;
  conditionText: string;
}

export interface WeatherData {
  currentTempC: number;
  conditionText: string;
  highC: number;
  lowC: number;
  /** Percentage, 0-100. */
  precipProbability: number;
  windKph: number;
  windDirection: string;
  sunrise: string;
  sunset: string;
  forecast: DayForecast[];
}

export type SourceStatus = 'ok' | 'stale' | 'error';

export interface SourceHealth {
  id: string;
  status: SourceStatus;
  fetchedAt: string | null;
  error: string | null;
}

export interface TodayInfo {
  iso: string;
  weekdayLong: string;
  dayOfMonth: number;
  monthLong: string;
}

export interface BatteryInfo {
  volts: number | null;
  /** Rounded percentage, or null when unknown. Only this is rendered. */
  percent: number | null;
}

export interface DashboardData {
  /** When this object was built. Excluded from the content hash. */
  generatedAt: string;
  /** When the rendered content last actually changed. Shown in the footer. */
  contentChangedAt: string;
  timezone: string;
  today: TodayInfo;
  calendar: CalendarData | null;
  weather: WeatherData | null;
  sourceHealth: SourceHealth[];
  battery: BatteryInfo;
}
```

Create `src/model/hash.ts`:

```ts
import { createHash } from 'node:crypto';
import type { DashboardData } from './dashboard.ts';

/**
 * Hash only what is visible on the panel.
 *
 * generatedAt, contentChangedAt and per-source fetchedAt are deliberately
 * excluded: including them would make every render unique, so the ETag would
 * always change, 304 would never fire, and the panel would flash on every
 * wake. Battery volts are excluded because only the rounded percent is drawn.
 */
export function contentHash(data: DashboardData): string {
  const visible = {
    timezone: data.timezone,
    today: data.today,
    calendar: data.calendar,
    weather: data.weather,
    sourceHealth: data.sourceHealth.map((s) => ({
      id: s.id,
      status: s.status,
      error: s.error,
    })),
    batteryPercent: data.battery.percent,
  };
  return createHash('sha256').update(JSON.stringify(visible)).digest('hex').slice(0, 32);
}
```

- [ ] **Step 4: Run the tests**

```bash
npm test && npm run check
```

Expected: 6 hash tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/model test/model
git commit -m "feat: add dashboard model and volatile-free content hash"
```

---

### Task 5: Source interfaces and the iCal calendar source

The spec names this the highest-risk code in Spec 1. Fixtures come first.

**Files:**
- Create: `src/sources/types.ts`, `src/sources/dateKeys.ts`, `src/sources/ical.ts`
- Create: `test/fixtures/ics.ts`, `test/sources/ical.test.ts`

**Interfaces:**
- Consumes: `CalendarEvent`, `CalendarData` from Task 4
- Produces:
  - `type SourceResult<T> = { status:'ok'; data:T; fetchedAt:string } | { status:'error'; error:string }`
  - `interface Source<TConfig, TData> { id: string; fetch(config: TConfig, signal: AbortSignal): Promise<SourceResult<TData>> }`
  - `localDateKey(instant: Date, timezone: string): string`
  - `expandCalendar(icsTexts: string[], now: Date, timezone: string): CalendarData`
  - `icalSource: Source<{ urls: string[]; timezone: string }, CalendarData>`

- [ ] **Step 1: Write the fixtures**

Create `test/fixtures/ics.ts`:

```ts
/** A single timed event on Monday 3 August 2026. */
export const SINGLE_TIMED = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//test//EN
BEGIN:VEVENT
UID:single-1
DTSTAMP:20260801T000000Z
DTSTART:20260803T083000Z
DTEND:20260803T084500Z
SUMMARY:Team standup
END:VEVENT
END:VCALENDAR`;

/** An all-day event on 3 August 2026. */
export const ALL_DAY = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//test//EN
BEGIN:VEVENT
UID:allday-1
DTSTAMP:20260801T000000Z
DTSTART;VALUE=DATE:20260803
DTEND;VALUE=DATE:20260804
SUMMARY:Bank holiday
END:VEVENT
END:VCALENDAR`;

/** Every weekday at 09:30, running for years, with 3 Aug cancelled. */
export const WEEKLY_WITH_EXDATE = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//test//EN
BEGIN:VEVENT
UID:weekly-1
DTSTAMP:20260101T000000Z
DTSTART:20260105T093000Z
DTEND:20260105T094500Z
RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR
EXDATE:20260803T093000Z
SUMMARY:Daily sync
END:VEVENT
END:VCALENDAR`;

/** Same weekly rule without the cancellation. */
export const WEEKLY = WEEKLY_WITH_EXDATE
  .split('\n')
  .filter((l) => !l.startsWith('EXDATE'))
  .join('\n');

/** An event tomorrow, 4 August 2026. */
export const TOMORROW = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//test//EN
BEGIN:VEVENT
UID:tomorrow-1
DTSTAMP:20260801T000000Z
DTSTART:20260804T071500Z
DTEND:20260804T081500Z
SUMMARY:Train to Euston
END:VEVENT
END:VCALENDAR`;

export const EMPTY = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//test//EN
END:VCALENDAR`;
```

- [ ] **Step 2: Write the failing test**

Create `test/sources/ical.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandCalendar, localDateKey } from '../../src/sources/ical.ts';
import * as fx from '../fixtures/ics.ts';

const TZ = 'Europe/London';
// Monday 3 August 2026, 07:00 UTC (08:00 London).
const NOW = new Date('2026-08-03T07:00:00.000Z');

test('localDateKey formats in the target zone', () => {
  // 23:30 UTC on 2 Aug is 00:30 on 3 Aug in London (BST).
  assert.equal(localDateKey(new Date('2026-08-02T23:30:00.000Z'), TZ), '2026-08-03');
  assert.equal(localDateKey(new Date('2026-08-02T22:30:00.000Z'), TZ), '2026-08-02');
});

test('picks up a single timed event today', () => {
  const cal = expandCalendar([fx.SINGLE_TIMED], NOW, TZ);
  assert.equal(cal.today.length, 1);
  assert.equal(cal.today[0]?.title, 'Team standup');
  assert.equal(cal.today[0]?.allDay, false);
});

test('treats an all-day event as today without timezone drift', () => {
  const cal = expandCalendar([fx.ALL_DAY], NOW, TZ);
  assert.equal(cal.today.length, 1);
  assert.equal(cal.today[0]?.allDay, true);
  assert.equal(cal.today[0]?.title, 'Bank holiday');
});

test('expands a weekly recurrence onto today', () => {
  const cal = expandCalendar([fx.WEEKLY], NOW, TZ);
  assert.equal(cal.today.length, 1, 'Monday 3 Aug is a weekday occurrence');
  assert.equal(cal.today[0]?.title, 'Daily sync');
});

test('honours EXDATE cancellations', () => {
  const cal = expandCalendar([fx.WEEKLY_WITH_EXDATE], NOW, TZ);
  assert.equal(cal.today.length, 0, '3 Aug was cancelled via EXDATE');
  assert.equal(cal.tomorrow.length, 1, 'but 4 Aug still occurs');
});

test('separates tomorrow from today', () => {
  const cal = expandCalendar([fx.SINGLE_TIMED, fx.TOMORROW], NOW, TZ);
  assert.equal(cal.today.length, 1);
  assert.equal(cal.tomorrow.length, 1);
  assert.equal(cal.tomorrow[0]?.title, 'Train to Euston');
});

test('merges multiple calendars and sorts by start time', () => {
  const cal = expandCalendar([fx.TOMORROW, fx.SINGLE_TIMED, fx.WEEKLY], NOW, TZ);
  const titles = cal.today.map((e) => e.title);
  assert.deepEqual(titles, ['Team standup', 'Daily sync'], '08:30 sorts before 09:30');
});

test('handles an empty calendar', () => {
  const cal = expandCalendar([fx.EMPTY], NOW, TZ);
  assert.deepEqual(cal, { today: [], tomorrow: [] });
});

test('survives the spring DST transition', () => {
  // 29 March 2026 is the UK spring-forward. A 09:30 UTC weekly event still
  // resolves onto the correct local day.
  const dstNow = new Date('2026-03-30T07:00:00.000Z'); // Monday after
  const cal = expandCalendar([fx.WEEKLY], dstNow, TZ);
  assert.equal(cal.today.length, 1);
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
npm test -- --test-name-pattern="localDateKey"
```

Expected: FAIL — cannot resolve `src/sources/ical.ts`.

- [ ] **Step 4: Write the source interfaces**

Create `src/sources/types.ts`:

```ts
export type SourceResult<T> =
  | { status: 'ok'; data: T; fetchedAt: string }
  | { status: 'error'; error: string };

export interface Source<TConfig, TData> {
  readonly id: string;
  fetch(config: TConfig, signal: AbortSignal): Promise<SourceResult<TData>>;
}
```

- [ ] **Step 5: Write the iCal implementation**

Create `src/sources/ical.ts`:

```ts
import ical from 'node-ical';
import type { CalendarResponse, VEvent } from 'node-ical';
import type { CalendarData, CalendarEvent } from '../model/dashboard.ts';
import type { Source, SourceResult } from './types.ts';

/** The calendar day an instant falls on, in the given zone: "YYYY-MM-DD". */
export function localDateKey(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function utcDateKey(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

/**
 * Recover the authored calendar date of an all-day event.
 *
 * All-day events carry a *floating* date with no zone. node-ical materialises
 * these as `new Date(year, month, day)` — midnight in whatever timezone the
 * **server process** runs in. Reading such a Date as UTC shifts it a day west
 * of Greenwich and the other way east of it, so the bug only appears on some
 * machines: a dev box in London disagrees with a container running UTC.
 *
 * The system-local getters are the exact inverse of that construction, so they
 * recover the authored date whatever the server's timezone is.
 */
function floatingDateKey(instant: Date): string {
  const year = instant.getFullYear();
  const month = String(instant.getMonth() + 1).padStart(2, '0');
  const day = String(instant.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * A CalendarResponse holds VEVENTs alongside VTIMEZONEs, VTODOs and calendar
 * metadata, so entries must be narrowed rather than assumed.
 */
function isVEvent(entry: unknown): entry is VEvent {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    (entry as { type?: unknown }).type === 'VEVENT'
  );
}

function addDays(key: string, days: number): string {
  const d = new Date(`${key}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return utcDateKey(d);
}

function toEvent(uid: string, title: string, start: Date, end: Date, allDay: boolean): CalendarEvent {
  return {
    uid,
    title: title.trim() || '(no title)',
    start: start.toISOString(),
    end: end.toISOString(),
    allDay,
  };
}

/**
 * Expand one or more iCalendar documents into today's and tomorrow's events.
 *
 * Recurrence is expanded over a window that generously brackets the two days
 * of interest, then filtered by local date key. Comparing date keys rather
 * than computing zone offsets keeps DST out of the arithmetic entirely.
 */
export function expandCalendar(icsTexts: string[], now: Date, timezone: string): CalendarData {
  const todayKey = localDateKey(now, timezone);
  const tomorrowKey = addDays(todayKey, 1);

  const windowStart = new Date(`${addDays(todayKey, -1)}T00:00:00.000Z`);
  const windowEnd = new Date(`${addDays(todayKey, 3)}T00:00:00.000Z`);

  const collected: CalendarEvent[] = [];

  for (const text of icsTexts) {
    let parsed: CalendarResponse;
    try {
      parsed = ical.sync.parseICS(text);
    } catch {
      continue; // A malformed feed must not take the others down.
    }

    for (const entry of Object.values(parsed)) {
      if (!isVEvent(entry)) continue;
      const event = entry;
      if (!event.start || !event.end) continue;

      const allDay = event.datetype === 'date';
      const durationMs = event.end.getTime() - event.start.getTime();
      const summary = typeof event.summary === 'string' ? event.summary : '';

      if (!event.rrule) {
        collected.push(toEvent(event.uid, summary, event.start, event.end, allDay));
        continue;
      }

      const excluded = new Set(
        Object.values(event.exdate ?? {})
          .filter((d): d is Date => d instanceof Date)
          .map((d) => d.toISOString()),
      );

      for (const occurrence of event.rrule.between(windowStart, windowEnd, true)) {
        if (excluded.has(occurrence.toISOString())) continue;

        // A modified instance (RECURRENCE-ID) overrides the generated one.
        // node-ical keys these by both date-only and full ISO timestamp; the
        // date-only form is the one that matches a generated occurrence.
        const override = event.recurrences?.[utcDateKey(occurrence)];
        const overrideStart = override?.start;
        const overrideEnd = override?.end;

        // instanceof rather than a cast: Omit<VEvent, 'recurrences'> widens
        // these to {}, and this is a real runtime guard as well as a narrowing.
        if (overrideStart instanceof Date && overrideEnd instanceof Date) {
          collected.push(
            toEvent(event.uid, String(override?.summary ?? summary), overrideStart, overrideEnd, allDay),
          );
        } else {
          collected.push(
            toEvent(event.uid, summary, occurrence, new Date(occurrence.getTime() + durationMs), allDay),
          );
        }
      }
    }
  }

  const keyOf = (e: CalendarEvent) =>
    e.allDay ? utcDateKey(new Date(e.start)) : localDateKey(new Date(e.start), timezone);

  const byStart = (a: CalendarEvent, b: CalendarEvent) => a.start.localeCompare(b.start);

  return {
    today: collected.filter((e) => keyOf(e) === todayKey).sort(byStart),
    tomorrow: collected.filter((e) => keyOf(e) === tomorrowKey).sort(byStart),
  };
}

export interface IcalConfig {
  urls: string[];
  timezone: string;
}

export const icalSource: Source<IcalConfig, CalendarData> = {
  id: 'ical',
  async fetch(config, signal): Promise<SourceResult<CalendarData>> {
    if (config.urls.length === 0) {
      return { status: 'error', error: 'no calendar URLs configured' };
    }
    try {
      const texts = await Promise.all(
        config.urls.map(async (url) => {
          const res = await globalThis.fetch(url, { signal });
          if (!res.ok) throw new Error(`${url} responded ${res.status}`);
          return res.text();
        }),
      );
      return {
        status: 'ok',
        data: expandCalendar(texts, new Date(), config.timezone),
        fetchedAt: new Date().toISOString(),
      };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },
};
```

- [ ] **Step 6: Run the tests**

```bash
npm test && npm run check
```

Expected: 9 iCal tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/sources test/sources test/fixtures
git commit -m "feat: add iCal calendar source with recurrence expansion"
```

---

### Task 6: Open-Meteo weather source

**Files:**
- Create: `src/sources/weatherCodes.ts`, `src/sources/openMeteo.ts`
- Create: `test/fixtures/openMeteo.ts`, `test/sources/openMeteo.test.ts`

**Interfaces:**
- Consumes: `WeatherData`, `DayForecast` from Task 4; `Source`, `SourceResult` from Task 5
- Produces:
  - `describeWeatherCode(code: number): string`
  - `mapOpenMeteo(raw: unknown): WeatherData`
  - `openMeteoSource: Source<{ latitude: number; longitude: number; timezone: string }, WeatherData>`

- [ ] **Step 1: Write the fixture**

Create `test/fixtures/openMeteo.ts`:

```ts
/** Trimmed but structurally faithful Open-Meteo forecast response. */
export const MK_FORECAST = {
  latitude: 52.04,
  longitude: -0.76,
  timezone: 'Europe/London',
  current: {
    time: '2026-08-03T08:00',
    temperature_2m: 21.6,
    weather_code: 2,
    wind_speed_10m: 12.8,
    wind_direction_10m: 315,
  },
  daily: {
    time: ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06'],
    temperature_2m_max: [23.8, 24.1, 19.4, 21.2],
    temperature_2m_min: [12.9, 14.0, 13.1, 12.4],
    precipitation_probability_max: [10, 5, 70, 35],
    weather_code: [2, 0, 61, 3],
    sunrise: ['2026-08-03T05:34', '2026-08-04T05:36', '2026-08-05T05:37', '2026-08-06T05:39'],
    sunset: ['2026-08-03T20:47', '2026-08-04T20:45', '2026-08-05T20:44', '2026-08-06T20:42'],
  },
};
```

- [ ] **Step 2: Write the failing test**

Create `test/sources/openMeteo.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapOpenMeteo, describeWeatherCode } from '../../src/sources/openMeteo.ts';
import { MK_FORECAST } from '../fixtures/openMeteo.ts';

test('maps current conditions', () => {
  const w = mapOpenMeteo(MK_FORECAST);
  assert.equal(w.currentTempC, 22, 'rounded for display');
  assert.equal(w.conditionText, 'Partly cloudy');
  assert.equal(w.highC, 24);
  assert.equal(w.lowC, 13);
  assert.equal(w.precipProbability, 10);
  assert.equal(w.windKph, 13);
  assert.equal(w.windDirection, 'NW');
});

test('produces exactly three forecast days, excluding today', () => {
  const w = mapOpenMeteo(MK_FORECAST);
  assert.equal(w.forecast.length, 3);
  assert.deepEqual(w.forecast.map((d) => d.weekday), ['TUE', 'WED', 'THU']);
  assert.equal(w.forecast[1]?.conditionText, 'Rain');
});

test('describes WMO codes', () => {
  assert.equal(describeWeatherCode(0), 'Clear');
  assert.equal(describeWeatherCode(61), 'Rain');
  assert.equal(describeWeatherCode(95), 'Thunderstorm');
  assert.equal(describeWeatherCode(999), 'Unknown');
});

test('rejects a malformed payload rather than rendering nonsense', () => {
  assert.throws(() => mapOpenMeteo({ current: {} }), /malformed/i);
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
npm test -- --test-name-pattern="maps current conditions"
```

Expected: FAIL — cannot resolve `src/sources/openMeteo.ts`.

- [ ] **Step 4: Write the implementation**

Create `src/sources/weatherCodes.ts`:

```ts
/** WMO weather interpretation codes, collapsed to short panel-friendly labels. */
const CODES: Record<number, string> = {
  0: 'Clear',
  1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Rime fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
  56: 'Freezing drizzle', 57: 'Freezing drizzle',
  61: 'Rain', 63: 'Rain', 65: 'Heavy rain',
  66: 'Freezing rain', 67: 'Freezing rain',
  71: 'Snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Showers', 81: 'Showers', 82: 'Heavy showers',
  85: 'Snow showers', 86: 'Snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm', 99: 'Thunderstorm',
};

export function describeWeatherCode(code: number): string {
  return CODES[code] ?? 'Unknown';
}

const POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

export function describeWindDirection(degrees: number): string {
  const index = Math.round(((degrees % 360) + 360) % 360 / 45) % 8;
  return POINTS[index]!;
}
```

Create `src/sources/openMeteo.ts`:

```ts
import { z } from 'zod';
import type { DayForecast, WeatherData } from '../model/dashboard.ts';
import type { Source, SourceResult } from './types.ts';
import { describeWeatherCode, describeWindDirection } from './weatherCodes.ts';

export { describeWeatherCode };

const schema = z.object({
  current: z.object({
    temperature_2m: z.number(),
    weather_code: z.number(),
    wind_speed_10m: z.number(),
    wind_direction_10m: z.number(),
  }),
  daily: z.object({
    time: z.array(z.string()).min(4),
    temperature_2m_max: z.array(z.number()).min(4),
    temperature_2m_min: z.array(z.number()).min(4),
    precipitation_probability_max: z.array(z.number()).min(1),
    weather_code: z.array(z.number()).min(4),
    sunrise: z.array(z.string()).min(1),
    sunset: z.array(z.string()).min(1),
  }),
});

function weekdayFor(isoDate: string): string {
  return new Date(`${isoDate}T12:00:00.000Z`)
    .toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' })
    .slice(0, 3)
    .toUpperCase();
}

export function mapOpenMeteo(raw: unknown): WeatherData {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`malformed Open-Meteo response: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
  }
  const { current, daily } = parsed.data;

  const forecast: DayForecast[] = [1, 2, 3].map((i) => ({
    weekday: weekdayFor(daily.time[i]!),
    highC: Math.round(daily.temperature_2m_max[i]!),
    lowC: Math.round(daily.temperature_2m_min[i]!),
    conditionText: describeWeatherCode(daily.weather_code[i]!),
  }));

  return {
    currentTempC: Math.round(current.temperature_2m),
    conditionText: describeWeatherCode(current.weather_code),
    highC: Math.round(daily.temperature_2m_max[0]!),
    lowC: Math.round(daily.temperature_2m_min[0]!),
    precipProbability: Math.round(daily.precipitation_probability_max[0]!),
    windKph: Math.round(current.wind_speed_10m),
    windDirection: describeWindDirection(current.wind_direction_10m),
    sunrise: daily.sunrise[0]!,
    sunset: daily.sunset[0]!,
    forecast,
  };
}

export interface OpenMeteoConfig {
  latitude: number;
  longitude: number;
  timezone: string;
}

export const openMeteoSource: Source<OpenMeteoConfig, WeatherData> = {
  id: 'weather',
  async fetch(config, signal): Promise<SourceResult<WeatherData>> {
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.searchParams.set('latitude', String(config.latitude));
    url.searchParams.set('longitude', String(config.longitude));
    url.searchParams.set('timezone', config.timezone);
    url.searchParams.set('forecast_days', '4');
    url.searchParams.set('current', 'temperature_2m,weather_code,wind_speed_10m,wind_direction_10m');
    url.searchParams.set(
      'daily',
      'temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code,sunrise,sunset',
    );

    try {
      const res = await globalThis.fetch(url, { signal });
      if (!res.ok) throw new Error(`Open-Meteo responded ${res.status}`);
      return {
        status: 'ok',
        data: mapOpenMeteo(await res.json()),
        fetchedAt: new Date().toISOString(),
      };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },
};
```

- [ ] **Step 5: Run the tests**

```bash
npm test && npm run check
```

Expected: 4 weather tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/sources/weatherCodes.ts src/sources/openMeteo.ts test/sources/openMeteo.test.ts test/fixtures/openMeteo.ts
git commit -m "feat: add Open-Meteo weather source"
```

---

### Task 7: Source runner with disk cache and stale fallback

**Files:**
- Create: `src/sources/cache.ts`, `src/sources/runner.ts`, `test/sources/runner.test.ts`

**Interfaces:**
- Consumes: `Source`, `SourceResult` from Task 5; `SourceHealth` from Task 4
- Produces:
  - `class SourceCache { constructor(dir: string); read<T>(key: string): Promise<CacheEntry<T> | null>; write<T>(key: string, data: T): Promise<void> }`
  - `type CacheEntry<T> = { data: T; fetchedAt: string }`
  - `runSource<C, D>(source: Source<C,D>, config: C, cache: SourceCache, timeoutMs: number): Promise<{ data: D | null; health: SourceHealth }>`

- [ ] **Step 1: Write the failing test**

Create `test/sources/runner.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceCache } from '../../src/sources/cache.ts';
import { runSource } from '../../src/sources/runner.ts';
import type { Source } from '../../src/sources/types.ts';

async function withCache(fn: (cache: SourceCache) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-'));
  try {
    await fn(new SourceCache(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const ok: Source<null, string> = {
  id: 'good',
  async fetch() {
    return { status: 'ok', data: 'fresh', fetchedAt: '2026-08-03T07:00:00.000Z' };
  },
};

const broken: Source<null, string> = {
  id: 'good', // same id so it reads the same cache key
  async fetch() {
    return { status: 'error', error: 'upstream exploded' };
  },
};

const hangs: Source<null, string> = {
  id: 'slow',
  fetch(_c, signal) {
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  },
};

test('reports ok and writes the cache on success', async () => {
  await withCache(async (cache) => {
    const result = await runSource(ok, null, cache, 1000);
    assert.equal(result.data, 'fresh');
    assert.equal(result.health.status, 'ok');
    assert.equal((await cache.read<string>('good'))?.data, 'fresh');
  });
});

test('falls back to cached data and reports stale', async () => {
  await withCache(async (cache) => {
    await runSource(ok, null, cache, 1000);
    const result = await runSource(broken, null, cache, 1000);
    assert.equal(result.data, 'fresh', 'serves the last good value');
    assert.equal(result.health.status, 'stale');
    assert.match(result.health.error ?? '', /exploded/);
  });
});

test('reports error when there is no cache to fall back on', async () => {
  await withCache(async (cache) => {
    const result = await runSource(broken, null, cache, 1000);
    assert.equal(result.data, null);
    assert.equal(result.health.status, 'error');
  });
});

test('times out a hanging source instead of blocking the render', async () => {
  await withCache(async (cache) => {
    const result = await runSource(hangs, null, cache, 50);
    assert.equal(result.health.status, 'error');
    assert.equal(result.data, null);
  });
});

test('never throws, whatever the source does', async () => {
  await withCache(async (cache) => {
    const explodes: Source<null, string> = {
      id: 'throws',
      async fetch() { throw new Error('unhandled'); },
    };
    const result = await runSource(explodes, null, cache, 1000);
    assert.equal(result.health.status, 'error');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- --test-name-pattern="reports ok and writes"
```

Expected: FAIL — cannot resolve `src/sources/cache.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/sources/cache.ts`:

```ts
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface CacheEntry<T> {
  data: T;
  fetchedAt: string;
}

/** Last-good values on disk, so a failed fetch degrades to stale rather than blank. */
export class SourceCache {
  constructor(private readonly dir: string) {}

  private path(key: string): string {
    return join(this.dir, `${key.replace(/[^a-z0-9_-]/gi, '_')}.json`);
  }

  async read<T>(key: string): Promise<CacheEntry<T> | null> {
    try {
      return JSON.parse(await readFile(this.path(key), 'utf8')) as CacheEntry<T>;
    } catch {
      return null;
    }
  }

  async write<T>(key: string, data: T): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const entry: CacheEntry<T> = { data, fetchedAt: new Date().toISOString() };
    const tmp = `${this.path(key)}.tmp`;
    await writeFile(tmp, JSON.stringify(entry), 'utf8');
    await rename(tmp, this.path(key));
  }
}
```

Create `src/sources/runner.ts`:

```ts
import type { SourceHealth } from '../model/dashboard.ts';
import type { SourceCache } from './cache.ts';
import type { Source } from './types.ts';

export interface RunOutcome<T> {
  data: T | null;
  health: SourceHealth;
}

/**
 * Run a source with a timeout, falling back to cached data on failure.
 * This function never rejects: a render must always be possible.
 */
export async function runSource<TConfig, TData>(
  source: Source<TConfig, TData>,
  config: TConfig,
  cache: SourceCache,
  timeoutMs: number,
): Promise<RunOutcome<TData>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let error: string;
  try {
    const result = await source.fetch(config, controller.signal);
    if (result.status === 'ok') {
      await cache.write(source.id, result.data);
      return {
        data: result.data,
        health: { id: source.id, status: 'ok', fetchedAt: result.fetchedAt, error: null },
      };
    }
    error = result.error;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
  }

  const cached = await cache.read<TData>(source.id);
  if (cached) {
    return {
      data: cached.data,
      health: { id: source.id, status: 'stale', fetchedAt: cached.fetchedAt, error },
    };
  }
  return {
    data: null,
    health: { id: source.id, status: 'error', fetchedAt: null, error },
  };
}
```

- [ ] **Step 4: Run the tests**

```bash
npm test && npm run check
```

Expected: 5 runner tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/sources/cache.ts src/sources/runner.ts test/sources/runner.test.ts
git commit -m "feat: add source runner with timeout and stale fallback"
```

---

### Task 8: Panel stylesheet and HTML template

Layout B: banner, four quadrants, footer. Two Spec 2 slots render as designed empty states from day one.

**Files:**
- Create: `src/render/fonts.ts`, `src/render/panel.css.ts`, `src/render/template.ts`
- Create: `test/render/template.test.ts`
- Modify: `package.json` (add font dependencies)

**Interfaces:**
- Consumes: `DashboardData` from Task 4, `PanelProfile` from Task 3
- Produces:
  - `loadFontCss(): Promise<string>` — `@font-face` rules with base64 `woff2` data URIs
  - `panelCss(profile: PanelProfile): string`
  - `renderHtml(data: DashboardData, profile: PanelProfile, fontCss: string): string`

- [ ] **Step 1: Add font dependencies**

Fonts are vendored through npm so there are no URLs to rot and no reliance on system fonts, which a container does not have.

```bash
npm install @fontsource/inter @fontsource/dela-gothic-one
```

- [ ] **Step 2: Write the failing test**

Create `test/render/template.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderHtml } from '../../src/render/template.ts';
import { panelCss } from '../../src/render/panel.css.ts';
import { WFT0583 } from '../../src/panel/profile.ts';
import type { DashboardData } from '../../src/model/dashboard.ts';

const data: DashboardData = {
  generatedAt: '2026-08-03T07:42:00.000Z',
  contentChangedAt: '2026-08-03T07:42:00.000Z',
  timezone: 'Europe/London',
  today: { iso: '2026-08-03', weekdayLong: 'Monday', dayOfMonth: 3, monthLong: 'August' },
  calendar: {
    today: [
      { uid: '1', title: 'Team standup', start: '2026-08-03T08:30:00.000Z', end: '2026-08-03T08:45:00.000Z', allDay: false },
    ],
    tomorrow: [],
  },
  weather: {
    currentTempC: 22, conditionText: 'Partly cloudy', highC: 24, lowC: 13,
    precipProbability: 10, windKph: 13, windDirection: 'NW',
    sunrise: '2026-08-03T05:34', sunset: '2026-08-03T20:47',
    forecast: [
      { weekday: 'TUE', highC: 24, lowC: 14, conditionText: 'Sunny' },
      { weekday: 'WED', highC: 19, lowC: 13, conditionText: 'Rain' },
      { weekday: 'THU', highC: 21, lowC: 12, conditionText: 'Overcast' },
    ],
  },
  sourceHealth: [
    { id: 'ical', status: 'ok', fetchedAt: '2026-08-03T07:42:00.000Z', error: null },
    { id: 'weather', status: 'ok', fetchedAt: '2026-08-03T07:42:00.000Z', error: null },
  ],
  battery: { volts: 4.02, percent: 87 },
};

test('renders the event and the temperature', () => {
  const html = renderHtml(data, WFT0583, '');
  assert.match(html, /Team standup/);
  assert.match(html, /22/);
  assert.match(html, /MONDAY 3/i);
});

test('escapes event titles', () => {
  const hostile = structuredClone(data);
  hostile.calendar!.today[0]!.title = '<script>alert(1)</script>';
  const html = renderHtml(hostile, WFT0583, '');
  assert.ok(!html.includes('<script>alert(1)</script>'), 'must not inject raw markup');
  assert.match(html, /&lt;script&gt;/);
});

test('renders an unavailable state when a source has no data', () => {
  const broken = structuredClone(data);
  broken.weather = null;
  broken.sourceHealth = [{ id: 'weather', status: 'error', fetchedAt: null, error: 'timeout' }];
  const html = renderHtml(broken, WFT0583, '');
  assert.match(html, /slot--empty/, 'the weather card falls back to the empty state');
  assert.doesNotMatch(html, /NaN|undefined|null/, 'no leaked placeholder values');
});

test('shows a stale marker but keeps the data', () => {
  const stale = structuredClone(data);
  stale.sourceHealth = [{ id: 'weather', status: 'stale', fetchedAt: '2026-08-03T04:10:00.000Z', error: 'timeout' }];
  const html = renderHtml(stale, WFT0583, '');
  assert.match(html, /Partly cloudy/, 'stale data is still shown');
  assert.match(html, /04:10/, 'with its age');
});

test('the stylesheet contains no greys', () => {
  const css = panelCss(WFT0583);
  assert.doesNotMatch(css, /rgba?\(/i, 'no rgb/rgba colours');
  assert.doesNotMatch(css, /opacity\s*:/i, 'no opacity');
  const hexes = css.match(/#[0-9a-f]{3,6}/gi) ?? [];
  const allowed = new Set(['#000', '#fff', '#000000', '#ffffff']);
  for (const hex of hexes) {
    assert.ok(allowed.has(hex.toLowerCase()), `${hex} is not pure black or white`);
  }
});

test('the page is locked to the profile size', () => {
  const css = panelCss(WFT0583);
  assert.match(css, /width:\s*800px/);
  assert.match(css, /height:\s*480px/);
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
npm test -- --test-name-pattern="renders the event"
```

Expected: FAIL — cannot resolve `src/render/template.ts`.

- [ ] **Step 4: Write the font loader**

Create `src/render/fonts.ts`:

```ts
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

/**
 * Find a woff2 in a @fontsource package by matching on filename fragments.
 * Matching rather than hardcoding keeps this working across fontsource
 * releases, which have changed their file naming before.
 */
async function findFont(pkg: string, mustInclude: string[]): Promise<Buffer> {
  const filesDir = join(dirname(require.resolve(`${pkg}/package.json`)), 'files');
  const entries = await readdir(filesDir);
  const match = entries.find(
    (f) => f.endsWith('.woff2') && mustInclude.every((frag) => f.includes(frag)),
  );
  if (!match) {
    throw new Error(`no woff2 in ${pkg} matching ${mustInclude.join('+')}; found: ${entries.join(', ')}`);
  }
  return readFile(join(filesDir, match));
}

function face(family: string, weight: number, data: Buffer): string {
  return `@font-face{font-family:"${family}";font-style:normal;font-weight:${weight};` +
    `src:url(data:font/woff2;base64,${data.toString('base64')}) format("woff2");}`;
}

/**
 * Fonts are embedded as data URIs because the container has no system fonts.
 * Omit this and the preview looks perfect while the panel renders in a
 * fallback face.
 */
export async function loadFontCss(): Promise<string> {
  const [display, regular, semibold, bold] = await Promise.all([
    findFont('@fontsource/dela-gothic-one', ['latin', '400']),
    findFont('@fontsource/inter', ['latin', '400']),
    findFont('@fontsource/inter', ['latin', '600']),
    findFont('@fontsource/inter', ['latin', '700']),
  ]);
  return [
    face('Dela Gothic One', 400, display),
    face('Inter', 400, regular),
    face('Inter', 600, semibold),
    face('Inter', 700, bold),
  ].join('');
}
```

- [ ] **Step 5: Write the stylesheet**

Create `src/render/panel.css.ts`:

```ts
import type { PanelProfile } from '../panel/profile.ts';

/**
 * Only #000 and #fff are permitted. Thresholding a page that is already pure
 * black and white is lossless; any grey is a gamble on which side of the
 * threshold it lands. Anything that should read as dimmed uses a hatch.
 */
export function panelCss(profile: PanelProfile): string {
  return `
*{margin:0;padding:0;box-sizing:border-box;}
html,body{width:${profile.width}px;height:${profile.height}px;overflow:hidden;background:#fff;color:#000;}
body{font-family:"Inter",sans-serif;-webkit-font-smoothing:none;text-rendering:geometricPrecision;}
.disp{font-family:"Dela Gothic One",sans-serif;letter-spacing:-0.02em;}
.tnum{font-variant-numeric:tabular-nums;}

.banner{height:132px;padding:18px 26px;display:flex;justify-content:space-between;align-items:flex-start;}
.banner-date .d1{font-size:66px;line-height:0.92;}
.banner-date .d2{font-size:30px;line-height:1;}
.banner-wx{display:flex;gap:18px;align-items:flex-start;}
.banner-wx .detail{font-size:13px;line-height:1.65;text-align:right;padding-top:6px;}
.banner-wx .temp{font-size:72px;line-height:0.9;text-align:right;}
.banner-wx .cond{font-size:15px;font-weight:700;text-align:right;}

.rule{background:#000;height:3px;}
.grid{height:311px;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;}
.cell{padding:16px 24px;position:relative;}
.cell--tl{border-right:2px solid #000;border-bottom:2px solid #000;}
.cell--tr{border-bottom:2px solid #000;}
.cell--bl{border-right:2px solid #000;}

.label{font-size:11px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:12px;}
.stale{font-size:10px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;border:1px solid #000;padding:1px 4px;margin-left:6px;}

.events{display:flex;flex-direction:column;gap:11px;font-size:18px;}
.event{display:flex;gap:12px;align-items:baseline;}
.event .t{width:74px;font-weight:700;}
.event .n{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}

.days{display:flex;gap:22px;font-size:14px;text-align:center;}
.days .w{font-weight:800;}
.days .t{font-size:30px;margin:6px 0;}
.sun{font-size:13px;margin-top:16px;}

/* Dimmed appearance without greys: a 45-degree hatch of pure black on white. */
.slot--empty{
  position:absolute;inset:14px 24px;border:2px solid #000;
  display:flex;align-items:center;justify-content:center;
  font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;
  background-image:repeating-linear-gradient(45deg,#000 0 1px,#fff 1px 7px);
}
.slot--empty span{background:#fff;padding:4px 10px;border:1px solid #000;}

.footer{height:34px;border-top:2px solid #000;padding:9px 26px;display:flex;justify-content:space-between;
  font-size:11px;letter-spacing:0.08em;text-transform:uppercase;}
`.trim();
}
```

- [ ] **Step 6: Write the template**

Create `src/render/template.ts`:

```ts
import type { DashboardData, CalendarEvent } from '../model/dashboard.ts';
import type { PanelProfile } from '../panel/profile.ts';
import { panelCss } from './panel.css.ts';

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function hhmm(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso));
}

/** Open-Meteo returns naive local times like "2026-08-03T20:47". */
function clockOnly(value: string): string {
  return value.includes('T') ? value.slice(11, 16) : value;
}

function staleBadge(data: DashboardData, id: string): string {
  const health = data.sourceHealth.find((s) => s.id === id);
  if (health?.status !== 'stale' || !health.fetchedAt) return '';
  return `<span class="stale">from ${hhmm(health.fetchedAt, data.timezone)}</span>`;
}

function emptySlot(caption: string): string {
  return `<div class="slot--empty"><span>${esc(caption)}</span></div>`;
}

function eventRow(event: CalendarEvent, timezone: string): string {
  const time = event.allDay ? 'ALL DAY' : hhmm(event.start, timezone);
  return `<div class="event"><span class="t tnum">${esc(time)}</span><span class="n">${esc(event.title)}</span></div>`;
}

function agendaCell(data: DashboardData): string {
  const events = data.calendar?.today ?? [];
  if (!data.calendar) return emptySlot('Calendar unavailable');
  if (events.length === 0) return emptySlot('Nothing scheduled');
  return `<div class="events">${events.slice(0, 6).map((e) => eventRow(e, data.timezone)).join('')}</div>`;
}

function forecastCell(data: DashboardData): string {
  const weather = data.weather;
  if (!weather) return emptySlot('Weather unavailable');
  const days = weather.forecast
    .map((d) => `<div><div class="w">${esc(d.weekday)}</div><div class="t disp">${d.highC}&deg;</div><div>${esc(d.conditionText)}</div></div>`)
    .join('');
  return `<div class="days">${days}</div>
    <div class="sun tnum">Sunrise ${esc(clockOnly(weather.sunrise))} &middot; Sunset ${esc(clockOnly(weather.sunset))}</div>`;
}

function banner(data: DashboardData): string {
  const weather = data.weather;
  const wx = weather
    ? `<div class="banner-wx">
         <div class="detail tnum">H ${weather.highC}&deg; &nbsp; L ${weather.lowC}&deg;<br>Rain ${weather.precipProbability}%<br>${esc(weather.windDirection)} ${weather.windKph}kph</div>
         <div><div class="temp disp">${weather.currentTempC}&deg;</div><div class="cond">${esc(weather.conditionText)}</div></div>
       </div>`
    : `<div class="banner-wx"><div class="cond">Weather unavailable</div></div>`;

  return `<div class="banner">
    <div class="banner-date">
      <div class="d1 disp">${esc(data.today.weekdayLong.slice(0, 3).toUpperCase())} ${data.today.dayOfMonth}</div>
      <div class="d2 disp">${esc(data.today.monthLong.toUpperCase())}</div>
    </div>
    ${wx}
  </div>`;
}

export function renderHtml(data: DashboardData, profile: PanelProfile, fontCss: string): string {
  const battery = data.battery.percent === null ? 'Battery --' : `Battery ${data.battery.percent}%`;
  const changed = hhmm(data.contentChangedAt, data.timezone);

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<style>${fontCss}${panelCss(profile)}</style></head><body>
${banner(data)}
<div class="rule"></div>
<div class="grid">
  <div class="cell cell--tl">
    <div class="label">Today${staleBadge(data, 'ical')}</div>
    ${agendaCell(data)}
  </div>
  <div class="cell cell--tr">
    <div class="label">Next 3 days${staleBadge(data, 'weather')}</div>
    ${forecastCell(data)}
  </div>
  <div class="cell cell--bl">${emptySlot('Transport — coming soon')}</div>
  <div class="cell cell--br">${emptySlot('Bins & tasks — coming soon')}</div>
</div>
<div class="footer"><span class="tnum">Updated ${esc(changed)}</span><span>${esc(battery)}</span></div>
</body></html>`;
}
```

- [ ] **Step 7: Run the tests**

```bash
npm test && npm run check
```

Expected: 6 template tests pass, including the no-greys guard.

- [ ] **Step 8: Commit**

```bash
git add src/render package.json package-lock.json test/render
git commit -m "feat: add panel stylesheet and layout B template"
```

---

### Task 9: Chromium renderer

**Files:**
- Create: `src/render/browser.ts`, `test/render/browser.test.ts`

**Interfaces:**
- Consumes: `PanelProfile` from Task 3
- Produces:
  - `class Renderer { screenshot(html: string, profile: PanelProfile): Promise<Buffer>; close(): Promise<void> }`

- [ ] **Step 1: Write the failing test**

Create `test/render/browser.test.ts`:

```ts
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { Renderer } from '../../src/render/browser.ts';
import { WFT0583 } from '../../src/panel/profile.ts';

const renderer = new Renderer();
after(() => renderer.close());

test('screenshots at exactly the profile size', async () => {
  const png = await renderer.screenshot('<html><body></body></html>', WFT0583);
  const meta = await sharp(png).metadata();
  assert.equal(meta.width, 800);
  assert.equal(meta.height, 480);
});

test('reuses one browser across renders', async () => {
  const a = await renderer.screenshot('<html><body>A</body></html>', WFT0583);
  const b = await renderer.screenshot('<html><body>B</body></html>', WFT0583);
  assert.ok(a.length > 0 && b.length > 0);
  assert.notDeepEqual(a, b, 'different content must produce different pixels');
});

test('renders identical HTML deterministically', async () => {
  const html = '<html><body><h1>Same</h1></body></html>';
  const a = await renderer.screenshot(html, WFT0583);
  const b = await renderer.screenshot(html, WFT0583);
  assert.deepEqual(a, b, 'non-determinism here would make golden tests useless');
});
```

- [ ] **Step 2: Install the browser binary and run the test**

```bash
npx playwright install chromium
npm test -- --test-name-pattern="screenshots at exactly"
```

Expected: FAIL — cannot resolve `src/render/browser.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/render/browser.ts`:

```ts
import { chromium, type Browser } from 'playwright';
import type { PanelProfile } from '../panel/profile.ts';

/**
 * One long-lived Chromium instance. Launching per render wastes several
 * hundred milliseconds and churns memory; the panel refreshes often enough
 * for that to matter.
 */
export class Renderer {
  private browser: Browser | null = null;

  private async ensure(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    this.browser = await chromium.launch({
      // Required in most container configurations.
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
    });
    return this.browser;
  }

  async screenshot(html: string, profile: PanelProfile): Promise<Buffer> {
    const browser = await this.ensure();
    const context = await browser.newContext({
      viewport: { width: profile.width, height: profile.height },
      deviceScaleFactor: 1,
      // Deterministic output: no animations, fixed scrollbars.
      reducedMotion: 'reduce',
    });
    try {
      const page = await context.newPage();
      await page.setContent(html, { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);
      return await page.screenshot({ type: 'png', animations: 'disabled' });
    } finally {
      await context.close();
    }
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = null;
  }
}
```

- [ ] **Step 4: Run the tests**

```bash
npm test && npm run check
```

Expected: 3 browser tests pass. These are slower than the rest — several seconds is normal.

- [ ] **Step 5: Commit**

```bash
git add src/render/browser.ts test/render/browser.test.ts
git commit -m "feat: add long-lived Chromium renderer"
```

---

### Task 10: Device registry

**Files:**
- Create: `src/devices/types.ts`, `src/devices/store.ts`, `test/devices/store.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `interface DeviceRecord { id, name, claimed, timezone, latitude, longitude, calendarUrls, panelProfileId, quietHoursStart, quietHoursEnd, activeIntervalSeconds, lowBatteryIntervalSeconds, lowBatteryVolts, unclaimedIntervalSeconds, lastSeenAt, lastBatteryVolts, lastEtag, lastFirmwareVersion }`
  - `defaultDevice(id: string): DeviceRecord`
  - `class DeviceStore { constructor(path: string); list(): Promise<DeviceRecord[]>; get(id): Promise<DeviceRecord | null>; getOrCreate(id): Promise<DeviceRecord>; update(id, patch): Promise<DeviceRecord> }`

- [ ] **Step 1: Write the failing test**

Create `test/devices/store.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceStore } from '../../src/devices/store.ts';

async function withStore(fn: (store: DeviceStore, path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-dev-'));
  const path = join(dir, 'config.json');
  try {
    await fn(new DeviceStore(path), path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('creates an unclaimed device on first sight', async () => {
  await withStore(async (store) => {
    const device = await store.getOrCreate('esp32-a1b2c3');
    assert.equal(device.id, 'esp32-a1b2c3');
    assert.equal(device.claimed, false);
    assert.equal(device.panelProfileId, 'wft0583-800x480-mono');
  });
});

test('returns the same record on second sight', async () => {
  await withStore(async (store) => {
    const first = await store.getOrCreate('esp32-a1b2c3');
    await store.update('esp32-a1b2c3', { name: 'Desk panel', claimed: true });
    const second = await store.getOrCreate('esp32-a1b2c3');
    assert.equal(second.name, 'Desk panel');
    assert.equal(second.claimed, true);
    assert.equal(second.id, first.id);
  });
});

test('persists across instances', async () => {
  await withStore(async (store, path) => {
    await store.getOrCreate('esp32-a1b2c3');
    await store.update('esp32-a1b2c3', { name: 'Kitchen' });
    const reopened = new DeviceStore(path);
    assert.equal((await reopened.get('esp32-a1b2c3'))?.name, 'Kitchen');
  });
});

test('writes valid JSON atomically', async () => {
  await withStore(async (store, path) => {
    await store.getOrCreate('esp32-a1b2c3');
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    assert.ok(Array.isArray(parsed.devices));
  });
});

test('returns null for an unknown device without creating it', async () => {
  await withStore(async (store) => {
    assert.equal(await store.get('nope'), null);
    assert.deepEqual(await store.list(), []);
  });
});

test('rejects updates to unknown devices', async () => {
  await withStore(async (store) => {
    await assert.rejects(() => store.update('ghost', { name: 'x' }), /unknown device/i);
  });
});

test('serialises concurrent writes without losing one', async () => {
  await withStore(async (store) => {
    await store.getOrCreate('a');
    await store.getOrCreate('b');
    await Promise.all([
      store.update('a', { name: 'Alpha' }),
      store.update('b', { name: 'Bravo' }),
    ]);
    assert.equal((await store.get('a'))?.name, 'Alpha');
    assert.equal((await store.get('b'))?.name, 'Bravo');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- --test-name-pattern="creates an unclaimed device"
```

Expected: FAIL — cannot resolve `src/devices/store.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/devices/types.ts`:

```ts
export interface DeviceRecord {
  id: string;
  name: string;
  claimed: boolean;

  timezone: string;
  latitude: number;
  longitude: number;
  calendarUrls: string[];
  panelProfileId: string;

  /** Local hour, 0-23, when quiet hours begin and end. */
  quietHoursStart: number;
  quietHoursEnd: number;
  activeIntervalSeconds: number;
  lowBatteryIntervalSeconds: number;
  lowBatteryVolts: number;
  unclaimedIntervalSeconds: number;

  lastSeenAt: string | null;
  lastBatteryVolts: number | null;
  lastEtag: string | null;
  lastFirmwareVersion: string | null;
}

export function defaultDevice(id: string): DeviceRecord {
  return {
    id,
    name: 'Unnamed panel',
    claimed: false,
    timezone: 'Europe/London',
    latitude: 52.04,
    longitude: -0.76,
    calendarUrls: [],
    panelProfileId: 'wft0583-800x480-mono',
    quietHoursStart: 23,
    quietHoursEnd: 6,
    activeIntervalSeconds: 900,
    lowBatteryIntervalSeconds: 21600,
    lowBatteryVolts: 3.5,
    unclaimedIntervalSeconds: 60,
    lastSeenAt: null,
    lastBatteryVolts: null,
    lastEtag: null,
    lastFirmwareVersion: null,
  };
}
```

Create `src/devices/store.ts`:

```ts
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { defaultDevice, type DeviceRecord } from './types.ts';

interface StoreFile {
  devices: DeviceRecord[];
}

/**
 * A JSON file written atomically. Chosen over SQLite because writes are rare,
 * one process owns it, and it stays human-readable and diffable.
 */
export class DeviceStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  private async read(): Promise<StoreFile> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as StoreFile;
      return { devices: parsed.devices ?? [] };
    } catch {
      return { devices: [] };
    }
  }

  private async write(file: StoreFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(file, null, 2), 'utf8');
    await rename(tmp, this.path);
  }

  /** Serialise mutations so concurrent updates cannot clobber each other. */
  private mutate<T>(fn: (file: StoreFile) => Promise<T> | T): Promise<T> {
    const next = this.queue.then(async () => {
      const file = await this.read();
      const result = await fn(file);
      await this.write(file);
      return result;
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  async list(): Promise<DeviceRecord[]> {
    return (await this.read()).devices;
  }

  async get(id: string): Promise<DeviceRecord | null> {
    return (await this.read()).devices.find((d) => d.id === id) ?? null;
  }

  async getOrCreate(id: string): Promise<DeviceRecord> {
    return this.mutate((file) => {
      const existing = file.devices.find((d) => d.id === id);
      if (existing) return existing;
      const created = defaultDevice(id);
      file.devices.push(created);
      return created;
    });
  }

  async update(id: string, patch: Partial<DeviceRecord>): Promise<DeviceRecord> {
    return this.mutate((file) => {
      const index = file.devices.findIndex((d) => d.id === id);
      if (index === -1) throw new Error(`unknown device: ${id}`);
      const updated = { ...file.devices[index]!, ...patch, id };
      file.devices[index] = updated;
      return updated;
    });
  }
}

export { defaultDevice };
export type { DeviceRecord };
```

- [ ] **Step 4: Run the tests**

```bash
npm test && npm run check
```

Expected: 7 store tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/devices test/devices
git commit -m "feat: add atomic JSON device registry"
```

---

### Task 11: Wake scheduling

**Files:**
- Create: `src/schedule/nextWake.ts`, `test/schedule/nextWake.test.ts`

**Interfaces:**
- Consumes: `DeviceRecord`, `defaultDevice` from Task 10
- Produces:
  - `interface WakeInput { now: Date; device: DeviceRecord; batteryVolts: number | null }`
  - `nextWakeSeconds(input: WakeInput): number`
  - `MIN_WAKE_SECONDS = 60`

- [ ] **Step 1: Write the failing test**

Create `test/schedule/nextWake.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextWakeSeconds, MIN_WAKE_SECONDS } from '../../src/schedule/nextWake.ts';
import { defaultDevice } from '../../src/devices/types.ts';

const claimed = { ...defaultDevice('esp32-test'), claimed: true };

// 12:00 UTC = 13:00 London (BST), comfortably inside the active window.
const midday = new Date('2026-08-03T12:00:00.000Z');
// 00:30 UTC = 01:30 London, inside quiet hours (23:00-06:00).
const night = new Date('2026-08-03T00:30:00.000Z');

test('unclaimed devices poll quickly so enrolment feels responsive', () => {
  const device = { ...claimed, claimed: false };
  assert.equal(nextWakeSeconds({ now: midday, device, batteryVolts: 4.0 }), 60);
});

test('uses the active interval during the day', () => {
  assert.equal(nextWakeSeconds({ now: midday, device: claimed, batteryVolts: 4.0 }), 900);
});

test('low battery wins over everything except enrolment', () => {
  assert.equal(nextWakeSeconds({ now: midday, device: claimed, batteryVolts: 3.4 }), 21600);
});

test('sleeps until the quiet window ends', () => {
  const seconds = nextWakeSeconds({ now: night, device: claimed, batteryVolts: 4.0 });
  // 01:30 London to 06:00 London is 4h30m.
  assert.equal(seconds, 4 * 3600 + 30 * 60);
});

test('an unknown battery does not trigger low-battery backoff', () => {
  assert.equal(nextWakeSeconds({ now: midday, device: claimed, batteryVolts: null }), 900);
});

test('never returns less than the floor', () => {
  const device = { ...claimed, activeIntervalSeconds: 5 };
  assert.equal(nextWakeSeconds({ now: midday, device, batteryVolts: 4.0 }), MIN_WAKE_SECONDS);
});

test('always returns a positive whole number of seconds', () => {
  for (let hour = 0; hour < 24; hour++) {
    const now = new Date(`2026-08-03T${String(hour).padStart(2, '0')}:00:00.000Z`);
    const seconds = nextWakeSeconds({ now, device: claimed, batteryVolts: 4.0 });
    assert.ok(Number.isInteger(seconds) && seconds > 0, `hour ${hour} produced ${seconds}`);
    assert.ok(seconds <= 24 * 3600, `hour ${hour} produced ${seconds}`);
  }
});

test('survives the autumn DST transition without a negative interval', () => {
  // 25 October 2026, the UK falls back. 01:30 UTC is ambiguous locally.
  const dst = new Date('2026-10-25T01:30:00.000Z');
  const seconds = nextWakeSeconds({ now: dst, device: claimed, batteryVolts: 4.0 });
  assert.ok(seconds > 0 && seconds <= 24 * 3600);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- --test-name-pattern="uses the active interval"
```

Expected: FAIL — cannot resolve `src/schedule/nextWake.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/schedule/nextWake.ts`:

```ts
import type { DeviceRecord } from '../devices/types.ts';

export const MIN_WAKE_SECONDS = 60;
const DAY_SECONDS = 24 * 3600;

export interface WakeInput {
  now: Date;
  device: DeviceRecord;
  batteryVolts: number | null;
}

interface LocalClock {
  hour: number;
  minute: number;
  second: number;
}

function localClock(now: Date, timezone: string): LocalClock {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const num = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  // en-GB renders midnight as "24" in some ICU versions.
  return { hour: num('hour') % 24, minute: num('minute'), second: num('second') };
}

function inQuietHours(clock: LocalClock, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end
    ? clock.hour >= start && clock.hour < end
    : clock.hour >= start || clock.hour < end; // window crosses midnight
}

function secondsUntilHour(clock: LocalClock, hour: number): number {
  const nowSeconds = clock.hour * 3600 + clock.minute * 60 + clock.second;
  const targetSeconds = hour * 3600;
  const delta = targetSeconds - nowSeconds;
  return delta > 0 ? delta : delta + DAY_SECONDS;
}

/**
 * Decide how long the device should sleep. Rules are evaluated in order.
 *
 * Around a DST transition this can be an hour out for a single wake, because
 * it works in local wall-clock time rather than absolute offsets. That is an
 * accepted trade for keeping the arithmetic comprehensible.
 */
export function nextWakeSeconds({ now, device, batteryVolts }: WakeInput): number {
  const clamp = (seconds: number) =>
    Math.max(MIN_WAKE_SECONDS, Math.min(DAY_SECONDS, Math.round(seconds)));

  if (!device.claimed) return clamp(device.unclaimedIntervalSeconds);

  if (batteryVolts !== null && batteryVolts < device.lowBatteryVolts) {
    return clamp(device.lowBatteryIntervalSeconds);
  }

  const clock = localClock(now, device.timezone);
  if (inQuietHours(clock, device.quietHoursStart, device.quietHoursEnd)) {
    return clamp(secondsUntilHour(clock, device.quietHoursEnd));
  }

  return clamp(device.activeIntervalSeconds);
}
```

- [ ] **Step 4: Run the tests**

```bash
npm test && npm run check
```

Expected: 8 scheduling tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/schedule test/schedule
git commit -m "feat: add server-side wake scheduling"
```

---

### Task 12: Frame service

The piece that ties data, rendering and caching together — and the place where Chromium is skipped when nothing changed.

**Files:**
- Create: `src/devices/battery.ts`, `src/render/enrolment.ts`, `src/render/frameService.ts`
- Create: `test/render/frameService.test.ts`

**Interfaces:**
- Consumes: `runSource`/`SourceCache` (Task 7), `icalSource` (Task 5), `openMeteoSource` (Task 6), `renderHtml` (Task 8), `Renderer` (Task 9), `DeviceRecord` (Task 10), `quantisePng`/`PROFILES` (Task 3), `contentHash` (Task 4)
- Produces:
  - `batteryPercent(volts: number | null): number | null`
  - `renderEnrolmentHtml(device: DeviceRecord, baseUrl: string, profile: PanelProfile, fontCss: string): string`
  - `interface Frame { buffer: Buffer; etag: string; renderedAt: string }`
  - `class FrameService { constructor(deps: FrameDeps); frameFor(device: DeviceRecord, batteryVolts: number | null): Promise<Frame>; enrolmentFrame(device: DeviceRecord, baseUrl: string): Promise<Frame>; previewHtml(device: DeviceRecord): Promise<string> }`

- [ ] **Step 1: Write the failing test**

Create `test/render/frameService.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FrameService } from '../../src/render/frameService.ts';
import { batteryPercent } from '../../src/devices/battery.ts';
import { SourceCache } from '../../src/sources/cache.ts';
import { Renderer } from '../../src/render/browser.ts';
import { defaultDevice } from '../../src/devices/types.ts';
import { WFT0583 } from '../../src/panel/profile.ts';

test('maps battery volts to a percentage', () => {
  assert.equal(batteryPercent(4.2), 100);
  assert.equal(batteryPercent(3.3), 0);
  assert.equal(batteryPercent(5.0), 100, 'clamped');
  assert.equal(batteryPercent(2.0), 0, 'clamped');
  assert.equal(batteryPercent(null), null);
  assert.equal(batteryPercent(0), null, 'no battery connected reads as zero');
});

test('produces a full-size buffer and skips Chromium when nothing changed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-frame-'));
  const renderer = new Renderer();
  let screenshots = 0;
  const counting = {
    screenshot: (html: string) => { screenshots++; return renderer.screenshot(html, WFT0583); },
    close: () => renderer.close(),
  };

  try {
    const service = new FrameService({
      renderer: counting as unknown as Renderer,
      cache: new SourceCache(dir),
      // Stub the sources so the test never touches the network.
      fetchData: async () => ({
        calendar: { today: [], tomorrow: [] },
        weather: null,
        sourceHealth: [{ id: 'ical', status: 'ok' as const, fetchedAt: '2026-08-03T07:00:00.000Z', error: null }],
      }),
    });

    const device = { ...defaultDevice('esp32-test'), claimed: true };
    const first = await service.frameFor(device, 4.0);
    assert.equal(first.buffer.length, 48000);
    assert.match(first.etag, /^[0-9a-f]{32}$/);
    assert.equal(screenshots, 1);

    const second = await service.frameFor(device, 4.0);
    assert.equal(second.etag, first.etag, 'unchanged content keeps its ETag');
    assert.equal(screenshots, 1, 'Chromium must not run again');
  } finally {
    await renderer.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('renders an enrolment frame in the normal format', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-enrol-'));
  const renderer = new Renderer();
  try {
    const service = new FrameService({
      renderer,
      cache: new SourceCache(dir),
      fetchData: async () => { throw new Error('sources must not be called for enrolment'); },
    });
    const frame = await service.enrolmentFrame(defaultDevice('esp32-a1b2c3'), 'http://192.168.1.20:8080');
    assert.equal(frame.buffer.length, 48000, 'firmware needs no special case');
    assert.match(frame.etag, /^[0-9a-f]{32}$/);
  } finally {
    await renderer.close();
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- --test-name-pattern="maps battery volts"
```

Expected: FAIL — cannot resolve `src/devices/battery.ts`.

- [ ] **Step 3: Write the battery mapping**

Create `src/devices/battery.ts`:

```ts
const EMPTY_VOLTS = 3.3;
const FULL_VOLTS = 4.2;

/**
 * Crude linear mapping of a single LiPo cell. A real discharge curve is not
 * linear, but the panel only shows a rounded percentage and the value is
 * advisory. Zero means no battery is connected, not a flat one.
 */
export function batteryPercent(volts: number | null): number | null {
  if (volts === null || volts <= 0) return null;
  const ratio = (volts - EMPTY_VOLTS) / (FULL_VOLTS - EMPTY_VOLTS);
  return Math.round(Math.max(0, Math.min(1, ratio)) * 100);
}
```

- [ ] **Step 4: Write the enrolment template**

Create `src/render/enrolment.ts`:

```ts
import type { DeviceRecord } from '../devices/types.ts';
import type { PanelProfile } from '../panel/profile.ts';

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Setup instructions rendered onto the panel itself. Black and white only. */
export function renderEnrolmentHtml(
  device: DeviceRecord,
  baseUrl: string,
  profile: PanelProfile,
  fontCss: string,
): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${fontCss}
*{margin:0;padding:0;box-sizing:border-box;}
html,body{width:${profile.width}px;height:${profile.height}px;background:#fff;color:#000;overflow:hidden;}
body{font-family:"Inter",sans-serif;-webkit-font-smoothing:none;display:flex;align-items:center;justify-content:center;}
.card{border:4px solid #000;padding:44px 56px;text-align:center;}
h1{font-family:"Dela Gothic One",sans-serif;font-size:52px;letter-spacing:-0.02em;margin-bottom:18px;}
p{font-size:22px;line-height:1.5;}
.url{font-size:30px;font-weight:700;margin:22px 0;border-top:2px solid #000;border-bottom:2px solid #000;padding:14px 0;}
.id{font-size:16px;letter-spacing:0.1em;text-transform:uppercase;}
</style></head><body>
<div class="card">
  <h1>NEW PANEL</h1>
  <p>Open this address to set me up</p>
  <div class="url">${esc(baseUrl)}</div>
  <p class="id">Device ID: ${esc(device.id)}</p>
</div>
</body></html>`;
}
```

- [ ] **Step 5: Write the frame service**

Create `src/render/frameService.ts`:

```ts
import { createHash } from 'node:crypto';
import type { CalendarData, DashboardData, SourceHealth, WeatherData } from '../model/dashboard.ts';
import { contentHash } from '../model/hash.ts';
import { PROFILES, WFT0583, type PanelProfile } from '../panel/profile.ts';
import { quantisePng } from '../panel/quantise.ts';
import { batteryPercent } from '../devices/battery.ts';
import type { DeviceRecord } from '../devices/types.ts';
import { icalSource } from '../sources/ical.ts';
import { openMeteoSource } from '../sources/openMeteo.ts';
import { runSource } from '../sources/runner.ts';
import type { SourceCache } from '../sources/cache.ts';
import type { Renderer } from './browser.ts';
import { renderEnrolmentHtml } from './enrolment.ts';
import { renderHtml } from './template.ts';
import { loadFontCss } from './fonts.ts';

const SOURCE_TIMEOUT_MS = 8000;

export interface SourceBundle {
  calendar: CalendarData | null;
  weather: WeatherData | null;
  sourceHealth: SourceHealth[];
}

export interface FrameDeps {
  renderer: Renderer;
  cache: SourceCache;
  /** Overridable so tests never touch the network. */
  fetchData?: (device: DeviceRecord) => Promise<SourceBundle>;
}

export interface Frame {
  buffer: Buffer;
  etag: string;
  renderedAt: string;
}

interface Memo {
  hash: string;
  frame: Frame;
  contentChangedAt: string;
}

export class FrameService {
  private readonly memo = new Map<string, Memo>();
  private fontCssPromise: Promise<string> | null = null;

  constructor(private readonly deps: FrameDeps) {}

  private fontCss(): Promise<string> {
    this.fontCssPromise ??= loadFontCss();
    return this.fontCssPromise;
  }

  private profileFor(device: DeviceRecord): PanelProfile {
    return PROFILES[device.panelProfileId] ?? WFT0583;
  }

  private async fetchAll(device: DeviceRecord): Promise<SourceBundle> {
    if (this.deps.fetchData) return this.deps.fetchData(device);

    const [calendar, weather] = await Promise.all([
      runSource(icalSource, { urls: device.calendarUrls, timezone: device.timezone }, this.deps.cache, SOURCE_TIMEOUT_MS),
      runSource(openMeteoSource, { latitude: device.latitude, longitude: device.longitude, timezone: device.timezone }, this.deps.cache, SOURCE_TIMEOUT_MS),
    ]);

    return {
      calendar: calendar.data,
      weather: weather.data,
      sourceHealth: [calendar.health, weather.health],
    };
  }

  private buildData(device: DeviceRecord, bundle: SourceBundle, batteryVolts: number | null, contentChangedAt: string): DashboardData {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: device.timezone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    }).formatToParts(now);
    const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';

    return {
      generatedAt: now.toISOString(),
      contentChangedAt,
      timezone: device.timezone,
      today: {
        iso: now.toISOString().slice(0, 10),
        weekdayLong: part('weekday'),
        dayOfMonth: Number(part('day')),
        monthLong: part('month'),
      },
      calendar: bundle.calendar,
      weather: bundle.weather,
      sourceHealth: bundle.sourceHealth,
      battery: { volts: batteryVolts, percent: batteryPercent(batteryVolts) },
    };
  }

  private async rasterise(html: string, profile: PanelProfile): Promise<Frame> {
    const png = await this.deps.renderer.screenshot(html, profile);
    const buffer = await quantisePng(png, profile);
    return {
      buffer,
      etag: createHash('sha256').update(buffer).digest('hex').slice(0, 32),
      renderedAt: new Date().toISOString(),
    };
  }

  /** Build the device's frame, re-rendering only when visible content changed. */
  async frameFor(device: DeviceRecord, batteryVolts: number | null): Promise<Frame> {
    const bundle = await this.fetchAll(device);
    const previous = this.memo.get(device.id);
    const provisional = this.buildData(device, bundle, batteryVolts, previous?.contentChangedAt ?? new Date().toISOString());
    const hash = contentHash(provisional);

    if (previous && previous.hash === hash) return previous.frame;

    const contentChangedAt = new Date().toISOString();
    const data = { ...provisional, contentChangedAt };
    const profile = this.profileFor(device);
    const frame = await this.rasterise(renderHtml(data, profile, await this.fontCss()), profile);

    this.memo.set(device.id, { hash, frame, contentChangedAt });
    return frame;
  }

  async enrolmentFrame(device: DeviceRecord, baseUrl: string): Promise<Frame> {
    const profile = this.profileFor(device);
    return this.rasterise(renderEnrolmentHtml(device, baseUrl, profile, await this.fontCss()), profile);
  }

  /** The HTML behind /preview, for iterating on layout in a browser. */
  async previewHtml(device: DeviceRecord): Promise<string> {
    const bundle = await this.fetchAll(device);
    const data = this.buildData(device, bundle, device.lastBatteryVolts, new Date().toISOString());
    return renderHtml(data, this.profileFor(device), await this.fontCss());
  }
}
```

- [ ] **Step 6: Run the tests**

```bash
npm test && npm run check
```

Expected: 3 frame-service tests pass, including the assertion that Chromium runs only once.

- [ ] **Step 7: Commit**

```bash
git add src/devices/battery.ts src/render/enrolment.ts src/render/frameService.ts test/render/frameService.test.ts
git commit -m "feat: add frame service with content-aware render caching"
```

---

### Task 13: Device HTTP API

**Files:**
- Create: `src/http/deviceRoutes.ts`, `src/http/app.ts`, `test/http/deviceRoutes.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `FrameService` (Task 12), `DeviceStore` (Task 10), `nextWakeSeconds` (Task 11)
- Produces:
  - `createApp(deps: AppDeps): express.Express`
  - `interface AppDeps { store: DeviceStore; frames: FrameService; publicBaseUrl: string }`

- [ ] **Step 1: Write the failing test**

Create `test/http/deviceRoutes.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/http/app.ts';
import { DeviceStore } from '../../src/devices/store.ts';
import type { FrameService } from '../../src/render/frameService.ts';

/** A frame service stub — these tests are about the HTTP contract, not pixels. */
function stubFrames(etag = 'a'.repeat(32)): FrameService {
  return {
    frameFor: async () => ({ buffer: Buffer.alloc(48000, 0), etag, renderedAt: '2026-08-03T07:42:00.000Z' }),
    enrolmentFrame: async () => ({ buffer: Buffer.alloc(48000, 1), etag: 'b'.repeat(32), renderedAt: '2026-08-03T07:42:00.000Z' }),
    previewHtml: async () => '<html></html>',
  } as unknown as FrameService;
}

async function withServer(fn: (base: string, store: DeviceStore) => Promise<void>, frames = stubFrames()) {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-http-'));
  const store = new DeviceStore(join(dir, 'config.json'));
  const app = createApp({ store, frames, publicBaseUrl: 'http://test.local:8080' });
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

test('serves an enrolment frame for an unknown device', async () => {
  await withServer(async (base, store) => {
    const res = await fetch(`${base}/api/devices/esp32-new/frame`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/octet-stream');
    assert.equal((await res.arrayBuffer()).byteLength, 48000);
    const device = await store.get('esp32-new');
    assert.equal(device?.claimed, false, 'auto-registered as unclaimed');
  });
});

test('unclaimed devices are told to come back quickly', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/devices/esp32-new/frame`);
    assert.equal(res.headers.get('x-next-wake-seconds'), '60');
  });
});

test('serves a full frame with an ETag once claimed', async () => {
  await withServer(async (base, store) => {
    await store.getOrCreate('esp32-1');
    await store.update('esp32-1', { claimed: true });
    const res = await fetch(`${base}/api/devices/esp32-1/frame`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('etag'), `"${'a'.repeat(32)}"`);
    assert.equal(res.headers.get('x-next-wake-seconds'), '900');
    assert.equal((await res.arrayBuffer()).byteLength, 48000);
  });
});

test('returns 304 when the device already has the frame', async () => {
  await withServer(async (base, store) => {
    await store.getOrCreate('esp32-1');
    await store.update('esp32-1', { claimed: true });
    const res = await fetch(`${base}/api/devices/esp32-1/frame`, {
      headers: { 'if-none-match': `"${'a'.repeat(32)}"` },
    });
    assert.equal(res.status, 304);
    assert.equal(res.headers.get('x-next-wake-seconds'), '900');
    assert.equal((await res.arrayBuffer()).byteLength, 0, '304 must carry no body');
  });
});

test('records battery, firmware and last-seen from request headers', async () => {
  await withServer(async (base, store) => {
    await store.getOrCreate('esp32-1');
    await store.update('esp32-1', { claimed: true });
    await fetch(`${base}/api/devices/esp32-1/frame`, {
      headers: { 'x-battery-voltage': '3.94', 'x-firmware-version': '0.1.0', 'x-wake-reason': 'timer' },
    });
    const device = await store.get('esp32-1');
    assert.equal(device?.lastBatteryVolts, 3.94);
    assert.equal(device?.lastFirmwareVersion, '0.1.0');
    assert.ok(device?.lastSeenAt);
  });
});

test('rejects a malformed device id rather than creating junk records', async () => {
  await withServer(async (base, store) => {
    const res = await fetch(`${base}/api/devices/..%2Fetc/frame`);
    assert.equal(res.status, 400);
    assert.deepEqual(await store.list(), []);
  });
});

test('returns 503 with a retry interval when rendering fails', async () => {
  const failing = {
    frameFor: async () => { throw new Error('chromium died'); },
    enrolmentFrame: async () => { throw new Error('chromium died'); },
    previewHtml: async () => '',
  } as unknown as FrameService;

  await withServer(async (base, store) => {
    await store.getOrCreate('esp32-1');
    await store.update('esp32-1', { claimed: true });
    const res = await fetch(`${base}/api/devices/esp32-1/frame`);
    assert.equal(res.status, 503);
    assert.ok(Number(res.headers.get('x-next-wake-seconds')) > 0);
  }, failing);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- --test-name-pattern="serves an enrolment frame"
```

Expected: FAIL — cannot resolve `src/http/app.ts`.

- [ ] **Step 3: Write the device routes**

Create `src/http/deviceRoutes.ts`:

```ts
import { Router } from 'express';
import type { DeviceStore } from '../devices/store.ts';
import type { FrameService } from '../render/frameService.ts';
import { nextWakeSeconds } from '../schedule/nextWake.ts';

/** Device IDs come from firmware; keep them to a safe alphabet. */
const DEVICE_ID = /^[a-z0-9][a-z0-9_-]{1,63}$/i;

const ERROR_RETRY_SECONDS = 300;

function parseVolts(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function deviceRoutes(store: DeviceStore, frames: FrameService, publicBaseUrl: string): Router {
  const router = Router();

  router.get('/devices/:id/frame', async (req, res) => {
    const id = req.params.id;
    if (!DEVICE_ID.test(id)) {
      res.status(400).json({ error: 'invalid device id' });
      return;
    }

    const device = await store.getOrCreate(id);
    const batteryVolts = parseVolts(req.get('x-battery-voltage'));

    // Record telemetry before rendering, so a render failure still logs the visit.
    await store.update(id, {
      lastSeenAt: new Date().toISOString(),
      lastBatteryVolts: batteryVolts ?? device.lastBatteryVolts,
      lastFirmwareVersion: req.get('x-firmware-version') ?? device.lastFirmwareVersion,
    });

    const wake = nextWakeSeconds({ now: new Date(), device, batteryVolts });
    res.set('X-Next-Wake-Seconds', String(wake));
    res.set('Cache-Control', 'no-store');

    try {
      const frame = device.claimed
        ? await frames.frameFor(device, batteryVolts)
        : await frames.enrolmentFrame(device, publicBaseUrl);

      const etag = `"${frame.etag}"`;
      if (req.get('if-none-match') === etag) {
        res.set('ETag', etag);
        res.status(304).end();
        return;
      }

      await store.update(id, { lastEtag: frame.etag });
      res.set('ETag', etag);
      res.set('Content-Type', 'application/octet-stream');
      res.set('Content-Length', String(frame.buffer.length));
      res.status(200).end(frame.buffer);
    } catch (err) {
      // Never send a broken frame. The device keeps its last good image.
      console.error(`[frame] ${id} render failed:`, err);
      res.set('X-Next-Wake-Seconds', String(ERROR_RETRY_SECONDS));
      res.status(503).json({ error: 'render failed' });
    }
  });

  return router;
}
```

Create `src/http/app.ts`:

```ts
import express from 'express';
import type { DeviceStore } from '../devices/store.ts';
import type { FrameService } from '../render/frameService.ts';
import { deviceRoutes } from './deviceRoutes.ts';

export interface AppDeps {
  store: DeviceStore;
  frames: FrameService;
  publicBaseUrl: string;
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());
  app.use('/api', deviceRoutes(deps.store, deps.frames, deps.publicBaseUrl));
  return app;
}
```

- [ ] **Step 4: Run the tests**

```bash
npm test && npm run check
```

Expected: 7 HTTP contract tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/http test/http
git commit -m "feat: add device frame API with ETag, enrolment and 503 fallback"
```

---

### Task 14: Server entrypoint and the fake-device CLI

The fake device is what lets the rest of this project be built with no hardware powered on.

**Files:**
- Create: `src/tools/fakeDevice.ts`, `test/panel/unpack.test.ts`, `test/render/golden.test.ts`, `test/fixtures/golden/dashboard.bin`
- Modify: `src/index.ts`, `src/panel/quantise.ts`, `.gitignore`

**Interfaces:**
- Consumes: `createApp` (Task 13), `DeviceStore` (Task 10), `FrameService` (Task 12)
- Produces:
  - `unpackToGrayscale(packed: Buffer, profile: PanelProfile): Uint8Array`
  - `bufferToPng(packed: Buffer, profile: PanelProfile): Promise<Buffer>`
  - a runnable `npm run fake-device -- --server http://localhost:8080 --id esp32-fake`

- [ ] **Step 1: Write the failing test**

Create `test/panel/unpack.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packGrayscale, unpackToGrayscale } from '../../src/panel/quantise.ts';
import { WFT0583 } from '../../src/panel/profile.ts';

test('unpack is the inverse of pack', () => {
  const gray = new Uint8Array(800 * 480);
  for (let i = 0; i < gray.length; i++) gray[i] = i % 3 === 0 ? 0 : 255;

  const roundTripped = unpackToGrayscale(packGrayscale(gray, WFT0583), WFT0583);
  assert.equal(roundTripped.length, gray.length);
  for (let i = 0; i < gray.length; i++) {
    assert.equal(roundTripped[i], gray[i], `pixel ${i} changed`);
  }
});

test('rejects a buffer of the wrong size', () => {
  assert.throws(() => unpackToGrayscale(Buffer.alloc(10), WFT0583), /expected 48000/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- --test-name-pattern="unpack is the inverse"
```

Expected: FAIL — `unpackToGrayscale` is not exported.

- [ ] **Step 3: Add unpacking to the quantiser**

Append to `src/panel/quantise.ts`:

```ts
/** Inverse of packGrayscale. Used by tooling to view what the panel will show. */
export function unpackToGrayscale(packed: Buffer, profile: PanelProfile): Uint8Array {
  if (packed.length !== profile.bytes) {
    throw new Error(`expected ${profile.bytes} bytes, received ${packed.length}`);
  }
  const gray = new Uint8Array(profile.width * profile.height);
  for (let y = 0; y < profile.height; y++) {
    const byteRow = y * profile.stride;
    const pixelRow = y * profile.width;
    for (let x = 0; x < profile.width; x++) {
      const bit = packed[byteRow + (x >> 3)]! & (0x80 >> (x & 7));
      gray[pixelRow + x] = bit ? 0 : 255;
    }
  }
  return gray;
}

/** Render a packed buffer back to a viewable PNG. */
export async function bufferToPng(packed: Buffer, profile: PanelProfile): Promise<Buffer> {
  return sharp(Buffer.from(unpackToGrayscale(packed, profile)), {
    raw: { width: profile.width, height: profile.height, channels: 1 },
  }).png().toBuffer();
}
```

- [ ] **Step 4: Keep generated images out of git**

Add to `.gitignore`. The golden `.bin` and `dashboard.png` **are** committed;
these two are transient output.

```
# fake-device output and golden test diffs
/frame.png
test/fixtures/golden/actual.png
```

- [ ] **Step 5: Write the entrypoint**

Replace `src/index.ts`:

```ts
import 'dotenv/config';
import { networkInterfaces } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from './http/app.ts';
import { DeviceStore } from './devices/store.ts';
import { FrameService } from './render/frameService.ts';
import { Renderer } from './render/browser.ts';
import { SourceCache } from './sources/cache.ts';

export const version = '0.1.0';

function lanAddress(): string {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return 'localhost';
}

export async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 8080);
  const dataDir = resolve(process.env.DATA_DIR ?? './data');
  const publicBaseUrl = process.env.PUBLIC_BASE_URL || `http://${lanAddress()}:${port}`;

  const store = new DeviceStore(join(dataDir, 'config.json'));
  const renderer = new Renderer();
  const frames = new FrameService({ renderer, cache: new SourceCache(join(dataDir, 'cache')) });

  const server = createApp({ store, frames, publicBaseUrl }).listen(port, () => {
    console.log(`inkpanel ${version} listening on ${publicBaseUrl}`);
  });

  const shutdown = async () => {
    server.close();
    await renderer.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// Only start when run directly, so tests can import this module.
// pathToFileURL rather than string comparison: on Windows argv[1] is a
// backslash path that never matches an import.meta.url suffix.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
```

- [ ] **Step 6: Write the fake device**

Create `src/tools/fakeDevice.ts`:

```ts
import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { bufferToPng } from '../panel/quantise.ts';
import { WFT0583 } from '../panel/profile.ts';

const { values } = parseArgs({
  options: {
    server: { type: 'string', default: 'http://localhost:8080' },
    id: { type: 'string', default: 'esp32-fake01' },
    battery: { type: 'string', default: '4.02' },
    out: { type: 'string', default: 'frame.png' },
    once: { type: 'boolean', default: false },
  },
});

let etag: string | null = null;

async function cycle(): Promise<number> {
  const headers: Record<string, string> = {
    'X-Battery-Voltage': values.battery!,
    'X-Firmware-Version': 'fake-0.1.0',
    'X-Wake-Reason': 'timer',
  };
  if (etag) headers['If-None-Match'] = etag;

  const res = await fetch(`${values.server}/api/devices/${values.id}/frame`, { headers });
  const wake = Number(res.headers.get('x-next-wake-seconds') ?? 900);

  if (res.status === 304) {
    console.log(`304 unchanged — sleeping ${wake}s (panel would NOT refresh)`);
    return wake;
  }
  if (!res.ok) {
    console.error(`${res.status} ${res.statusText} — sleeping ${wake}s, keeping last image`);
    return wake;
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length !== WFT0583.bytes) {
    throw new Error(`expected ${WFT0583.bytes} bytes, got ${buffer.length}`);
  }
  etag = res.headers.get('etag');
  await writeFile(values.out!, await bufferToPng(buffer, WFT0583));
  console.log(`200 ${buffer.length} bytes → ${values.out} (etag ${etag}) — sleeping ${wake}s`);
  return wake;
}

const wake = await cycle();
if (!values.once) {
  setInterval(() => { void cycle(); }, wake * 1000);
}
```

- [ ] **Step 7: Add the golden-image test**

This is the regression net for layout. It compares the **packed buffer** rather
than PNG pixels, so a match is exact rather than tolerance-based.

Create `test/render/golden.test.ts`:

```ts
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Renderer } from '../../src/render/browser.ts';
import { renderHtml } from '../../src/render/template.ts';
import { loadFontCss } from '../../src/render/fonts.ts';
import { quantisePng, bufferToPng } from '../../src/panel/quantise.ts';
import { WFT0583 } from '../../src/panel/profile.ts';
import type { DashboardData } from '../../src/model/dashboard.ts';

const here = dirname(fileURLToPath(import.meta.url));
const goldenDir = join(here, '..', 'fixtures', 'golden');
const renderer = new Renderer();
after(() => renderer.close());

const FIXTURE: DashboardData = {
  generatedAt: '2026-08-03T07:42:00.000Z',
  contentChangedAt: '2026-08-03T07:42:00.000Z',
  timezone: 'Europe/London',
  today: { iso: '2026-08-03', weekdayLong: 'Monday', dayOfMonth: 3, monthLong: 'August' },
  calendar: {
    today: [
      { uid: '1', title: 'Team standup', start: '2026-08-03T08:30:00.000Z', end: '2026-08-03T08:45:00.000Z', allDay: false },
      { uid: '2', title: 'Lunch — The Swan', start: '2026-08-03T12:00:00.000Z', end: '2026-08-03T13:00:00.000Z', allDay: false },
    ],
    tomorrow: [],
  },
  weather: {
    currentTempC: 22, conditionText: 'Partly cloudy', highC: 24, lowC: 13,
    precipProbability: 10, windKph: 13, windDirection: 'NW',
    sunrise: '2026-08-03T05:34', sunset: '2026-08-03T20:47',
    forecast: [
      { weekday: 'TUE', highC: 24, lowC: 14, conditionText: 'Sunny' },
      { weekday: 'WED', highC: 19, lowC: 13, conditionText: 'Rain' },
      { weekday: 'THU', highC: 21, lowC: 12, conditionText: 'Overcast' },
    ],
  },
  sourceHealth: [
    { id: 'ical', status: 'ok', fetchedAt: '2026-08-03T07:42:00.000Z', error: null },
    { id: 'weather', status: 'ok', fetchedAt: '2026-08-03T07:42:00.000Z', error: null },
  ],
  battery: { volts: 4.02, percent: 87 },
};

test('dashboard layout matches the golden buffer', async () => {
  const html = renderHtml(FIXTURE, WFT0583, await loadFontCss());
  const actual = await quantisePng(await renderer.screenshot(html, WFT0583), WFT0583);
  const goldenPath = join(goldenDir, 'dashboard.bin');

  if (process.env.UPDATE_GOLDENS === '1') {
    await mkdir(goldenDir, { recursive: true });
    await writeFile(goldenPath, actual);
    await writeFile(join(goldenDir, 'dashboard.png'), await bufferToPng(actual, WFT0583));
    return;
  }

  let expected: Buffer;
  try {
    expected = await readFile(goldenPath);
  } catch {
    assert.fail('no golden found — run UPDATE_GOLDENS=1 npm test to create it');
  }

  if (!actual.equals(expected)) {
    // Write the actual output so the difference can be eyeballed.
    await writeFile(join(goldenDir, 'actual.png'), await bufferToPng(actual, WFT0583));
    const differing = actual.reduce((n, byte, i) => (byte === expected[i] ? n : n + 1), 0);
    assert.fail(
      `${differing} of ${actual.length} bytes differ. ` +
      `Compare fixtures/golden/dashboard.png with actual.png. ` +
      `If the change is intended, re-run with UPDATE_GOLDENS=1.`,
    );
  }
});
```

Generate the first golden and commit it:

```bash
UPDATE_GOLDENS=1 npm test -- --test-name-pattern="golden buffer"
npm test -- --test-name-pattern="golden buffer"
```

Expected: the second run passes against the committed golden.

> **Generate goldens in the same environment CI uses.** Font rasterisation
> differs between platforms and Chromium versions. A golden made on Windows
> will not match one made in the Linux container, and a test that flaps is a
> test everyone learns to ignore. Once Task 16 exists, regenerate inside the
> container: `docker compose run --rm inkpanel npx cross-env UPDATE_GOLDENS=1 npm test`.

- [ ] **Step 8: Verify end to end**

```bash
npm test && npm run check
```

Then, in one terminal:

```bash
npm start
```

And in another:

```bash
npm run fake-device -- --once
```

Expected: `200 48000 bytes → frame.png`. Open `frame.png` — it should show the enrolment screen, since the device is unclaimed. Run it a second time and it should still return `200` (the enrolment frame is not memoised), but a claimed device would return `304`.

- [ ] **Step 9: Commit**

```bash
git add .gitignore src/index.ts src/panel/quantise.ts src/tools test/panel/unpack.test.ts test/render/golden.test.ts test/fixtures/golden
git commit -m "feat: add server entrypoint, fake-device CLI and golden layout test"
```

---

### Task 15: Management API and config UI

**Files:**
- Create: `src/http/manageRoutes.ts`, `public/index.html`, `public/app.js`, `public/styles.css`
- Create: `test/http/manageRoutes.test.ts`
- Modify: `src/http/app.ts`

**Interfaces:**
- Consumes: `DeviceStore` (Task 10), `FrameService` (Task 12), `bufferToPng` (Task 14)
- Produces: `manageRoutes(store: DeviceStore, frames: FrameService): Router`

- [ ] **Step 1: Vendor the design system**

The UI reuses the CtrlAlt tokens rather than inventing a second look.

```bash
mkdir -p public/vendor/fonts
gh api repos/CtrlAltcouk/ctrlalt-website/contents/colors_and_type.css --jq '.content' | base64 -d > public/vendor/colors_and_type.css
gh api repos/CtrlAltcouk/ctrlalt-website/contents/fonts/ModifiedDelaGothicOne-Regular.ttf --jq '.content' | base64 -d > public/vendor/fonts/ModifiedDelaGothicOne-Regular.ttf
```

The relative `url("./fonts/...")` inside the vendored CSS resolves correctly with this layout.

- [ ] **Step 2: Write the failing test**

Create `test/http/manageRoutes.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/http/app.ts';
import { DeviceStore } from '../../src/devices/store.ts';
import type { FrameService } from '../../src/render/frameService.ts';

const frames = {
  frameFor: async () => ({ buffer: Buffer.alloc(48000, 0), etag: 'c'.repeat(32), renderedAt: '2026-08-03T07:42:00.000Z' }),
  enrolmentFrame: async () => ({ buffer: Buffer.alloc(48000, 0), etag: 'd'.repeat(32), renderedAt: '2026-08-03T07:42:00.000Z' }),
  previewHtml: async () => '<html><body>preview</body></html>',
} as unknown as FrameService;

async function withServer(fn: (base: string, store: DeviceStore) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-mgmt-'));
  const store = new DeviceStore(join(dir, 'config.json'));
  const server = createApp({ store, frames, publicBaseUrl: 'http://test.local:8080' }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await fn(`http://127.0.0.1:${port}`, store);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('lists devices', async () => {
  await withServer(async (base, store) => {
    await store.getOrCreate('esp32-1');
    const res = await fetch(`${base}/api/devices`);
    assert.equal(res.status, 200);
    const body = await res.json() as { devices: Array<{ id: string }> };
    assert.equal(body.devices[0]?.id, 'esp32-1');
  });
});

test('updates and claims a device', async () => {
  await withServer(async (base, store) => {
    await store.getOrCreate('esp32-1');
    const res = await fetch(`${base}/api/devices/esp32-1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Desk panel', claimed: true, latitude: 52.04, longitude: -0.76 }),
    });
    assert.equal(res.status, 200);
    assert.equal((await store.get('esp32-1'))?.name, 'Desk panel');
  });
});

test('rejects invalid config instead of corrupting the store', async () => {
  await withServer(async (base, store) => {
    await store.getOrCreate('esp32-1');
    const res = await fetch(`${base}/api/devices/esp32-1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ latitude: 'not a number', activeIntervalSeconds: -5 }),
    });
    assert.equal(res.status, 400);
    assert.equal((await store.get('esp32-1'))?.name, 'Unnamed panel', 'unchanged');
  });
});

test('serves preview HTML and a PNG of the real output', async () => {
  await withServer(async (base, store) => {
    await store.getOrCreate('esp32-1');
    const html = await fetch(`${base}/api/devices/esp32-1/preview`);
    assert.match(html.headers.get('content-type') ?? '', /text\/html/);

    const png = await fetch(`${base}/api/devices/esp32-1/render.png`);
    assert.equal(png.headers.get('content-type'), 'image/png');
    const bytes = Buffer.from(await png.arrayBuffer());
    assert.deepEqual(bytes.subarray(0, 4), Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'PNG magic');
  });
});

test('health reports device count and liveness', async () => {
  await withServer(async (base, store) => {
    await store.getOrCreate('esp32-1');
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const body = await res.json() as { status: string; devices: number };
    assert.equal(body.status, 'ok');
    assert.equal(body.devices, 1);
  });
});

test('404s for an unknown device', async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/api/devices/ghost`)).status, 404);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
npm test -- --test-name-pattern="lists devices"
```

Expected: FAIL — 404, routes not mounted.

- [ ] **Step 4: Write the management routes**

Create `src/http/manageRoutes.ts`:

```ts
import { Router } from 'express';
import { z } from 'zod';
import type { DeviceStore } from '../devices/store.ts';
import type { FrameService } from '../render/frameService.ts';
import { bufferToPng } from '../panel/quantise.ts';
import { PROFILES, WFT0583 } from '../panel/profile.ts';

const patchSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  claimed: z.boolean().optional(),
  timezone: z.string().min(1).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  calendarUrls: z.array(z.string().url()).max(10).optional(),
  panelProfileId: z.string().refine((id) => id in PROFILES, 'unknown panel profile').optional(),
  quietHoursStart: z.number().int().min(0).max(23).optional(),
  quietHoursEnd: z.number().int().min(0).max(23).optional(),
  activeIntervalSeconds: z.number().int().min(60).max(86400).optional(),
  lowBatteryIntervalSeconds: z.number().int().min(60).max(86400).optional(),
  lowBatteryVolts: z.number().min(2.5).max(4.2).optional(),
}).strict();

export function manageRoutes(store: DeviceStore, frames: FrameService): Router {
  const router = Router();

  router.get('/devices', async (_req, res) => {
    res.json({ devices: await store.list() });
  });

  router.get('/devices/:id', async (req, res) => {
    const device = await store.get(req.params.id);
    if (!device) { res.status(404).json({ error: 'unknown device' }); return; }
    res.json(device);
  });

  router.put('/devices/:id', async (req, res) => {
    if (!(await store.get(req.params.id))) {
      res.status(404).json({ error: 'unknown device' }); return;
    }
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid config', issues: parsed.error.issues });
      return;
    }
    res.json(await store.update(req.params.id, parsed.data));
  });

  router.get('/devices/:id/preview', async (req, res) => {
    const device = await store.get(req.params.id);
    if (!device) { res.status(404).json({ error: 'unknown device' }); return; }
    res.type('html').send(await frames.previewHtml(device));
  });

  router.get('/devices/:id/render.png', async (req, res) => {
    const device = await store.get(req.params.id);
    if (!device) { res.status(404).json({ error: 'unknown device' }); return; }
    const frame = await frames.frameFor(device, device.lastBatteryVolts);
    const profile = PROFILES[device.panelProfileId] ?? WFT0583;
    res.type('png').send(await bufferToPng(frame.buffer, profile));
  });

  return router;
}
```

- [ ] **Step 5: Mount the routes and static UI**

Replace `src/http/app.ts`:

```ts
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { DeviceStore } from '../devices/store.ts';
import type { FrameService } from '../render/frameService.ts';
import { deviceRoutes } from './deviceRoutes.ts';
import { manageRoutes } from './manageRoutes.ts';

export interface AppDeps {
  store: DeviceStore;
  frames: FrameService;
  publicBaseUrl: string;
}

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  app.get('/health', async (_req, res) => {
    res.json({
      status: 'ok',
      devices: (await deps.store.list()).length,
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  // Device routes first: both mount under /api and :id/frame must win.
  app.use('/api', deviceRoutes(deps.store, deps.frames, deps.publicBaseUrl));
  app.use('/api', manageRoutes(deps.store, deps.frames));
  app.use(express.static(publicDir));

  return app;
}
```

- [ ] **Step 6: Write the config UI**

Create `public/styles.css`:

```css
@import url("./vendor/colors_and_type.css");

body{background:var(--bg-0);color:var(--fg-1);font-family:var(--font-body);margin:0;padding:var(--sp-8);}
h1{font-family:var(--font-display);font-size:var(--fs-3xl);letter-spacing:var(--tracking-display);margin-bottom:var(--sp-6);}
h2{font-family:var(--font-body);font-weight:700;font-size:var(--fs-xl);margin-bottom:var(--sp-4);}
.eyebrow{font-size:var(--fs-xs);font-weight:600;text-transform:uppercase;letter-spacing:var(--tracking-caps);color:var(--brand-pink);}
.card{background:var(--bg-2);border:1px solid var(--line-1);border-radius:var(--radius-lg);padding:var(--sp-6);margin-bottom:var(--sp-6);}
label{display:block;font-size:var(--fs-sm);color:var(--fg-2);margin:var(--sp-4) 0 var(--sp-2);}
input{width:100%;background:var(--bg-3);border:1px solid var(--line-1);border-radius:var(--radius-sm);
  color:var(--fg-1);font-family:var(--font-body);font-size:var(--fs-base);padding:var(--sp-3);}
input:focus{outline:none;border-color:var(--brand-pink);box-shadow:var(--shadow-glow);}
button{background:var(--brand-pink);color:var(--bg-0);border:0;border-radius:var(--radius-pill);
  font-weight:700;font-size:var(--fs-base);padding:var(--sp-3) var(--sp-6);cursor:pointer;
  transition:background var(--dur-fast) var(--ease-out);margin-top:var(--sp-5);}
button:hover{background:var(--brand-pink-hover);}
.meta{font-size:var(--fs-sm);color:var(--fg-3);}
.status{font-size:var(--fs-xs);text-transform:uppercase;letter-spacing:var(--tracking-caps);
  border:1px solid var(--line-2);border-radius:var(--radius-pill);padding:2px 10px;margin-left:var(--sp-3);}
.preview{width:100%;max-width:800px;border:1px solid var(--line-2);border-radius:var(--radius-md);background:#fff;}
.row{display:flex;gap:var(--sp-4);flex-wrap:wrap;}
.row>*{flex:1 1 220px;}
```

Create `public/index.html`:

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
  <p class="eyebrow">CtrlAlt</p>
  <h1>inkpanel</h1>
  <div id="devices"></div>
  <script type="module" src="./app.js"></script>
</body>
</html>
```

Create `public/app.js`:

```js
const container = document.getElementById('devices');

const field = (device, key, label, type = 'text') => `
  <label for="${device.id}-${key}">${label}</label>
  <input id="${device.id}-${key}" name="${key}" type="${type}"
         value="${device[key] ?? ''}">`;

function card(device) {
  const status = device.claimed ? 'Claimed' : 'Unclaimed';
  const seen = device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString() : 'never';
  const battery = device.lastBatteryVolts ? `${device.lastBatteryVolts.toFixed(2)} V` : 'unknown';

  return `
  <div class="card">
    <h2>${device.name}<span class="status">${status}</span></h2>
    <p class="meta">${device.id} &middot; last seen ${seen} &middot; battery ${battery}</p>
    <form data-id="${device.id}">
      <div class="row">
        <div>${field(device, 'name', 'Name')}</div>
        <div>${field(device, 'timezone', 'Timezone')}</div>
      </div>
      <div class="row">
        <div>${field(device, 'latitude', 'Latitude', 'number')}</div>
        <div>${field(device, 'longitude', 'Longitude', 'number')}</div>
      </div>
      <label for="${device.id}-cal">Calendar iCal URLs (one per line)</label>
      <textarea id="${device.id}-cal" name="calendarUrls" rows="3"
        style="width:100%">${(device.calendarUrls ?? []).join('\n')}</textarea>
      <div class="row">
        <div>${field(device, 'activeIntervalSeconds', 'Refresh interval (s)', 'number')}</div>
        <div>${field(device, 'quietHoursStart', 'Quiet from (hour)', 'number')}</div>
        <div>${field(device, 'quietHoursEnd', 'Quiet until (hour)', 'number')}</div>
      </div>
      <label><input type="checkbox" name="claimed" ${device.claimed ? 'checked' : ''}> Claimed</label>
      <button type="submit">Save</button>
    </form>
    <h2 style="margin-top:24px">What the panel shows</h2>
    <img class="preview" alt="Rendered panel output" src="/api/devices/${device.id}/render.png?t=${Date.now()}">
  </div>`;
}

async function save(event) {
  event.preventDefault();
  const form = event.target;
  const raw = Object.fromEntries(new FormData(form));
  const body = {
    name: raw.name,
    timezone: raw.timezone,
    latitude: Number(raw.latitude),
    longitude: Number(raw.longitude),
    calendarUrls: String(raw.calendarUrls || '').split('\n').map((s) => s.trim()).filter(Boolean),
    activeIntervalSeconds: Number(raw.activeIntervalSeconds),
    quietHoursStart: Number(raw.quietHoursStart),
    quietHoursEnd: Number(raw.quietHoursEnd),
    claimed: form.querySelector('[name=claimed]').checked,
  };

  const res = await fetch(`/api/devices/${form.dataset.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const problem = await res.json();
    alert(`Save failed: ${problem.error}\n${JSON.stringify(problem.issues ?? [], null, 2)}`);
    return;
  }
  await load();
}

async function load() {
  const { devices } = await (await fetch('/api/devices')).json();
  container.innerHTML = devices.length
    ? devices.map(card).join('')
    : '<div class="card"><p class="meta">No panels yet. Power one on and it will appear here.</p></div>';
  container.querySelectorAll('form').forEach((f) => f.addEventListener('submit', save));
}

await load();
```

- [ ] **Step 7: Run the tests and look at the UI**

```bash
npm test && npm run check
```

Expected: 6 management tests pass.

```bash
npm start
```

Open `http://localhost:8080`, then in another terminal run `npm run fake-device -- --once` to make a device appear. Reload, name it, tick **Claimed**, save. The preview image should switch from the enrolment screen to the dashboard.

- [ ] **Step 8: Commit**

```bash
git add src/http public test/http/manageRoutes.test.ts
git commit -m "feat: add management API and CtrlAlt-styled config UI"
```

---

### Task 16: Containerisation and deployment

**Files:**
- Create: `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `docs/deployment.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: the whole server
- Produces: `docker compose up -d` yielding a working service on port 8080

- [ ] **Step 1: Write the Dockerfile**

Create `.dockerignore`:

```
node_modules
data
.git
.superpowers
docs
*.png
```

Create `Dockerfile`:

```dockerfile
# The Playwright image ships Chromium with every shared library it needs.
# Installing chromium into a bare image is where hours disappear.
FROM mcr.microsoft.com/playwright:v1.56.0-noble

WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080

COPY package*.json ./
RUN npm ci

COPY . .

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "src/index.ts"]
```

Create `docker-compose.yml`:

```yaml
services:
  inkpanel:
    build: .
    container_name: inkpanel
    restart: unless-stopped
    ports:
      - "8080:8080"
    volumes:
      - inkpanel-data:/data
    environment:
      # Printed on the enrolment screen. Set this to the address panels can reach.
      PUBLIC_BASE_URL: ""
    # Chromium needs more than the 64MB default.
    shm_size: "512mb"

volumes:
  inkpanel-data:
```

- [ ] **Step 2: Build and verify**

```bash
docker compose build
docker compose up -d
curl -s http://localhost:8080/health
```

Expected: `{"status":"ok","devices":0,"uptimeSeconds":...}`

Then confirm rendering works inside the container, which is where Chromium problems surface:

```bash
npm run fake-device -- --once --server http://localhost:8080
```

Expected: `200 48000 bytes → frame.png`. If this fails with a Chromium launch error, the base image tag has drifted from the installed Playwright version — align them.

- [ ] **Step 3: Write the deployment guide**

Create `docs/deployment.md`:

```markdown
# Deployment

## Proxmox LXC

1. Create a Debian 12 container: 2 cores, 1 GB RAM, 8 GB disk.
2. Install Docker inside it.
3. Clone this repo, then `docker compose up -d`.
4. Set `PUBLIC_BASE_URL` in `docker-compose.yml` to the address panels reach the
   host on, e.g. `http://192.168.1.20:8080`. It is printed on the enrolment
   screen, so getting it right saves guesswork at the panel.

An unprivileged LXC is fine. Chromium runs with `--no-sandbox`, which is
acceptable because it only ever loads HTML this service generated itself.

## TrueNAS

Works equally well as a Docker app. Map a dataset to `/data`.

## Resources

Chromium is the only heavy component and runs for a second or two per *changed*
render. Unchanged renders never launch it at all. Idle memory is roughly 150 MB.

## Backups

Everything that matters is `/data/config.json` — device records and calendar
URLs. `/data/cache` is disposable.
```

- [ ] **Step 4: Update the README**

Replace the status block in `README.md` with a quick start, and add the security warning verbatim:

```markdown
## Quick start

```bash
git clone https://github.com/CtrlAltcouk/inkpanel.git
cd inkpanel
docker compose up -d
```

Open `http://<host>:8080`. Flash the firmware, power the panel, and it will
appear in the UI with setup instructions shown on the panel itself.

## Security

**There is no authentication. Do not expose this to the internet.**

Anyone who can reach the server can read your calendar as a rendered image and
change any device's configuration. It is designed as a LAN appliance. If you
need remote access, put it behind a VPN or a reverse proxy that provides its
own authentication.
```

- [ ] **Step 5: Commit**

```bash
git add Dockerfile docker-compose.yml .dockerignore docs/deployment.md README.md
git commit -m "feat: containerise and document deployment"
```

---

### Task 17: Firmware — fetch and display

Bring-up only: mains/USB powered, WiFi credentials compiled in. Sleep and provisioning come next.

**Files:**
- Create: `firmware/inkpanel/inkpanel.ino`, `firmware/inkpanel/config.h`, `firmware/inkpanel/FrameClient.{h,cpp}`, `firmware/inkpanel/secrets.example.h`
- Copy: `OldV2EPD.h`, `OldV2EPD.cpp` from `EE04_WFT0583CZ61_OldV2_Test` **unchanged**
- Modify: `.gitignore` (add `firmware/inkpanel/secrets.h`)

**Interfaces:**
- Consumes: the device protocol from Task 13
- Produces:
  - `deviceId(char* out, size_t len)` — `esp32-xxxxxx` from the MAC
  - `enum class FetchResult { Updated, NotModified, Failed }`
  - `struct FetchOutcome { FetchResult result; uint32_t nextWakeSeconds; char etag[40]; }`
  - `FetchOutcome fetchFrame(...)`

- [ ] **Step 1: Copy the working driver**

```bash
mkdir -p firmware/inkpanel
cp EE04_WFT0583CZ61_OldV2_Test/OldV2EPD.h  firmware/inkpanel/
cp EE04_WFT0583CZ61_OldV2_Test/OldV2EPD.cpp firmware/inkpanel/
```

Do not edit the init sequence. It is the old-V2 variant and it is known to work on this panel.

- [ ] **Step 2: Speed up the SPI data path**

In `firmware/inkpanel/OldV2EPD.cpp`, replace the body of `dataBlock` with a chunked bulk write. The existing version issues one `SPI.transfer()` per byte for 96,000 bytes.

```cpp
void OldV2EPD::dataBlock(const uint8_t* values, size_t count, bool invert) {
  if (!values || count == 0) return;
  SPI.beginTransaction(SPISettings(Hardware::SPI_HZ, MSBFIRST, SPI_MODE0));
  digitalWrite(Hardware::EPD_DC, HIGH);
  digitalWrite(Hardware::EPD_CS, LOW);

  if (!invert) {
    // writeBytes takes a non-const pointer but does not modify the buffer.
    SPI.writeBytes(const_cast<uint8_t*>(values), count);
  } else {
    // Invert through a small scratch buffer rather than duplicating 48 KB.
    uint8_t chunk[512];
    size_t sent = 0;
    while (sent < count) {
      const size_t n = (count - sent < sizeof(chunk)) ? (count - sent) : sizeof(chunk);
      for (size_t i = 0; i < n; ++i) chunk[i] = static_cast<uint8_t>(~values[sent + i]);
      SPI.writeBytes(chunk, n);
      sent += n;
    }
  }

  digitalWrite(Hardware::EPD_CS, HIGH);
  SPI.endTransaction();
}
```

- [ ] **Step 3: Write the config and secrets template**

Create `firmware/inkpanel/config.h`:

```cpp
#pragma once
#include <stdint.h>

// XIAO ePaper Display Board EE04 (ESP32-S3 Plus). Unchanged from the test sketch.
namespace Hardware {
constexpr int EPD_SCLK   = 7;
constexpr int EPD_MOSI   = 9;
constexpr int EPD_CS     = 44;
constexpr int EPD_DC     = 10;
constexpr int EPD_BUSY   = 4;   // active LOW
constexpr int EPD_RST    = 38;
constexpr int EPD_ENABLE = 43;

constexpr int KEY1 = 2;  // refresh now
constexpr int KEY2 = 3;
constexpr int KEY3 = 5;  // hold at boot to factory reset

constexpr int BATTERY_ADC_PIN = 1;
constexpr int BATTERY_ADC_ENABLE_PIN = 6;

constexpr uint32_t SPI_HZ = 4'000'000;
}

constexpr uint32_t EPD_BUSY_TIMEOUT_MS = 60'000;
constexpr uint32_t WIFI_TIMEOUT_MS = 15'000;
constexpr uint32_t HTTP_TIMEOUT_MS = 20'000;

// Used only when the server is unreachable and cannot dictate a schedule.
constexpr uint32_t FALLBACK_WAKE_SECONDS = 900;
constexpr uint32_t MAX_BACKOFF_SECONDS = 3600;

constexpr const char* FIRMWARE_VERSION = "0.1.0";
```

Create `firmware/inkpanel/secrets.example.h`:

```cpp
#pragma once
// Copy to secrets.h for bring-up. Task 19 replaces this with on-device
// provisioning, after which secrets.h is only a convenience for development.
#define WIFI_SSID   "your-network"
#define WIFI_PASS   "your-password"
#define SERVER_URL  "http://192.168.1.20:8080"
```

Add to `.gitignore`:

```
firmware/inkpanel/secrets.h
```

- [ ] **Step 4: Write the frame client**

Create `firmware/inkpanel/FrameClient.h`:

```cpp
#pragma once
#include <Arduino.h>
#include <stddef.h>
#include <stdint.h>

enum class FetchResult { Updated, NotModified, Failed };

struct FetchOutcome {
  FetchResult result;
  uint32_t nextWakeSeconds;
  char etag[40];
};

/** Build a stable device id from the WiFi MAC: "esp32-a1b2c3". */
void deviceId(char* out, size_t len);

/**
 * Fetch a frame into `framebuffer`.
 * On NotModified or Failed the buffer is left untouched.
 */
FetchOutcome fetchFrame(const char* serverUrl,
                        const char* id,
                        uint8_t* framebuffer,
                        size_t bufferSize,
                        const char* currentEtag,
                        float batteryVolts,
                        const char* wakeReason);
```

Create `firmware/inkpanel/FrameClient.cpp`:

```cpp
#include "FrameClient.h"

#include <HTTPClient.h>
#include <WiFi.h>
#include <esp_mac.h>

#include "config.h"

void deviceId(char* out, size_t len) {
  uint8_t mac[6] = {0};
  esp_read_mac(mac, ESP_MAC_WIFI_STA);
  snprintf(out, len, "esp32-%02x%02x%02x", mac[3], mac[4], mac[5]);
}

FetchOutcome fetchFrame(const char* serverUrl,
                        const char* id,
                        uint8_t* framebuffer,
                        size_t bufferSize,
                        const char* currentEtag,
                        float batteryVolts,
                        const char* wakeReason) {
  FetchOutcome outcome{FetchResult::Failed, FALLBACK_WAKE_SECONDS, {0}};

  char url[192];
  snprintf(url, sizeof(url), "%s/api/devices/%s/frame", serverUrl, id);

  HTTPClient http;
  http.setTimeout(HTTP_TIMEOUT_MS);
  if (!http.begin(url)) {
    Serial.println("[net] http.begin failed");
    return outcome;
  }

  char volts[16];
  snprintf(volts, sizeof(volts), "%.2f", batteryVolts);
  http.addHeader("X-Battery-Voltage", volts);
  http.addHeader("X-Firmware-Version", FIRMWARE_VERSION);
  http.addHeader("X-Wake-Reason", wakeReason);
  if (currentEtag && currentEtag[0]) http.addHeader("If-None-Match", currentEtag);

  // Ask HTTPClient to retain the headers we care about.
  const char* wanted[] = {"ETag", "X-Next-Wake-Seconds"};
  http.collectHeaders(wanted, 2);

  const int status = http.GET();
  Serial.printf("[net] GET %s -> %d\n", url, status);

  if (status > 0) {
    const String wake = http.header("X-Next-Wake-Seconds");
    if (wake.length() > 0) {
      const long parsed = wake.toInt();
      if (parsed > 0) outcome.nextWakeSeconds = static_cast<uint32_t>(parsed);
    }
    snprintf(outcome.etag, sizeof(outcome.etag), "%s", http.header("ETag").c_str());
  }

  if (status == HTTP_CODE_NOT_MODIFIED) {
    outcome.result = FetchResult::NotModified;
    http.end();
    return outcome;
  }

  if (status != HTTP_CODE_OK) {
    http.end();
    return outcome;
  }

  const int length = http.getSize();
  if (length != static_cast<int>(bufferSize)) {
    Serial.printf("[net] expected %u bytes, server said %d\n",
                  static_cast<unsigned>(bufferSize), length);
    http.end();
    return outcome;
  }

  // Read the whole frame before touching the panel: a truncated read must not
  // become a half-drawn screen.
  WiFiClient* stream = http.getStreamPtr();
  size_t received = 0;
  const uint32_t deadline = millis() + HTTP_TIMEOUT_MS;
  while (received < bufferSize && millis() < deadline) {
    const int available = stream->available();
    if (available <= 0) { delay(1); continue; }
    const int read = stream->readBytes(framebuffer + received,
                                       min(static_cast<size_t>(available), bufferSize - received));
    if (read <= 0) break;
    received += static_cast<size_t>(read);
  }
  http.end();

  if (received != bufferSize) {
    Serial.printf("[net] short read: %u of %u\n",
                  static_cast<unsigned>(received), static_cast<unsigned>(bufferSize));
    return outcome;
  }

  outcome.result = FetchResult::Updated;
  return outcome;
}
```

- [ ] **Step 5: Write the sketch**

Create `firmware/inkpanel/inkpanel.ino`:

```cpp
#include <Arduino.h>
#include <WiFi.h>

#include "config.h"
#include "secrets.h"
#include "FrameClient.h"
#include "OldV2EPD.h"

OldV2EPD display;

static float readBatteryVoltage() {
  pinMode(Hardware::BATTERY_ADC_ENABLE_PIN, OUTPUT);
  digitalWrite(Hardware::BATTERY_ADC_ENABLE_PIN, HIGH);
  delay(10);
  analogReadResolution(12);
  const float volts = (static_cast<float>(analogRead(Hardware::BATTERY_ADC_PIN)) / 4096.0f) * 7.16f;
  digitalWrite(Hardware::BATTERY_ADC_ENABLE_PIN, LOW);
  return volts;
}

static bool connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  const uint32_t deadline = millis() + WIFI_TIMEOUT_MS;
  while (WiFi.status() != WL_CONNECTED && millis() < deadline) delay(200);
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[wifi] connect failed");
    return false;
  }
  Serial.printf("[wifi] connected, ip=%s\n", WiFi.localIP().toString().c_str());
  return true;
}

void setup() {
  Serial.begin(115200);
  delay(1500);

  char id[24];
  deviceId(id, sizeof(id));
  Serial.printf("\n[inkpanel] %s device=%s\n", FIRMWARE_VERSION, id);

  const float volts = readBatteryVoltage();

  if (!connectWifi()) return;

  const FetchOutcome outcome = fetchFrame(
      SERVER_URL, id, display.framebuffer(), OldV2EPD::BUFFER_SIZE, "", volts, "boot");

  switch (outcome.result) {
    case FetchResult::Updated:
      Serial.println("[epd] drawing new frame");
      if (!display.begin()) { Serial.printf("[epd] init failed: %s\n", display.lastError()); return; }
      if (!display.display(display.framebuffer())) { Serial.printf("[epd] refresh failed: %s\n", display.lastError()); return; }
      display.sleep();
      Serial.printf("[epd] done, etag=%s next=%us\n", outcome.etag, outcome.nextWakeSeconds);
      break;
    case FetchResult::NotModified:
      Serial.println("[epd] unchanged, panel left alone");
      break;
    case FetchResult::Failed:
      Serial.println("[epd] fetch failed, panel left alone");
      break;
  }
}

void loop() {
  delay(1000);
}
```

- [ ] **Step 6: Flash and verify against the real server**

Start the server, then flash with **Tools → Board → XIAO_ESP32S3_PLUS**, USB CDC On Boot **Enabled**, PSRAM **OPI PSRAM**. Open Serial Monitor at 115200.

Expected serial output:

```
[inkpanel] 0.1.0 device=esp32-xxxxxx
[wifi] connected, ip=192.168.x.x
[net] GET http://.../api/devices/esp32-xxxxxx/frame -> 200
[epd] drawing new frame
[epd] done, etag="..." next=60s
```

Expected on the panel: the **enrolment screen**, naming the server URL and this device's ID.

Then claim the device in the web UI, add a calendar URL, set the location, press reset — the panel should now show the dashboard.

- [ ] **Step 7: Commit**

```bash
git add firmware/inkpanel .gitignore
git commit -m "feat(firmware): fetch and display server-rendered frames"
```

---

### Task 18: Firmware — deep sleep and backoff

**Files:**
- Modify: `firmware/inkpanel/inkpanel.ino`

**Interfaces:**
- Consumes: `FetchOutcome` from Task 17
- Produces: a device that sleeps between refreshes and wakes on KEY1

- [ ] **Step 1: Read the measured sleep current**

Open `docs/hardware/sleep-current.md` from Task 1. If idle draw exceeds 1 mA, stop and fix the hardware first — the intervals below assume it does not.

- [ ] **Step 2: Add sleep, RTC state and backoff**

Replace `firmware/inkpanel/inkpanel.ino` with:

```cpp
#include <Arduino.h>
#include <WiFi.h>
#include <driver/rtc_io.h>
#include <esp_sleep.h>

#include "config.h"
#include "secrets.h"
#include "FrameClient.h"
#include "OldV2EPD.h"

OldV2EPD display;

// RTC memory survives deep sleep, so the ETag persists without touching flash.
RTC_DATA_ATTR char storedEtag[40] = {0};
RTC_DATA_ATTR uint32_t consecutiveFailures = 0;

static float readBatteryVoltage() {
  pinMode(Hardware::BATTERY_ADC_ENABLE_PIN, OUTPUT);
  digitalWrite(Hardware::BATTERY_ADC_ENABLE_PIN, HIGH);
  delay(10);
  analogReadResolution(12);
  const float volts = (static_cast<float>(analogRead(Hardware::BATTERY_ADC_PIN)) / 4096.0f) * 7.16f;
  digitalWrite(Hardware::BATTERY_ADC_ENABLE_PIN, LOW);
  return volts;
}

static const char* wakeReason() {
  switch (esp_sleep_get_wakeup_cause()) {
    case ESP_SLEEP_WAKEUP_TIMER: return "timer";
    case ESP_SLEEP_WAKEUP_EXT1:  return "button";
    default:                     return "boot";
  }
}

static bool connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  const uint32_t deadline = millis() + WIFI_TIMEOUT_MS;
  while (WiFi.status() != WL_CONNECTED && millis() < deadline) delay(200);
  return WiFi.status() == WL_CONNECTED;
}

/** Exponential backoff, doubling per consecutive failure up to the cap. */
static uint32_t backoffSeconds() {
  uint32_t seconds = FALLBACK_WAKE_SECONDS;
  for (uint32_t i = 1; i < consecutiveFailures && seconds < MAX_BACKOFF_SECONDS; ++i) {
    seconds *= 2;
  }
  return seconds > MAX_BACKOFF_SECONDS ? MAX_BACKOFF_SECONDS : seconds;
}

[[noreturn]] static void sleepFor(uint32_t seconds) {
  Serial.printf("[sleep] %u seconds\n", seconds);
  Serial.flush();

  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);

  // Panel rail off — the image persists without power.
  pinMode(Hardware::EPD_ENABLE, OUTPUT);
  digitalWrite(Hardware::EPD_ENABLE, LOW);

  // KEY1 wakes for an immediate refresh. GPIO 2 is RTC-capable on the S3.
  rtc_gpio_pullup_en(static_cast<gpio_num_t>(Hardware::KEY1));
  esp_sleep_enable_ext1_wakeup(1ULL << Hardware::KEY1, ESP_EXT1_WAKEUP_ANY_LOW);
  esp_sleep_enable_timer_wakeup(static_cast<uint64_t>(seconds) * 1000000ULL);
  esp_deep_sleep_start();
}

void setup() {
  Serial.begin(115200);
  delay(300);

  char id[24];
  deviceId(id, sizeof(id));
  const char* reason = wakeReason();
  Serial.printf("\n[inkpanel] %s device=%s wake=%s\n", FIRMWARE_VERSION, id, reason);

  const float volts = readBatteryVoltage();

  if (!connectWifi()) {
    consecutiveFailures++;
    Serial.printf("[wifi] failed (%u consecutive)\n", consecutiveFailures);
    sleepFor(backoffSeconds());
  }

  const FetchOutcome outcome = fetchFrame(
      SERVER_URL, id, display.framebuffer(), OldV2EPD::BUFFER_SIZE,
      storedEtag, volts, reason);

  if (outcome.result == FetchResult::Failed) {
    consecutiveFailures++;
    Serial.printf("[net] failed (%u consecutive), panel untouched\n", consecutiveFailures);
    sleepFor(backoffSeconds());
  }

  consecutiveFailures = 0;

  if (outcome.result == FetchResult::Updated) {
    if (display.begin() && display.display(display.framebuffer())) {
      display.sleep();
      snprintf(storedEtag, sizeof(storedEtag), "%s", outcome.etag);
      Serial.println("[epd] drawn");
    } else {
      Serial.printf("[epd] failed: %s\n", display.lastError());
    }
  } else {
    Serial.println("[epd] unchanged, no refresh");
  }

  sleepFor(outcome.nextWakeSeconds);
}

void loop() {}
```

- [ ] **Step 3: Verify the sleep cycle**

Flash, then watch the serial monitor across two cycles. Expected on the second wake:

```
[inkpanel] 0.1.0 device=esp32-xxxxxx wake=timer
[net] GET ... -> 304
[epd] unchanged, no refresh
[sleep] 900 seconds
```

**The panel must not flash on a `304`.** If it does, the ETag is not surviving sleep — check `storedEtag` is `RTC_DATA_ATTR` and that the server's ETag header is being captured.

Then press KEY1: it should wake immediately and report `wake=button`.

Finally, pull the WiFi or stop the server and confirm the panel keeps its image while the log shows increasing backoff.

- [ ] **Step 4: Commit**

```bash
git add firmware/inkpanel/inkpanel.ino
git commit -m "feat(firmware): deep sleep, RTC-persisted ETag and failure backoff"
```

---

### Task 19: Firmware — on-device provisioning

Without this the project is not actually shareable: nobody else can put their SSID in your header file.

**Files:**
- Create: `firmware/inkpanel/Provisioning.{h,cpp}`
- Modify: `firmware/inkpanel/inkpanel.ino`

**Interfaces:**
- Consumes: `config.h`
- Produces:
  - `struct Credentials { char ssid[33]; char password[65]; char serverUrl[128]; }`
  - `bool loadCredentials(Credentials& out)`
  - `void clearCredentials()`
  - `[[noreturn]] void runProvisioningPortal()`

- [ ] **Step 1: Write the provisioning module**

Create `firmware/inkpanel/Provisioning.h`:

```cpp
#pragma once
#include <Arduino.h>

struct Credentials {
  char ssid[33];
  char password[65];
  char serverUrl[128];
};

/** True when a usable SSID and server URL are stored in NVS. */
bool loadCredentials(Credentials& out);
void clearCredentials();

/** Starts a SoftAP captive portal. Reboots once the user saves; never returns. */
[[noreturn]] void runProvisioningPortal();
```

Create `firmware/inkpanel/Provisioning.cpp`:

```cpp
#include "Provisioning.h"

#include <DNSServer.h>
#include <Preferences.h>
#include <WebServer.h>
#include <WiFi.h>

#include "config.h"

namespace {
constexpr const char* NAMESPACE = "inkpanel";
constexpr const char* AP_SSID = "inkpanel-setup";

Preferences prefs;
DNSServer dns;
WebServer web(80);

String pageHtml() {
  String options;
  const int found = WiFi.scanNetworks();
  for (int i = 0; i < found; ++i) {
    options += "<option value=\"" + WiFi.SSID(i) + "\">" + WiFi.SSID(i) +
               " (" + String(WiFi.RSSI(i)) + " dBm)</option>";
  }

  return String(
      "<!doctype html><html><head><meta charset=utf-8>"
      "<meta name=viewport content='width=device-width,initial-scale=1'>"
      "<title>inkpanel setup</title><style>"
      "body{background:#0a0a0b;color:#f5f5f6;font-family:system-ui,sans-serif;padding:24px;max-width:480px;margin:auto}"
      "h1{color:#f7a4a2}label{display:block;margin:16px 0 6px;font-size:14px;color:#b9bac0}"
      "input,select{width:100%;padding:12px;border-radius:6px;border:1px solid #26272c;background:#1f2024;color:#f5f5f6;font-size:16px}"
      "button{margin-top:24px;width:100%;padding:14px;border:0;border-radius:999px;background:#f7a4a2;color:#0a0a0b;font-weight:700;font-size:16px}"
      "</style></head><body><h1>inkpanel</h1><form method=POST action=/save>"
      "<label>WiFi network</label><select name=ssid>") + options + String(
      "</select>"
      "<label>Password</label><input name=pass type=password>"
      "<label>Server address</label><input name=url placeholder='http://192.168.1.20:8080'>"
      "<button type=submit>Save and restart</button></form></body></html>");
}

void handleSave() {
  prefs.begin(NAMESPACE, false);
  prefs.putString("ssid", web.arg("ssid"));
  prefs.putString("pass", web.arg("pass"));
  prefs.putString("url", web.arg("url"));
  prefs.end();

  web.send(200, "text/html",
           "<body style='background:#0a0a0b;color:#f5f5f6;font-family:sans-serif;padding:24px'>"
           "<h1 style='color:#f7a4a2'>Saved</h1><p>Restarting...</p></body>");
  delay(1200);
  ESP.restart();
}
}  // namespace

bool loadCredentials(Credentials& out) {
  prefs.begin(NAMESPACE, true);
  const String ssid = prefs.getString("ssid", "");
  const String pass = prefs.getString("pass", "");
  const String url = prefs.getString("url", "");
  prefs.end();

  if (ssid.isEmpty() || url.isEmpty()) return false;

  snprintf(out.ssid, sizeof(out.ssid), "%s", ssid.c_str());
  snprintf(out.password, sizeof(out.password), "%s", pass.c_str());
  snprintf(out.serverUrl, sizeof(out.serverUrl), "%s", url.c_str());
  return true;
}

void clearCredentials() {
  prefs.begin(NAMESPACE, false);
  prefs.clear();
  prefs.end();
}

[[noreturn]] void runProvisioningPortal() {
  Serial.println("[setup] starting portal on SSID 'inkpanel-setup'");

  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(AP_SSID);
  dns.start(53, "*", WiFi.softAPIP());

  web.on("/", HTTP_GET, [] { web.send(200, "text/html", pageHtml()); });
  web.on("/save", HTTP_POST, handleSave);
  // Anything else redirects, which is what triggers the captive-portal prompt.
  web.onNotFound([] {
    web.sendHeader("Location", String("http://") + WiFi.softAPIP().toString());
    web.send(302, "text/plain", "");
  });
  web.begin();

  for (;;) {
    dns.processNextRequest();
    web.handleClient();
    delay(2);
  }
}
```

- [ ] **Step 2: Wire it into the sketch**

In `firmware/inkpanel/inkpanel.ino`, remove `#include "secrets.h"`, add `#include "Provisioning.h"`, and replace `connectWifi()` and the top of `setup()`:

```cpp
static Credentials credentials;

static bool connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(credentials.ssid, credentials.password);
  const uint32_t deadline = millis() + WIFI_TIMEOUT_MS;
  while (WiFi.status() != WL_CONNECTED && millis() < deadline) delay(200);
  return WiFi.status() == WL_CONNECTED;
}
```

And at the start of `setup()`, after `Serial.begin`:

```cpp
  // KEY3 held at boot wipes stored credentials.
  pinMode(Hardware::KEY3, INPUT_PULLUP);
  delay(50);
  if (digitalRead(Hardware::KEY3) == LOW) {
    Serial.println("[setup] KEY3 held — clearing credentials");
    clearCredentials();
    runProvisioningPortal();
  }

  if (!loadCredentials(credentials)) {
    Serial.println("[setup] no credentials stored — starting portal");
    runProvisioningPortal();
  }
```

Then replace every use of `SERVER_URL` with `credentials.serverUrl`.

- [ ] **Step 3: Verify provisioning**

Erase flash (**Tools → Erase All Flash Before Sketch Upload: Enabled**, upload once, then set it back to Disabled). On boot, the serial log should show the portal starting.

From a phone: join `inkpanel-setup`. A captive-portal prompt should appear; if not, browse to `http://192.168.4.1`. Pick your network, enter the password and the server address, save. The device restarts and fetches a frame.

Then hold KEY3 and press reset — it should clear credentials and return to the portal.

- [ ] **Step 4: Commit**

```bash
git add firmware/inkpanel/Provisioning.h firmware/inkpanel/Provisioning.cpp firmware/inkpanel/inkpanel.ino
git commit -m "feat(firmware): on-device WiFi provisioning and factory reset"
```

---

### Task 20: Hardware verification and documentation

**Files:**
- Create: `docs/hardware/verification.md`, `firmware/README.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything
- Produces: a signed-off checklist proving Spec 1 works on real hardware

- [ ] **Step 1: Write the checklist**

Create `docs/hardware/verification.md`:

```markdown
# Hardware verification

Run through this against real hardware before calling Spec 1 done. Record the
date and firmware version.

## Display
- [ ] Enrolment screen is legible end to end, no missing horizontal bands
- [ ] Dashboard renders: banner, four quadrants, footer
- [ ] Both Spec 2 slots show their hatched empty state, not blank white
- [ ] Text is crisp, not broken up — check the smallest labels
- [ ] Borders reach all four edges (no offset or wrap)
- [ ] Image is not mirrored or upside down

## Protocol
- [ ] First boot of an unknown device shows the enrolment screen
- [ ] Claiming it in the UI switches the panel to the dashboard
- [ ] An unchanged refresh logs `304` **and the panel does not flash**
- [ ] Changing a calendar event causes a refresh within one interval
- [ ] Stopping the server leaves the last image up, with backoff in the log
- [ ] Pulling WiFi leaves the last image up

## Power
- [ ] Deep sleep current matches `sleep-current.md`
- [ ] KEY1 wakes and refreshes immediately, logging `wake=button`
- [ ] KEY3 held at boot returns to the provisioning portal
- [ ] Battery percentage in the footer tracks a discharging cell

## Provisioning
- [ ] A factory-reset device presents `inkpanel-setup`
- [ ] Portal is usable from a phone
- [ ] Wrong password fails gracefully and retries rather than bricking

## Endurance
- [ ] Runs 48 hours unattended without intervention
- [ ] Record the battery drop over that window and extrapolate
```

- [ ] **Step 2: Write the firmware README**

Create `firmware/README.md`:

```markdown
# inkpanel firmware

## Board settings

Arduino IDE, **XIAO_ESP32S3_PLUS**:

- USB CDC On Boot: **Enabled**
- CPU Frequency: 240 MHz
- PSRAM: **OPI PSRAM**
- Erase All Flash Before Sketch Upload: Disabled (enable once when changing
  provisioning storage)

No external libraries are required.

## Before powering the panel

1. Disconnect power while handling the ribbon.
2. Insert the 24-pin ribbon the correct way round.
3. Set the EE04 jumper to **24 Pin**.
4. Close the connector latch fully.

## First run

The device starts a WiFi access point called `inkpanel-setup`. Join it from a
phone, choose your network, and enter your inkpanel server address. It then
restarts and shows an enrolment screen naming its own device ID — claim that
device in the web UI.

## Panel compatibility

This firmware drives a 7.5" 800x480 mono panel (GDEW075T7 / flex
`WFT0583CZ61`) using the **old** Waveshare V2 sequence. The current V2 driver
and GxEPD2's `GxEPD2_750_T7` will **not** drive it correctly. If your panel
shows nothing, confirm which revision you have before changing anything else.

## Buttons

- **KEY1** — wake and refresh now
- **KEY3 held at boot** — clear credentials and return to the setup portal
```

- [ ] **Step 3: Run the full suite one last time**

```bash
npm test && npm run check
docker compose build
```

Expected: every test passes, typecheck is clean, image builds.

- [ ] **Step 4: Work through the checklist on hardware**

Tick every box in `docs/hardware/verification.md`. Anything that fails is a bug to fix before Spec 1 is complete — do not tick optimistically.

- [ ] **Step 5: Commit and tag**

```bash
git add docs/hardware firmware/README.md README.md
git commit -m "docs: add hardware verification checklist and firmware guide"
git tag -a v0.1.0 -m "Spec 1: end-to-end panel"
git push origin main --tags
```

---

## Notes for the implementer

**Order matters less than you'd think.** Tasks 2–16 are server-side and can be
done with no hardware at all. Task 1 needs hardware but nothing depends on it
until Task 18. Tasks 17–19 need the panel.

**The fake-device CLI is your friend.** `npm run fake-device -- --once` writes
`frame.png`, which is exactly what the panel would show, down to the bit. Use it
constantly — it is far faster than a five-second e-paper refresh.

**If the panel shows nothing at all**, the problem is almost never this code. In
order of likelihood: the EE04 jumper is not on 24 Pin, the ribbon is reversed or
not fully seated, or `EPD_ENABLE` is not being driven high. Serial will report
`BUSY timeout` in all three cases.

**Do not "improve" the `OldV2EPD` init sequence.** It looks redundant in places.
It works. The current Waveshare V2 driver does not work on this panel.





