# inkpanel — Spec 1: End-to-end panel

**Date:** 2026-08-03
**Status:** Approved, ready for implementation planning
**Scope:** First of two specs. Spec 2 covers additional sources and sharing polish.

---

## 1. What we are building

A self-hosted dashboard for e-paper displays. A server fetches data, renders a
page, and reduces it to a 1-bit image. A battery-powered ESP32 panel wakes,
fetches that image, displays it, and sleeps.

Spec 1 delivers a working panel on a desk showing a real calendar and real
weather, running on battery, with multi-device support and no hardcoded
configuration. It deliberately front-loads every technical unknown that could
invalidate the design.

### Goals

- A panel that is genuinely useful every morning.
- Layout iterated in a browser, not reflashed.
- No credentials on the device.
- Someone who is not the author can clone the repo and set it up.
- Battery life measured in months, or an early, honest finding that it is not.

### Non-goals for Spec 1

Transport, bins, tasks, the location picker, per-device layout presets, and
open-source packaging polish. All deferred to Spec 2 — see §12.

---

## 2. Hardware

The reference build, and the only configuration that will be tested:

| Part | Detail |
|---|---|
| MCU | Seeed XIAO ESP32-S3 Plus |
| Carrier | Seeed XIAO ePaper Display Board (EE04), 24-pin jumper |
| Panel | 7.5" 800×480 monochrome, Good Display GDEW075T7, flex `WFT0583CZ61` |
| Driver | Waveshare "old V2" full-refresh sequence |

The existing `EE04_WFT0583CZ61_OldV2_Test` sketch already drives this panel
correctly and is the starting point for the firmware. Its `OldV2EPD` driver and
`MonoCanvas` framebuffer are carried over unchanged; `MonoCanvas`'s drawing
primitives and bitmap font become unused, since Spec 1 does no on-device
rendering.

**Panel revision matters.** This panel needs the *old* V2 initialisation
sequence — panel setting `0x00 = 0x3F`, LUT-from-register with five 42-byte
tables at `0x20`–`0x24`, BUSY active-low. Waveshare's current V2 driver and
GxEPD2's `GxEPD2_750_T7` will not drive it correctly. The existing init block
must be preserved verbatim.

---

## 3. Architecture

```
┌── Proxmox LXC (Debian) ──────────────────────────────────┐
│  Docker, from the official Playwright image              │
│                                                           │
│   sources/     ical + open-meteo → DashboardData         │
│   render/      DashboardData → HTML → Chromium → PNG     │
│   quantise/    PNG → 1-bit → 48,000-byte packed buffer   │
│   devices/     registry, per-device config, frame cache  │
│   http/        device API + config UI                    │
│                                                           │
│   volume: /data   (config.json, cached frames)           │
└───────────────────────────────────────────────────────────┘
                        ▲ plain HTTP over LAN
                        │
        ┌───────────────┴────────────────┐
        │  XIAO ESP32-S3 Plus + EE04     │
        │  wake → fetch → blit → sleep   │
        └────────────────────────────────┘
```

**Stack:** Node 22, TypeScript, Express, Playwright, `sharp`. Chosen to match the
author's existing tooling.

### Two decisions that shape everything

**The `304` path.** If the rendered buffer is byte-identical to what the device
is already showing, the server returns `304 Not Modified` and the panel does not
refresh at all. This avoids a five-second black-and-white flash and its power
cost. On a desk, a panel that flashes every fifteen minutes for no reason becomes
intolerable; this makes it flash only when something has actually changed.

**The server owns the schedule.** The device has no opinion about when to wake —
it obeys `X-Next-Wake-Seconds` from the last response. Cadence logic lives in
testable TypeScript and never requires reflashing. A device that cannot reach the
server falls back to a conservative built-in default and retries with backoff.

---

## 4. The render pipeline

Five stages, each independently testable.

### 4.1 Sources → `DashboardData`

Every source implements one interface:

```ts
interface Source<T> {
  id: string;
  fetch(config: SourceConfig, signal: AbortSignal): Promise<SourceResult<T>>;
}

type SourceResult<T> =
  | { status: 'ok';    data: T; fetchedAt: string }
  | { status: 'stale'; data: T; fetchedAt: string; error: string }
  | { status: 'error'; error: string };
```

Sources run in parallel, each with its own timeout, and never throw upward. A
failed fetch falls back to the last good value from the on-disk cache and is
reported as `stale`.

