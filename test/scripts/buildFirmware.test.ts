import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const SCRIPT = join(process.cwd(), 'scripts', 'build-firmware.sh');
const MANIFEST_SCRIPT = join(process.cwd(), 'scripts', 'firmware-manifest.mjs');
const REAL_SKETCH_DIR = join(process.cwd(), 'firmware', 'inkpanel');

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

// The board is a XIAO ESP32-S3 *Plus* (16MB flash), not the plain
// XIAO_ESP32S3 (8MB). Building for the wrong one produced the single most
// misleading failure in this project's history: arduino-cli compiled a valid
// image, the manifest offsets were correct, the web flasher wrote all three
// images and reported success — and the board then boot-looped printing
// "invalid header: 0x00000000", because the ROM cannot boot an image built
// for a different flash layout. Not one step in the chain reported an error.
test('the build script targets the Plus variant, which is the board that actually exists', async () => {
  const text = await readFile(SCRIPT, 'utf8');
  const fqbnLine = text.split('\n').find((l) => /^FQBN=/.test(l));
  assert.ok(fqbnLine, 'could not find the FQBN assignment');
  assert.match(
    fqbnLine!,
    /XIAO_ESP32S3_PLUS/,
    'must build for the Plus variant — the plain XIAO_ESP32S3 has 8MB flash and yields an image this board cannot boot',
  );
});

test('the build script rejects an unknown FQBN instead of building for the wrong board', async () => {
  const text = await readFile(SCRIPT, 'utf8');
  // Comment lines are stripped first: the explanatory comment above the FQBN
  // contains the phrase "arduino-cli compiled a perfectly valid image", which
  // a naive substring search matches ahead of the real compile step and
  // inverts the ordering check. Prose is not code.
  const code = text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

  // The check must come before the compile, or it cannot prevent anything.
  const validation = code.indexOf('board details --fqbn');
  const compile = code.indexOf('arduino-cli compile');
  assert.ok(validation > -1, 'no FQBN validation found');
  assert.ok(compile > -1, 'no compile step found');
  assert.ok(validation < compile, 'the FQBN check must run before the compile, not after');
});

// Fakes just enough of an arduino-cli output dir for the manifest generator
// to run against, without arduino-cli: a build report plus the three binary
// names it looks for.
async function makeFakeDist(dir: string) {
  await writeFile(
    join(dir, 'build-report.json'),
    JSON.stringify({ builder_result: { build_properties: ['build.bootloader_addr=0x0'] } }),
    'utf8',
  );
  await writeFile(join(dir, 'inkpanel.ino.bootloader.bin'), 'bootloader', 'utf8');
  await writeFile(join(dir, 'inkpanel.ino.partitions.bin'), 'partitions', 'utf8');
  await writeFile(join(dir, 'inkpanel.ino.bin'), 'app', 'utf8');
}

test('the manifest generator reads the version out of config.h rather than hardcoding it', async () => {
  // A hardcoded version silently lies about what is on the board. This runs
  // the real generator, as a real subprocess, against the real firmware
  // sketch — so it fails if the version is ever hardcoded, or if config.h
  // stops being consulted. (Substring-matching the shell script's text, as
  // the old version of this test did, cannot detect either of those: it
  // passed even when the version was hardcoded, because the script's own
  // error message still mentioned FIRMWARE_VERSION and config.h.)
  const dist = await mkdtemp(join(tmpdir(), 'inkpanel-fw-dist-'));
  try {
    await makeFakeDist(dist);
    const result = spawnSync(process.execPath, [MANIFEST_SCRIPT, dist, REAL_SKETCH_DIR], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);

    const configText = await readFile(join(REAL_SKETCH_DIR, 'config.h'), 'utf8');
    const expected = configText.match(/FIRMWARE_VERSION\s*=\s*"([^"]+)"/)?.[1];
    assert.equal(expected, '0.1.0', 'sanity check: firmware/inkpanel/config.h is expected to say 0.1.0');

    const manifest = JSON.parse(await readFile(join(dist, 'manifest.json'), 'utf8'));
    assert.equal(manifest.version, expected);
  } finally {
    await rm(dist, { recursive: true, force: true });
  }
});

test('the manifest generator fails loudly when config.h has no FIRMWARE_VERSION', async () => {
  const dist = await mkdtemp(join(tmpdir(), 'inkpanel-fw-dist-'));
  const sketch = await mkdtemp(join(tmpdir(), 'inkpanel-fw-sketch-'));
  try {
    await writeFile(join(sketch, 'config.h'), '#pragma once\n// no version constant in this one\n', 'utf8');
    const result = spawnSync(process.execPath, [MANIFEST_SCRIPT, dist, sketch], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, 'must not succeed when there is no version to read');
    assert.match(result.stderr, /FIRMWARE_VERSION/);
  } finally {
    await rm(dist, { recursive: true, force: true });
    await rm(sketch, { recursive: true, force: true });
  }
});

