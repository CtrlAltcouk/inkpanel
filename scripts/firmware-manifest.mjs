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
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// The three images a full flash writes, and where each one is written.
//
// Only the bootloader offset is read from arduino-cli's build properties
// below: it is the one offset that varies by chip family within the ESP32
// line, and arduino-cli publishes it as `build.bootloader_addr`.
//
// PARTITION_TABLE_OFFSET and APP_OFFSET are NOT read from arduino-cli — it
// does not publish them. They are the Arduino ESP32 core's standard offsets
// for the default partition scheme this board (XIAO_ESP32S3) builds against.
// If the partition scheme ever changes (a custom partitions.csv), these two
// constants need to be revisited by hand; nothing here will warn you.
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
  const props = Object.fromEntries(
    (report.builder_result?.build_properties ?? report.build_properties ?? [])
      .map((line) => {
        const eq = line.indexOf('=');
        return eq === -1 ? null : [line.slice(0, eq), line.slice(eq + 1)];
      })
      .filter(Boolean),
  );

  const files = await readdir(dist);
  const find = (suffix) => files.find((f) => f.endsWith(suffix));

  const parts = [
    { path: find('.bootloader.bin'), offset: props['build.bootloader_addr'] ?? '0x0' },
    { path: find('.partitions.bin'), offset: PARTITION_TABLE_OFFSET },
    { path: find('.ino.bin'), offset: APP_OFFSET },
  ];

  for (const part of parts) {
    if (!part.path) throw new Error(`missing a required binary in ${dist}: ${JSON.stringify(parts)}`);
  }

  const manifest = {
    version,
    builtAt: new Date().toISOString(),
    parts: parts.map((p) => ({ path: p.path, offset: Number(p.offset) })),
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
