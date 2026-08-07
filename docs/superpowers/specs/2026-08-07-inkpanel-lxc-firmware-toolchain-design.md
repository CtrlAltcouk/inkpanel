# inkpanel — Spec 4: Firmware toolchain in the LXC

**Date:** 2026-08-07
**Status:** Approved, ready for implementation
**Follows:** [Spec 3](2026-08-06-inkpanel-web-flash-design.md), merged.

---

## 1. What this is

Spec 3 added a Flash tab that writes firmware to a board from the browser. It
flashes a build; it does not produce one. Today that build is a manual
`arduino-cli` step on a developer's machine, and `firmware/dist/` is gitignored
— so a `git pull` on the LXC brings the code but no binaries, and the Flash tab
correctly reports that no build is available.

This spec closes that gap: **the container builds its own firmware**, so a
Proxmox install is self-contained. Update the LXC and the Flash tab is ready,
with firmware matching the code that was just pulled.

### Explicitly not in this spec

| Deferred | Why |
|---|---|
| A "Build firmware" button in the UI | Automatic-on-update covers the actual need. A button is a second trigger for the same operation and can wait until something wants it |
| Building firmware in CI | The build has to land on the LXC's disk to be served; CI would mean publishing and fetching artifacts, a bigger change than this needs |
| Cross-compiling for other boards | This project targets one board |

**Nothing in the server or the Flash tab changes.** They already behave
correctly when a build exists and when one doesn't. This is entirely a
provisioning change.

---

## 2. Architecture

Three changes, all in `scripts/proxmox/`.

### 2.1 The installer gains a toolchain step

`scripts/proxmox/inkpanel-lxc.sh` installs `arduino-cli` into
`/usr/local/bin` — root-owned and not writable by the `inkpanel` user, the
same posture already used for the updater, so the web application can never
influence what a build does.

The `esp32:esp32` core is then installed **as the `inkpanel` user**.
`arduino-cli` stores cores under the invoking user's home (`~/.arduino15`),
and the build itself runs as `inkpanel`; installing the core as root would put
it somewhere the build cannot see. This is the same class of mistake as
running `npm ci` as the wrong user, which the installer already avoids.

The installer finishes with an initial firmware build, so a fresh container
has a flashable panel immediately rather than after the first update.

### 2.2 The updater rebuilds only when firmware changed

`scripts/proxmox/files/inkpanel-update` already records the state of
`package-lock.json` before and after `git pull` and runs `npm ci` only when it
changed. The firmware rebuild follows exactly that shape: capture the commit
before the pull, and afterwards check whether anything under `firmware/`
changed:

```
git diff --name-only BEFORE..AFTER -- firmware/
```

Most updates touch neither the firmware nor the lockfile and will skip both
steps.

### 2.3 A failed build must never fail the update

The rebuild runs outside the fatal path. A compile error, a missing toolchain,
or a full disk gets logged to the update log, and the update still reports
success.

This is not leniency, it is the updater's existing rule: *a broken update must
be a no-op, not an outage.* The server's job is serving frames to panels, and
whether an ESP32 compile succeeded has nothing to do with that. Coupling them
would mean a firmware typo could stop every panel in the house getting a
dashboard.

The consequence is stated plainly rather than hidden: **after a failed
rebuild, the Flash tab offers the previous build, not the current code.** The
update log is the place that says so.

---

## 3. Disk

The ESP32 core and its Xtensa toolchain are roughly **1.5–2.5 GB**, landing in
the `inkpanel` user's home. The container already holds Node, the application,
and Chromium.

Two consequences:

- **The installer's default rises from `DISK=8` to `DISK=12`** for new
  containers.
- **The installer checks free space before installing the core** and fails
  with a clear message naming the shortfall. Filling a disk mid-install leaves
  a half-extracted toolchain and a container that is confusing to diagnose;
  refusing up front is kinder.

**A default change does not help an existing container** — it was provisioned
at whatever size it was created with. An existing install with too little room
needs `pct resize <CTID> rootfs +6G` first. The installer's failure message
says this, because the person hitting it is exactly the person who needs to
know it.

---

## 4. Failure behaviour

| Situation | Behaviour |
|---|---|
| Not enough disk at install time | Installer fails before installing the core, naming the shortfall and the `pct resize` fix |
| `arduino-cli` download fails at install time | Installer fails — the toolchain is a declared part of the install |
| Firmware build fails at install time | Logged; install completes. The Flash tab reports no build available |
| Firmware build fails during an update | Logged; **update reports success**. Flash tab keeps offering the previous build |
| `git pull` did not touch `firmware/` | Rebuild skipped entirely |

---

## 5. Testing

The same honest limit that applied to the original installer applies here:
**there is no Proxmox host in the development environment**, so these scripts
are verified by text assertion, not execution.

| Layer | Coverage |
|---|---|
| Installer | `arduino-cli` installed root-owned; core installed **as the app user**; build invoked **as the app user**; free-space guard present and ahead of the core install; `DISK` default is 12 |
| Updater | Rebuild is conditional on `firmware/` changing; rebuild **cannot call `fail`** and is not inside the fatal path |
| Shell syntax | `bash -n` on both scripts |

The most important of these is that **the rebuild cannot abort the update**.
That is the property most likely to regress under a later edit, and its
failure mode — every panel losing its dashboard because of an unrelated
compile error — is the worst outcome in this spec. It gets a test that fails
if the build step is ever moved into the fatal path.

**The first real deploy is the first genuine exercise of the whole chain**,
exactly as it was for the original installer. Text assertions prove structure,
not that `arduino-cli` installs cleanly on Debian 13 or that the Xtensa
toolchain fits. Those are found on first run.
