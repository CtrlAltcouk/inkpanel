#!/usr/bin/env bash
#
# Build both production firmware targets and stage them for the web flasher.
#
# The legacy/full-size package remains at firmware/dist so every existing
# caller keeps the same paths. InkPanel Mini is additive at firmware/dist/mini.
# Both targets are built into one staging tree and published with one directory
# swap, so a failed Mini compile can never replace a previously-good 7.5-inch
# package (and vice versa).
#
# Requires arduino-cli with the esp32 core installed:
#   arduino-cli core install esp32:esp32
#
# Usage: ./scripts/build-firmware.sh
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKETCH="$ROOT/firmware/inkpanel"
DIST="$ROOT/firmware/dist"

# Existing reference hardware: XIAO ESP32-S3 Plus, 16 MB flash.
# Exact case matters: the FQBN is XIAO_ESP32S3_Plus.
FQBN="${FQBN:-esp32:esp32:XIAO_ESP32S3_Plus}"

# InkPanel Mini reference hardware: standard XIAO ESP32-S3, 8 MB flash.
MINI_FQBN="${MINI_FQBN:-esp32:esp32:XIAO_ESP32S3}"

INPUT_HASH="$(FQBN="$FQBN" MINI_FQBN="$MINI_FQBN" bash "$ROOT/scripts/firmware-input-hash.sh")"

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

validate_fqbn() {
  local fqbn="$1" label="$2"
  if ! "$ARDUINO_CLI" board details --fqbn "$fqbn" >/dev/null 2>&1; then
    echo "unknown $label FQBN: $fqbn" >&2
    echo "" >&2
    echo "Installed XIAO boards:" >&2
    "$ARDUINO_CLI" board listall 2>/dev/null | grep -i xiao >&2 || echo "  (none found — is the esp32 core installed?)" >&2
    exit 1
  fi
}

validate_fqbn "$FQBN" "full-size"
validate_fqbn "$MINI_FQBN" "Mini"

# Never destroy the currently-served firmware before both replacement targets
# are complete. Compile into a sibling tree, then atomically swap it into place.
STAGE="$(mktemp -d "$ROOT/firmware/.dist-build.XXXXXX")"
MINI_SKETCH_WORK="$(mktemp -d "$ROOT/firmware/.mini-sketch.XXXXXX")"
OLD_DIST=""
cleanup() {
  [[ -z "${STAGE:-}" || ! -e "$STAGE" ]] || rm -rf "$STAGE"
  [[ -z "${MINI_SKETCH_WORK:-}" || ! -e "$MINI_SKETCH_WORK" ]] || rm -rf "$MINI_SKETCH_WORK"
  [[ -z "${OLD_DIST:-}" || ! -e "$OLD_DIST" ]] || rm -rf "$OLD_DIST"
}
trap cleanup EXIT

# ---------------------------------------------------------------- full-size

echo "== compiling full-size InkPanel for $FQBN =="
"$ARDUINO_CLI" compile \
  --fqbn "$FQBN" \
  --output-dir "$STAGE" \
  --json \
  "$SKETCH" >"$STAGE/build-report.json"

node "$ROOT/scripts/firmware-manifest.mjs" "$STAGE" "$SKETCH" full

# ---------------------------------------------------------------- Mini

MINI_SKETCH="$MINI_SKETCH_WORK/inkpanel"
cp -a "$SKETCH" "$MINI_SKETCH"
cp "$MINI_SKETCH/partitions-mini.csv" "$MINI_SKETCH/partitions.csv"
MINI_DIST="$STAGE/mini"
mkdir -p "$MINI_DIST"

echo "== compiling InkPanel Mini for $MINI_FQBN =="
"$ARDUINO_CLI" compile \
  --fqbn "$MINI_FQBN" \
  --build-property 'compiler.cpp.extra_flags=-DINKPANEL_MINI=1' \
  --output-dir "$MINI_DIST" \
  --json \
  "$MINI_SKETCH" >"$MINI_DIST/build-report.json"

node "$ROOT/scripts/firmware-manifest.mjs" "$MINI_DIST" "$MINI_SKETCH" mini

# Write freshness only after both manifests succeeded. The updater therefore
# never treats a package containing only one current target as complete.
printf '%s\n' "$INPUT_HASH" >"$STAGE/input.sha256"

# Same filesystem: replace the complete package set as one transaction.
mkdir -p "$(dirname "$DIST")"
if [[ -e "$DIST" ]]; then
  OLD_DIST="${DIST}.previous.$$"
  rm -rf "$OLD_DIST"
  mv "$DIST" "$OLD_DIST"
fi

if mv "$STAGE" "$DIST"; then
  STAGE=""
  if [[ -n "$OLD_DIST" ]]; then
    rm -rf "$OLD_DIST"
    OLD_DIST=""
  fi
else
  if [[ -n "$OLD_DIST" && -e "$OLD_DIST" ]]; then
    mv "$OLD_DIST" "$DIST"
    OLD_DIST=""
  fi
  echo "could not publish the new firmware build; previous build restored" >&2
  exit 1
fi

echo "== wrote full-size $DIST/manifest.json =="
echo "== wrote Mini $DIST/mini/manifest.json =="
echo "== firmware input fingerprint: $INPUT_HASH =="
echo "-- full-size manifest --"
cat "$DIST/manifest.json"
echo "-- Mini manifest --"
cat "$DIST/mini/manifest.json"
