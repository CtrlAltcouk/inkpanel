# Home Assistant App architecture

Status: HA-1, HA-2 and ha.6 installation-location defaults are implemented and validated on real Home Assistant hardware. HA-3 read-only Home Assistant To Do is implemented in `0.1.0-ha.7` and awaits real-installation validation on the `Home-Assistant` branch.

InkPanel remains a standalone product. Home Assistant support is an additional deployment and data-provider layer; it must not make the normal Docker/Proxmox/Raspberry Pi installation depend on Home Assistant.

## Product goals

1. Package InkPanel as a Home Assistant App (the current Home Assistant name for an add-on).
2. Make the InkPanel Studio available through Home Assistant Ingress.
3. Keep physical ESP32 panels able to reach the InkPanel frame endpoint over the LAN.
4. Use Home Assistant Core as an optional native data provider without requiring a manually-created long-lived access token when InkPanel is running as an App.
5. Add Home Assistant-backed Calendar and To Do choices while retaining InkPanel's existing iCal and local To Do sources.
6. Add a generic Home Assistant Entities widget for sensors and other useful entity state.
7. Preserve the existing firmware, framebuffer profiles, standalone deployment and existing source providers unless a change is explicitly required and regression-tested.

## Supported deployment modes

### Standalone

Existing behaviour remains authoritative:

- Node/Express application
- `DATA_DIR` defaults to `./data` or `/data` in Docker
- direct HTTP panel/API listener
- optional self-signed HTTPS listener for WebSerial
- optional InkPanel password/session authentication
- existing provider stores and source integrations

No Home Assistant environment or token is required.

### Home Assistant App

Home Assistant Supervisor runs InkPanel as a container.

The App will:

- use `/data` for all InkPanel persistent state so Home Assistant backups include it;
- enable `homeassistant_api: true`;
- receive `SUPERVISOR_TOKEN` at runtime;
- talk to Home Assistant Core through `http://supervisor/core/api/`;
- expose the Studio through Ingress;
- expose a LAN-reachable panel endpoint separately from the Ingress browser path;
- not ask the user to copy a Home Assistant long-lived token.

The App image is built for `amd64` and `aarch64` from the same Playwright base used by standalone InkPanel.

## Critical network boundary: Ingress is not the panel URL

Home Assistant Ingress is for an authenticated browser session. ESP32 panels cannot use an Ingress URL.

Therefore Home Assistant mode has two distinct concepts:

1. **Admin/Studio URL** — Home Assistant Ingress, authenticated by Home Assistant.
2. **Panel base URL** — a normal LAN-reachable InkPanel URL used by ESP32 firmware for `/api/devices/:id/frame`.

`PUBLIC_BASE_URL` in Home Assistant mode must represent the panel-facing LAN address, not the Ingress path.

The current application auto-detects a non-loopback interface for `PUBLIC_BASE_URL`. Inside a Home Assistant container that may be a container/bridge address and therefore cannot be trusted as the ESP32-visible URL. Home Assistant packaging must provide an explicit or reliably discovered panel base URL.

## Ingress compatibility

The current frontend contains root-absolute requests such as `/api/...` and root-absolute image URLs. Those cannot be assumed to work correctly behind an arbitrary Ingress path prefix.

Before enabling Ingress for production, browser requests must become base-path aware. The implementation should use one central browser API/path helper rather than patching each widget ad hoc.

Login redirects must also be base-path aware.

Ingress authentication must not accidentally make the LAN admin interface unauthenticated. The implementation must preserve an explicit trust boundary between Home Assistant-authenticated Ingress traffic and normal LAN traffic.

## Home Assistant authentication

When running as a Home Assistant App:

- `SUPERVISOR_TOKEN` is server-side only;
- it is sent as `Authorization: Bearer <token>` to the Home Assistant Core proxy;
- it must never be returned to the InkPanel browser, DeviceStore, remembered settings, source cache, framebuffer, logs or ESP32 firmware;
- missing/invalid Supervisor credentials must degrade Home Assistant-backed widgets to a clear unavailable/not-configured state without breaking standalone InkPanel sources.

