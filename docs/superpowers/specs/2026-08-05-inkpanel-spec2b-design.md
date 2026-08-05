# inkpanel — Spec 2b: Train departures and bin collections

**Date:** 2026-08-05
**Status:** Approved, ready for implementation planning
**Follows:** [Spec 2a](2026-08-04-inkpanel-spec2a-design.md), merged and running.

---

## 1. What this is

The panel has two quadrants reserved since Spec 1, both currently showing a
hatched "coming soon" box. This spec fills them: **train departures**
bottom-left, **bin collections** bottom-right.

After this, nothing on the panel says "coming soon".

### Explicitly not in this spec

| Deferred | Why |
|---|---|
| Bus departures | Bus Open Data Service needs registration and is a substantially chunkier dataset |
| Traffic drive time | Every routing provider needs a paid-tier key, so every person cloning the repo hits a signup wall |
| Tasks | Has no source. The original choice was Home Assistant's to-do list, and HA was dropped in Spec 1 in favour of the secret iCal URL. Needs a design decision before it needs code. |
| Per-device layout presets | Not needed while every panel shows the same four things |
| Event-aware wake scheduling | Independent of this work |

**No transport mode switcher.** The original request was a train/bus/traffic
selector. With bus and traffic deferred, a selector with one option is
scaffolding for a future that may not arrive. The `Source` interface is already
the abstraction that makes adding bus straightforward; the field arrives with
the mode that needs it.

---

## 2. Architecture

Two new sources implementing the existing `Source<TConfig, TData>` interface,
run through the existing `runSource` — which already provides an 8-second
timeout, a disk cache, and stale-fallback-on-failure. Nothing structural is new.

```
src/sources/train.ts       origin + destination → next departures
src/sources/bins.ts        UPRN → next collection and which bins
src/sources/stations.ts    bundled CRS lookup, no network
data/stations.json         ~2,500 CRS codes, committed
```

### The train protocol is contained in one file

At the time of writing it is **not yet known** whether National Rail's Rail Data
Marketplace serves the Live Departure Boards product as REST/JSON or as SOAP.
The repo owner is registering to find out.

That uncertainty is deliberately confined to `src/sources/train.ts`, behind:

```ts
fetch(config: TrainConfig, signal: AbortSignal): Promise<SourceResult<TrainData>>
```

Everything else — the model, the template, the config UI, the tests — is written
against `TrainData` and is protocol-agnostic. The answer changes one file.

**If it turns out to be SOAP-only**, the fallback is Darwin's OpenLDBWS with a
single small XML parser added as a dependency. That knowingly relaxes the
project's no-new-dependencies rule, once, because hand-rolled XML extraction on
a live feed would be the most fragile code in the repo. The rule is a value
worth keeping, not a law worth breaking the product over — and the reason gets
recorded at the point of the exception.

### The station list is bundled, not fetched

Roughly 2,500 CRS codes as a committed JSON file. The picker filters instantly,
works offline, and costs no API quota. Station codes change perhaps annually; a
slightly stale entry is a far smaller problem than a lookup that can fail while
someone is trying to configure their panel.

### Bins is a JSON API, not scraping

Two calls, both plain `fetch`, no dependencies:

1. `GET mycouncil.milton-keynes.gov.uk/authapi/isauthenticated?…` → session id
2. `POST mycouncil.milton-keynes.gov.uk/apibroker/runLookup?id=64d9feda3a507&sid=…`
   with `{ formValues: { "Section 1": { uprnCore: { value: UPRN } } } }` → JSON

