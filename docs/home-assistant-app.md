# Home Assistant App architecture

Status: Phase 1 architecture decision for the `Home-Assistant` branch.

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

### Phase HA-1 — App/runtime foundation

- Home Assistant repository metadata and App metadata.
- `/data` persistence.
- Ingress-compatible browser path handling.
- secure panel-facing LAN URL boundary.
- Home Assistant runtime detection and client.
- authenticated health/status diagnostics in Settings.
- CI validation for standalone mode and Home Assistant mode.

No existing widget should change source in this phase.

### Phase HA-2 — Home Assistant Calendar

Extend Calendar configuration with a provider choice:

- existing iCal URLs;
- Home Assistant calendar entity/entities.

Home Assistant mode should discover `calendar.*` entities and read events using Home Assistant's calendar API. The existing normalized InkPanel Calendar data/rendering should be reused where possible so selecting HA does not create a second visual design.

Existing iCal behaviour remains unchanged.

### Phase HA-3 — Home Assistant To Do

Extend To Do configuration with a provider choice:

- existing InkPanel local named list;
- Home Assistant `todo.*` entity.

Use `todo.get_items` for incomplete items. Preserve InkPanel's current local-list store and editing behaviour.

A later milestone may allow add/update/complete/delete actions against Home Assistant lists from Studio. The first HA To Do milestone may be read-only if that reduces integration risk.

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