test('flash offsets live in exactly one documented place', async () => {
  // The offsets used to be claimed (in comments) to come from arduino-cli's
  // build properties, with hardcoded defaults as a fallback. In reality only
  // the bootloader offset is ever read from build properties; the
  // partition-table and app offsets are unconditional literals. The old
  // version of this test asserted the *shell script* contained no 0x8000 or
  // 0x1000 — true, but only because the shell script never held offsets to
  // begin with, not because the offsets came from arduino-cli. What actually
  // matters: the shell script still holds none, and the manifest generator
  // defines each literal exactly once, as a named constant, rather than the
  // same number being scattered across the codebase.
  const shellText = await readFile(SCRIPT, 'utf8');
  assert.doesNotMatch(shellText, /0x8000/, 'the shell script must not hardcode a flash offset');
  assert.doesNotMatch(shellText, /0x10000/, 'the shell script must not hardcode a flash offset');

  const manifestText = await readFile(MANIFEST_SCRIPT, 'utf8');
  assert.equal(
    (manifestText.match(/0x8000/g) ?? []).length,
    1,
    'the partition-table offset should be defined exactly once, as a named constant',
  );
  assert.equal(
    (manifestText.match(/0x10000/g) ?? []).length,
    1,
    'the app offset should be defined exactly once, as a named constant',
  );
});

test('the manifest generator fails when build-report.json lacks build_properties', async () => {
  const dist = await mkdtemp(join(tmpdir(), 'inkpanel-fw-dist-'));
  const sketch = await mkdtemp(join(tmpdir(), 'inkpanel-fw-sketch-'));
  try {
    await writeFile(join(sketch, 'config.h'), 'constexpr const char* FIRMWARE_VERSION = "0.1.0";\n', 'utf8');
    await writeFile(
      join(dist, 'build-report.json'),
      JSON.stringify({ some_totally_different_shape: { nested: true } }),
      'utf8',
    );
    const result = spawnSync(process.execPath, [MANIFEST_SCRIPT, dist, sketch], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, 'must not succeed with unrecognised build-report shape');
    assert.match(result.stderr, /build_properties/, 'error must name the missing build_properties');
  } finally {
    await rm(dist, { recursive: true, force: true });
    await rm(sketch, { recursive: true, force: true });
  }
});

test('the manifest generator fails when build.bootloader_addr is missing from build_properties', async () => {
  const dist = await mkdtemp(join(tmpdir(), 'inkpanel-fw-dist-'));
  const sketch = await mkdtemp(join(tmpdir(), 'inkpanel-fw-sketch-'));
  try {
    await writeFile(join(sketch, 'config.h'), 'constexpr const char* FIRMWARE_VERSION = "0.1.0";\n', 'utf8');
    await writeFile(
      join(dist, 'build-report.json'),
      JSON.stringify({ builder_result: { build_properties: ['some.other_prop=value'] } }),
      'utf8',
    );
    const result = spawnSync(process.execPath, [MANIFEST_SCRIPT, dist, sketch], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, 'must not succeed when build.bootloader_addr is missing');
    assert.match(result.stderr, /build.bootloader_addr/, 'error must name the missing property');
  } finally {
    await rm(dist, { recursive: true, force: true });
    await rm(sketch, { recursive: true, force: true });
  }
});

// esptool-js's writeFlash silently `continue`s past any zero-length image --
// its only complaint goes to debug(), which the web flasher does not wire up.
// So a 0-byte bootloader is skipped with no error at all: the flash reports
// complete success and the board boot-loops on "invalid header: 0x00000000"
// because nothing was written to 0x0. A missing file was already caught; an
// empty one was not, and it is the more dangerous of the two precisely
// because everything downstream reports success.
test('the manifest generator fails when a required binary is empty, not just missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-empty-bin-'));
  try {
    await makeFakeDist(dir);
    await writeFile(join(dir, 'inkpanel.ino.bootloader.bin'), '', 'utf8');

    const result = spawnSync(process.execPath, [MANIFEST_SCRIPT, dir, REAL_SKETCH_DIR], {
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, 'an empty binary must fail the build');
    assert.match(result.stderr, /empty/i);
    assert.match(result.stderr, /bootloader/i, 'the message must name which binary is empty');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the manifest generator fails when a required binary file is missing', async () => {
  const dist = await mkdtemp(join(tmpdir(), 'inkpanel-fw-dist-'));
  const sketch = await mkdtemp(join(tmpdir(), 'inkpanel-fw-sketch-'));
  try {
    await writeFile(join(sketch, 'config.h'), 'constexpr const char* FIRMWARE_VERSION = "0.1.0";\n', 'utf8');
    await makeFakeDist(dist);
    // Delete one of the required binaries
    await rm(join(dist, 'inkpanel.ino.bootloader.bin'));
    const result = spawnSync(process.execPath, [MANIFEST_SCRIPT, dist, sketch], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, 'must not succeed when a binary is missing');
    assert.match(result.stderr, /missing a required binary/, 'error must indicate missing binary');
  } finally {
    await rm(dist, { recursive: true, force: true });
    await rm(sketch, { recursive: true, force: true });
  }
});
