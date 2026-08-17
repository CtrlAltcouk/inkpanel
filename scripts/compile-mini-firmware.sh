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
# package containing the compiled binaries, an Arduino-IDE-ready production
# sketch, and a standalone SSD1681 driver test that needs no server.
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
# Keep the staged production directory named exactly `inkpanel` for that reason.
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

# Build a standalone test around the exact production MiniEPD implementation.
# It lets the real panel prove orientation, polarity, BUSY handling, refresh and
# controller sleep without requiring a feature-branch InkPanel server.
DRIVER_TEST="$WORK/InkPanelMiniDriverTest"
mkdir -p "$DRIVER_TEST"
cp "$SOURCE_SKETCH/MiniEPD.cpp" "$SOURCE_SKETCH/MiniEPD.h" "$DRIVER_TEST/"
cat >"$DRIVER_TEST/config.h" <<'EOF'
#pragma once
#include <stdint.h>
namespace Hardware {
constexpr int EPD_RST  = 1;  // XIAO D0
constexpr int EPD_CS   = 2;  // XIAO D1
constexpr int EPD_BUSY = 3;  // XIAO D2, active HIGH
constexpr int EPD_DC   = 4;  // XIAO D3
constexpr int EPD_SCLK = 7;  // XIAO D8
constexpr int EPD_MOSI = 9;  // XIAO D10
constexpr uint32_t SPI_HZ = 4'000'000;
}
constexpr uint32_t EPD_BUSY_TIMEOUT_MS = 60'000;
EOF
cat >"$DRIVER_TEST/InkPanelMiniDriverTest.ino" <<'EOF'
#include <Arduino.h>
#include <string.h>
#include "MiniEPD.h"

MiniEPD display;

static void pixel(uint8_t* fb, int x, int y, bool black = true) {
  if (x < 0 || x >= MiniEPD::WIDTH || y < 0 || y >= MiniEPD::HEIGHT) return;
  const size_t index = static_cast<size_t>(y) * (MiniEPD::WIDTH / 8) + x / 8;
  const uint8_t mask = static_cast<uint8_t>(0x80u >> (x & 7));
  if (black) fb[index] |= mask;
  else fb[index] &= static_cast<uint8_t>(~mask);
}

static void hline(uint8_t* fb, int x, int y, int w) {
  for (int i = 0; i < w; ++i) pixel(fb, x + i, y);
}

static void vline(uint8_t* fb, int x, int y, int h) {
  for (int i = 0; i < h; ++i) pixel(fb, x, y + i);
}

static void rect(uint8_t* fb, int x, int y, int w, int h) {
  hline(fb, x, y, w);
  hline(fb, x, y + h - 1, w);
  vline(fb, x, y, h);
  vline(fb, x + w - 1, y, h);
}

static void fillRect(uint8_t* fb, int x, int y, int w, int h) {
  for (int yy = y; yy < y + h; ++yy) {
    for (int xx = x; xx < x + w; ++xx) pixel(fb, xx, yy);
  }
}

static void checker(uint8_t* fb, int x, int y, int cells, int cellSize) {
  for (int cy = 0; cy < cells; ++cy) {
    for (int cx = 0; cx < cells; ++cx) {
      if (((cx + cy) & 1) == 0) {
        fillRect(fb, x + cx * cellSize, y + cy * cellSize, cellSize, cellSize);
      }
    }
  }
}

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\nInkPanel Mini production-driver validation");
  Serial.println("Expected: WHITE background with BLACK marks");
  Serial.println("TL=solid square, TR=outline square, BL=3 bars, BR=checker");

  uint8_t* fb = display.framebuffer();
  memset(fb, 0x00, MiniEPD::BUFFER_SIZE);  // logical white

  // Outer border and centre cross establish full 200x200 orientation.
  rect(fb, 2, 2, 196, 196);
  hline(fb, 70, 100, 60);
  vline(fb, 100, 70, 60);

  // Four deliberately different corner markers make rotation/mirroring obvious.
  fillRect(fb, 12, 12, 28, 28);       // TOP LEFT: solid
  rect(fb, 160, 12, 28, 28);          // TOP RIGHT: outline
  for (int i = 0; i < 3; ++i) {
    fillRect(fb, 14 + i * 10, 160, 5, 28); // BOTTOM LEFT: three vertical bars
  }
  checker(fb, 160, 160, 4, 7);        // BOTTOM RIGHT: checkerboard

  Serial.printf("Framebuffer: %u bytes\n", static_cast<unsigned>(MiniEPD::BUFFER_SIZE));
  Serial.println("Initialising SSD1681...");
  if (!display.begin()) {
    Serial.printf("FAILED begin: %s\n", display.lastError());
    return;
  }

  Serial.println("Running full refresh...");
  if (!display.display(fb)) {
    Serial.printf("FAILED refresh: %s\n", display.lastError());
    return;
  }

  Serial.println("Refresh complete. Entering controller sleep...");
  if (!display.sleep()) {
    Serial.printf("Sleep warning: %s\n", display.lastError());
    return;
  }

  Serial.println("PASS: driver refresh and sleep commands completed.");
}