Standalone mode may later support an optional manually-configured HA URL/token, but this is explicitly outside the initial App milestone.

## Home Assistant client

Add one shared server-side Home Assistant client rather than implementing separate HTTP code in each widget.

Initial responsibilities:

- health/config probe;
- list/read entity states;
- list calendar entities and read events;
- call response-returning actions such as `todo.get_items`;
- bounded request timeouts;
- validation of response shapes;
- safe errors without token reflection;
- test seams for deterministic fixtures.

Potential later responsibility:

- WebSocket subscriptions for change-driven invalidation or richer discovery.

V1 should prefer simple HTTP snapshot reads because InkPanel renders on demand and e-paper panels do not need a continuously streaming backend to function.

## Provider roadmap

### Phase HA-1 — App/runtime foundation (complete)

- Home Assistant repository metadata and App metadata.
- `/data` persistence.
- Ingress-compatible browser path handling.
- secure panel-facing LAN URL boundary.
- Home Assistant runtime detection and client.
- authenticated health/status diagnostics in Settings.
- CI validation for standalone mode and Home Assistant mode.

Validated on a real Home Assistant installation: Ingress and authenticated LAN Studio, Supervisor API, direct HTTPS WebFlash, full-size/Mini firmware flashing and enrolment, and Home Assistant-owned updates. Standalone remains independent.

### Phase HA-2 — Home Assistant Calendar (implemented and validated on real hardware)

Extend Calendar configuration with a provider choice:

- existing iCal URLs;
- Home Assistant calendar entity/entities.

Studio discovers `calendar.*` entities using authenticated `/api/home-assistant/calendars`. Only entity IDs, friendly names, support/availability and safe errors reach the browser. Select up to ten calendars in the Calendar card and click Save changes. Missing saved IDs remain selected and are labeled missing/unavailable. Standalone exposes only the iCal choice; no long-lived token is required in the App.

Existing iCal behaviour remains unchanged.

#### Versioning and remembered drafts

Calendar V1 remains exactly `{ type: "calendar", version: 1, config: { calendarUrls: [...] } }`. No DeviceStore migration runs. V1 and V2 iCal both use the existing `runCalendars()` path, including its SSRF protections and recurrence expansion.

Calendar V2 uses a strict provider union:

```json
{ "type": "calendar", "version": 2, "config": { "provider": "ical", "calendarUrls": ["https://example.com/feed.ics"] } }
{ "type": "calendar", "version": 2, "config": { "provider": "home-assistant", "entityIds": ["calendar.family", "calendar.work"] } }
```

Provider fields cannot be mixed. IDs must match `calendar.[a-z0-9_]+`, duplicates are rejected and both lists have a maximum of ten. Studio preserves each widget's version with its configuration: loading V1 or saving unrelated settings never upgrades it. Explicit provider changes produce V2 and keep V2 thereafter. Active > slot > shared > default precedence is unchanged; provider-specific drafts are retained while switching in the editor. Empty provider selections do not replace a useful shared preference. Saved preferences contain IDs/URLs, never Supervisor credentials.

#### Client, dates and normalization

