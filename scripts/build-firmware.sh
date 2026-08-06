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

rm -rf "$DIST"
mkdir -p "$DIST"

echo "== compiling for $FQBN =="
# --output-dir puts the binaries somewhere predictable; --json makes the
# build report machine-readable so the bootloader offset can be read from it
# directly (see firmware-manifest.mjs for why only that one offset).
arduino-cli compile \
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
