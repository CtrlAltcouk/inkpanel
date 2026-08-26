# InkPanel

InkPanel turns an ESP32-S3 e-paper display into a configurable dashboard. This Home Assistant App runs the same InkPanel server and Studio as the standalone installation.

This `0.1.0-ha.4` release is experimental. Add
`https://github.com/CtrlAltcouk/inkpanel#Home-Assistant` as a Home Assistant App repository to test it.

The Studio opens through Home Assistant Ingress. Physical panels use the separately configured LAN address; they cannot use an Ingress URL.

The App image includes the verified production WebFlash packages for both the full-size InkPanel and InkPanel Mini. Firmware is built during release CI, never when the App starts.

Home Assistant owns App updates, so the standalone InkPanel updater is intentionally unavailable in this deployment.

See the **Documentation** tab before starting the App.