The shared server-only `HomeAssistantClient` calls relative `calendars` and `calendars/<encoded entity ID>` paths under the existing `/core/api/` base, using its existing bearer token and timeout handling. IDs are revalidated before requests; redirects are refused and API JSON is runtime-validated. Unknown event attributes, description and location are discarded. Home Assistant owns recurrence expansion; InkPanel does not expand RRULEs for this provider. The endpoints follow the [official HA REST calendar API](https://developers.home-assistant.io/docs/api/rest/#get-apicalendars).

A bounded four-UTC-day envelope brackets today and tomorrow in the panel's timezone, including extreme UTC offsets and DST transitions. Timed events are classified by their panel-local start date, matching the existing iCal display semantics. Date-only events use their authored dates directly and span each selected date before their exclusive end; they never shift through UTC conversion. The provider returns the existing `CalendarData`/`CalendarEvent` contract. Titles are trimmed with `(no title)` fallback; missing/invalid UIDs get a deterministic entity/start/end/title digest. Stable sorting removes API-order changes. UIDs and unrelated HA metadata do not affect frame hashes.

#### Cache and failure isolation

Selected calendars are fetched concurrently and independently through `SourceCache`, source ID `home-assistant-calendar`. Each key includes the device, a non-secret digest of the normalized HA API base (instance), entity ID and bounded query window. App `/data` separates installations. No token is included in the key or data. Changing instance endpoint, entity, device or date window cannot reuse a different logical source's data. A disabled/unconfigured HA client cannot replay HA cache.

Within the same window, temporary failures reuse validated last-good raw events and report stale health. Crossing the date window intentionally does not replay incomplete previous-day data. Partial failures retain other calendars' events and report an aggregate count; all unavailable means Calendar unavailable. Other widget sources continue independently.

The full-size 800×480 and Mini 200×200 renderers are unchanged. Only their source of `CalendarData` changes. Firmware, provisioning, schedules and panel protocol are unchanged. Experimental images are published as `ghcr.io/ctrlaltcouk/inkpanel-home-assistant:0.1.0-ha.7` for linux/amd64 and linux/arm64.

#### First-time panel location defaults (ha.6; validated on real hardware)

In Home Assistant App mode, an unknown panel's first enrolment reads the installation location from `/api/config` through the server-only `HomeAssistantClient.installationLocation()` method. Latitude (-90..90), longitude (-180..180), a valid IANA timezone and a non-empty location name are validated and projected into `latitude`, `longitude`, `timezone` and `locationLabel`. Full-size panels retain four dashboard slots; Mini panels retain one.

The deployment adapter supplies an optional generic location-defaults provider to the HTTP enrolment flow. DeviceStore has no Home Assistant dependency: it applies only those four fields to a new profile-specific default record and validates the complete current record before writing. Historical migration/default schemas are unchanged; no schema bump is required.

Known devices never request installation location and are never automatically updated when HA's location changes. Manual per-panel Studio settings remain authoritative. If HA is unavailable or returns invalid location data for an unknown panel, enrolment returns HTTP 503 with a 300-second retry interval and writes no device. It does not silently fall back to historical location defaults. Standalone enrolment remains unchanged. Supervisor credentials and unrelated HA config fields are never included in the seed or HTTP response.

After upgrading to ha.6, validate a genuinely new panel of each size against the installation location in Home Assistant. Existing panels intentionally retain their saved location; update those manually in Studio if necessary. Check that a manual location edit survives subsequent wakes, and that a known panel continues to receive frames during a temporary HA API outage (individual HA-backed widgets retain their existing unavailable/stale semantics).

### Phase HA-3 — Home Assistant To Do (implemented; awaiting real-world validation)

To Do V2 adds a strict provider choice while existing To Do V1 records remain valid, local, and unchanged on load or unrelated saves:

- `{"type":"todo","version":2,"config":{"provider":"local","listId":"..."}}`
- `{"type":"todo","version":2,"config":{"provider":"home-assistant","entityId":"todo.shopping_list"}}`

An empty selection is allowed as not set up. HA entity IDs must match `^todo\.[a-z0-9_]+$` (maximum 255 characters). Local list-ID validation is unchanged. No DeviceStore schema bump or frozen migration/default change is involved.

#### Server-only API and live data

The shared `HomeAssistantClient` discovers lists using `GET states`, validating the envelope and projecting only To Do entity IDs and friendly names (or readable fallback names). The authenticated InkPanel endpoint `GET /api/home-assistant/todo-lists` returns these safe choices. Standalone returns `supported: false` without contacting HA.

Items use the official [`todo.get_items` action](https://www.home-assistant.io/actions/todo.get_items/) via `POST services/todo/get_items?return_response`, with JSON `{"entity_id":"todo.example","status":"needs_action"}`. This follows the [REST response-producing service contract](https://developers.home-assistant.io/docs/api/rest/#post-apiservicesdomainservice). The existing normalized Supervisor base, bearer authentication, redirect rejection, timeouts, cancellation and safe errors are shared by GET and JSON POST requests.

The selected entity's `service_response` is validated. Only non-empty trimmed `needs_action` summaries, in HA order and limited to five, become the existing `TodoData` (`{ items: string[] }`). UIDs, descriptions, due metadata, arbitrary state attributes and credentials do not enter rendering or caching.

FrameService uses a live-only source: no persistent last-good task list is replayed. A configured entity remains configured during an outage, with null data and diagnostic error health. Other widgets continue independently. Duplicate identical To Do sections share the existing per-frame request promise. Empty lists use the existing ALL DONE state; absent selections and unavailable data retain the existing renderer semantics. Full-size and Mini visual templates, framebuffer sizes and firmware are unchanged. Only visible item text/order affects the existing pixel hash.

#### Studio and remembered settings

In App mode the Provider selector offers **InkPanel list** and **Home Assistant**. InkPanel retains its complete existing local list/task editor and immediate CRUD persistence. HA mode shows only a list selector and read-only help: manage tasks in Home Assistant. Provider/entity selection is panel configuration and requires **Save changes**. Local task-content edits retain their separate preview-refresh/dirty-state behaviour.

Calendar and To Do share provider draft handling. Active widget drafts retain their associated versions; explicit provider switches save V2. Both provider choices survive switching widget types, saving/reloading, and per-slot/shared remembered settings. The separate editor-preferences store accepts one entry per widget/provider (legacy one-per-type entries remain readable), with the active choice first and useful shared fallbacks retained independently. This is convenience state, not a DeviceStore migration.

Missing or removed HA entities are shown as missing/unavailable without clearing the saved ID. Syntax is sufficient for saving HA config; discovery availability is never required to read/save an existing panel. Local V1/V2 selections still require a real TodoStore list when saved.

#### Real-installation validation for ha.7

1. Upgrade the App to ha.7 and open Studio through Ingress.
2. Select To Do → Home Assistant, choose a list, and save on a full-size panel and a Mini.
3. Verify the first five incomplete items match HA ordering, then complete/add/reorder items in HA and wake the panel or refresh its preview.
4. Complete all items and verify ALL DONE. Temporarily make the source unavailable and verify no stale task list is replayed and unrelated widgets remain usable.
5. Switch to InkPanel list and back, save/reopen, and verify both selections survive. Existing local CRUD and Calendar provider choices should remain intact.
6. Remove a selected HA entity and verify Studio retains its missing selection until explicitly changed.

Future HA write support (`todo.add_item`, `todo.update_item`, `todo.remove_item`) is a separate milestone. ha.7 exposes none of those actions from Studio.

### Phase HA-4 — Home Assistant Entities

Add a generic widget type such as `home_assistant` or `ha_entities`.

It should allow selecting useful entities from Home Assistant and display normalized rows such as:

- entity friendly name;
- state;
- unit of measurement where applicable;
- optional icon/category metadata used only by Studio, not required by the monochrome framebuffer.

Initial supported domains should prioritize display-oriented state:

- `sensor.*`
- `binary_sensor.*`
- `weather.*`
- `climate.*`
- `person.*`
- `lock.*`
- `alarm_control_panel.*`

The data model must be generic enough that additional domains can be enabled later without a DeviceStore migration.

Example physical content:

```
HOME
------------------------
Living room       21.4 C
Outside             16 C
Solar             2.8 kW
House             1.3 kW
Battery              78%
Front door         LOCKED
```

Mini should use a reduced single-focus or short-list layout rather than attempting to mirror a large full-size list blindly.

### Phase HA-5 — richer Home Assistant capabilities

Possible later work:

- weather provider sourced from `weather.*`;
- energy/power presets built from selected sensors;
- person/presence summary;
- door/window/security summary;
- change-driven server invalidation through the HA WebSocket API;
- safe Studio actions where interaction is genuinely useful.

These must remain optional and additive.

## Data and hashing rules

Home Assistant-backed data follows the same e-paper rules as existing widgets:

- hash only values that are visibly rendered;
- do not hash HA timestamps, contexts or hidden attributes merely because they changed;
- unchanged visible state preserves the existing ETag/304/no-refresh behaviour;
- one unavailable HA entity should not unnecessarily break unrelated widgets;
- stale behaviour must be chosen per provider. Security/door state should not silently display old values as current; calendar semantics may differ.

## Persistence

Home Assistant entity IDs/provider selections may be stored in widget config/remembered preferences because they are not secrets.

Never persist `SUPERVISOR_TOKEN`.

App runtime state remains under `/data`, including the existing:

- `config.json`;
- source cache;
- remembered editor preferences;
- local To Do lists;
- printer connections;
- managed provider credentials;
- session secret;
- generated HTTPS material if still required in HA mode.

## Firmware compatibility

Home Assistant integration should require no ESP32 firmware protocol change.

Both existing hardware profiles remain authoritative:

- `wft0583-800x480-mono` — 800x480 / 48,000 bytes / four widgets;
- `ssd1681-200x200-mono` — 200x200 / 5,000 bytes / one widget.

The server continues to render normalized widget data into the existing frame protocol.

## App repository/package shape

Current Home Assistant requires `repository.yaml` at the repository root for an App repository. The InkPanel App itself should live in a dedicated folder so the existing application source can remain at repository root.

Preferred production distribution is a pre-built multi-architecture image in GHCR rather than asking every Home Assistant host to compile Chromium and Node dependencies locally.

Repository shape:

```
repository.yaml
home-assistant/
  config.yaml
  README.md
  DOCS.md
  CHANGELOG.md

Dockerfile.home-assistant
src/
public/
firmware/
...
```

The App `config.yaml` references `ghcr.io/ctrlaltcouk/inkpanel-home-assistant`. The existing root Dockerfile remains the standalone image; `Dockerfile.home-assistant` and the startup adapter add App packaging without duplicating the application source tree.

The App starts three deliberately separate listeners:

- internal port `8099` is the Ingress Studio and accepts only Supervisor proxy traffic;
- LAN HTTP port `8080` retains InkPanel password/session authentication and serves physical panel frames;
- LAN HTTPS port `8443` retains the secure WebFlash Studio.

The App options adapter requires `panel_base_url` and `lan_password`, sets `/data` persistence, and obtains Home Assistant API authority exclusively from the runtime `SUPERVISOR_TOKEN`.

## WebFlash note

Home Assistant Ingress does not remove WebSerial's browser secure-context requirement. The existing InkPanel HTTPS/WebFlash path must be validated on a real Home Assistant installation before it is declared supported through Ingress.

The Ingress Flash tab remains present. When WebSerial is unavailable there, it links to the active direct HTTPS Studio root instead of trying to flash inside Ingress or guessing an address. Both existing firmware targets remain available through that direct Studio.

## Acceptance gates

Before merging Home Assistant work back toward `main`:

1. Standalone CI remains green.
2. Existing 7.5-inch and Mini firmware builds remain green.
3. Home Assistant App metadata validates.
4. App starts with `/data` persistence.
5. Studio loads correctly through a non-root Ingress prefix.
6. ESP32 frame requests work through the separate LAN panel URL.
7. Supervisor token is never exposed to browser/API responses/logs.
8. HA connection status can be diagnosed from Settings.
9. At least one real Home Assistant entity can be read from the user's installation before building higher-level widgets.
10. Existing non-HA widgets remain fully usable in the Home Assistant deployment.
