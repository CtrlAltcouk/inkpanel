# InkPanel

InkPanel turns an ESP32-S3 e-paper display into a configurable dashboard. This Home Assistant App runs the same InkPanel server and Studio as the standalone installation.

This `0.1.0-ha.9` release is experimental. Add
`https://github.com/CtrlAltcouk/inkpanel#Home-Assistant` as a Home Assistant App repository to test it.

The Studio opens through Home Assistant Ingress. Physical panels use the separately configured LAN address; they cannot use an Ingress URL.

The App image includes the verified production WebFlash packages for both the full-size InkPanel and InkPanel Mini. Firmware is built during release CI, never when the App starts.

Home Assistant owns App updates, so the standalone InkPanel updater is intentionally unavailable in this deployment.

The Calendar widget can now use existing Home Assistant calendar entities, with multiple calendars and no copied token or secret iCal URL. Choose the provider and calendars in Studio, then save the panel. Existing iCal calendars remain supported, and both display sizes keep their existing visual layout. HA-2 is implemented and validated on real Home Assistant hardware.

New panels use Home Assistant's installation location and timezone at first enrolment. Existing panels keep their saved settings, including manual Studio edits. If the installation location cannot be read, a new panel retries later instead of saving an incorrect default location.

See the **Documentation** tab before starting the App.

To Do can now display a Home Assistant `todo.*` list using the existing full-size or Mini layout. Choose **Home Assistant** as the provider, select a list, and click **Save changes**. This milestone is read-only: edit tasks in Home Assistant. Existing InkPanel lists keep their full local editor. Both provider selections are remembered, missing entities remain visible, and HA outages show unavailable data rather than replaying stale tasks.

Real-world ha.8 testing confirmed the provider and preview fixes worked over direct LAN, but Ingress retained an older Studio document. ha.9 gives each release a different Ingress entry query, making the iframe load a fresh document after upgrading while preserving all existing base paths. Normal Studio assets remain `no-store`. The server's `/api/runtime-config` reports the image release in HA mode for comparison between Ingress and LAN.

Upgrade to ha.9 and reopen InkPanel from the Home Assistant sidebar normally; no hard refresh, cache clearing or reinstall should be needed. Confirm the iframe URL contains `inkpanel_release=0.1.0-ha.9`, both HA providers appear, and claimed previews load correctly without Push. HA-3 still needs this real-installation retest; it is not yet fully validated. No firmware or e-ink layout changes are included.
