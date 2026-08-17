# InkPanel Mini — 1.54-inch 200×200 support

InkPanel Mini adds a second display class without replacing or resizing the existing 7.5-inch dashboard.

## Compatibility invariants

These are release gates, not aspirations:

- Existing `wft0583-800x480-mono` devices keep the current 800×480 four-widget renderer and 48,000-byte framebuffer.
- Existing firmware 0.1.4 remains able to enrol and fetch frames without sending any new headers.
- Existing device configuration migrates losslessly; the four widget slots keep their order and configuration.
- The current EE04 / old-V2 display driver is not modified to support the Mini.
- A Mini failure must not change the behaviour, published firmware package, or rendering of an existing large panel.

## Mini reference hardware

- Seeed Studio XIAO ESP32-S3 (standard 8 MB board)
- Seeed ePaper Driver Board for XIAO
- 1.54-inch 200×200 monochrome SSD1681 panel
- 24-pin FPC

Driver-board ePaper routing from Seeed:

| ePaper | XIAO |
| --- | --- |
| RST | D0 |
| CS | D1 |
| BUSY | D2 |
| DC | D3 |
| SCK | D8 |
| MOSI | D10 |

Seeed_GFX identifies this panel as `BOARD_SCREEN_COMBO 505`. The bench test for this exact combination has been completed successfully before starting InkPanel integration.

The standard XIAO ESP32-S3 has no dedicated `ADC_BAT` input like the Plus variant. Mini firmware therefore reports battery voltage as unknown until a validated measurement circuit/profile is added.

## Display profiles

### Existing

`wft0583-800x480-mono`

- 800×480
- 1 bit/pixel
- stride 100 bytes
- 48,000-byte framebuffer
- four dashboard widgets
- existing renderer and old-V2 firmware driver

### Mini

`ssd1681-200x200-mono`

- 200×200
- 1 bit/pixel
- stride 25 bytes
- 5,000-byte framebuffer
- one dashboard widget
- dedicated compact renderer
- dedicated SSD1681 firmware target

The server wire framebuffer remains logical row-major, MSB-first, black bit = 1. The Mini display driver owns any controller-specific inversion/orientation needed by SSD1681; those details do not leak into the dashboard renderer.

## Persisted device model

Device-store V1 and V2 stay frozen. Mini support advances persistence to V3.

V3 keeps `dashboardSections` but permits only profile-valid lengths:

- `wft0583-800x480-mono` → exactly four sections
- `ssd1681-200x200-mono` → exactly one section

V2 → V3 migration copies every existing field and all four sections unchanged.

New devices still default to `wft0583-800x480-mono` unless enrolment explicitly identifies a known profile.

## Device enrolment protocol

New firmware may send:

`X-InkPanel-Profile: <profile-id>`

Rules:

1. Unknown device + no profile header → create the existing 7.5-inch profile. This preserves compatibility with firmware 0.1.4.
2. Unknown device + known profile header → create that profile with its correct default dashboard layout.
3. Unknown device + unknown profile header → reject rather than silently creating the wrong device type.
4. Existing device → the persisted profile remains authoritative. A mismatching firmware header is treated as a diagnostic/configuration error, never as permission to silently change panel type.

## Rendering

The existing 800×480 template/CSS remains the large-panel renderer.

A separate Mini renderer produces a 200×200 single-widget composition. It reuses the same source data and widget configuration as the large dashboard. Source fetching, caching, stale handling, provider credentials, ETags and 304 behaviour stay shared.

The Mini renderer must not render the large dashboard and crop/scale it.

## Studio UI

For a large panel, Studio remains unchanged: real 800×480 preview plus the current 2×2 widget map.

For a Mini panel, Studio shows:

- `InkPanel Mini · 1.54 inch · 200×200`
- a real square 200×200 preview
- one Content selector/editor
- the same reusable widget settings and server-wide provider credentials
- the existing Device and Schedule tabs

## Firmware

Mini and full-size builds now share the networking, provisioning, ETag, failure-backoff and sleep-scheduling code while selecting different physical display implementations at compile time.

The default build remains the existing `esp32:esp32:XIAO_ESP32S3_Plus` target with firmware version `0.1.4`, the existing 16 MB partition map, and the untouched `OldV2EPD` driver.

The Mini build uses:

- FQBN `esp32:esp32:XIAO_ESP32S3`
- compile target `INKPANEL_MINI`
- firmware version `0.2.0-mini.1` during hardware validation
- `MiniEPD`, a dedicated SSD1681 full-refresh driver
- 5,000-byte frame buffer
- profile header `X-InkPanel-Profile: ssd1681-200x200-mono`
- a separate 8 MB partition map with one-time provisioning at `0x7FF000`
- timer wake only for the first supported revision
- no fabricated battery-voltage telemetry

The device contract remains:

`wake → Wi-Fi → GET frame → 304 = no panel refresh → 200 = refresh → sleep`

A 200 response is not considered successful until the physical SSD1681 refresh completes. A display failure preserves the old ETag so the frame is retried after the existing exponential backoff. The Mini driver performs SSD1681 polarity conversion locally; the server wire format stays black-bit-1.

CI compiles both firmware targets independently. The full-size build still publishes the existing `firmware/dist` package; Mini compilation is additive and produces a temporary hardware-validation artifact rather than replacing the production WebFlash package.

## Hardware validation package

During the draft phase CI publishes `inkpanel-mini-hardware-validation` for the real-device test. It contains:

- compiled Mini binaries, including a merged image;
- an Arduino-IDE-ready `arduino/inkpanel` copy of the exact production sources;
- the Mini target baked into `config.h`;
- the 8 MB Mini partition map installed as `partitions.csv`;
- a `README_FIRST.txt` with flashing instructions.

For Arduino IDE validation select the standard **XIAO ESP32S3**, not the Plus board. No extra compiler flags are required in the exported validation sketch.

This validation artifact is never copied into `firmware/dist`; the existing full-size WebFlash/update package remains the only published production firmware until Mini hardware validation is complete.

## WebFlash and CI

WebFlash will expose the hardware choice explicitly rather than guessing from USB:

- InkPanel 7.5-inch — XIAO ESP32-S3 Plus + EE04
- InkPanel Mini 1.54-inch — XIAO ESP32-S3 + ePaper Driver Board + SSD1681

The existing full-size firmware manifest/update behaviour remains the compatibility baseline. Multi-target WebFlash packaging is added only after the real Mini validates the new SSD1681 driver, orientation and polarity.

## Delivery status

- [x] Green existing `main` baseline.
- [x] V3 schema + profile registry + backwards-compatible enrolment header.
- [x] Per-device rendering + dedicated 200×200 Mini renderer and 5,000-byte tests.
- [x] Studio single-widget mode and square preview.
- [x] Production Mini firmware target added alongside the existing full-size target.
- [x] CI compiles both standard XIAO Mini and XIAO ESP32-S3 Plus firmware targets.
- [x] CI generates an isolated Mini hardware-validation package without replacing `firmware/dist`.
- [ ] Real-hardware validation of the production Mini driver: orientation, polarity, full refresh and sleep.
- [ ] End-to-end Mini frame/ETag/304 validation against the feature-branch server.
- [ ] WebFlash multi-hardware selection/package.
- [ ] Final documentation, regression pass and merge.
