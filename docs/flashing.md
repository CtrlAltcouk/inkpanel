# Flashing and setting up a panel from the browser

The Flash tab writes firmware to a XIAO ESP32-S3 over USB, straight from
InkPanel's web UI. Normal new-board onboarding does not require Arduino IDE,
a second COM-port selection, or the ESP32's temporary `192.168.4.1` page.

There are four deliberately separate operations:

| Mode | What it does | When to use it |
|---|---|---|
| **Update existing board** (default) | Writes only the bootloader, partition table and application regions. NVS is not touched, so Wi-Fi credentials and the server address survive. | Routine firmware updates. |
| **Set up a new board** | Erases the chip, writes the complete install image **and** a CRC-protected one-time Wi-Fi/server record in the same flash transaction. | A new XIAO, or a board being onboarded from scratch. |
| **Configure an unconfigured board** | Sends Wi-Fi and InkPanel brain settings over normal USB CDC without writing firmware. | Recovery for a board that already has InkPanel firmware but no usable settings. |
| **Factory reset / recover** | Erases the chip and writes the complete install image without credentials. | Recovery/testing, or deliberately returning a board to unconfigured setup mode. |

The device identity survives all four modes. A panel id such as
`esp32-85bf98` is derived from the chip MAC rather than from normal flash.

---

## 1. Build the firmware first

The Flash tab serves a build; it does not compile firmware on demand.

**On a Proxmox LXC install this is automatic.** The installer sets up
`arduino-cli` and the ESP32 core. Successful firmware builds are fingerprinted
in `firmware/dist/input.sha256`; the updater compares that fingerprint with the
current tracked firmware inputs and rebuilds whenever the served package is
missing or stale.

Firmware compiles into a staging directory and is only published to
`firmware/dist/` after compile and manifest generation both succeed, so a bad
firmware commit cannot destroy the previous working WebFlash package.

**For a local checkout or Docker deployment**, install Arduino CLI and the
ESP32 core, then run:

```bash
arduino-cli core update-index
arduino-cli core install esp32:esp32
./scripts/build-firmware.sh
```

The build creates these manifest entries:

- `parts` — fresh-install/recovery image set, normally the single merged image.
- `updateParts` — bootloader, partition-table and application region images for
  an NVS-safe routine update.
- `provisioning` — the exact offset, size and record format of the one-time
  setup partition compiled into `partitions.csv`.

The browser does **not** hardcode the provisioning address. It receives it from
the build manifest, which derives it from the same partition table compiled
into the ESP32 firmware.

### Existing LXC installed before firmware freshness tracking

Older installs may still have the previous root-owned updater helper. Repair it
once from the Proxmox host, replacing `<CTID>` with the InkPanel container id:

```bash
pct exec <CTID> -- bash -lc '
set -e
cd /opt/inkpanel/app
runuser -u inkpanel -- git pull --ff-only origin main
install -o root -g root -m 0755 scripts/proxmox/files/inkpanel-update /usr/local/bin/inkpanel-update
install -o root -g root -m 0644 scripts/proxmox/files/write-status.mjs /usr/local/bin/write-status.mjs
/usr/local/bin/inkpanel-update
'
```

The root helper is intentionally not self-replaced from the service-user-owned
checkout because doing that would weaken the updater's privilege separation.

---

## 2. Open the Flash tab over HTTPS

WebSerial is only exposed to secure browser contexts. InkPanel therefore keeps
its panel-facing listener on HTTP port 8080 and provides an HTTPS listener for
the management/Flash UI, normally:

```text
https://<your-server-ip>:<HTTPS_PORT>/#flash
```

`HTTPS_PORT` defaults to `8443` and can be changed in `inkpanel.env` or the
Docker Compose environment. The HTTP Flash page obtains the effective port
from the server only after the HTTPS listener is active, so its secure-connection
link stays correct after a change and is omitted if certificates or binding fail.

The locally generated certificate includes the detected LAN IP and the valid
host/IP from `PUBLIC_BASE_URL`, but it is still self-signed, so the browser may
show a trust warning. Panels continue using plain HTTP on port 8080 and never
need to trust this browser certificate. An existing installation upgrading
from the older localhost-only certificate may show one new warning when the
corrected certificate is generated.

Use a Chromium-family browser with WebSerial such as Chrome or Edge.

---

## 3. Recommended new-board experience

1. Attach the Wi-Fi antenna and connect the XIAO/EE04 with a data-capable USB
   cable.
2. Open **InkPanel → Flash** over HTTPS.
3. Select **Set up a new board**.
4. Enter the Wi-Fi SSID and password.
5. Check the **InkPanel brain** field. It is pre-filled from
   `PUBLIC_BASE_URL`, normally something like:

   ```text
   http://192.168.1.50:8080
   ```

6. Click **Flash & configure new board** and select the XIAO once in Chromium's
   device picker.
7. InkPanel erases the chip and flashes the complete firmware image.
8. Before the ESP32 is allowed to boot, the browser also writes the Wi-Fi and
   brain settings into the dedicated one-time `provision` partition. With the
   normal merged image this record is patched into the merged image itself, so
   it remains one flash write.
9. On first boot firmware validates the setup record's magic, format, strict
   field lengths and CRC32.
10. Only after validation does firmware copy the values into the normal
    Preferences/NVS keys used by every other setup path.
11. The one-time partition is immediately erased so the Wi-Fi password does not
    remain stored in two places.
12. The board joins Wi-Fi, contacts the InkPanel brain and appears under
    **Panels**.