Approach derived from [`MiltonKeynesCityCouncil.py`](https://github.com/robbrad/UKBinCollectionData/blob/master/uk_bin_collection/uk_bin_collection/councils/MiltonKeynesCityCouncil.py)
in the UKBinCollectionData project — Python, so the approach is ported rather
than the code reused.

**This is an undocumented internal endpoint.** The `id=64d9feda3a507` is a form
identifier baked into MK's own web form. It can change without warning and break
bins silently. It is not a stable contract and the spec does not pretend
otherwise: expect to repair this occasionally. The source pattern degrades
correctly when it happens (§5), so the panel will say bins are unavailable
rather than showing a stale date as though it were current.

---

## 3. What the quadrants render

Selected from three mocked alternatives at true 800×480 size. Each cell is
roughly 400×155, which is the binding constraint.

### Bottom-left — train departures

```
MKC → EUSTON
07:42   On time            Plat 3
08:01   07:58  9 late      Plat 1
08:19   On time            Plat 3
```

**Up to three** departures — fewer if the API returns fewer, which happens late
at night and during severe disruption. One departure is a valid render, not an
error; zero departures with a successful fetch renders `No departures` rather
than the unavailable state, because "the API worked and there are no trains" is
different from "we could not ask".

The **time is the largest element**, because it is the thing being looked for. A
delay renders the original time struck through beside the new one, so disruption
is visible without reading — which matters on a 1-bit panel with no colour to
lean on. Platform right-aligned, omitted when the API does not supply one rather
than rendering an empty column.

Cancelled services show the time struck through with `Cancelled` in place of the
status, and no platform.

### Bottom-right — bin collections

```
BINS
WED 6 AUG
▨ Recycling
⣿ Food waste
```

Date large, then which bins are due. Bin types are distinguished by **fill
pattern, not colour** — because the panel is pure black and white. Patterns are
built from `#000` and `#fff` via `repeating-linear-gradient` /
`radial-gradient`, per the stylesheet rule that has applied since Spec 1.

**Pattern assignment must be deterministic and must not depend on MK's exact
wording.** The council API returns free-text bin descriptions that can change
without notice. The mapper normalises each to a known type by keyword —
`recycl` → recycling, `food` → food, `garden`/`green` → garden, everything else
→ general — and each type has a fixed pattern, so the same bin always looks the
same week to week. An unrecognised description renders with the general pattern
and its own text rather than being dropped: showing an unfamiliar bin is better
than silently omitting one that needs putting out.

Only the **next** collection is shown, not the full schedule. The cell has room
for a date and two or three bin types with type large enough to read at arm's
length; a full four-week schedule does not fit legibly.

---

## 4. Refresh behaviour — an accepted cost

**Live departures will make the panel refresh on most wakes during the day.**

Departure times are drawn on the panel, so they are part of the content hash. As
trains depart and delays update, that hash changes — realistically on most wakes
between 06:00 and 23:00. Today the panel refreshes only when the calendar or
weather changes, a handful of times daily. At a 15-minute interval this moves to
roughly 68 refreshes a day rather than a dozen.

Two consequences: more battery — each refresh costs about 0.22 mAh against 0.10
for a `304` — and more visible flashing.

**This is accepted deliberately.** A departure board showing stale times is
worse than no departure board. It is not a defect to engineer around; it is what
live data costs. Quiet hours already suppress it overnight, and the per-panel
interval remains adjustable.

It does mean the `304` mechanism, which exists to stop needless refreshes, will
fire much less often on a panel with trains configured. That is the correct
outcome, not a regression.

The sleep-current measurement in `docs/hardware/sleep-current.md` is still an
unfilled form, so the battery impact cannot be quantified. Worth revisiting once
it is.

---

## 5. Failure behaviour

Unchanged from the established pattern. Each quadrant has four appearances:

| State | Appearance |
|---|---|
| ok | Data as above |
| stale | Data with an age badge, e.g. `from 06:15` |
| unavailable | Hatched box: `Trains unavailable` / `Bins unavailable` |
| not configured | Hatched box: `Trains — not set up` / `Bins — not set up` |

Bins failing is the likely case in practice, given §2. When it does, the panel
must say so rather than presenting a stale collection date as current — putting
the wrong bin out is a worse outcome than knowing the data is missing.

A source with no configuration is distinct from a source that failed, and reads
differently. Empty is not the same as broken.

---

## 6. Configuration

`DeviceRecord` gains three optional fields, all empty by default so existing
`config.json` files load unchanged and each quadrant falls back to its
not-configured state:

| Field | Type | Purpose |
|---|---|---|
| `trainOriginCrs` | `string` | Origin station CRS code, e.g. `MKC` |
| `trainDestinationCrs` | `string` | Destination CRS code, e.g. `EUS` |
| `binsUprn` | `string` | Unique Property Reference Number |

**Station fields** use the same type-ahead component as the city picker, but
against the bundled CRS list — filtering happens locally with no request.

**The UPRN field** is a plain text input with a short explanation and a link to
where one can be found. This is deliberately the least clever option: the
alternative, a postcode-to-address lookup, means reverse-engineering a *second*
undocumented MK endpoint and doubling the surface that can silently break, to
save a one-time copy and paste.

Validation: CRS codes are three uppercase letters and must exist in the bundled
list. A UPRN is up to 12 digits.

---

## 7. Testing

| Layer | Coverage |
|---|---|
| Train mapper | Fixture → `TrainData`: on time, delayed, cancelled, no services, missing platform |
| Bins mapper | Fixture → `BinsData`: single bin, multiple bins, no upcoming collection, malformed response |
| Station lookup | CRS→name, name→CRS, unknown code, case-insensitive search |
| Template | All four states per quadrant (ok, stale, unavailable, not configured); no-greys guard still passes |
| Config | CRS validation rejects unknown codes; UPRN validation rejects non-numeric |
| Contract | Both sources return `SourceResult`, never throw, and degrade to stale via `runSource` |

**No test may call the real National Rail or MK council APIs.** Both are
fixture-driven, consistent with the rule established for Open-Meteo in Spec 2a —
a suite that fails offline or depends on a council's uptime is worse than no
suite.

Golden-image coverage extends to a panel with all four quadrants populated.

---

## 8. Open item at time of writing

**The train API protocol.** Whether Rail Data Marketplace serves REST/JSON or
SOAP determines the implementation inside `src/sources/train.ts` and whether one
XML-parsing dependency is added. Everything else in this spec is settled and
independent of the answer.

The implementation plan should sequence `train.ts` after the answer is known, or
write it against a fixture first and fill the transport in once confirmed.