void loop() {}
EOF

DRIVER_TEST_OUTPUT="$WORK/driver-test-output"
mkdir -p "$DRIVER_TEST_OUTPUT"
echo "== compiling standalone MiniEPD validation sketch =="
"$ARDUINO_CLI" compile --fqbn "$FQBN" --output-dir "$DRIVER_TEST_OUTPUT" "$DRIVER_TEST"
DRIVER_TEST_BIN="$(find "$DRIVER_TEST_OUTPUT" -maxdepth 1 -name '*.ino.bin' -type f -size +0c -print -quit)"
if [[ -z "$DRIVER_TEST_BIN" ]]; then
  echo "standalone MiniEPD validation sketch did not produce an application binary" >&2
  exit 1
fi

echo "== standalone MiniEPD validation compile OK =="

if [[ -n "$ARTIFACT_DIR" ]]; then
  rm -rf "$ARTIFACT_DIR"
  mkdir -p \
    "$ARTIFACT_DIR/binaries" \
    "$ARTIFACT_DIR/arduino/inkpanel" \
    "$ARTIFACT_DIR/driver-test/InkPanelMiniDriverTest"

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

  cp -a "$DRIVER_TEST"/. "$ARTIFACT_DIR/driver-test/InkPanelMiniDriverTest/"

  cat >"$ARTIFACT_DIR/README_FIRST.txt" <<'EOF'
INKPANEL MINI - HARDWARE VALIDATION BUILD
========================================

Hardware:
- Seeed Studio XIAO ESP32-S3 (standard, 8 MB)
- Seeed ePaper Driver Board for XIAO
- 1.54-inch 200x200 monochrome SSD1681 panel

This is a validation build from the InkPanel Mini feature branch. It is NOT the
normal 7.5-inch firmware and must not be flashed to an EE04 / 7.5-inch panel.

STEP 1 - VALIDATE THE PRODUCTION DISPLAY DRIVER FIRST
-----------------------------------------------------
Open:
  driver-test/InkPanelMiniDriverTest/InkPanelMiniDriverTest.ino

In Arduino IDE select the standard:
  XIAO_ESP32S3 / Seeed Studio XIAO ESP32S3

Do NOT select XIAO ESP32-S3 Plus.

Upload and open Serial Monitor at 115200 baud. The screen should be WHITE with:
- a black outer border;
- TOP LEFT: solid black square;
- TOP RIGHT: outline square;
- BOTTOM LEFT: three vertical black bars;
- BOTTOM RIGHT: checkerboard;
- a small cross in the centre.

The test performs ONE full refresh and then puts the SSD1681 controller to
sleep. Send a photo of the panel and the Serial output before moving to Step 2.
If the image is rotated, mirrored or inverted, do not compensate in the server;
the MiniEPD driver owns that physical-controller transform.

STEP 2 - FULL PRODUCTION MINI FIRMWARE
--------------------------------------
After the driver pattern is confirmed, open:
  arduino/inkpanel/inkpanel.ino

Select the same standard XIAO ESP32S3 and upload normally.

The validation copy already has INKPANEL_MINI baked into config.h and the 8 MB
Mini partition table installed as partitions.csv. Do not add compiler flags or
edit the partition table.

The production firmware uses the same InkPanel provisioning stack as the
full-size panel. In this Arduino validation build there is no WebFlash one-time
record, so it offers USB provisioning for 30 seconds and then starts the
inkpanel-setup Wi-Fi recovery portal if no settings are already stored.

IMPORTANT DURING FEATURE-BRANCH VALIDATION
------------------------------------------
A normal server still on main does not yet know the Mini panel profile. Full
end-to-end 5,000-byte frame fetching therefore waits until the feature-branch
server is deliberately used for that validation. Step 1 needs no server at all.

Compiled production Mini binaries are included under binaries/ for advanced or
recovery use. The Arduino IDE source is the preferred validation route.
EOF

  echo "== exported Mini validation package to $ARTIFACT_DIR =="
fi
