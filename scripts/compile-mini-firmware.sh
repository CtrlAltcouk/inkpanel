#!/usr/bin/env bash
#
# Compile the InkPanel Mini target without publishing it to firmware/dist yet.
#
# Mini deliberately shares the production firmware source tree with the
# existing 7.5-inch target. A staged copy swaps only the partition table and
# adds INKPANEL_MINI, so the standard 8 MB XIAO ESP32-S3 gets the correct flash
# layout while the existing 16 MB XIAO ESP32-S3 Plus build remains untouched.
#
# Set MINI_ARTIFACT_DIR=/path to additionally export a hardware-validation
# package containing the compiled binaries and an Arduino-IDE-ready sketch.
# The normal production build leaves that variable unset and publishes nothing.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_SKETCH="$ROOT/firmware/inkpanel"
FQBN="${MINI_FQBN:-esp32:esp32:XIAO_ESP32S3}"
ARTIFACT_DIR="${MINI_ARTIFACT_DIR:-}"

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
MERGED_BIN="$(find "$OUTPUT" -maxdepth 1 -name '*.merged.bin' -type f -size +0c -print -quit)"
if [[ -z "$APP_BIN" || -z "$PART_BIN" || -z "$MERGED_BIN" ]]; then
  echo "Mini compile completed but expected non-empty firmware outputs are missing" >&2
  exit 1
fi

echo "== InkPanel Mini compile OK =="
echo "application: $(basename "$APP_BIN") ($(stat -c '%s' "$APP_BIN") bytes)"
echo "partitions:  $(basename "$PART_BIN") ($(stat -c '%s' "$PART_BIN") bytes)"
echo "merged:      $(basename "$MERGED_BIN") ($(stat -c '%s' "$MERGED_BIN") bytes)"

if [[ -n "$ARTIFACT_DIR" ]]; then
  rm -rf "$ARTIFACT_DIR"
  mkdir -p "$ARTIFACT_DIR/binaries" "$ARTIFACT_DIR/arduino/inkpanel"

  cp "$OUTPUT"/*.bin "$ARTIFACT_DIR/binaries/"

  # Export the exact production sources but bake the target define into
  # config.h. That makes the validation copy Arduino-IDE-ready without relying
  # on an IDE-specific custom compiler flag; every .cpp sees the same target.
  cp -a "$SOURCE_SKETCH"/. "$ARTIFACT_DIR/arduino/inkpanel/"
  {
    printf '#define INKPANEL_MINI 1\n'
    cat "$SOURCE_SKETCH/config.h"
  } >"$ARTIFACT_DIR/arduino/inkpanel/config.h"
  cp "$SOURCE_SKETCH/partitions-mini.csv" "$ARTIFACT_DIR/arduino/inkpanel/partitions.csv"

  cat >"$ARTIFACT_DIR/README_FIRST.txt" <<'EOF'
INKPANEL MINI - HARDWARE VALIDATION BUILD
========================================

Hardware:
- Seeed Studio XIAO ESP32-S3 (standard, 8 MB)
- Seeed ePaper Driver Board for XIAO
- 1.54-inch 200x200 monochrome SSD1681 panel

This is a validation build from the InkPanel Mini feature branch. It is NOT the
normal 7.5-inch firmware and must not be flashed to an EE04 / 7.5-inch panel.

RECOMMENDED: ARDUINO IDE
------------------------
1. Open arduino/inkpanel/inkpanel.ino.
2. Select the standard "XIAO_ESP32S3" / "Seeed Studio XIAO ESP32S3" board.
   Do NOT select XIAO ESP32-S3 Plus.
3. Select the Mini's COM port.
4. Upload normally.
5. Open Serial Monitor at 115200 baud.

The validation copy already has INKPANEL_MINI baked into config.h and the 8 MB
Mini partition table installed as partitions.csv. Do not add compiler flags or
edit the partition table.

PROVISIONING
------------
On first boot the firmware uses the same InkPanel provisioning stack as the
full-size panel: one-time flash provisioning when packaged by WebFlash, then USB
provisioning, then the inkpanel-setup captive portal as recovery.

For this Arduino validation build there is no WebFlash provisioning record, so
leave Serial Monitor open. The firmware first offers USB provisioning for 30
seconds and then starts the inkpanel-setup Wi-Fi recovery portal if no settings
are stored. You can configure Wi-Fi and the InkPanel server through that portal.

IMPORTANT DURING FEATURE-BRANCH VALIDATION
------------------------------------------
A normal server still on main does not yet know the Mini panel profile. Full
end-to-end frame fetching therefore waits until the Mini server changes are
available on the server being tested. The first physical check is that this
production driver boots, provisions, and reaches the SSD1681 without corrupting
or hanging the panel.

Compiled binaries are also included under binaries/ for advanced/recovery use.
The Arduino IDE source is the safest validation route because it uses the exact
standard-XIAO board settings when uploading.
EOF

  echo "== exported Mini validation package to $ARTIFACT_DIR =="
fi
