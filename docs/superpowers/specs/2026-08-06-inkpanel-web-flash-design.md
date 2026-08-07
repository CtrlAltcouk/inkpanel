# inkpanel — Spec 3: Browser-based firmware flashing

**Date:** 2026-08-06
**Status:** Approved, ready for implementation planning
**Follows:** [Spec 2b](2026-08-05-inkpanel-spec2b-design.md), merged and running.

---

## 1. What this is

Today, getting new firmware onto a board means opening Arduino IDE, compiling
the sketch, and uploading over USB. This spec adds a **Flash tab** to the
existing web UI: connect a board over USB, and flash the already-built
firmware straight from the browser. No IDE, no per-board recompile.

**What this does not change:** WiFi and server-address setup stay exactly as
they are today — a freshly-flashed board with no stored credentials opens its
own `inkpanel-setup` access point, and you configure it from a phone. That
flow already works and is untouched by this spec. This is purely about
replacing *how the firmware gets onto the chip*, not how the chip gets onto
the network.

### Explicitly not in this spec

| Deferred | Why |
|---|---|
| Injecting WiFi credentials as part of the flash | Explicitly ruled out during design — the existing captive portal already solves this, and folding credential entry into the flash tool would duplicate a flow that works, for no real gain |
| CI-built firmware binaries | No build pipeline exists today; adding one is a bigger, separate decision. The build stays a local, manual step for now |
| Support for other board types | This project targets one board (XIAO ESP32-S3 + EE04). No variant selection is needed |
| Bus and traffic data sources | A separate, unrelated subsystem — its own spec |

---

## 2. Architecture

Three new pieces. Nothing in the existing render or device pipeline changes.

```
scripts/build-firmware.sh       one-shot: arduino-cli compile -> firmware/dist/
firmware/dist/                  gitignored build output (.bin files + manifest.json)

src/http/firmwareRoutes.ts      serves the manifest + binaries, behind existing auth
src/https.ts                    generates a self-signed cert on first boot, adds a second listener

public/flash.js                 new "Flash" tab: WebSerial + esptool-js
```

### The build step stays local and manual

There is no firmware build pipeline today — the `.ino` is compiled by hand in
Arduino IDE. Adding CI (compiling on every push, publishing binaries) is a
bigger, separate decision than this spec needs to make, and it would require
the server to fetch build artifacts over the internet at flash time. Instead,
`scripts/build-firmware.sh` runs `arduino-cli compile` locally, whenever
firmware code changes, and copies the output into `firmware/dist/`:

- the bootloader, partition table, and app binaries, at whatever flash offsets
  `arduino-cli` reports for this board profile — captured from its own build
  output rather than hand-typed, so they can't drift out of sync with a future
  partition-table change
