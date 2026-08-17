# InkPanel Mini — 1.54-inch 200×200 support

InkPanel Mini adds a second display class without replacing or resizing the existing 7.5-inch dashboard.

## Compatibility invariants

These are release gates, not aspirations:

- Existing `wft0583-800x480-mono` devices keep the current 800×480 four-widget renderer and 48,000-byte framebuffer.
- Existing firmware 0.1.4 remains able to enrol and fetch frames without sending any new headers.
- Existing device configuration migrates losslessly; the four widget slots keep their order and configuration.
- The current EE04 / old-V2 display driver is not modified to support the Mini.
- A Mini failure must not change the behaviour, firmware package, updater rollback or rendering of an existing large panel.

## Mini reference hardware

- Seeed Studio XIAO ESP32-S3 (standard 8 MB board)
- Seeed ePaper Driver Board for XIAO
- 1.54-inch 200×200 monochrome SSD1681 panel
- 24-pin FPC

Driver-board routing:

| ePaper | XIAO |
| --- | --- |
| RST | D0 |
| CS | D1 |
| BUSY | D2 |
| DC | D3 |
| SCK | D8 |
| MOSI | D10 |

Seeed_GFX identifies this panel as `BOARD_SCREEN_COMBO 505`. The exact board/panel combination was bench-tested before InkPanel integration and the production `MiniEPD` driver has since completed a real full-refresh + controller-sleep validation on the physical panel.

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

The server wire framebuffer remains logical row-major, MSB-first, black bit = 1. The Mini display driver owns SSD1681 polarity/orientation details; those do not leak into the dashboard renderer.

## Persisted device model

Device-store V1 and V2 stay frozen. Mini support advances persistence to V3.

V3 permits only profile-valid dashboard lengths:

- `wft0583-800x480-mono` → exactly four sections
- `ssd1681-200x200-mono` → exactly one section

V2 → V3 migration copies every existing field and all four sections unchanged. New devices still default to the existing 7.5-inch profile unless firmware explicitly advertises a known profile.

## Device enrolment protocol

New firmware may send:

`X-InkPanel-Profile: <profile-id>`

Rules:

1. Unknown device + no profile header → create the existing 7.5-inch profile.
2. Unknown device + known profile header → create that profile with the correct default layout.
3. Unknown device + unknown profile header → reject rather than silently creating the wrong device type.
4. Existing device → persisted profile remains authoritative; mismatching firmware gets a diagnostic error and never silently changes hardware type.

The Mini HTTP contract is covered end-to-end in tests: first response is exactly 5,000 bytes with an ETag; repeating the request with that ETag returns HTTP 304 with no framebuffer body.

## Rendering and Studio

The existing 800×480 template/CSS remains the large-panel renderer.

A separate Mini renderer produces a 200×200 single-widget composition while reusing the same source data, cache, credentials and widget configuration model. It does not render the large dashboard and crop/scale it.

For a Mini panel Studio shows:

- `InkPanel Mini · 1.54 inch · 200×200`
- a real square 200×200 preview
- one Content selector/editor
- the same remembered widget settings and write-only provider credentials
- the existing Device and Schedule controls

## Firmware

Mini and full-size builds share networking, provisioning, ETag, failure-backoff and sleep-scheduling code while selecting different physical display implementations at compile time.

The full-size target remains:

- FQBN `esp32:esp32:XIAO_ESP32S3_Plus`
- firmware version `0.1.4`
- existing 16 MB partition map
- existing `OldV2EPD` driver

The Mini target uses:

- FQBN `esp32:esp32:XIAO_ESP32S3`
- compile target `INKPANEL_MINI`
- firmware version `0.2.0-mini.1`
- `MiniEPD` SSD1681 full-refresh driver
- 5,000-byte framebuffer
- profile header `X-InkPanel-Profile: ssd1681-200x200-mono`
- 8 MB partition map with one-time provisioning at `0x7FF000`
- timer wake for the first supported revision
- no fabricated battery telemetry

The device contract stays:

`wake → Wi-Fi → GET frame → 304 = no panel refresh → 200 = refresh → sleep`

A 200 response is successful only after physical refresh completes. Display failure preserves the old ETag so the same frame is retried through the existing exponential backoff.

## Production firmware packaging

The existing package location remains the compatibility root:

```text
firmware/dist/
├── manifest.json          # existing 7.5-inch target
├── *.bin                  # existing 7.5-inch binaries
├── input.sha256
└── mini/
    ├── manifest.json      # 1.54-inch Mini target
    └── *.bin              # Mini binaries
```

`build-firmware.sh` builds both targets into one staging tree and publishes them with one directory swap. If either target fails to compile or generate a valid manifest, the previously-served package remains in place.

This structure is deliberate: the root-owned updater already snapshots and restores all of `firmware/dist`, so automatic rollback protects both target packages without creating a second rollback mechanism.

## WebFlash

The Flash page explicitly asks which hardware is being flashed before any firmware is downloaded or flash erase/write starts:

- **InkPanel 7.5-inch** — XIAO ESP32-S3 Plus + EE04
- **InkPanel Mini 1.54-inch** — XIAO ESP32-S3 + ePaper Driver Board + SSD1681

The historical `/api/firmware/manifest` and `/api/firmware/bin/:name` endpoints continue to mean the full-size target. New target-aware routes expose the Mini package separately, preventing same-named binaries from crossing between hardware targets.

Fresh install, update, configure-only recovery and factory-reset modes continue to use the same WebSerial flow. Each target uses its own manifest and provisioning address.

## Hardware validation package

During development CI also publishes `inkpanel-mini-hardware-validation`. It contains an Arduino-ready production Mini sketch, compiled binaries and the standalone production-driver validation sketch used on the real panel. This is a development artifact; normal users use WebFlash after merge.

## Delivery status

- [x] Green `main` baseline before feature work.
- [x] V3 schema + profile registry + backwards-compatible enrolment.
- [x] Dedicated 200×200 single-widget renderer and Studio mode.
- [x] Production Mini firmware target and SSD1681 driver.
- [x] Physical production-driver full refresh, polarity/orientation and controller sleep validated on the real panel.
- [x] Automated 5,000-byte response + ETag + 304/no-body contract.
- [x] Atomic production packaging for full-size + Mini targets.
- [x] Explicit WebFlash hardware selection and target-isolated firmware routes.
- [ ] Final CI/regression pass.
- [ ] Merge, deploy through Settings → Update now, then perform the live end-to-end Mini test against the updated InkPanel server.
