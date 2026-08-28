# InkPanel

InkPanel turns an ESP32-S3 e-paper display into a configurable dashboard. This Home Assistant App runs the same InkPanel server and Studio as the standalone installation.

This `0.1.0-ha.12` release is experimental. Add
`https://github.com/CtrlAltcouk/inkpanel#Home-Assistant` as a Home Assistant App repository to test it.

The Studio opens through Home Assistant Ingress. Physical panels use the separately configured LAN address; they cannot use an Ingress URL.

### Personal Home Assistant To Do (HA-5)

Studio remains Home Assistant-admin-only (`panel_admin: true`). Open it through Ingress to register your HA user ID, then use **Settings → Home Assistant To Do users → Manage** to assign personal lists. In a To Do widget, choose Home Assistant, an owner and one of their assigned lists, then Save changes. Existing V2 HA widgets remain **Legacy shared Home Assistant To Do** until you explicitly choose **Make personal** and save.

Only HA To Do has ownership. Calendar, Sensors, local InkPanel lists, other data and panel configuration remain household/shared. Physical panels use the owner/list saved in their widget, never the user currently browsing Studio. Revoked or unavailable ownership fails closed without fetching tasks. Back up `/data/.home-assistant-users.json` with device configuration.

ha.12 keeps the complete release-versioned Studio assets introduced in ha.11 (`/assets/0.1.0-ha.12/`). Normal non-admin personal Studio access requires a future permission/redaction milestone; this release does not broaden Supervisor privileges or enumerate HA accounts.

The App image includes the verified production WebFlash packages for both the full-size InkPanel and InkPanel Mini. Firmware is built during release CI, never when the App starts.

Home Assistant owns App updates, so the standalone InkPanel updater is intentionally unavailable in this deployment.

The Calendar widget can now use existing Home Assistant calendar entities, with multiple calendars and no copied token or secret iCal URL. Choose the provider and calendars in Studio, then save the panel. Existing iCal calendars remain supported, and both display sizes keep their existing visual layout. HA-2 is implemented and validated on real Home Assistant hardware.

New panels use Home Assistant's installation location and timezone at first enrolment. Existing panels keep their saved settings, including manual Studio edits. If the installation location cannot be read, a new panel retries later instead of saving an incorrect default location.

See the **Documentation** tab before starting the App.

To Do can now display a Home Assistant `todo.*` list using the existing full-size or Mini layout. Choose **Home Assistant** as the provider, select a list, and click **Save changes**. This milestone is read-only: edit tasks in Home Assistant. Existing InkPanel lists keep their full local editor. Both provider selections are remembered, missing entities remain visible, and HA outages show unavailable data rather than replaying stale tasks.

Real-world ha.8 testing confirmed the provider and preview fixes worked over direct LAN, but Ingress retained an older Studio document. ha.9 gives each release a different Ingress entry query, making the iframe load a fresh document after upgrading while preserving all existing base paths. Normal Studio assets remain `no-store`. The server's `/api/runtime-config` reports the image release in HA mode for comparison between Ingress and LAN.

Real-world ha.10 testing confirmed Sensors worked through direct LAN Studio, but Ingress still loaded older nested frontend modules. Versioning the document alone was insufficient because JS/CSS URLs remained stable. ha.11 versions the entire Studio asset namespace using the image release, so relative module imports also receive new URLs. Upgrade to ha.11 and reopen normally from the HA sidebar, without hard refresh, cache clearing or reinstall. Confirm the iframe query is `inkpanel_release=0.1.0-ha.11`, runtime config reports that release, and Studio JS/CSS requests include `/assets/0.1.0-ha.11/` beneath the existing Ingress prefix.

**Home Assistant Sensors** is the first read-only generic entity-display milestone, deliberately supporting only `sensor.*` entities. Choose the new Content option in Studio, search by friendly name or entity ID, add up to four sensors, arrange their order and click **Save changes**. One sensor uses a large-value layout; two to four use compact rows on both full-size and Mini displays. Values and units come directly from HA without conversions. Missing sensors remain selected until explicitly removed; outages show unavailable data, never a persisted stale sensor value. Manage sensors in HA, not InkPanel.

HA-4 is implemented but awaits final real-world Ingress and physical-display validation. Sensors and existing widgets, firmware, framebuffer/protocol, profiles and DeviceStore migrations are unchanged. See the repository's `docs/home-assistant-app.md` for the architecture and ha.11 validation checklist.
