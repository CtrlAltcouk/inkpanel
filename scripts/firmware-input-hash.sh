#!/usr/bin/env bash
# Print a deterministic hash of every repository input that affects either
# production ESP32 firmware image. Build output under firmware/dist is
# intentionally excluded because it is gitignored and is the thing this hash
# is used to validate.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FQBN_VALUE="${FQBN:-esp32:esp32:XIAO_ESP32S3_Plus}"
MINI_FQBN_VALUE="${MINI_FQBN:-esp32:esp32:XIAO_ESP32S3}"

{
  printf 'fqbn=%s\n' "$FQBN_VALUE"
  printf 'mini_fqbn=%s\n' "$MINI_FQBN_VALUE"

  # Use Git's tracked-file list so generated files such as firmware/dist/* can
  # never make the fingerprint change merely because a build just completed.
  git ls-files -z -- \
    firmware/ \
    scripts/build-firmware.sh \
    scripts/compile-mini-firmware.sh \
    scripts/firmware-manifest.mjs \
    scripts/firmware-input-hash.sh \
  | sort -z \
  | while IFS= read -r -d '' file; do
      printf 'file=%s\n' "$file"
      sha256sum "$file"
    done
} | sha256sum | awk '{print $1}'
