# inkpanel firmware

> **Not yet run on hardware.** Written against the working
> `EE04_WFT0583CZ61_OldV2_Test` sketch, but never flashed. Work through
> [`docs/hardware/verification.md`](../docs/hardware/verification.md) before
> trusting it.

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

## First run

The panel starts a WiFi access point called `inkpanel-setup`. Join it from a
phone, pick your network, and enter your inkpanel server address — for example
`http://192.168.1.20:8080`. It restarts and shows an enrolment screen naming its
own device ID. Claim that device in the web UI.

For bench work you can skip the portal: copy `secrets.example.h` to `secrets.h`
and fill it in. The sketch picks it up via `__has_include`, so the repo still
compiles for everyone else without it. `secrets.h` is gitignored.

## Buttons

| Button | Action |
|---|---|
| KEY1 | Wake and refresh now |
| KEY2 | Reserved |
| KEY3 held at boot | Clear credentials, return to the setup portal |

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

**Panel never flashes.** Almost never the code. In order of likelihood: the EE04
jumper is not on 24 Pin, the ribbon is reversed or not fully seated, or
`EPD_ENABLE` is not being driven high. Serial reports `BUSY timeout` in all
three cases.

**Panel flashes on every wake even when nothing changed.** The ETag is not
surviving deep sleep, or the server's `ETag` header is not being captured.

**Short read / wrong byte count.** The server sent something other than 48,000
bytes. Check the panel profile matches on both sides.
