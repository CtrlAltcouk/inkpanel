import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const SCRIPT = join(process.cwd(), 'scripts', 'build-firmware.sh');

test('the build script exists and is executable', async () => {
  const info = await stat(SCRIPT);
  assert.ok(info.isFile());
  // Mode check is meaningless on Windows, where every file reports 0666.
  if (process.platform !== 'win32') {
    assert.ok((info.mode & 0o111) !== 0, 'must be executable');
  }
});

test('the build script fails fast rather than producing a partial dist', async () => {
  const text = await readFile(SCRIPT, 'utf8');
  assert.match(text, /set -Eeuo pipefail/, 'a half-written dist would flash a broken board');
});

test('the build script reads the version from config.h rather than hardcoding it', async () => {
  // A hardcoded version silently lies about what is on the board.
  const text = await readFile(SCRIPT, 'utf8');
  assert.match(text, /FIRMWARE_VERSION/);
  assert.match(text, /config\.h/);
});

test('the build script derives flash offsets from arduino-cli, not literals', async () => {
  // Offsets that drift from the partition table brick the board in a way that
  // looks like a bad cable. They must come from the build, never be typed.
  const text = await readFile(SCRIPT, 'utf8');
  assert.doesNotMatch(text, /0x1000\b/, 'hardcoded bootloader offset');
  assert.doesNotMatch(text, /0x8000\b/, 'hardcoded partition offset');
});
