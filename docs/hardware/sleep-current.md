# EE04 deep-sleep current

**Not yet measured.** This is the single biggest unknown in the project and it
decides whether battery life is months or a fortnight. No firmware default
should be trusted until this is filled in.

## How to measure

Flash `firmware/spikes/sleep_current/sleep_current.ino`, then put a multimeter
in series on the battery positive lead, set to µA. Allow 30 seconds to settle.

Measure three configurations:

| # | Configuration | Reading |
|---|---|---|
| 1 | Panel rail off (`PANEL_RAIL_OFF = true`), USB connected | ______ µA |
| 2 | Panel rail on (`PANEL_RAIL_OFF = false`), USB connected | ______ µA |
| 3 | **Panel rail off, USB disconnected, battery only** | ______ µA |

**Configuration 3 is the real number.** The USB-serial path draws current that
will dominate the reading, so a measurement taken over USB is meaningless.

**Date:** ____________  **Meter:** ____________

## What the result means

| Idle draw | Consequence |
|---|---|
| Under ~100 µA | The months-long estimate holds. Use the planned defaults. |
| 100 µA – 1 mA | Expect weeks. Lengthen intervals and say so in the README. |
| Over 1 mA | Days. **Stop and investigate the hardware** before building firmware around a false assumption. |

Carrier boards routinely have a power LED or a regulator with quiescent draw
that swamps the MCU's own ~7 µA. If configuration 3 is over 1 mA, look for an
LED to cut or a regulator that stays enabled — no firmware change recovers it.

## Estimate being tested

Assuming ~50 µA idle:

| | Estimate |
|---|---|
| Wake with full refresh | ~8 s awake, ≈0.22 mAh |
| Wake ending in `304` | ~4 s awake, no flash, ≈0.10 mAh |
| Deep sleep | ≈1.2 mAh/day |
| Total | ≈3.5 mAh/day → months on a 2000 mAh cell |