- `manifest.json`, carrying the firmware version (read directly out of
  `config.h`'s `FIRMWARE_VERSION`) and a build timestamp

`firmware/dist/` is gitignored, the same treatment as `/data/` — build output,
not source.

### Serving

`GET /api/firmware/manifest` and the binary files themselves sit behind the
same session auth as the rest of the management API. If no build has been
run, the manifest response says so plainly, and the Flash tab shows that
rather than letting someone reach the write step only to fail there.

### HTTPS runs alongside HTTP, not instead of it

The browser API this whole feature depends on — WebSerial — only works in a
**secure context**: HTTPS, or the page loaded from `localhost`. inkpanel runs
in a headless LXC and is reached over plain HTTP from a LAN IP on a different
machine, so WebSerial is unavailable there today, and that's not something
code can work around.

Firmware check-ins and ordinary browsing must keep working exactly as they do
now — existing panels can't suddenly need TLS, and a self-signed cert has no
story for how an ESP32 would trust it. So HTTPS is **additive**: on first
boot, if no cert exists in the data directory, the server generates one via
`openssl req -x509` (same "generate once, store in `dataDir`" pattern already
used for the session secret) and listens on a second port — default `8443` —
serving the identical Express app. Port `8080` is completely unchanged.

The Flash tab checks for `navigator.serial`. If it's missing specifically
because the page is on plain HTTP, it links to the same page on `:8443`
instead of showing a generic "unsupported" message — a different problem
needs a different fix shown.

---

## 3. The flashing flow

### Preserve mode needs no special logic

A normal flash — writing bootloader, partition table, and app binary at their
designated offsets — is exactly what Arduino IDE's Upload button already
does. It was never touching the NVS partition where WiFi credentials live;
that's simply how `esptool`'s `write_flash` behaves unless told to erase
first. So "preserve, by default" isn't a feature to build carefully — it's
the baseline, and the only thing to avoid is accidentally adding an erase
step to it.

**Device identity survives either way.** The device ID (`esp32-85bf98` and so
on) is read straight from the chip's WiFi MAC via `esp_read_mac()` — baked
into silicon, not stored in flash. Neither preserve nor erase mode can ever
change which device a board identifies as.

### Erase mode is one explicit extra step

An `erase_flash` command before the normal write, wiping the whole chip so
the board comes up blank and opens the captive portal again — the same
end state as holding KEY3 today, just triggered from the browser.

### Step by step

1. **Connect** — the browser's native port-picker dialog opens. This is the
   real safety mechanism: nothing can flash without an explicit, visible
   choice in that dialog.
2. esptool-js reads the chip's identity before writing anything, and refuses
   to proceed if it isn't an ESP32-S3, rather than attempting a mismatched
   write.
3. **Choose preserve or erase** — a radio choice, preserve pre-selected.
4. **Flash** — a progress bar driven by esptool-js's real write progress,
   with a scrolling log underneath. Same visual pattern as the existing
   self-update status view, not a new UI idiom.
5. Automatic reset, then a plain confirmation.

---

## 4. Error handling

| Case | Behaviour |
|---|---|
| Browser has no WebSerial (Firefox, Safari) | Plain "use Chrome or Edge" message before Connect is even clickable |
| WebSerial missing because of plain HTTP | Points at the `:8443` address specifically, not a generic error |
| Port picker cancelled | Returns to idle — not treated as an error |
| Chip isn't an ESP32-S3, or nothing responds | Stops before writing anything |
| Board won't auto-reset into bootloader mode | Falls back to manual instructions: hold the board's BOOT button, tap RESET, retry |
| Serial port already open elsewhere (e.g. Arduino IDE's serial monitor) | Message specifically names this — WebSerial ports are exclusive, and this is a real, likely gotcha |
| Write fails partway (cable pulled, brownout) | Message states plainly that this is safely recoverable — the ROM bootloader lives in mask ROM, no flash write can ever damage it, and the board can always be put back into bootloader mode and reflashed |
| No firmware build available | Flash tab says so up front, not after Connect |

---

## 5. Testing

**Automated**, following the existing suite's patterns:

- `firmwareRoutes.ts` — manifest shape when a build exists and when it
  doesn't, correct content-type on binaries, session-auth-gated like
  `manageRoutes.test.ts`.
- `https.ts` — generates a cert+key once, doesn't regenerate on a second run
  (idempotent, mirroring the existing `.session-secret`), restrictive file
  permissions, and `/health` reachable over both listeners.
- `build-firmware.sh` — a smoke test that it exists and is executable. A test
  that actually invokes `arduino-cli` against real hardware toolchains isn't
  realistic to run in this suite.

**Not automatable, and stated plainly rather than glossed over**: the
browser-side flow itself — WebSerial, esptool-js, chip identification, an
actual preserve-mode flash, an actual erase-mode flash, auto-reset into
bootloader mode. None of it can run in Node's test runner; it needs a real
board and a real Chromium browser.

### Hardware verification status — **NOT YET VERIFIED ON HARDWARE**

As of 2026-08-07, **none of the five checklist items below has been run.**
The feature is code-complete and covered by 346 automated tests, but no part
of it has touched a real board.

Two things block the checklist, both environmental rather than defects:

- **`arduino-cli` is not installed on the development machine**, so
  `scripts/build-firmware.sh` has never produced a real build. Every test of
  it runs against synthetic input. With no build in `firmware/dist/`, the
  Flash tab correctly reports that none is available — which means even the
  two items needing no board (1 and 4) cannot be completed, because there is
  nothing to flash.
- **No board is attached**, and items 2, 3 and 5 need one.

The checklist, all items outstanding:

1. Connect over `:8443` in Chrome; port picker appears; board identified as
   an ESP32-S3. — **not run**
2. Preserve-mode flash on an *already-provisioned* board (BedRoom): confirm it
   reboots straight onto WiFi and checks in as itself, no re-pairing, with
   `lastSeenAt` updating in the Panels tab. — **not run**
3. Erase-mode flash: confirm it comes up broadcasting `inkpanel-setup`, can be
   reconfigured from a phone, and reappears under **the same device id** (the
   id is MAC-derived, so an erase must not create a duplicate). — **not run**
4. Open the tab over plain `:8080` from a second machine: confirm the HTTPS
   notice appears and its link works. — **not run**
5. Open the Arduino IDE serial monitor on the port, then click Connect:
   confirm the "close other serial tools" message rather than a raw
   exception. — **not run**

Items 1 and 4 exercise no hardware, so completing only those would not make
this feature verified. Item 2 is the one that matters most: it is the routine
case, and getting preserve-vs-erase backwards silently destroys a user's WiFi
configuration on what they believed was a routine update.

One further gap worth naming: **nobody has ever loaded the Flash tab over a
LAN IP on plain HTTP from a second machine**, in any browser. The
browser/protocol branching is covered by unit tests across all four
combinations, but has never been observed in a real browser on a real
network.
