# inkpanel firmware

> **Deployed and working on one real panel.** The hardware verification
> checklist in [`docs/hardware/verification.md`](../docs/hardware/verification.md)
> has not been fully worked through; in particular, the sleep-current
> measurement in [`docs/hardware/sleep-current.md`](../docs/hardware/sleep-current.md)
> remains an unfilled form.

## Board settings

Arduino IDE, **Tools → Board → XIAO_ESP32S3_PLUS**:

- USB CDC On Boot: **Enabled**
- CPU Frequency: 240 MHz
- PSRAM: **OPI PSRAM**
- Erase All Flash Before Sketch Upload: Disabled (enable once when first
  switching to provisioning, to clear stale NVS)

No external libraries are required — everything used ships with the ESP32
Arduino core.

## Plug the WiFi antenna in

**Do this first.** The XIAO ESP32-S3 has a U.FL socket on the module and ships
with a small antenna that must be clipped on. Without it the radio is deaf
enough that association mostly fails — and when it does briefly succeed, TCP
stalls, so the symptom shows up as an HTTP timeout rather than anything
obviously WiFi-related.

Symptoms of a missing antenna:

```
[wifi] attempt 1 failed (status 0)     <- IDLE: never even started associating
[wifi] attempt 2 failed (status 6)     <- DISCONNECTED: associated, then dropped
```

`firmware/spikes/wifi_scan/` confirms it: with no antenna you will see almost no
networks even beside the router.

## Before powering the panel

1. Disconnect USB and battery while handling the ribbon.
2. Insert the 24-pin ribbon the correct way round.
3. Set the EE04 jumper to **24 Pin**.
4. Close the connector latch fully.

Reversing the ribbon or using the wrong jumper can prevent operation and may
damage the display.

## First run — recommended WebFlash flow

A normal new-board setup no longer requires Arduino IDE or connecting to
`192.168.4.1`.

1. Open the InkPanel **Flash** tab in Chrome/Edge over HTTPS.
2. Choose **Set up a new board**.
3. Enter the Wi-Fi SSID and password. The InkPanel server address is filled in
   automatically from the server's `PUBLIC_BASE_URL`.
4. Choose the XIAO in the browser's USB picker.
5. InkPanel erases and flashes the board, waits for the fresh firmware to
   reappear over USB CDC, then sends the Wi-Fi and server settings directly
   from the browser to the board.
6. The firmware stores those values in NVS and joins the normal Wi-Fi network.

The Wi-Fi password is not sent to the InkPanel server. It exists in the browser
form and then travels over the local USB connection to the ESP32.

The XIAO ESP32-S3 normally enters flashing mode automatically. There is no
normal BOOT-button step. BOOT + RESET is only a recovery fallback when automatic
reset repeatedly fails.

### USB provisioning protocol

Fresh firmware with no stored credentials waits for up to 30 seconds for the
browser. It emits:

```text
INKPANEL_READY_V1
```

and accepts one newline-terminated record:

```text
INKPANEL_PROVISION_V1|<ssid-base64>|<password-base64>|<server-url-base64>
```

On a successful NVS write it replies:

```text
INKPANEL_SAVED_V1
```

The fields are base64-encoded so Unicode SSIDs and delimiter characters cannot
corrupt the line protocol. The server URL must use the panel-facing plain HTTP
listener, for example `http://192.168.1.20:8080`.

## Captive-portal fallback

The old setup route is deliberately retained for recovery and non-browser
setups. If no USB provisioning command arrives during the 30-second window, a
fresh board starts the Wi-Fi access point `inkpanel-setup` and serves its local
setup page at:

```text
http://192.168.4.1
```

`192.168.4.1` belongs only to the temporary Wi-Fi network created by the ESP32;
it is not the InkPanel/LXC address and disappears once the panel joins normal
Wi-Fi.

For bench work you can also skip provisioning entirely: copy
`secrets.example.h` to `secrets.h` and fill it in. The sketch picks it up via
`__has_include`, so the repo still compiles for everyone else without it.
`secrets.h` is gitignored.

## Buttons

| Button | Action |
|---|---|
| KEY1 | Wake and refresh now |
| KEY2 | Reserved |
| KEY3 held at boot | Clear credentials and enter captive-portal recovery |

## How a wake cycle works

1. Wake on timer or KEY1.
2. Join WiFi from stored credentials.
3. `GET /api/devices/{id}/frame` with the current ETag, battery voltage,
   firmware version and wake reason.
4. `200` → draw and store the new ETag. `304` → do nothing at all.
   Anything else → leave the panel alone and back off.
5. Sleep for `X-Next-Wake-Seconds` from the response.

The device has no scheduling logic of its own beyond a fallback for when the
server is unreachable. Cadence is a server concern, so changing it never means
reflashing.

## Panel compatibility

This firmware drives a 7.5" 800x480 mono panel (Good Display GDEW075T7, flex
`WFT0583CZ61`) using the **old** Waveshare V2 sequence — panel setting
`0x00 = 0x3F`, LUT-from-register with five 42-byte tables at `0x20`–`0x24`,
BUSY active low.

Waveshare's current V2 driver and GxEPD2's `GxEPD2_750_T7` will **not** drive it
correctly. If the panel stays blank, confirm which revision you have before
changing anything else.

**Do not "tidy" the `OldV2EPD` init sequence.** It looks redundant in places. It
works.

## Troubleshooting

**The new-board browser setup cannot reconnect after flashing.** Close Arduino
Serial Monitor or any other program holding the port, leave the board plugged
directly into the computer, and retry **Set up a new board**. Native USB briefly
disappears while the S3 resets, so the browser intentionally waits for it to
re-enumerate.

**The board reaches `inkpanel-setup` / `192.168.4.1`.** USB provisioning was not
received during the startup window. You can use the captive portal as a
fallback, or reconnect USB and run **Set up a new board** again.

**Panel never flashes.** Almost never the code. In order of likelihood: the EE04
jumper is not on 24 Pin, the ribbon is reversed or not fully seated, or
`EPD_ENABLE` is not being driven high. Serial reports `BUSY timeout` in all
three cases.

**Panel flashes on every wake even when nothing changed.** The ETag is not
surviving deep sleep, or the server's `ETag` header is not being captured.

**Short read / wrong byte count.** The server sent something other than 48,000
bytes. Check the panel profile matches on both sides.
