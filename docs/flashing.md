# Flashing a panel from the browser

The Flash tab writes firmware to a XIAO ESP32-S3 over USB, straight from
inkpanel's web UI. It replaces opening the Arduino IDE to compile and upload.

**It does not touch Wi-Fi setup.** A newly-erased board still opens its own
`inkpanel-setup` access point, and you still configure the network and server
address from a phone, exactly as before. This tab replaces compiling and
uploading — nothing else. That is worth stating plainly, because a tool that
flashes boards sounds like it should also handle onboarding, and this one
deliberately doesn't.

---

## 1. Build the firmware first

The server flashes a build; it does not compile one on demand from the Flash
tab. Something has to produce `firmware/dist/` before the tab has anything to
offer.

**On a Proxmox LXC install, this is automatic.** The installer sets up
`arduino-cli` and the ESP32 core alongside Node and Chromium, and the updater
(`pct exec <CTID> -- /usr/local/bin/inkpanel-update` — the full path matters;
see [deployment.md](deployment.md)) rebuilds firmware whenever a pull
actually changes anything under `firmware/` — mirroring how it already only
runs `npm ci` when the lockfile changes. Most updates touch neither. A build
failure is logged but never fails the update itself: whether an ESP32 compile
succeeds has nothing to do with whether the server keeps serving frames to
panels, so the Flash tab just keeps offering the previous build rather than
the whole update being blocked on a firmware-side problem.

**Everywhere else — a local checkout, a Docker deployment — it's a manual
step.** Install [`arduino-cli`](https://arduino.github.io/arduino-cli/latest/installation/),
then the ESP32 core:

```bash
arduino-cli core update-index
arduino-cli core install esp32:esp32
```

Then build:

```bash
./scripts/build-firmware.sh
```

Run this again whenever firmware code changes.

Either way, the result is the same: `firmware/dist/` — three binaries plus a
`manifest.json` recording the firmware version and each binary's flash
offset. The bootloader offset comes from `arduino-cli`'s own build report
rather than being hardcoded, because it genuinely varies by chip family; the
other two are documented constants for this board's partition scheme.

`firmware/dist/` is gitignored. It is build output, not source.

Until a build has run, the Flash tab will say no firmware build is available
rather than offering a flash that would fail.

---

## 2. Open the Flash tab over HTTPS

**The Flash tab only works over HTTPS.** This is a browser rule, not a choice
inkpanel makes: WebSerial — the API that talks to the USB port — is only
available in a *secure context*. On plain HTTP, `navigator.serial` simply does
not exist, and no amount of code can work around it.

So inkpanel serves a **second listener on port 8443** with a self-signed
certificate, generated once on first boot and reused thereafter:

```
https://<your-server-ip>:8443/#flash
```

Your browser will warn that the certificate is not trusted. That is expected —
the certificate is self-signed, because a private LAN address cannot obtain a
publicly-trusted one. Click through the warning.

The certificate is stable across restarts, so you should see that warning once
per browser, not every time. If it reappears on every visit, something is
regenerating the certificate and that is worth investigating.

**Port 8080 is completely unchanged.** Your panels keep checking in over plain
HTTP — they have no way to trust a self-signed certificate, so they must. If
HTTPS fails to start for any reason, the server logs it, disables the Flash
tab, and carries on serving panels normally.

If you open the Flash tab on `http://…:8080` instead, it will tell you and give
you a link to the right address.

### Browser support

**Chrome or Edge** (or another Chromium-based browser). WebSerial does not
exist in Firefox or Safari, and both projects have said it will not be added,
so there is nothing to wait for — use Chrome or Edge for this one tab.

The tab tells these two situations apart: a Firefox user is told to change
browser, and a Chrome user on plain HTTP is told to change address. They are
different problems with different fixes.

---

## 3. Preserve or erase

| Mode | What it does | When to use it |
|---|---|---|
| **Update firmware only** (default) | Writes the bootloader, partition table and app. Leaves the NVS partition alone, so **Wi-Fi credentials and the server address survive**. | Routine firmware updates. The board reboots and rejoins your network by itself. |
| **Erase everything** | Wipes the whole chip first, then writes. The board comes back blank. | Starting over, or clearing a bad configuration. You will need to redo Wi-Fi setup from a phone. |

Preserving is the default and needs no special handling — a normal flash was
never touching the credentials partition in the first place. Erasing is the
extra step, and it is opt-in.

**The device identity survives either mode.** A panel's id (`esp32-85bf98` and
so on) is derived from the chip's MAC address, which is burned into silicon
rather than stored in flash. Erasing a board does not give you a duplicate
entry in the Panels tab — it comes back as the same panel.

---

## 4. Flashing

1. Plug the board into the machine running the browser (not necessarily the
   machine running inkpanel).
2. Click **Connect**. Your browser shows its own port picker — this is the
   browser's UI, and it is the real safety gate: nothing can be flashed
   without you explicitly choosing a port here.
3. The board is identified. If it is not an ESP32-S3, the flow stops there
   rather than attempting a mismatched write.
4. Choose preserve or erase, then click **Flash**. Progress and a log appear.
5. The board resets automatically when the write finishes.

---

## Troubleshooting

**"That port is already in use."**
Only one program can hold a serial port. Close the Arduino IDE serial monitor,
or any other serial tool, and try again. This is the most common problem.

**"Could not put the board into flashing mode."**
The automatic reset into the bootloader did not take — it is reliable most of
the time but not universally, across every OS and cable. Do it by hand: hold
the board's **BOOT** button, tap **RESET**, release **BOOT**, then try again.

**"Cancelled — no board selected."**
You closed the port picker. Nothing happened; just click Connect again.

**"Failed to write ... to flash after seq N failed with status ..."**
The board connected and entered flashing mode fine — the failure happened
partway through writing, so holding BOOT won't help here; that's connection
advice for a problem this isn't. This is the chip's own ROM loader rejecting
one block, which in practice is almost always the USB link dropping a beat
during a long transfer: plug directly into the computer's own USB port rather
than a hub or extension cable, keep the tab in the foreground, and don't let
the computer sleep while it writes. Then try again.

**Any other write failure partway through.**
**The board is not damaged.** The ROM bootloader lives in mask ROM and no
flash write can overwrite it, so the board can always be put back into
bootloader mode and reflashed. Hold **BOOT**, tap **RESET**, and flash again.

**The Flash tab says no firmware build is available.**
Run `./scripts/build-firmware.sh` — see section 1.

**Connect does nothing / there is no Connect button.**
Check the address bar. If you are on `http://…:8080`, switch to
`https://…:8443`. If you are in Firefox or Safari, switch to Chrome or Edge.

**The board flashed fine but never appears in Panels.**
That is a network problem, not a flashing one. After an erase, the board needs
Wi-Fi setup again — look for the `inkpanel-setup` access point. If it was a
preserve-mode flash and it still does not check in, check the antenna is
seated on its U.FL connector; a loose antenna shows up as repeated Wi-Fi
association failures in the serial log.
