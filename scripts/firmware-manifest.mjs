#!/usr/bin/env node
/**
 * Turn arduino-cli's build report into the manifest the web flasher reads.
 *
 * Offsets are taken from the build's own properties. Hardcoding them is the
 * failure mode this exists to prevent: an offset that disagrees with the
 * partition table produces a board that fails to boot in a way that looks
 * like a hardware fault.
 *
 * Usage: node scripts/firmware-manifest.mjs <distDir> <version>
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const [dist, version] = process.argv.slice(2);
if (!dist || !version) {
  console.error('usage: firmware-manifest.mjs <distDir> <version>');
  process.exit(1);
}

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

// The three images a full flash writes. Offsets come from build properties
// where arduino-cli publishes them, with the ESP32-S3 core's documented
// defaults as a fallback for older arduino-cli versions that omit them.
const parts = [
  { path: find('.bootloader.bin'), offset: props['build.bootloader_addr'] ?? '0x0' },
  { path: find('.partitions.bin'), offset: '0x8000' },
  { path: find('.ino.bin'), offset: '0x10000' },
];

for (const part of parts) {
  if (!part.path) throw new Error(`missing a required binary in ${dist}: ${JSON.stringify(parts)}`);
}

await writeFile(
  join(dist, 'manifest.json'),
  `${JSON.stringify(
    {
      version,
      builtAt: new Date().toISOString(),
      parts: parts.map((p) => ({ path: p.path, offset: Number(p.offset) })),
    },
    null,
    2,
  )}\n`,
  'utf8',
);