**Spec 1 sources:**

- **`ical`** — Google Calendar's per-calendar secret `.ics` address. No OAuth, no
  Google Cloud project. Accepts multiple URLs. Documented caveat: Google refreshes
  this feed lazily and newly created events may take hours to appear.
- **`openMeteo`** — current conditions, today's high/low, precipitation
  probability, wind, three-day forecast, sunrise/sunset. No API key.

**Highest-risk code in Spec 1 is iCal recurrence expansion.** `RRULE`, all-day
events, `EXDATE` cancellations and `VTIMEZONE` across DST boundaries are a
well-known source of subtle bugs. This gets fixture-driven tests written up
front, not retrofitted.

### 4.2 `DashboardData` → HTML

A template producing a standalone document sized for exactly 800×480. No
responsive CSS, no media queries, one fixed canvas.

**Fonts must be embedded as base64 data URIs.** A container has no reliable
system fonts; omitting this yields a perfect local preview and a panel rendered
in fallback Times.

### 4.3 HTML → PNG

Playwright with a **single long-lived Chromium instance**, not one launch per
render. Viewport 800×480, `deviceScaleFactor` 1, wait on `document.fonts.ready`,
then screenshot. The browser is restarted on crash.

### 4.4 PNG → 1-bit

> **Constraint: the panel stylesheet may not contain greys. Only `#000` and `#fff`.**

Thresholding a page that is already pure black and white is lossless — only
antialiased glyph edges need a decision. Any grey is a gamble on which side of
the threshold it lands. Anything that should *look* lighter uses a hatch or dot
pattern built from pure black and white via `repeating-linear-gradient`.

Dithering (Floyd–Steinberg) is reserved for photographic content and is not used
in Spec 1.

### 4.5 Pack for the device

1 bit per pixel, MSB = leftmost pixel, `1 = black`, 100-byte stride, 48,000 bytes
total. This is byte-for-byte the layout `MonoCanvas` already uses, so the
firmware copies the response straight into `display.framebuffer()`.

### 4.6 Content hashing and the timestamp trap

If the footer timestamp were the render time, every render would differ, the
ETag would always change, `304` would never fire, and the panel would flash
forever — defeating the design's best feature.

Therefore:

- The content hash **excludes volatile fields** (`generatedAt`, fetch times).
- The footer shows **when the content last changed**, not when it was last checked.
- A staleness marker appears only when a source is genuinely stale
  (e.g. "weather from 04:10").

Chromium therefore only runs when data has actually changed; most wake cycles
cost the server nothing.

---

## 5. Layout

**Layout B — banner and cards**, selected from three mocked alternatives.

- **Banner** (top ~132px): large date left; current temperature, conditions and
  today's high/low, rain probability and wind right.
- **Four quadrants** below a full-width rule:
  - Today's agenda (top-left)
  - Three-day forecast plus sunrise/sunset (top-right)
  - *Reserved for transport* (bottom-left) — Spec 2
  - *Reserved for bins and tasks* (bottom-right) — Spec 2
- **Footer** (34px): content timestamp left, battery right.

Spec 2's slots are laid out now so the page is not redesigned when those sources
arrive. In Spec 1 they render as designed empty states, not blank rectangles.

**Typography.** Dela Gothic One for display type — its heavy, closed forms
survive 1-bit thresholding cleanly where a thin geometric face would break up.
Inter for body text, tabular numerals for times.

**Each card has three appearances — normal, stale, and unavailable.** With four
visible quadrants, an undesigned missing source leaves an unexplained white
rectangle. These states are a design deliverable.

Empty and stale states are bound by the no-greys rule in §4.4. Anything that
should read as "dimmed" uses a hatch or dot pattern in pure black and white —
not opacity, and not a grey border. This applies to the reserved Spec 2 slots,
which are visible on the panel from day one.

---

## 6. Device protocol

The complete contract between server and firmware.

### 6.1 Fetch a frame

```
GET /api/devices/{deviceId}/frame

Request headers
  If-None-Match:       "<etag>"        optional, from last successful fetch
  X-Battery-Voltage:   4.02            volts
  X-Firmware-Version:  0.1.0
  X-Wake-Reason:       timer | button | boot | reset

200 OK
  Content-Type:        application/octet-stream
  Content-Length:      48000
  ETag:                "<sha256 prefix of buffer>"
  X-Next-Wake-Seconds: 900
  <48,000 raw bytes>

304 Not Modified
  ETag, X-Next-Wake-Seconds, no body

503 Service Unavailable
  X-Next-Wake-Seconds: 300
  Server not ready. Device must not redraw.
```

