# EE04 deep-sleep current

**Not yet measured.** Seeed does not publish a figure for this board. What
follows is what can be inferred from their own claims and from measurements of
the bare XIAO module — enough to bound the answer, not enough to rely on.

## What is known

**Seeed's EE04 wiki** says only: *"Battery life depends on refresh frequency
(typically 3-month on a full charge with default settings)"*. No current figure.

**The XIAO 7.5" ePaper Panel** — Seeed's own integrated product using the same
silicon — claims 3 months from a 3.7 V 2000 mAh cell at a 6-hour refresh
interval.

**The bare XIAO ESP32-S3** has been measured by users in deep sleep at:

| Powered via | Deep sleep current |
|---|---|
| Battery pads | ~12 µA |
| 5 V pin | ~63 µA |
| 3V3 pin | ~298 µA |

The EE04 carrier adds a charging IC, a battery power switch, two switching
converters (the 150 µH inductors either side of the board) and the panel rail.
None of those are free.

## What the 3-month claim implies

2000 mAh over 90 days is 22.2 mAh/day, or **926 µA average**. At a 6-hour
refresh interval only four refreshes occur per day, costing well under 1 mAh in
total — so essentially all of that budget is idle draw.

That points to **several hundred µA**, not the tens of µA a bare ESP32-S3
suggests. Manufacturer battery claims are often conservative, so treat ~900 µA
as a pessimistic bound rather than a prediction.

## What that means for this project

Against inkpanel's default schedule — quiet hours 23:00–06:00, 15-minute
intervals otherwise, so roughly 68 wakes a day of which about a dozen actually
change anything:

| Idle draw | Idle cost | Wake cost | Total | 2000 mAh lasts |
|---|---|---|---|---|
| 12 µA | 0.3 mAh/day | 8.2 mAh/day | 8.5 | ~8 months |
| 100 µA | 2.4 | 8.2 | 10.6 | ~6 months |
| 500 µA | 12.0 | 8.2 | 20.2 | ~3 months |
| 900 µA | 21.6 | 8.2 | 29.8 | ~2 months |

**Every outcome in that range is acceptable.** Even the pessimistic end gives two
months at a 15-minute refresh, which is far better than the "days" scenario
worth worrying about.

The measurement still matters, but for a different reason than expected — it
decides **which lever is worth pulling**:

- **If idle is high (~900 µA)** it is 72% of the budget. Halving the refresh
  rate buys only about 14% more runtime, so cadence tuning is nearly pointless
  and the only real lever is hardware.
- **If idle is low (~12 µA)** the wake cycles dominate completely, and refresh
  cadence is the whole game.

## How to measure

Flash `firmware/spikes/sleep_current/sleep_current.ino`, then put a multimeter
in series on the battery positive lead, set to µA. Allow 30 seconds to settle.

| # | Configuration | Reading |
|---|---|---|
| 1 | Panel rail off (`PANEL_RAIL_OFF = true`), USB connected | ______ µA |
| 2 | Panel rail on (`PANEL_RAIL_OFF = false`), USB connected | ______ µA |
| 3 | **Panel rail off, USB disconnected, battery only** | ______ µA |

**Configuration 3 is the real number.** The USB-serial path draws current that
dominates the reading, so anything measured over USB is meaningless. The board's
ON/OFF switch must be ON — it cuts battery power entirely, which is useful for
storage but reads 0 µA and tells you nothing.

Comparing 1 against 2 also answers a separate question: how much the panel rail
costs when left enabled, and therefore whether driving `EPD_ENABLE` low before
sleep is doing anything useful.

**Date:** ____________  **Meter:** ____________

## If the result is bad

Over ~2 mA would mean days rather than months, and no firmware change recovers
it. Look for a power LED to cut, or a converter that stays enabled with no load.
Note also the bare-module finding above: how the XIAO is fed matters by a factor
of 25, so the EE04's power path is a reasonable place to look first.

## Sources

- [EE04 wiki](https://wiki.seeedstudio.com/epaper_ee04/)
- [XIAO 7.5" ePaper Panel product page](https://www.seeedstudio.com/XIAO-7-5-ePaper-Panel-p-6416.html)
- [XIAO ESP32S3 deep sleep current thread](https://forum.seeedstudio.com/t/xiao-esp32s3-deep-sleep-current-higher-than-expected/276916)
