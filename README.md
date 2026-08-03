# inkpanel

A self-hosted, day-at-a-glance dashboard for e-paper displays.

A small server renders your calendar, weather and more into a single 1-bit image.
A battery-powered ESP32 panel wakes up, fetches that image, displays it, and goes
back to sleep. The panel does almost nothing; the server does almost everything.

> **Status: in design.** Nothing is implemented yet. The design lives in
> [`docs/superpowers/specs/`](docs/superpowers/specs/). Watch this space.

## Why this shape

E-paper holds its image with the power disconnected, so the only energy cost is
the refresh itself. That makes "wake rarely, draw once, sleep" the natural design
— and it means all the interesting work can happen somewhere with a real CPU.

Rendering server-side buys a lot:

- Layout is HTML and CSS you can iterate on in a browser, not bitmap fonts on a
  microcontroller.
- No API credentials ever reach the device.
- Redesign the page without reflashing anything.

## Hardware

The reference build, and the only configuration currently tested:

| Part | Detail |
|---|---|
| MCU | Seeed XIAO ESP32-S3 Plus |
| Carrier | Seeed XIAO ePaper Display Board (EE04), 24-pin jumper |
| Panel | 7.5" 800x480 monochrome (Good Display GDEW075T7 / flex `WFT0583CZ61`) |
| Driver | Waveshare "old V2" full-refresh sequence |

Other panels should work with a new panel profile, but only this one is verified
against real hardware.

## Licence

MIT — see [LICENSE](LICENSE).

The e-paper driver sequence is adapted from Waveshare's `epd7in5_V2_old.py` and
retains its original permission notice.
