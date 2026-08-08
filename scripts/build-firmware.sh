#!/usr/bin/env bash
#
# Build the firmware and stage it for the web flasher.
#
# Run this by hand whenever firmware source changes. It is deliberately NOT
# wired into npm start, CI, or the LXC installer: the Arduino toolchain is a
# large dependency, and the server never needs to compile anything — it only
# serves what this produced.
#
# Requires arduino-cli with the esp32 core installed:
#   arduino-cli core install esp32:esp32
#
# Usage: ./scripts/build-firmware.sh
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKETCH="$ROOT/firmware/inkpanel"
DIST="$ROOT/firmware/dist"

# The board is a XIAO ESP32-S3 *Plus*, which is a different target from the
# plain XIAO_ESP32S3: 16MB of flash rather than 8MB, so a different partition
# scheme and flash configuration get baked into the bootloader image.
#
# This was originally set to the non-Plus board, and the failure it produced
# was thoroughly misleading: arduino-cli compiled a perfectly valid image, the
# manifest offsets were right, the web flasher wrote all three images and
# reported success — and the board then sat in a boot loop printing
# "invalid header: 0x00000000", because the ROM could not boot an image built
# for a different flash layout. Nothing anywhere reported an error.
#
# Overridable so a different XIAO variant does not need a code change.
# Case matters. FQBNs are case-sensitive, and the board's *display name* is
# XIAO_ESP32S3_PLUS while its FQBN is XIAO_ESP32S3_Plus — so copying the name
# out of a board list gives you something that looks right and is rejected.
# This exact string came from `arduino-cli board listall` on the real machine.
FQBN="${FQBN:-esp32:esp32:XIAO_ESP32S3_Plus}"

# Resolve arduino-cli by path, not by trusting PATH to contain it.
#
# This script is invoked three different ways, and only one of them has a
# normal login PATH: by hand from a shell, by the LXC installer, and by
# inkpanel-update via `runuser -u inkpanel`. runuser resets the environment
# for the target user, and the inkpanel service user has /usr/sbin/nologin as
# its shell — so /usr/local/bin, where arduino-cli installs, is not on PATH
# there. The failure that produced was quiet and expensive: the updater's
# rebuild step is deliberately non-fatal, so every automatic rebuild would
# have logged "arduino-cli not found" and carried on reporting the update a
# success, while the Flash tab kept serving whatever stale build was on disk.
ARDUINO_CLI="${ARDUINO_CLI:-$(command -v arduino-cli 2>/dev/null || true)}"
if [[ -z "$ARDUINO_CLI" ]]; then
  for candidate in /usr/local/bin/arduino-cli /usr/bin/arduino-cli "$HOME/.local/bin/arduino-cli"; do
    if [[ -x "$candidate" ]]; then
      ARDUINO_CLI="$candidate"
      break
    fi
  done
fi
if [[ -z "$ARDUINO_CLI" ]]; then
  echo "arduino-cli not found on PATH or in /usr/local/bin, /usr/bin, ~/.local/bin." >&2
  echo "Install it (https://arduino.github.io/arduino-cli/) or set ARDUINO_CLI=/path/to/arduino-cli." >&2
  exit 1
fi

# Fail here, not three steps later on the bench. A wrong FQBN otherwise either
# stops the build with a bare "board not found", or — far worse, and what
# actually happened — builds cleanly for the wrong hardware and produces an
# image that only fails once it is on a board.
if ! "$ARDUINO_CLI" board details --fqbn "$FQBN" >/dev/null 2>&1; then
  echo "unknown FQBN: $FQBN" >&2
  echo "" >&2
  echo "Installed XIAO boards:" >&2
  "$ARDUINO_CLI" board listall 2>/dev/null | grep -i xiao >&2 || echo "  (none found — is the esp32 core installed?)" >&2
  echo "" >&2
  echo "Set FQBN=... to override, e.g. FQBN=esp32:esp32:XIAO_ESP32S3 $0" >&2
  exit 1
fi

rm -rf "$DIST"
mkdir -p "$DIST"

echo "== compiling for $FQBN =="
# --output-dir puts the binaries somewhere predictable; --json makes the
# build report machine-readable so the bootloader offset can be read from it
# directly (see firmware-manifest.mjs for why only that one offset).
"$ARDUINO_CLI" compile \
  --fqbn "$FQBN" \
  --output-dir "$DIST" \
  --json \
  "$SKETCH" >"$DIST/build-report.json"

# arduino-cli emits <sketch>.ino.bootloader.bin, .partitions.bin and .ino.bin.
# The manifest generator reads the version straight out of config.h (instead
# of it being restated here) and the flash offsets out of its own documented
# constants plus the build report above — see firmware-manifest.mjs, the one
# place both live.
node "$ROOT/scripts/firmware-manifest.mjs" "$DIST" "$SKETCH"

echo "== wrote $DIST/manifest.json =="
cat "$DIST/manifest.json"
