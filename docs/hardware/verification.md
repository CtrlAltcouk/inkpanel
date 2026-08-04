# Hardware verification

The firmware is deployed and working on one real panel. Stages 1 and 2 below
have been completed. Complete Stage 3 onwards to fully verify the remaining
features, and record the date and firmware version when doing so.

Do not tick optimistically. A box that fails is a bug to fix, not a note to
carry forward.

**Date tested:** ____________  **Firmware:** ____________

## Before powering anything

- [ ] **WiFi antenna clipped onto the U.FL socket on the XIAO module**
- [ ] USB and battery both disconnected while handling the ribbon
- [ ] 24-pin ribbon inserted the correct way round, latch fully closed
- [ ] EE04 jumper set to **24 Pin**

> The antenna is easy to overlook and does not fail cleanly. Without it the
> panel associates roughly one boot in three, and the visible symptom is an
> HTTP read timeout rather than anything that looks like a WiFi problem.

## Stage 1 — fetch and display (commit "fetch and display server-rendered frames")

USB powered, `secrets.h` created from the example.

- [ ] Serial at 115200 shows `[inkpanel] 0.1.0 device=esp32-xxxxxx`
- [ ] WiFi connects and prints an IP
- [ ] `[net] GET ... -> 200`
- [ ] Panel draws the **enrolment screen**, showing the server URL and this
      device's ID
- [ ] Enrolment text is legible with no missing horizontal bands
- [ ] Claim the device in the web UI, add a calendar URL and location
- [ ] Reset — panel now draws the dashboard
- [ ] Both outer borders reach all four edges; image is not mirrored or rotated
- [ ] Black is even, not blotchy
- [ ] The two Spec 2 slots show their hatched empty state, not blank white
- [ ] Smallest text (13px weather detail, footer) is readable at arm's length

## Stage 2 — deep sleep (commit "deep sleep, RTC-persisted ETag")

- [ ] After drawing, serial prints `[sleep] 900 seconds` and goes quiet
- [ ] Device wakes on its own and prints `wake=timer`
- [ ] Second wake logs `304` **and the panel does not flash**
- [ ] Press KEY1 — wakes immediately, logs `wake=button`
- [ ] Change a calendar event, wait one interval — panel updates
- [ ] Stop the server — panel keeps its image, log shows increasing backoff
      (900, 1800, 3600, capped)
- [ ] Restart the server — device recovers on its next wake without a reset
- [ ] Disconnect USB, run on battery only — still wakes and refreshes

> If the panel flashes on a `304`, the ETag is not surviving sleep. Check that
> `storedEtag` is `RTC_DATA_ATTR` and that the server's `ETag` header is being
> captured by `collectHeaders`.

## Stage 3 — provisioning (commit "on-device WiFi provisioning")

Delete `secrets.h` and re-flash, with **Erase All Flash Before Sketch Upload**
enabled once.

- [ ] Serial reports the portal starting
- [ ] `inkpanel-setup` appears in the phone's WiFi list
- [ ] Joining it triggers a captive-portal prompt (or `http://192.168.4.1` works)
- [ ] Network list is populated and readable
- [ ] Saving reboots the device and it fetches a frame
- [ ] Wrong password fails gracefully and retries rather than bricking
- [ ] Submitting with an empty server address is rejected, not saved
- [ ] Hold KEY3 and reset — returns to the portal
- [ ] After a factory reset the device re-enrols under the **same** device ID

## Stage 4 — power

Requires the Task 1 measurement in `sleep-current.md`.

- [ ] Deep sleep current matches the recorded figure
- [ ] Battery percentage in the footer tracks a discharging cell
- [ ] Low battery (below 3.5 V) lengthens the interval to 6 hours

## Stage 5 — endurance

- [ ] Runs 48 hours unattended with no intervention
- [ ] Record battery voltage at start and end: ______ V → ______ V
- [ ] Extrapolated runtime: ______ days
- [ ] No ghosting or blotching after two days of refreshes

## Known gaps at time of writing

- The golden image was generated on Windows and will not match one rendered in
  the Linux container. Regenerate before wiring CI to it.
- The Docker image has never been built.