### 6.2 Enrolment

An unknown `deviceId` is auto-created as **unclaimed** and served an **enrolment
frame** — a rendered page reading *"New panel. Open &lt;server URL&gt; to set me up.
Device ID: esp32-a1b2c3"*.

The enrolment frame is an ordinary `200` response in the normal format: 48,000
bytes, with an ETag and `X-Next-Wake-Seconds`. The firmware needs no special
case for it. Unclaimed devices are given a short wake interval (default 60 s) so
the panel updates promptly once claimed.

The URL printed on the frame is the server's configured `PUBLIC_BASE_URL`,
falling back to the LAN IP and port the server is bound to. mDNS/`.local`
resolution is not assumed — it is unreliable across routers and OSes, and a
printed IP always works.

Setup instructions therefore appear on the panel itself, through the same render
path as everything else. No pairing codes, no serial monitor, no ambiguity about
which device is which.

### 6.3 Management API

```
GET  /api/devices                    list devices and health
GET  /api/devices/{id}               device config
PUT  /api/devices/{id}               update config
GET  /api/devices/{id}/preview       live HTML preview
GET  /api/devices/{id}/render.png    1-bit PNG, exactly what the panel shows
GET  /health                         liveness, last render, per-source status
```

`preview` and `render.png` side by side are the primary development loop:
the first shows intent, the second shows what quantisation actually did.

### 6.4 Panel profile

```ts
{
  id: 'wft0583-800x480-mono',
  width: 800, height: 480,
  bitDepth: 1, bitOrder: 'msb-first', inkBit: 1,
  stride: 100, bytes: 48000
}
```

Only this profile ships. Others are possible but untested, and untested
abstraction is worse than none.

---

## 7. Scheduling

The server computes `X-Next-Wake-Seconds` from rules evaluated in order:

1. **Battery below threshold** → long interval (default 6 h).
2. **Quiet hours** (default 23:00–06:00) → sleep until the active window opens.
3. **Default active interval** (default 15 min).

Pure function of `(now, deviceConfig, batteryVoltage)`, therefore directly
testable. Midnight and DST transitions get explicit test cases.

Event-aware wake — refreshing sooner when an event is imminent — is deliberately
deferred to Spec 2.

---

## 8. Configuration and storage

A single JSON file on the `/data` volume, written atomically via write-to-temp
and rename. Chosen over SQLite because writes are rare, a single process owns it,
it is human-readable and diffable, and it adds no native dependency. SQLite is
the documented upgrade path if device counts grow.

Secrets — calendar URLs in particular — live in this file, not in the repo.
`.env.example` documents every variable; `.env` and `/data` are gitignored.

---

## 9. Firmware

Built on the existing working driver. Three boot paths:

1. **No credentials in NVS** → SoftAP captive portal `inkpanel-setup`. The user
   joins it, selects their WiFi, and enters the password and server URL. This is
   not optional polish: a stranger cloning the repo cannot edit an SSID into a
   header file, so provisioning must happen on-device or the project is not
   actually shareable.
2. **Normal wake** → connect WiFi (15 s timeout) → `GET` with `If-None-Match` →
   act on response → deep sleep for `X-Next-Wake-Seconds`.
3. **KEY3 held at boot** → wipe NVS, return to captive portal.

**Response handling is deliberately dull.** `200` blits and stores the new ETag
in RTC memory, which survives deep sleep. `304` does nothing at all. Any failure
leaves the panel completely untouched and backs off exponentially. The worst case
is a slightly out-of-date page, never a blank one.

**No on-device rendering.** No fonts, no error screens, no drawing primitives. A
panel that cannot reach the server keeps showing its last good page; the web UI
is where a quiet device is discovered.

KEY1 wakes the device for an immediate refresh via `ext1`. GPIO 2, 3 and 5 are
all RTC-capable on the ESP32-S3, so this works.

### Pin mapping (unchanged)

