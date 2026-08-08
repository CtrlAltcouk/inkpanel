import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, mkdtemp, writeFile, rm, chmod } from 'node:fs/promises';
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
  // Exact case, deliberately. FQBNs are case-sensitive, and this board's
  // display name (XIAO_ESP32S3_PLUS) differs in case from its FQBN
  // (XIAO_ESP32S3_Plus) — so the all-caps form looks correct, matches what a
  // board listing shows, and is rejected by arduino-cli. That cost a whole
  // build cycle. A case-insensitive assertion here would not have caught it.
  assert.match(
    fqbnLine!,
    /esp32:esp32:XIAO_ESP32S3_Plus\b/,
    'must build for the Plus variant, with exactly this casing — the plain XIAO_ESP32S3 has 8MB flash and yields an image this board cannot boot',
  );
});

// The script runs three ways and only one has a normal login PATH: by hand,
// from the LXC installer, and from inkpanel-update via `runuser -u inkpanel`.
// runuser resets the environment for the target user, and that service user
// has /usr/sbin/nologin as its shell, so /usr/local/bin — where arduino-cli
// installs — is absent. The resulting failure was quiet and expensive: the
// updater's rebuild is deliberately non-fatal, so every automatic rebuild
// would log "arduino-cli not found", the update would still report success,
// and the Flash tab would keep serving whatever stale build was on disk.
//
// Runs the real script with an empty PATH and a fake arduino-cli pointed at
// by ARDUINO_CLI, asserting it gets far enough to invoke it — proving the
// resolution does not depend on PATH.
test('the build script finds arduino-cli without relying on PATH', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-cli-path-'));
  try {
    const fakeCli = join(dir, 'fake-arduino-cli');
    // Exits non-zero for `board details`, so the script stops at the FQBN
    // check. That is enough: reaching that check at all proves it resolved
    // and executed the binary.
    await writeFile(fakeCli, '#!/usr/bin/env bash\necho "FAKE CLI CALLED: $*" >&2\nexit 1\n', 'utf8');
    await chmod(fakeCli, 0o755);

    // PATH must stay usable — bash and coreutils are resolved through it, and
    // emptying it means the script never runs at all rather than running
    // without arduino-cli. ARDUINO_CLI takes precedence over PATH by design,
    // so this holds whether or not a real arduino-cli happens to be installed
    // on the machine running the tests.
    const result = spawnSync('bash', [SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, ARDUINO_CLI: fakeCli, HOME: dir },
    });

    assert.doesNotMatch(
      result.stderr,
      /arduino-cli not found/,
      'must not report arduino-cli missing when ARDUINO_CLI points at a real executable',
    );
    // Reaching the FQBN check is the proof: it runs only after resolution
    // succeeded, and it reports failure only by observing the resolved
    // binary's exit status. The fake's own stderr is not visible here because
    // the script redirects that call to /dev/null.
    assert.match(
      result.stderr,
      /unknown FQBN/,
      'the resolved binary must actually be invoked — reaching the FQBN check proves it was',
    );

    // The override alone is not the fix that matters in production — nothing
    // sets ARDUINO_CLI there. The fallback search is what makes the script
    // work under `runuser`, where /usr/local/bin is off PATH.
    const source = await readFile(SCRIPT, 'utf8');
    assert.match(
      source,
      /for candidate in[^\n]*\/usr\/local\/bin\/arduino-cli/,
      'must fall back to searching /usr/local/bin, which is where arduino-cli installs and where runuser cannot see it',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
  // Matches the invocation however arduino-cli is referenced — it is called
  // through "$ARDUINO_CLI" rather than by bare name, so that the binary can
  // be resolved without depending on PATH.
  const compile = code.search(/\bcompile\s+\\/);
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
// The merged image is one complete flash image with the bootloader,
// partition table and application already positioned inside it by the
// toolchain. Writing it at 0 is what esp-web-tools and the other mainstream
// browser flashers do, and it removes every offset this project could get
// wrong. The three-image write it replaces was correct on paper — verified
// offsets, valid non-empty images, a flash that reported success — and still
// left a board reading zeros at 0x0.
test('the manifest prefers the single merged image, written at offset 0', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-merged-'));
  try {
    await makeFakeDist(dir);
    await writeFile(join(dir, 'inkpanel.ino.merged.bin'), 'merged image', 'utf8');

    const result = spawnSync(process.execPath, [MANIFEST_SCRIPT, dir, REAL_SKETCH_DIR], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);

    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.parts.length, 1, 'a merged image is a single write, not three');
    assert.equal(manifest.parts[0].path, 'inkpanel.ino.merged.bin');
    assert.equal(manifest.parts[0].offset, 0, 'the merged image starts at the beginning of flash');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the manifest falls back to the three separate images when no merged one exists', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-unmerged-'));
  try {
    // makeFakeDist deliberately writes no merged.bin.
    await makeFakeDist(dir);

    const result = spawnSync(process.execPath, [MANIFEST_SCRIPT, dir, REAL_SKETCH_DIR], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);

    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.parts.length, 3);
    assert.deepEqual(
      manifest.parts.map((p: { offset: number }) => p.offset),
      [0, 32768, 65536],
      'bootloader at 0x0, partition table at 0x8000, application at 0x10000',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

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
