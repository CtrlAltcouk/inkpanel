# Flashing and setting up a panel from the browser

The Flash tab writes firmware to a XIAO ESP32-S3 over USB, straight from
InkPanel's web UI. For a new board it can also send Wi-Fi and server settings
over the same USB cable, so normal onboarding needs neither Arduino IDE nor the
ESP32's temporary `192.168.4.1` setup page.

There are four deliberately separate operations:

| Mode | What it does | When to use it |
|---|---|---|
| **Update existing board** (default) | Writes only the bootloader, partition table and application regions. NVS is not touched, so Wi-Fi credentials and the server address survive. | Routine firmware updates. |
| **Set up a new board** | Erases the chip, writes the complete install image, then provisions Wi-Fi and the InkPanel brain directly over USB. | A new XIAO, or a board you want to onboard from scratch. |
| **Configure an unconfigured board** | Sends Wi-Fi and InkPanel brain settings over normal USB CDC without writing firmware. | A board that has firmware but is sitting in setup/recovery mode, including when automatic post-flash provisioning was missed. |
| **Factory reset / recover** | Erases the chip and writes the complete install image, but does not send credentials. | Recovery/testing, or deliberately returning a board to unconfigured setup mode. |

The device identity survives all four modes. A panel id such as
`esp32-85bf98` is derived from the chip's MAC address, which is burned into
silicon rather than stored in flash.

---

## 1. Build the firmware first

The server flashes a build; it does not compile one on demand from the Flash
tab. Something has to produce `firmware/dist/` before the tab has anything to
offer.

**On a Proxmox LXC install, this is automatic.** The installer sets up
`arduino-cli` and the ESP32 core alongside Node and Chromium. Every successful
firmware build writes `firmware/dist/input.sha256`, a fingerprint of the tracked
firmware sources and build inputs. The updater compares that fingerprint with
the current checkout on every update and rebuilds whenever the served package
is missing or stale. It does not rely only on what happened to change during
the latest `git pull`.

Firmware is compiled into a staging directory and is published to
`firmware/dist/` only after the compile and manifest generation both succeed.
A failed firmware build therefore does not take the dashboard server down and
does not destroy the previous successful WebFlash package.

