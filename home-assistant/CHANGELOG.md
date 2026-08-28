# Changelog

## 0.1.0-ha.12

- Add HA-5 personal Home Assistant To Do ownership keyed only by validated user IDs from the trusted Supervisor Ingress listener. LAN headers cannot forge an identity.
- Persist observed users and unique personal-list assignments in a separate version-1, atomic mode-0600 ownership store; retain corrupt originals and fail closed.
- Add current-user/scoped-list APIs and administrative Settings assignment management without task contents, user enumeration or broader Supervisor privileges. Explicitly retain `panel_admin: true`.
- Add To Do V3 fixed owner/entity configuration. Keep V1/V2 unchanged, label V2 HA as legacy shared, and require explicit Make personal/save conversion. Preserve provider drafts without sharing personal defaults across panels.
- Check ownership before and after live fetch; revoked/reassigned/unavailable ownership never fetches another list or replays stale tasks. Keep existing full-size/Mini To Do pixels and ETags.
- Only HA To Do is user-scoped. Calendar, Sensors, other sources, local To Do and panel configuration remain shared. Non-admin Studio is deferred to a dedicated permissions/redaction milestone.
- Synchronize App, Ingress query and image release at ha.12; retain complete release-versioned assets. No firmware, framebuffer, protocol, profile, DeviceStore version or frozen migration changes.

## 0.1.0-ha.11

- Real-world ha.10 Sensors worked over direct LAN, while Ingress retained older nested frontend modules. A release query on the document alone did not version stable JS/CSS/import URLs.
- Serve the complete Studio asset graph under `/assets/<image-release>/` without copying the public directory. HA index/login/legal documents reference this namespace; ordinary relative imports, dynamic imports and CSS dependencies inherit it.
- Keep document URLs and API/Ingress prefix resolution unchanged. Preserve root assets for standalone and legacy callers, normal `no-store` headers and immutable vendor fonts. Validate release metadata and never alias older release namespaces to current assets.
- Advance App, Ingress entry query and image release to ha.11. Keep Sensors architecture and physical layouts unchanged; HA-4 awaits final real-world Ingress/physical validation.
- No firmware, framebuffer, protocol, profile, DeviceStore version or frozen migration changes.

## 0.1.0-ha.10

- Add HA-4 Home Assistant Sensors: the first read-only generic entity-display milestone, supporting only `sensor.*` in the strict `entities` V1 widget with up to four ordered, unique selections.
- Discover safe sensor summaries through the authenticated HA client; fetch selected states concurrently through individual state endpoints. Strip unrelated attributes and keep Supervisor credentials server-only.
- Add HA-only searchable Studio selection, current values, ordering and missing-entity preservation using existing saved/per-slot/shared drafts.
- Add isolated full-size and Mini hero/row layouts. Preserve HA units, show honest partial/all-source unavailability and never replay persistent sensor data. Existing widget output remains unchanged.
- Advance App, Ingress entry and published image to the same ha.10 release while retaining BUILD_VERSION/INKPANEL_HA_RELEASE invariants and ha.9 freshness behaviour, now confirmed working in real-world testing.
- No firmware, framebuffer/protocol, profile, DeviceStore version or frozen migration changes. HA-4 awaits real-world validation; the branch remains experimental.

## 0.1.0-ha.9

- Real-world ha.8 testing confirmed that direct LAN Studio worked, while Home Assistant Ingress retained an older Studio document at its unchanged iframe entry URL.
- Set a release-specific, query-only `ingress_entry` so an App upgrade changes the iframe URL without changing its pathname or API/module base paths. CI enforces that the entry query and image version match the App version on every release.
- Preserve ha.8's normal Studio `no-store` policy, separate runtime capability/discovery handling and fresh initial/Push previews.
- Expose the image's non-secret build release in HA runtime config, shared by LAN and Ingress, for easy version comparison.
- No e-ink renderer/template/CSS, firmware, framebuffer/protocol, profile or DeviceStore/migration changes. HA-3 still awaits real-installation validation through Ingress after this release.

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
