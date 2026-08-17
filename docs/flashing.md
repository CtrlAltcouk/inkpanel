# Flashing and setting up a panel from the browser

The Flash tab writes InkPanel firmware to a supported XIAO ESP32-S3 over USB, straight from the web UI. Normal new-board onboarding does not require Arduino IDE, a second COM-port selection, or the ESP32's temporary `192.168.4.1` page.

InkPanel currently publishes two explicit hardware targets:

| Target | Hardware | Display |
|---|---|---|
| **InkPanel 7.5-inch** | XIAO ESP32-S3 Plus + EE04 | 800×480 monochrome, four widgets |
| **InkPanel Mini 1.54-inch** | XIAO ESP32-S3 + ePaper Driver Board for XIAO | SSD1681 200×200 monochrome, one widget |

Choose the physical hardware target **before** choosing a flash operation. InkPanel does not try to infer Plus-vs-standard XIAO from the generic ESP32-S3 chip name.

There are four deliberately separate operations:

| Mode | What it does | When to use it |
|---|---|---|
| **Update existing board** (default) | Writes only the selected target's bootloader, partition table and application regions. NVS is not touched, so Wi-Fi credentials and the server address survive. | Routine firmware updates. |
| **Set up a new board** | Erases the chip, writes the selected target's complete install image **and** a CRC-protected one-time Wi-Fi/server record in the same flash transaction. | A new XIAO, or a board being onboarded from scratch. |
| **Configure an unconfigured board** | Sends Wi-Fi and InkPanel brain settings over normal USB CDC without writing firmware. | Recovery for a board that already has InkPanel firmware but no usable settings. |
| **Factory reset / recover** | Erases the chip and writes the selected target's complete install image without credentials. | Recovery/testing, or deliberately returning a board to unconfigured setup mode. |

The device identity survives all four modes. A panel id such as `esp32-85bf98` is derived from the chip MAC rather than from normal flash.

---

## 1. Build the firmware first

The Flash tab serves builds; it does not compile firmware on demand.

**On a Proxmox LXC install this is automatic.** The installer sets up `arduino-cli` and the ESP32 core. Successful firmware builds are fingerprinted in `firmware/dist/input.sha256`; the updater compares that fingerprint with the current tracked firmware inputs and rebuilds whenever the served package is missing or stale.

`./scripts/build-firmware.sh` compiles both hardware targets into one staging tree and publishes them only after both compiles and both manifests succeed:

```text
firmware/dist/
├── manifest.json          # 7.5-inch target
├── *.bin                  # 7.5-inch binaries
├── input.sha256
└── mini/
    ├── manifest.json      # Mini target
    └── *.bin              # Mini binaries
```

Publishing the complete tree with one directory swap is important. A broken Mini build cannot replace a previously-good full-size package, and the root-owned updater's existing snapshot/rollback of `firmware/dist` protects both targets together.

**For a local checkout or Docker deployment**, install Arduino CLI and the ESP32 core, then run:

```bash
arduino-cli core update-index
arduino-cli core install esp32:esp32
./scripts/build-firmware.sh
```

Each target manifest contains:

- `target` — `full` or `mini`.
- `parts` — fresh-install/recovery image set, normally the single merged image.
- `updateParts` — bootloader, partition-table and application region images for an NVS-safe routine update.
- `provisioning` — the exact offset, size and record format of the one-time setup partition compiled into that target's partition table.

The browser does **not** hardcode a provisioning address. It receives the selected target's value from its manifest.

### Existing LXC installed before firmware freshness tracking

Older installs may still have the previous root-owned updater helper. Repair it once from the Proxmox host, replacing `<CTID>` with the InkPanel container id:

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

The root helper is intentionally not self-replaced from the service-user-owned checkout because doing that would weaken the updater's privilege separation.

---

## 2. Open the Flash tab over HTTPS

WebSerial is only exposed to secure browser contexts. InkPanel therefore keeps its panel-facing listener on HTTP port 8080 and provides an HTTPS listener for the management/Flash UI, normally:

```text
https://<your-server-ip>:<HTTPS_PORT>/#flash
```

`HTTPS_PORT` defaults to `8443` and can be changed in `inkpanel.env` or the Docker Compose environment. The HTTP Flash page obtains the effective port from the server only after the HTTPS listener is active, so its secure-connection link stays correct after a change and is omitted if certificates or binding fail.

The locally generated certificate includes the detected LAN IP and the valid host/IP from `PUBLIC_BASE_URL`, but it is still self-signed, so the browser may show a trust warning. Panels continue using plain HTTP on port 8080 and never need to trust this browser certificate.

Use a Chromium-family browser with WebSerial such as Chrome or Edge.

---

## 3. Recommended new-board experience

1. Connect the correct hardware with a data-capable USB cable.
2. Open **InkPanel → Flash** over HTTPS.
3. Under **Which panel hardware are you flashing?**, choose either:
   - **InkPanel 7.5-inch** for XIAO ESP32-S3 Plus + EE04; or
   - **InkPanel Mini 1.54-inch** for the standard XIAO ESP32-S3 + ePaper Driver Board + SSD1681.
4. Select **Set up a new board**.
5. Enter the Wi-Fi SSID and password.
6. Check the **InkPanel brain** field. It is pre-filled from `PUBLIC_BASE_URL`, normally something like:

   ```text
   http://192.168.1.50:8080
   ```