There is no post-flash WebSerial handoff in this normal path. Windows/Chromium
may re-enumerate the XIAO when it leaves the ROM flasher and boots the new
firmware, but onboarding no longer depends on the browser finding that new COM
port.

The Wi-Fi password is **never sent to the InkPanel server**. The browser gets
the firmware from the server, combines the one-time record locally in memory,
and sends the resulting bytes directly to the ESP32 over USB.

### Configure-only remains a recovery path

If a board already has InkPanel firmware but has no usable credentials, choose
**Configure an unconfigured board**. This opens its normal USB CDC serial port
and uses the `INKPANEL_PROVISION_V1` recovery protocol to save the same NVS
keys without reflashing.

The firmware keeps this recovery USB protocol available even while the fallback
setup AP is running.

### No BOOT button in the normal flow

The XIAO ESP32-S3 normally enters Espressif's flashing mode automatically over
USB. Do not use BOOT as a normal step. BOOT + RESET is recovery-only if repeated
automatic flashing attempts genuinely fail.

---

## 4. The one-time provisioning partition

InkPanel uses a custom 16 MB partition table that deliberately preserves the
important existing offsets:

```text
NVS        0x009000
app0       0x010000
provision  0xFFF000  size 0x1000
```

The final 4 KiB flash sector (`0xFFF000` through `0xFFFFFF`) is reserved as a
custom data partition named `provision`. A 60 KiB guard gap is intentionally
left between the end of SPIFFS and this final sector.

The current binary record is:

```text
0x00  8 bytes   magic "INKPV001"
0x08  uint16    format version
0x0A  uint16    SSID UTF-8 byte length
0x0C  uint16    password UTF-8 byte length
0x0E  uint16    server URL UTF-8 byte length
0x10  uint32    CRC32(metadata + payload)
0x14  payload   SSID + password + server URL
rest            0xFF
```

The firmware never trusts a record merely because the magic matches. Version,
field lengths, partition bounds and CRC all have to validate before NVS is
written. A corrupt record is cleared and the board falls through to the normal
USB/captive recovery paths.

KEY3 also clears both NVS and this one-time partition so a deliberate credential
reset cannot immediately re-import a pending record.

---

## 5. Updating an existing board

Choose **Update existing board** for routine firmware changes.

This mode does **not** use the full merged image. It writes only the bootloader,
partition table and application regions, preserving NVS. Because the custom
InkPanel partition table keeps NVS at `0x9000` and the application at
`0x10000`, existing boards can move onto the table without relocating their
saved Wi-Fi/server settings.

If the build does not contain `updateParts`, the browser refuses the update
rather than falling back to a full image that could erase credentials.

---

## 6. Factory reset / recovery

**Factory reset / recover** erases the chip and installs the complete firmware
without a one-time provisioning record.

An unconfigured board then tries the recovery paths in this order:

1. one-time flash provisioning record — normally absent after factory reset;
2. USB provisioning window;
3. fallback AP/captive page.

The fallback AP is:

```text
Wi-Fi: inkpanel-setup
Page:  http://192.168.4.1
```

`192.168.4.1` is the ESP32's own temporary private AP address. It is **not** the
Proxmox/Raspberry Pi brain IPv4. The recommended recovery route is still
**Configure an unconfigured board** over USB; using `192.168.4.1` is optional.

---

## Troubleshooting

**"That port is already in use."**  
Close Arduino IDE, VS Code Serial Monitor or any other serial tool. Only one
program can own the COM port.

**"Could not put the board into flashing mode automatically."**  
Unplug/reconnect and retry first. If repeated attempts still fail, hold BOOT,
tap RESET, release BOOT, then retry. That sequence is recovery-only.

**New-board flash says it completed but the device does not appear in Panels.**  
Open Serial Monitor at 115200 after the flash. Firmware `0.1.2` or newer should
show the flash-time import stage. Successful onboarding includes messages like:

```text
[setup] no credentials stored — checking flash-time provisioning
[setup] imported flash-time Wi-Fi/server settings and erased temporary record
[setup] flash-time credentials imported
[wifi] connected ...
```

If it instead falls through to USB/recovery, capture the serial output. The
record will have been missing or rejected before any credential was written to
NVS.

**The serial monitor says `INKPANEL_READY_V1`.**  
The board is in the configure-only USB recovery path. Close Serial Monitor and
use **Configure an unconfigured board**.

**The serial monitor says `inkpanel-setup` / `192.168.4.1`.**  
The board has no usable saved settings. That address belongs only to its
recovery Wi-Fi network. You do not need to open it; use **Configure an
unconfigured board** over USB.

**A fresh flash still reports firmware `0.1.0` or an older package.**  
The self-hosted brain is serving stale `firmware/dist` output. Update/repair the
LXC firmware builder and rebuild before flashing again. Current builds are
fingerprinted specifically to prevent stale packages surviving future updates.

**`invalid header: 0x0203a9c3`.**  
That historic failure came from converting binary firmware into a JavaScript
string and letting the compressor UTF-8-expand the ESP magic byte `E9` into
`C3 A9`. WebFlash now converts firmware back into `Uint8Array` and refuses an
image at address zero unless its first byte is `0xE9`.

**A write fails partway through.**  
The ESP32-S3 ROM bootloader is not overwritten by the application flash, so a
failed write does not permanently brick the board. Retry through WebFlash.

**The Flash tab says no firmware build is available.**  
Run `./scripts/build-firmware.sh`.

**There is no Flash control.**  
Use `https://…:<HTTPS_PORT>`, not the plain HTTP panel endpoint, and use a Chromium
browser with WebSerial support.
