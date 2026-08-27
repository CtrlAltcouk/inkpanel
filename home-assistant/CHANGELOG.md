# Changelog

## 0.1.0-ha.8

- Fix Studio/cache reliability issues discovered during real-installation HA-3 validation; HA-3 is not yet fully validated and needs retesting.
- Serve normal Studio assets with `Cache-Control: no-store`, without stale asset validators; keep intentional immutable vendor-font caching.
- Determine Calendar/To Do provider support from runtime deployment mode, independently of discovery availability. Temporary discovery failures keep the HA provider visible and saved entities intact.
- Use fresh preview URLs on initial open, save/reopen and Push so a claimed panel does not reuse an old enrolment preview. Keep server frame memoisation and preview `no-store` behaviour unchanged.
- No e-ink renderer/template/CSS, firmware, framebuffer/protocol, profile, DeviceStore schema or migration changes.

## 0.1.0-ha.7

- Add read-only Home Assistant To Do discovery and incomplete-item fetching through the server-only Supervisor client.
- Add To Do V2 local/Home Assistant provider selection without rewriting V1 records or changing DeviceStore schema/migrations.
- Preserve both Calendar and To Do provider drafts across switching, saved per-slot settings and shared fallbacks.
- Keep local To Do CRUD, full-size/Mini visual layouts and firmware unchanged; HA task lists are live-only, not stale-cached.
- HA-1, HA-2 and ha.6 location defaults are real-hardware validated. HA-3 awaits real-installation validation.

## 0.1.0-ha.6

- Seed newly enrolled full-size and Mini panels from the validated Home Assistant installation latitude, longitude, timezone and location name.
- Keep existing panels and manual Studio location choices unchanged; standalone defaults and frozen migrations are unchanged.
- Return a retryable error without creating a device if first-enrolment installation location is unavailable or invalid.
- HA-1 and HA-2 native Calendar are validated on real Home Assistant hardware. No renderer, firmware or framebuffer changes.

## 0.1.0-ha.5

- Add native Home Assistant Calendar discovery and multi-calendar selection through the server-only Supervisor client.
- Add Calendar widget V2 provider selection while preserving existing V1/iCal configurations and renderers.
- Preserve widget versions in Studio drafts and remembered settings.
- Normalize panel-local dates and use isolated per-calendar stale caches with deterministic event ordering.
- HA-1 is validated; HA-2 awaits real-world validation. No firmware changes.

## 0.1.0-ha.4

- Let Home Assistant own App updates: remove the standalone updater UI and reject its mutation endpoint.
- Show update ownership in Settings without changing standalone deployments.

## 0.1.0-ha.3

- Include verified full-size and Mini production firmware packages in the App image.
- Make the Home Assistant Ingress WebFlash handoff clearer.

## 0.1.0-ha.2

- Use the current Home Assistant App image label.
- Always move WebFlash from Ingress to the direct secure InkPanel Studio.

## 0.1.0-ha.1

- Add the first Home Assistant App package for amd64 and aarch64.
- Add Studio support for arbitrary Ingress path prefixes.
- Keep panel HTTP and WebFlash HTTPS available as explicit LAN services.
- Add a safe Home Assistant Core connection status in Settings.