| Signal | GPIO | | Signal | GPIO |
|---|---:|---|---|---:|
| SCLK | 7 | | BUSY | 4 |
| MOSI | 9 | | RST | 38 |
| CS | 44 | | ENABLE | 43 |
| DC | 10 | | KEY1/2/3 | 2 / 3 / 5 |

SPI at 4 MHz, mode 0. **`SPI.writeBytes()` replaces the current per-byte
`SPI.transfer()` loop**, which currently pushes 96,000 bytes one call at a time.

---

## 10. Failure behaviour

**Never send the device a broken frame, and never blank the panel.**

| Failure | Behaviour |
|---|---|
| One source fails, cache exists | Render cached data with a staleness marker on that card |
| One source fails, no cache | That card renders its designed *unavailable* state |
| All sources fail | Page still renders — date, battery, cards in empty states |
| Chromium crashes | Serve last good cached frame, log loudly, restart browser |
| Server unreachable | Device leaves panel untouched, exponential backoff |
| Device offline | Panel keeps last image; web UI shows last-seen |

---

## 11. Testing

| Layer | Approach |
|---|---|
| Source adapters | Fixture-driven, no network. iCal fixtures: weekly recurrence, all-day events, both DST transitions, `EXDATE`, multi-day spans, empty calendar |
| `DashboardData` normalisation | Pure function tests, including which events count as "today" across timezones |
| Quantiser | Exact-byte assertions plus a hand-computed example proving MSB-first and `1 = black` |
| Scheduling | Pure function tests; explicit midnight and DST cases |
| Render | Golden-image comparison against committed reference PNGs |
| HTTP contract | ETag/`304`, unknown-device enrolment, sane `X-Next-Wake-Seconds`, exactly 48,000 bytes |
| Firmware | Manual hardware verification checklist |

**Golden images must be generated inside the same container image CI uses.** Font
rasterisation varies across platforms and Chromium versions; goldens generated
elsewhere will flap until they are ignored, at which point they are worthless.

**A `fake-device` CLI** speaks the device protocol from a terminal. Roughly 95%
of this project can then be built and tested with no hardware powered on, and
device-side bugs become reproducible on a desk.

---

## 12. Security posture

**There is no authentication.** Anyone on the LAN can fetch a device frame or
reach the config UI. This is a deliberate choice for a home LAN appliance and
keeps enrolment friction at zero.

The README must state plainly: **do not expose this to the internet.** Anyone
needing remote access should use a VPN or a reverse proxy that provides its own
authentication. Optional token auth is a candidate for Spec 2.

---

## 13. Deployment

A Debian LXC on Proxmox running the service in Docker, built from the official
Playwright image. That base image matters — headless Chromium has a long tail of
missing shared libraries and sandbox failures in containers, and the Playwright
image already has them correct.

Roughly 1 GB RAM and 2 cores. Chromium is the only heavy component and runs for
a second or two per *changed* render.

---

## 14. Risks and open questions

**EE04 deep-sleep current is unknown and dominates battery life.** The estimates
below assume ~50 µA:

| | Estimate |
|---|---|
| Wake with full refresh | ~8 s awake, ≈0.22 mAh |
| Wake ending in `304` | ~4 s awake, no flash, ≈0.10 mAh |
| Deep sleep | ≈1.2 mAh/day |
| Total | ≈3.5 mAh/day → months on a 2000 mAh cell |

Carrier boards routinely have a power LED or regulator quiescent draw that
swamps the MCU's own ~7 µA. **If the EE04 idles at 2 mA, battery life collapses
from months to about a fortnight, and no firmware change recovers it** — the fix
would be hardware (cutting an LED, or a MOSFET on the panel rail).

**Measuring sleep current on real hardware is the first task in the
implementation plan**, before anything depends on the answer.

Secondary risks:

- **iCal recurrence correctness** — mitigated by fixtures written first.
- **Google's lazy `.ics` refresh** — accepted and documented; the escape hatch is
  proper OAuth in a later spec.
- **Thresholding legibility at small sizes** — mitigated by `render.png` in the
  dev loop and by forbidding greys.

---

## 15. Deferred to Spec 2

- Transport providers: train (National Rail Darwin), bus (Bus Open Data Service),
  traffic (drive time on a saved route)
- Milton Keynes bin collections
- Tasks
- Location picker with Open-Meteo geocoding
- Per-device layout presets
- Event-aware wake scheduling
- Optional token authentication
- Open-source packaging: Docker Compose, setup documentation, screenshots
