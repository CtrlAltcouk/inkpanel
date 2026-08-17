#!/usr/bin/env bash
#
# Compile the InkPanel Mini target without publishing it to firmware/dist yet.
#
# Mini deliberately shares the production firmware source tree with the
# existing 7.5-inch target. A staged copy swaps only the partition table and
# adds INKPANEL_MINI, so the standard 8 MB XIAO ESP32-S3 gets the correct flash
# layout while the existing 16 MB XIAO ESP32-S3 Plus build remains untouched.
#
# This script is the CI/local compile gate during hardware validation. Once the
# real Mini has passed physical testing, the WebFlash packaging step can publish
# a second manifest from the same staged target.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_SKETCH="$ROOT/firmware/inkpanel"
FQBN="${MINI_FQBN:-esp32:esp32:XIAO_ESP32S3}"

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
  echo "arduino-cli not found; install it or set ARDUINO_CLI=/path/to/arduino-cli" >&2
  exit 1
fi

if ! "$ARDUINO_CLI" board details --fqbn "$FQBN" >/dev/null 2>&1; then
  echo "unknown Mini FQBN: $FQBN" >&2
  "$ARDUINO_CLI" board listall 2>/dev/null | grep -i xiao >&2 || true
  exit 1
fi

WORK="$(mktemp -d "$ROOT/firmware/.mini-compile.XXXXXX")"
cleanup() {
  rm -rf "$WORK"
}
trap cleanup EXIT

# Arduino requires the primary .ino file to match the sketch directory name.
# Keep the staged directory named exactly `inkpanel` for that reason.
SKETCH_ROOT="$WORK/inkpanel"
cp -a "$SOURCE_SKETCH" "$SKETCH_ROOT"
cp "$SKETCH_ROOT/partitions-mini.csv" "$SKETCH_ROOT/partitions.csv"

OUTPUT="$WORK/output"
mkdir -p "$OUTPUT"

echo "== compiling InkPanel Mini for $FQBN =="
"$ARDUINO_CLI" compile \
  --fqbn "$FQBN" \
  --build-property 'compiler.cpp.extra_flags=-DINKPANEL_MINI=1' \
  --output-dir "$OUTPUT" \
  "$SKETCH_ROOT"

APP_BIN="$(find "$OUTPUT" -maxdepth 1 -name '*.ino.bin' -type f -size +0c -print -quit)"
PART_BIN="$(find "$OUTPUT" -maxdepth 1 -name '*.partitions.bin' -type f -size +0c -print -quit)"
if [[ -z "$APP_BIN" || -z "$PART_BIN" ]]; then
  echo "Mini compile completed but expected non-empty firmware outputs are missing" >&2
  exit 1
fi

echo "== InkPanel Mini compile OK =="
echo "application: $(basename "$APP_BIN") ($(stat -c '%s' "$APP_BIN") bytes)"
echo "partitions:  $(basename "$PART_BIN") ($(stat -c '%s' "$PART_BIN") bytes)"
