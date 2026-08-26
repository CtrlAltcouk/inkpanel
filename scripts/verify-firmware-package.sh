#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="${1:-$REPO_DIR/firmware/dist}"

test -s "$DIST_DIR/manifest.json"
test -s "$DIST_DIR/input.sha256"
test -n "$(find "$DIST_DIR" -maxdepth 1 -name '*.bin' -type f -size +0c -print -quit)"
test -s "$DIST_DIR/mini/manifest.json"
test -n "$(find "$DIST_DIR/mini" -maxdepth 1 -name '*.bin' -type f -size +0c -print -quit)"
test "$(node -e "const fs=require('node:fs'); const m=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); process.stdout.write(m.target)" "$DIST_DIR/manifest.json")" = "full"
test "$(node -e "const fs=require('node:fs'); const m=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); process.stdout.write(m.target)" "$DIST_DIR/mini/manifest.json")" = "mini"
test "$(cat "$DIST_DIR/input.sha256")" = "$(bash "$SCRIPT_DIR/firmware-input-hash.sh")"
