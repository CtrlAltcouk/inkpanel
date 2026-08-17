# InkPanel Mini — 1.54-inch 200×200 support

InkPanel Mini adds a second display class without replacing or resizing the existing 7.5-inch dashboard.

## Compatibility invariants

These are release gates, not aspirations:

- Existing `wft0583-800x480-mono` devices keep the current 800×480 four-widget renderer and 48,000-byte framebuffer.
- Existing firmware 0.1.4 remains able to enrol and fetch frames without sending any new headers.
- Existing device configuration migrates losslessly; the four widget slots keep their order and configuration.
- The current EE04 / old-V2 display driver is not modified to support the Mini.
- A Mini failure must not change the behaviour, firmware package, or rendering of an existing large panel.

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

Mini firmware keeps the existing InkPanel device contract where practical:

`wake → Wi-Fi → GET frame → 304 = no panel refresh → 200 = refresh → sleep`

It uses a 5,000-byte frame buffer and an SSD1681-specific display implementation. The current `firmware/inkpanel` EE04 target stays intact.

The Mini firmware identifies itself with the Mini profile header. It uses timer wake as the primary wake source. Factory-reset/recovery behaviour must be explicitly mapped to controls available on the standard XIAO ESP32-S3 rather than assuming EE04 KEY1/KEY3 exist.

## WebFlash and CI

WebFlash will eventually expose the hardware choice explicitly rather than guessing from USB:

- InkPanel 7.5-inch — XIAO ESP32-S3 Plus + EE04
- InkPanel Mini 1.54-inch — XIAO ESP32-S3 + ePaper Driver Board + SSD1681

Both production firmware targets must compile in CI before Mini support can merge. Existing large firmware manifest/update behaviour must remain backwards compatible while multi-target packaging is introduced deliberately.

## Delivery order

1. Green existing `main` baseline.
2. V3 schema + profile registry + enrolment header, with old-profile compatibility tests.
3. Per-device rendering + dedicated Mini renderer, including 5,000-byte framebuffer tests and unchanged large-profile regression tests.
4. Studio single-widget mode.
5. Mini production firmware and CI build.
6. Hardware validation on the real 1.54-inch panel.
7. WebFlash multi-hardware selection and documentation.
