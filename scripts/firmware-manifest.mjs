#!/usr/bin/env node
/**
 * Turn arduino-cli's build report into the manifest the web flasher reads.
 *
 * This also owns reading FIRMWARE_VERSION out of config.h. That used to live
 * in the calling shell script as a `grep -oP`, which is only checkable by
 * eyeballing the shell script's text — it cannot be exercised from a test in
 * a way that fails when the version is hardcoded instead. Doing it here,
 * behind an exported function, means a test can actually run the extraction
 * against a real config.h and assert on the result.
 *
 * Usage: node scripts/firmware-manifest.mjs <distDir> <sketchDir>
 */
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// The three region images used for a settings-preserving firmware update.
//
// Only the bootloader offset is read from arduino-cli's build properties
// below: it is the one offset that varies by chip family within the ESP32
// line, and arduino-cli publishes it as `build.bootloader_addr`.
//
// PARTITION_TABLE_OFFSET and APP_OFFSET are NOT read from arduino-cli — it
// does not publish them. They are the Arduino ESP32 core's standard offsets
// for the default partition scheme this board builds against. If the
// partition scheme ever changes, these two constants need to be revisited by
// hand; nothing here will warn you.
const PARTITION_TABLE_OFFSET = '0x8000';
const APP_OFFSET = '0x10000';

/**
 * Read the version the firmware will actually report, rather than restating
 * it somewhere else. Two sources of truth for a version is how a board ends
 * up claiming to be something it is not.
 */
export async function readFirmwareVersion(sketchDir) {
  const configPath = join(sketchDir, 'config.h');
  const text = await readFile(configPath, 'utf8');
  const match = text.match(/FIRMWARE_VERSION\s*=\s*"([^"]+)"/);
  if (!match) {
    throw new Error(`could not find FIRMWARE_VERSION in ${configPath}`);
  }
  return match[1];
}

export async function buildManifest(dist, sketchDir) {
  const version = await readFirmwareVersion(sketchDir);

  const report = JSON.parse(await readFile(join(dist, 'build-report.json'), 'utf8'));
  const rawProps = report.builder_result?.build_properties ?? report.build_properties;
  if (!rawProps) {
    throw new Error(`unexpected build-report.json shape: no build_properties found (keys: ${Object.keys(report)})`);
  }
  const props = Object.fromEntries(
    rawProps
      .map((line) => {
        const eq = line.indexOf('=');
        return eq === -1 ? null : [line.slice(0, eq), line.slice(eq + 1)];
      })
      .filter(Boolean),
  );

  const bootloaderAddr = props['build.bootloader_addr'];
  if (bootloaderAddr === undefined) {
    throw new Error(`unexpected build-report.json shape: build.bootloader_addr not found in build_properties (keys: ${Object.keys(props)})`);
  }

  const files = await readdir(dist);
  const find = (suffix) => files.find((f) => f.endsWith(suffix));

  // A routine update must not write through NVS. These three binaries cover
  // only the bootloader, partition table and application regions, so the
  // board's stored Wi-Fi/server settings remain untouched.
  const updateParts = [
    { path: find('.bootloader.bin'), offset: bootloaderAddr },
    { path: find('.partitions.bin'), offset: PARTITION_TABLE_OFFSET },
    { path: find('.ino.bin'), offset: APP_OFFSET },
  ];

  for (const part of updateParts) {
    if (!part.path) {
      // Keep the long-standing public error phrase "missing a required binary"
      // so callers/tests can classify this consistently. The context makes it
      // clear these are the region binaries required by safe update mode.
      throw new Error(`missing a required binary for safe update in ${dist}: ${JSON.stringify(updateParts)}`);
    }
  }

  // Fresh installs and factory recovery prefer arduino-cli's complete merged
  // image. It contains the same regions already placed at their toolchain-
  // chosen addresses and can safely overwrite the whole chip because these
  // modes deliberately erase configuration first. If a toolchain does not
  // emit a merged image, the three region images remain a valid full-install
  // fallback after an explicit chip erase.
  const merged = find('.merged.bin');
  const parts = merged
    ? [{ path: merged, offset: '0x0' }]
    : updateParts;

  // An empty binary is worse than a missing one. esptool-js's writeFlash
  // silently skips zero-length images, leaving a flash operation that appears
  // successful but cannot boot. Validate every binary exposed by either mode.
  const pathsToValidate = [...new Set([...parts, ...updateParts].map((part) => part.path))];
  for (const path of pathsToValidate) {
    const { size } = await stat(join(dist, path));
    if (size === 0) {
      throw new Error(
        `${path} is empty (0 bytes). A flash would silently skip it and produce an unbootable board.`,
      );
    }
  }

  const normalise = (list) => list.map((p) => ({ path: p.path, offset: Number(p.offset) }));
  const manifest = {
    version,
    builtAt: new Date().toISOString(),
    // `parts` is the install/recovery set for backwards compatibility with
    // older web UIs. New UIs use updateParts for the NVS-safe update mode.
    parts: normalise(parts),
    updateParts: normalise(updateParts),
  };

  await writeFile(join(dist, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

// Only run as a CLI when invoked directly (`node firmware-manifest.mjs ...`),
// so tests can import readFirmwareVersion/buildManifest above without a side
// effect of import being a filesystem write or a process.exit. Compared via
// pathToFileURL rather than string-templating argv[1] into a file:// URL,
// because on Windows argv[1] uses backslashes and import.meta.url does not.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dist, sketchDir] = process.argv.slice(2);
  if (!dist || !sketchDir) {
    console.error('usage: firmware-manifest.mjs <distDir> <sketchDir>');
    process.exit(1);
  }
  try {
    await buildManifest(dist, sketchDir);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
