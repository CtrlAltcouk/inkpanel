# inkpanel

[![CI](https://github.com/CtrlAltcouk/inkpanel/actions/workflows/ci.yml/badge.svg)](https://github.com/CtrlAltcouk/inkpanel/actions/workflows/ci.yml)

A self-hosted, day-at-a-glance dashboard for 7.5-inch e-paper displays.

InkPanel keeps the ESP32 deliberately simple: the server collects data, builds the dashboard, renders an 800×480 1-bit frame, and tells the panel when to wake again. The battery-powered panel wakes, checks for a new frame, refreshes only when the content changed, then returns to deep sleep.

## Current features

The web UI provides a Studio-style workspace for each panel with a live preview, dashboard configuration, device settings, scheduling, flashing and server updates.

Each panel has four independently configurable dashboard positions. Current widget types are:

- **Calendar** — one or more iCal feeds
- **Weather** — Open-Meteo using the panel location
- **Trains** — live National Rail departures
- **Bus** — live TransportAPI departures with optional route filtering
- **Traffic** — Google Maps Routes traffic-aware journey time
- **Octopus Agile** — cheapest still-valid Agile electricity slot
- **Bins** — Milton Keynes collection dates by UPRN
- **Empty** — intentionally blank section

Provider credentials are stored server-side and are not written into panel firmware or normal device configuration. The browser is told only whether a managed credential is configured; saved secrets are not returned to the UI.

## How it works

```text
Data providers ──> InkPanel server ──> 800×480 monochrome frame ──> ESP32/e-paper
                       │
                       ├─ Web admin / Studio UI
                       ├─ source cache + health
                       ├─ device configuration
                       └─ transactional self-update
```

A rendered frame has a content identity. If a panel already has the current image, the server returns `304` and the e-paper display is not refreshed. This avoids unnecessary flashing and saves battery power.

The physical e-paper renderer is intentionally separate from the browser/admin UI. Changes to the admin interface should not change the e-paper design or framebuffer pipeline unless that is an explicit renderer task. See [docs/ui-redesign-constraint.md](docs/ui-redesign-constraint.md).

## Quick start

### Proxmox LXC

Run this on the Proxmox host:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/CtrlAltcouk/inkpanel/main/scripts/proxmox/inkpanel-lxc.sh)"
```

The installer creates the LXC, installs the server dependencies and firmware toolchain, configures the service, and prepares the browser-flash package.

### Local / other Linux host

Requires Node.js 22 or newer:

```bash
git clone https://github.com/CtrlAltcouk/inkpanel.git
cd inkpanel
npm ci
npx playwright install chromium
npm start
```

The normal HTTP UI is available on port `8080` by default. InkPanel can also provide an HTTPS management listener, normally on `8443`, which is required for browser WebSerial flashing.

With no physical panel connected, the protocol can be exercised with:

```bash
npm run fake-device -- --once
```

That writes `frame.png`, representing the frame a real panel would receive.

## Flashing and provisioning

The recommended new-board path is entirely browser based and does not require the Arduino IDE or the `192.168.4.1` recovery portal:

1. Open **Flash** over the InkPanel HTTPS address in Chrome or Edge.
2. Choose **Set up a new board**.
3. Enter Wi-Fi details and confirm the InkPanel server address.
4. Select the XIAO once in the browser device picker.
5. InkPanel flashes the firmware and a one-time provisioning record in the same transaction.
6. On first boot the firmware imports the settings into NVS, erases the temporary record, joins Wi-Fi and contacts InkPanel.

Routine **Update existing board** flashing preserves NVS, so Wi-Fi and server settings survive firmware updates. USB configuration and the temporary `inkpanel-setup` / `192.168.4.1` portal remain recovery paths.

See [docs/flashing.md](docs/flashing.md) for the complete flow and recovery options.

## Configuration and data providers

Panel name, timezone, location, schedule and dashboard layout are configured from the web UI.

Some widgets require provider setup:

- Calendar: secret/private iCal URL
- National Rail: Rail Data Marketplace Consumer key
- Bus: TransportAPI app ID and app key
- Traffic: Google Maps Routes API key with the required Google project/billing setup
- Octopus Agile: tariff code only; no Octopus account API key is required for the public tariff data used here
- Bins: Milton Keynes UPRN

Weather uses Open-Meteo and needs no account.

Additional provider notes:

- [National Rail](docs/national-rail.md)
- [Bus and Traffic](docs/bus-traffic.md)
- [Octopus Agile](docs/octopus-agile.md)
- [Widget setup and remembered settings](docs/widget-setup-and-remembered-settings.md)

## Hardware

The reference hardware, and the configuration tested by this project, is:

| Part | Detail |
|---|---|
| MCU | Seeed XIAO ESP32-S3 Plus |
| Carrier | Seeed XIAO ePaper Display Board (EE04), 24-pin jumper |
| Panel | 7.5-inch 800×480 monochrome Good Display GDEW075T7 / flex `WFT0583CZ61` |
| Driver | Waveshare old-V2 full-refresh sequence |

Panel revision matters. This display requires the old-V2 initialisation sequence; changing the renderer or driver to a similarly named newer Waveshare/GxEPD2 profile can leave this hardware blank.

Hardware notes and verification material are under [docs/hardware](docs/hardware/).

## Updates

The Proxmox/LXC installation includes a transactional self-updater exposed in **Updates** in the web UI. It pulls `main` fast-forward-only, validates the candidate, rebuilds firmware when tracked firmware inputs changed, health-checks the new service and rolls back to the previous working commit if deployment fails.

For that reason, **`main` is the deployable branch** and should stay green.

## Development and repository policy

Useful checks:

```bash
npm run check     # TypeScript typecheck
npm test          # full Node/Chromium test suite
npm run test:tz   # repeat tests under multiple server timezones
```

GitHub Actions also compiles the production `XIAO_ESP32S3_Plus` firmware on every push to `main` and on pull requests.

Repository policy:

- `main` should always represent the current deployable state.
- CI must pass before feature work is considered complete.
- Feature/fix branches are temporary and should be deleted after merge.
- Generated build output, runtime data and local credentials do not belong in Git.
- Tests, deployment scripts and maintenance tools are part of the project even when the running Node process does not import them directly.

## Security

Set `INKPANEL_PASSWORD` to require a login for the management UI. Firmware frame requests and `/health` remain unauthenticated by design because the ESP32 does not perform an interactive login.

The panel-facing HTTP service is intended for a trusted LAN. Do not expose it directly to the public internet. Use a VPN or an appropriately configured reverse proxy for remote access, and set `TRUST_PROXY` correctly when a proxy is in front of InkPanel.

Calendar fetching includes destination validation and blocks private/non-public destinations by default. `CALENDAR_ALLOW_PRIVATE_NETWORKS=1` is an explicit opt-in for deliberately LAN-hosted calendars; loopback and link-local targets remain blocked.

See [.env.example](.env.example) and [docs/deployment.md](docs/deployment.md) for deployment settings.

## Repository layout

```text
public/       browser/admin UI
src/          InkPanel server, data sources, renderer and device logic
firmware/     production ESP32 firmware plus hardware diagnostic sketches
scripts/      build, deployment and maintenance tooling
test/         unit, integration, browser, firmware-contract and updater tests
docs/         current deployment, flashing, provider and hardware documentation
.github/      CI workflow
```

## Documentation

- [Deployment](docs/deployment.md)
- [Flashing and provisioning](docs/flashing.md)
- [National Rail](docs/national-rail.md)
- [Bus and Traffic](docs/bus-traffic.md)
- [Octopus Agile](docs/octopus-agile.md)
- [Widget setup and remembered settings](docs/widget-setup-and-remembered-settings.md)
- [Hardware verification](docs/hardware/verification.md)

## Licence

MIT — see [LICENSE](LICENSE).

The e-paper driver sequence is adapted from Waveshare's `epd7in5_V2_old.py` and retains its original permission notice.
