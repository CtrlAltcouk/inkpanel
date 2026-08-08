#!/usr/bin/env node
/**
 * Turn arduino-cli's build report into the manifest the web flasher reads.
 *
 * This also owns reading FIRMWARE_VERSION out of config.h and the one-time
 * provisioning partition out of partitions.csv. Keeping both values derived
 * from the firmware source prevents the browser flasher from inventing a
 * flash address independently of the partition table compiled into the board.
 *
 * Usage: node scripts/firmware-manifest.mjs <distDir> <sketchDir>
 */
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// The three region images used for a settings-preserving firmware update.
// The custom InkPanel partition table deliberately keeps these standard
// offsets stable so existing boards can move to it without relocating NVS or
// the running application.
const PARTITION_TABLE_OFFSET = '0x8000';
const APP_OFFSET = '0x10000';
const PROVISION_PARTITION_NAME = 'provision';
const PROVISION_FORMAT_VERSION = 1;

/** Read the version the firmware will actually report. */
export async function readFirmwareVersion(sketchDir) {
  const configPath = join(sketchDir, 'config.h');
  const text = await readFile(configPath, 'utf8');
  const match = text.match(/FIRMWARE_VERSION\s*=\s*"([^"]+)"/);
  if (!match) {
    throw new Error(`could not find FIRMWARE_VERSION in ${configPath}`);
  }
  return match[1];
}

function parsePartitionNumber(value, field) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) throw new Error(`provisioning partition has no ${field}`);

  let number;
  if (/^0x[0-9a-f]+$/i.test(trimmed)) number = Number.parseInt(trimmed, 16);
  else if (/^\d+[kKmM]$/.test(trimmed)) {
    const unit = trimmed.slice(-1).toLowerCase();
    const scale = unit === 'k' ? 1024 : 1024 * 1024;
    number = Number.parseInt(trimmed.slice(0, -1), 10) * scale;
  } else if (/^\d+$/.test(trimmed)) number = Number.parseInt(trimmed, 10);
  else throw new Error(`invalid provisioning partition ${field}: ${trimmed}`);

  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`invalid provisioning partition ${field}: ${trimmed}`);
  }
  return number;
}

/**
 * Read the address the firmware itself knows as the `provision` partition.
 * The browser writes secrets only to this explicitly reserved sector; it must
 * never guess an unused-looking address.
 */
export async function readProvisioningPartition(sketchDir) {
  const path = join(sketchDir, 'partitions.csv');
  const text = await readFile(path, 'utf8');
  const rows = text
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*/, '').trim())
    .filter(Boolean)
    .map((line) => line.split(',').map((value) => value.trim()));

  const row = rows.find((fields) => fields[0] === PROVISION_PARTITION_NAME);
  if (!row) throw new Error(`could not find ${PROVISION_PARTITION_NAME} partition in ${path}`);
  if (row[1] !== 'data') throw new Error(`${PROVISION_PARTITION_NAME} partition must be a data partition`);

  const offset = parsePartitionNumber(row[3], 'offset');
  const size = parsePartitionNumber(row[4], 'size');
  if (offset % 0x1000 !== 0 || size % 0x1000 !== 0) {
    throw new Error('provisioning partition offset and size must be 4 KiB aligned');
  }
  if (size < 0x1000) throw new Error('provisioning partition must be at least one 4 KiB sector');

  return { offset, size, format: PROVISION_FORMAT_VERSION };
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

  // A routine update must not write through NVS or the one-time provisioning
  // sector. These three binaries cover only bootloader, partition table and
  // application regions, so stored Wi-Fi/server settings remain untouched.
  const updateParts = [
    { path: find('.bootloader.bin'), offset: bootloaderAddr },
    { path: find('.partitions.bin'), offset: PARTITION_TABLE_OFFSET },
    { path: find('.ino.bin'), offset: APP_OFFSET },
  ];

  for (const part of updateParts) {
    if (!part.path) {
      throw new Error(`missing a required binary for safe update in ${dist}: ${JSON.stringify(updateParts)}`);
    }
  }

  // Fresh installs and factory recovery prefer arduino-cli's complete merged
  // image. New-board setup overlays the one-time provisioning record after
  // this image, before the ESP32 is allowed to boot.
  const merged = find('.merged.bin');
  const parts = merged
    ? [{ path: merged, offset: '0x0' }]
    : updateParts;

  // An empty binary is worse than a missing one. esptool-js silently skips
  // zero-length images, leaving a flash that appears successful but cannot boot.
  const pathsToValidate = [...new Set([...parts, ...updateParts].map((part) => part.path))];
  for (const path of pathsToValidate) {
    const { size } = await stat(join(dist, path));
    if (size === 0) {
      throw new Error(
        `${path} is empty (0 bytes). A flash would silently skip it and produce an unbootable board.`,
      );
    }
  }

  const provisioning = await readProvisioningPartition(sketchDir);
  const normalise = (list) => list.map((p) => ({ path: p.path, offset: Number(p.offset) }));
  const manifest = {
    version,
    builtAt: new Date().toISOString(),
    parts: normalise(parts),
    updateParts: normalise(updateParts),
    provisioning,
  };

  await writeFile(join(dist, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

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