**Everywhere else — a local checkout or Docker deployment — build manually.**
Install [`arduino-cli`](https://arduino.github.io/arduino-cli/latest/installation/),
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

The build creates two logical image sets in `manifest.json`:

- `parts` — the fresh-install/recovery set, normally the single toolchain-built
  `.merged.bin` at address zero.
- `updateParts` — the bootloader, partition table and application images at
  their individual offsets. Routine updates use this set so the NVS partition
  cannot be overwritten by the full merged image.

`firmware/dist/` is gitignored build output, not source.

### Existing LXC installed before firmware freshness tracking

Older LXCs may have a root-owned `/usr/local/bin/inkpanel-update` from before
firmware fingerprinting existed. The application checkout can update normally
while that old privileged helper keeps serving a stale `firmware/dist` package.
The updater is intentionally not allowed to replace itself from the
service-user-writable checkout because doing so would create an application-to-root
privilege escalation.

For an official InkPanel install, repair the privileged helper once from the
Proxmox host, then rebuild the current firmware:

```bash
pct exec <CTID> -- bash -lc '
set -e
cd /opt/inkpanel/app
runuser -u inkpanel -- git pull --ff-only origin main
curl -fsSL https://raw.githubusercontent.com/CtrlAltcouk/inkpanel/main/scripts/proxmox/files/inkpanel-update -o /tmp/inkpanel-update
bash -n /tmp/inkpanel-update
install -o root -g root -m 755 /tmp/inkpanel-update /usr/local/bin/inkpanel-update
runuser -u inkpanel -- ./scripts/build-firmware.sh
'
```

Replace `<CTID>` with the InkPanel container id shown by `pct list`. This is a
one-time repair for an older installation; fresh installations already receive
the current root-owned helper.

---

## 2. Open the Flash tab over HTTPS

**The Flash tab only works over HTTPS.** WebSerial — the browser API used to
talk to USB — is available only in a secure context. InkPanel therefore keeps
its normal panel-facing HTTP listener on port 8080 and adds a browser-only
HTTPS listener, normally on port 8443:

```text
https://<your-server-ip>:8443/#flash
```

The certificate is self-signed on a local installation, so the browser may
warn the first time. Accept the warning for your own InkPanel host.

Panels themselves continue using plain HTTP on port 8080. The ESP32 does not
need to trust the browser-facing self-signed certificate.

Use Chrome, Edge, Brave, Opera or another Chromium browser with WebSerial.
Firefox and Safari do not expose WebSerial.

---

## 3. Recommended new-board experience

For somebody downloading InkPanel and setting up a new panel, this is the
normal workflow:

1. Attach the Wi-Fi antenna and connect the XIAO/EE04 to the computer with a
   data-capable USB cable.
2. Open **InkPanel → Flash** over HTTPS.
3. Select **Set up a new board**.
4. Enter the Wi-Fi network name and password.
5. Check the **InkPanel brain** field. It is pre-filled from
   `PUBLIC_BASE_URL`, normally something like:

   ```text
   http://192.168.1.50:8080
   ```

   This is the Proxmox LXC / Raspberry Pi IPv4 address the ESP32 uses to fetch
   its rendered frame. A user normally does not need to discover or type it.
6. Click **Flash & configure new board** and select the XIAO in Chromium's USB
   picker.
7. InkPanel erases and flashes the complete firmware image.
8. The XIAO restarts. Native USB disappears briefly and comes back as the new
   firmware's USB CDC serial port.
9. The browser reopens the already-authorised device, waits for
   `INKPANEL_READY_V1`, and sends the Wi-Fi and brain details directly to the
   ESP32.
10. The ESP32 stores them in NVS, acknowledges with `INKPANEL_SAVED_V1`, joins
    Wi-Fi and contacts the InkPanel brain.
11. The new device appears in the Panels view ready to claim/configure.

The Wi-Fi password **is not POSTed to the InkPanel server**. It remains in the
browser and travels only across the local USB serial connection to the board.

### If automatic USB setup is missed

A successful firmware flash is not repeated just because Windows/Chromium did
not reopen the CDC port in time. Leave the board connected, select
**Configure an unconfigured board**, enter/check the same Wi-Fi and brain
settings, click **Configure board over USB**, and choose the board's normal COM
port. No erase or firmware write occurs in this mode.

Current firmware keeps this USB setup protocol available while it is in
recovery/setup mode, so there is no deadline and no need to use
`192.168.4.1`.

### No BOOT button in the normal flow

The XIAO ESP32-S3 normally enters Espressif's flashing mode automatically over
USB. Do not hold BOOT as a normal step. Only use BOOT + RESET as a recovery
fallback if repeated automatic connection attempts genuinely fail.

---

## 4. Updating an existing board

Choose **Update existing board** for routine firmware changes.

This mode deliberately does **not** use the full merged image. The manifest
provides separate bootloader, partition-table and application images, and the
browser writes only those regions. That preserves the NVS partition containing:

- Wi-Fi SSID
- Wi-Fi password
- InkPanel brain URL

After the flash the board restarts and rejoins the network without being set up
again.

If a firmware build does not contain the safe `updateParts` image set, the
browser refuses a preserve-mode flash rather than silently falling back to the
full image and risking credentials.

---

## 5. Factory reset / recovery

Choose **Factory reset / recover** when you deliberately want to wipe the
board. InkPanel erases the chip and installs the complete image but does not
send new credentials.

A board with no credentials first waits for automatic USB provisioning for
about 30 seconds. If none arrives, it starts the original recovery access
point:

```text
Wi-Fi: inkpanel-setup
Page:  http://192.168.4.1
```

`192.168.4.1` is an address on the temporary private Wi-Fi network created by
the ESP32 itself. It is **not** the Proxmox/Raspberry Pi brain address. It is
only reachable from a phone/computer that has deliberately joined the
`inkpanel-setup` Wi-Fi network.

The captive portal is only a fallback. While it is running, USB provisioning
continues to run at the same time, so the recommended recovery path is simply
**Configure an unconfigured board** in InkPanel.

---

## Troubleshooting

**"That port is already in use."**
Only one program can hold a serial port. Close Arduino IDE or VS Code Serial
Monitor and any other serial tool, then try again.

**"Could not put the board into flashing mode automatically."**
First unplug and reconnect the XIAO and retry; normal flashing should need no
buttons. If repeated attempts still fail, use the recovery sequence: hold
**BOOT**, tap **RESET**, release **BOOT**, then retry.

**The firmware flashes but automatic USB provisioning times out.**
The flash itself succeeded. Do **not** erase/flash it again. Close any serial
monitor, select **Configure an unconfigured board**, enter/check the Wi-Fi and
InkPanel brain fields, click **Configure board over USB**, and select the
XIAO's normal COM port.

**The serial monitor says `INKPANEL_READY_V1`.**
The firmware is waiting for USB provisioning. Close the Serial Monitor because
it prevents the browser owning the COM port, then use **Configure an
unconfigured board**.

**A freshly flashed board immediately prints the old setup lines and never
prints `INKPANEL_READY_V1`.**
If serial output looks like:

```text
[setup] no credentials stored — starting portal
[setup] portal starting, join WiFi 'inkpanel-setup'
[setup] open http://192.168.4.1
```

then the board was flashed with a legacy package even if the website itself is
current. Firmware `0.1.1` and newer prints the USB-provisioning stage first.
Repair an older LXC using the one-time command in section 1, reload the Flash
tab, and flash the new board again.

**The serial monitor says `inkpanel-setup` and `http://192.168.4.1`.**
The board has no saved Wi-Fi/brain settings. `192.168.4.1` is not your LXC or
Raspberry Pi; it is just the ESP32's recovery AP address. With current firmware,
leave the board connected and use **Configure an unconfigured board** over USB.
You do not need to join `inkpanel-setup` or open `192.168.4.1`.

**"Cancelled — no board selected."**
You closed the browser's port picker. Nothing was written; click again.

**"Failed to write ... to flash after seq N failed with status ..."**
The board already entered flashing mode, so BOOT is not the fix. Plug directly
into the computer rather than a hub/extension, keep the tab in the foreground,
and prevent the computer sleeping while it writes, then retry.

**`invalid header: 0x0203a9c3`.**
That specific historic failure was caused by firmware bytes being passed to
`esptool-js` as a JavaScript string, causing the ESP image magic byte `0xE9` to
be UTF-8-expanded to `0xC3 0xA9`. WebFlash now converts to `Uint8Array` before
writing and refuses any image at address zero whose first byte is not `0xE9`.

**Any other write failure partway through.**
The ESP32-S3 ROM bootloader cannot be overwritten by a flash operation, so a
failed application write does not permanently brick the board. Retry through
WebFlash; use BOOT + RESET only if automatic bootloader entry will not work.

**The Flash tab says no firmware build is available.**
Run `./scripts/build-firmware.sh` — see section 1.

**Connect does nothing / there is no Connect button.**
Check the address bar. If you are on `http://…:8080`, switch to
`https://…:8443`. If you are in Firefox or Safari, switch to Chrome or Edge.

**The board has credentials but never appears in Panels.**
Check the Wi-Fi antenna is clipped onto the XIAO's U.FL connector and inspect
serial output for association failures. Also verify the InkPanel brain URL in
the Flash form is reachable from the panel's Wi-Fi network.