7. Click **Flash & configure new board** and select the XIAO once in Chromium's device picker.
8. InkPanel identifies the ESP32-S3, erases the chip and flashes the package for the hardware target you selected.
9. Before the ESP32 boots, the browser writes the Wi-Fi and brain settings into that target's dedicated one-time `provision` partition. With the normal merged image this record is overlaid into the merged image itself, so it remains one flash write.
10. On first boot firmware validates the setup record's magic, format, strict field lengths and CRC32.
11. Only after validation does firmware copy the values into the normal Preferences/NVS keys used by every other setup path.
12. The one-time partition is immediately erased so the Wi-Fi password does not remain stored in two places.
13. The board joins Wi-Fi, contacts the InkPanel brain and appears under **Panels** with the hardware profile advertised by its firmware.

There is no post-flash WebSerial handoff in this normal path. Windows/Chromium may re-enumerate the XIAO when it leaves the ROM flasher and boots the new firmware, but onboarding does not depend on the browser finding that new COM port.

The Wi-Fi password is **never sent to the InkPanel server**. The browser gets firmware from the server, combines the one-time record locally in memory, and sends the resulting bytes directly to the ESP32 over USB.

### Configure-only remains a recovery path

If a board already has InkPanel firmware but has no usable credentials, choose **Configure an unconfigured board**. This opens its normal USB CDC serial port and uses the `INKPANEL_PROVISION_V1` recovery protocol to save the same NVS keys without reflashing.

The firmware keeps this recovery USB protocol available even while the fallback setup AP is running.

### No BOOT button in the normal flow

Both supported XIAO ESP32-S3 variants normally enter Espressif's flashing mode automatically over USB. Do not use BOOT as a normal step. BOOT + RESET is recovery-only if repeated automatic flashing attempts genuinely fail.

---

## 4. One-time provisioning partitions

Both profiles reserve a 4 KiB data partition named `provision`, but the physical address differs because the boards have different flash sizes.

### 7.5-inch / XIAO ESP32-S3 Plus — 16 MB

```text
NVS        0x009000
app0       0x010000
provision  0xFFF000  size 0x1000
```

### Mini / standard XIAO ESP32-S3 — 8 MB

```text
NVS        0x009000
app0       0x010000
provision  0x7FF000  size 0x1000
```

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

Firmware never trusts a record merely because the magic matches. Version, field lengths, partition bounds and CRC all have to validate before NVS is written. A corrupt record is cleared and the board falls through to the normal USB/captive recovery paths.

The 7.5-inch EE04 build also keeps its existing KEY3 credential-reset behaviour. The current Mini reference hardware has no equivalent dedicated KEY3 input, so use WebFlash **Factory reset / recover** or the USB recovery path for a deliberate Mini reset.

---

## 5. Updating an existing board

Choose the correct hardware target first, then **Update existing board** for routine firmware changes.

This mode does **not** use the full merged image. It writes only that target's bootloader, partition table and application regions, preserving NVS. Both target partition maps keep NVS at `0x9000` and the application at `0x10000`.

If the selected target's build does not contain `updateParts`, the browser refuses the update rather than falling back to a full image that could erase credentials.

The Flash page logs the chosen hardware target before it erases or writes anything. Same-named binary files from the full-size and Mini packages are served from target-isolated API routes.

---

## 6. Factory reset / recovery

**Factory reset / recover** erases the chip and installs the complete firmware for the selected hardware target without a one-time provisioning record.

An unconfigured board then tries the recovery paths in this order:

1. one-time flash provisioning record — normally absent after factory reset;
2. USB provisioning window;
3. fallback AP/captive page.

The fallback AP is:

```text
Wi-Fi: inkpanel-setup
Page:  http://192.168.4.1
```

`192.168.4.1` is the ESP32's own temporary private AP address. It is **not** the Proxmox/Raspberry Pi brain IPv4. The recommended recovery route is still **Configure an unconfigured board** over USB; using `192.168.4.1` is optional.

---

## Troubleshooting

**"That port is already in use."**  
Close Arduino IDE, VS Code Serial Monitor or any other serial tool. Only one program can own the COM port.

**"Could not put the board into flashing mode automatically."**  
Unplug/reconnect and retry first. If repeated attempts still fail, hold BOOT, tap RESET, release BOOT, then retry. That sequence is recovery-only.

**The Flash page shows Mini as unavailable.**  
Run `./scripts/build-firmware.sh` (or use **Settings → Update now** on a supported LXC). A successful production build must create both `firmware/dist/manifest.json` and `firmware/dist/mini/manifest.json`.

**New-board flash says it completed but the device does not appear in Panels.**  
Open Serial Monitor at 115200 after the flash. Successful onboarding should show the flash-time provisioning import followed by a Wi-Fi connection and frame request. If it falls through to USB/recovery, capture the Serial output; the record will have been missing or rejected before any credential was written to NVS.

**A Mini appears as a 7.5-inch panel, or firmware reports a profile mismatch.**  
Do not change the device profile manually. Confirm the **InkPanel Mini 1.54-inch** hardware target was selected when flashing. Mini firmware advertises `ssd1681-200x200-mono`; existing 0.1.4 full-size firmware intentionally advertises no profile and uses the server's backward-compatible full-size default.
