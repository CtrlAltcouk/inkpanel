# inkpanel

[![CI](https://github.com/CtrlAltcouk/inkpanel/actions/workflows/ci.yml/badge.svg)](https://github.com/CtrlAltcouk/inkpanel/actions/workflows/ci.yml)

A self-hosted, day-at-a-glance dashboard for e-paper displays.

A small server renders your calendar and weather into a single 1-bit image. A
battery-powered ESP32 panel wakes up, fetches that image, displays it, and goes
back to sleep. The panel does almost nothing; the server does almost everything.

Firmware can be flashed to a board from the **Flash tab** in the web UI, over
USB, without the Arduino IDE. It needs Chrome or Edge and the HTTPS address
(`https://<server>:8443`), because the browser API it uses only works in a
secure context — see [docs/flashing.md](docs/flashing.md). Wi-Fi setup is
unchanged and still happens from a phone.

> **Status: server working, one panel deployed.** The server renders, serves
> and caches frames, and the whole protocol is exercised by a `fake-device` CLI.
> The Proxmox LXC installer is tested and working. The firmware is flashed to
> a real panel and running, reporting battery and firmware version back to the
> server. The Docker image is written but has never been built.

## Why this shape

E-paper holds its image with the power disconnected, so the only energy cost is
the refresh itself. That makes "wake rarely, draw once, sleep" the natural
design — and it means all the interesting work can happen somewhere with a real
CPU.

Rendering server-side buys a lot:

- Layout is HTML and CSS you iterate on in a browser, not bitmap fonts on a
  microcontroller.
- No API credentials ever reach the device.
- Redesign the page without reflashing anything.

And one detail matters more than it sounds: when the rendered image is
byte-identical to what a panel is already showing, the server returns `304` and
**the panel does not refresh at all**. A 7.5" e-paper refresh is a five-second
black-and-white flash. On a desk, one every fifteen minutes for no reason gets
old fast.

## Quick start

**On Proxmox**, one command on the host creates an LXC and installs everything:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/CtrlAltcouk/inkpanel/main/scripts/proxmox/inkpanel-lxc.sh)"
```

**Anywhere else:**

```bash
git clone https://github.com/CtrlAltcouk/inkpanel.git
cd inkpanel
npm install
npx playwright install chromium
npm start
```

Open `http://localhost:8080`. With no hardware to hand, you can drive the whole
protocol from a terminal:

```bash
npm run fake-device -- --once
```

That writes `frame.png` — pixel-for-pixel what a panel would display. Run it
again and it returns `304`, exactly as the firmware will.

## Configuration

Everything is configured in the web UI: name, timezone, location, calendar URLs
and refresh schedule. Calendars use Google's per-calendar **secret iCal
address**, so there is no OAuth and no Google Cloud project. Be aware that
Google refreshes that feed lazily — a newly created event can take a few hours
to appear.

Weather comes from Open-Meteo, which needs no account and no API key.

## Hardware

The reference build, and the only configuration that will be tested:

| Part | Detail |
|---|---|
| MCU | Seeed XIAO ESP32-S3 Plus |
| Carrier | Seeed XIAO ePaper Display Board (EE04), 24-pin jumper |
| Panel | 7.5" 800x480 monochrome (Good Display GDEW075T7 / flex `WFT0583CZ61`) |
| Driver | Waveshare "old V2" full-refresh sequence |

**Panel revision matters.** This panel needs the *old* V2 initialisation
sequence. Waveshare's current V2 driver and GxEPD2's `GxEPD2_750_T7` will not
drive it correctly. If your panel stays blank, confirm which revision you have
before changing anything else.

Other panels should work with a new panel profile, but only this one is
verified against real hardware.

## Development

```bash
npm test          # unit and contract tests
npm run test:tz   # the same suite under four server timezones
npm run check     # typecheck
```

`npm run test:tz` exists because date bugs here are invisible on a single
machine: an all-day calendar event materialises at local midnight, so a dev box
in London and a container running UTC disagree about which day it falls on.

## Security

By default there is **no authentication** — anyone who can reach the server can
read your calendar as a rendered image and change any panel's configuration.

Set `INKPANEL_PASSWORD` to require a login. Two endpoints stay open regardless:
`/api/devices/:id/frame`, because firmware cannot log in, and `/health`, so
monitoring does not need credentials. Sign in at `/login.html`.

**The password travels in clear text.** This is plain HTTP, so the password and
the session cookie are readable by anyone able to capture packets on your
network. It is protection against casual access — a guest on your WiFi, someone
idly poking at the address — and **not** against a hostile network.

**Do not expose this to the internet.** If you need remote access, put it behind
a VPN or a reverse proxy that terminates TLS and does its own authentication.
**Behind a reverse proxy you must set `TRUST_PROXY`, or the rate limiter
buckets every client together** — `req.ip` otherwise resolves to the proxy's
own address for every request, so five bad logins from anyone locks out
everyone for 15 minutes. Set it to the number of proxy hops in front of the
server (usually `1`), or to a comma-separated list of trusted addresses/
subnets — see [Express's `trust proxy` docs](https://expressjs.com/en/guide/behind-proxies.html)
for the accepted values.

### HTTPS (`HTTPS_PORT`, default `8443`)

The server also listens on a second, HTTPS port, purely so the browser will
expose [WebSerial](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API)
for the firmware Flash tab — WebSerial refuses to run outside a secure
context. The certificate is **self-signed** and generated once on first boot
into the data directory, so your browser will show a trust warning the first
time you open the HTTPS port; accept it once and it will not reappear
(the certificate is reused, not regenerated, on every restart).

Panels are unaffected: firmware has no way to trust a self-signed certificate,
so it keeps checking in over the plain-HTTP port exactly as before. If no
certificate can be generated (for example, `openssl` is not installed), the
server logs that HTTPS is disabled and continues serving everything else over
HTTP — only the Flash tab is unavailable.

## Documentation

- [Spec](docs/superpowers/specs/2026-08-03-inkpanel-spec1-design.md) — the design and why it is shaped this way
- [Implementation plan](docs/superpowers/plans/2026-08-03-inkpanel-spec1.md) — task by task
- [Deployment](docs/deployment.md) — Proxmox, TrueNAS, and what to check when it fails
- [Flashing](docs/flashing.md) — writing firmware to a board from the browser

## Licence

MIT — see [LICENSE](LICENSE).

The e-paper driver sequence is adapted from Waveshare's `epd7in5_V2_old.py` and
retains its original permission notice.
