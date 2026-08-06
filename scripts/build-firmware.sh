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
FQBN="esp32:esp32:XIAO_ESP32S3"

command -v arduino-cli >/dev/null || {
  echo "arduino-cli not found. See https://arduino.github.io/arduino-cli/" >&2
  exit 1
}

# Read the version the firmware will actually report, rather than restating it
# here. Two sources of truth for a version is how a board ends up claiming to
# be something it is not.
VERSION="$(grep -oP 'FIRMWARE_VERSION\s*=\s*"\K[^"]+' "$SKETCH/config.h")"
[ -n "$VERSION" ] || { echo "could not read FIRMWARE_VERSION from config.h" >&2; exit 1; }

rm -rf "$DIST"
mkdir -p "$DIST"

echo "== compiling $VERSION for $FQBN =="
# --output-dir puts the binaries somewhere predictable; --json makes the
# build report machine-readable so offsets come from arduino-cli itself.
arduino-cli compile \
  --fqbn "$FQBN" \
  --output-dir "$DIST" \
  --json \
  "$SKETCH" >"$DIST/build-report.json"

# arduino-cli emits <sketch>.ino.bootloader.bin, .partitions.bin and .ino.bin.
# Offsets for the ESP32-S3 come from the build properties in the report rather
# than being typed here, so a future partition-table change cannot leave this
# script writing to stale addresses.
node "$ROOT/scripts/firmware-manifest.mjs" "$DIST" "$VERSION"

echo "== wrote $DIST/manifest.json =="
cat "$DIST/manifest.json"
