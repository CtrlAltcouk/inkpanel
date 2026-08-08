import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildManifest,
  readProvisioningPartition,
} from '../../scripts/firmware-manifest.mjs';

const realSketch = join(process.cwd(), 'firmware', 'inkpanel');

test('manifest tooling derives the one-time provisioning sector from partitions.csv', async () => {
  assert.deepEqual(await readProvisioningPartition(realSketch), {
    offset: 0xFFF000,
    size: 0x1000,
    format: 1,
  });
});

test('generated firmware manifest publishes the exact provisioning address used by the sketch', async () => {
  const dist = await mkdtemp(join(tmpdir(), 'inkpanel-provision-manifest-'));
  try {
    await writeFile(
      join(dist, 'build-report.json'),
      JSON.stringify({ builder_result: { build_properties: ['build.bootloader_addr=0x0'] } }),
    );
    await writeFile(join(dist, 'inkpanel.ino.bootloader.bin'), 'bootloader');
    await writeFile(join(dist, 'inkpanel.ino.partitions.bin'), 'partitions');
    await writeFile(join(dist, 'inkpanel.ino.bin'), 'application');
    await writeFile(join(dist, 'inkpanel.ino.merged.bin'), 'merged');

    const manifest = await buildManifest(dist, realSketch);
    assert.deepEqual(manifest.provisioning, {
      offset: 0xFFF000,
      size: 0x1000,
      format: 1,
    });

    const onDisk = JSON.parse(await readFile(join(dist, 'manifest.json'), 'utf8'));
    assert.deepEqual(onDisk.provisioning, manifest.provisioning);
  } finally {
    await rm(dist, { recursive: true, force: true });
  }
});

test('manifest tooling refuses an unaligned provisioning address instead of teaching the browser a dangerous offset', async () => {
  const sketch = await mkdtemp(join(tmpdir(), 'inkpanel-bad-partitions-'));
  try {
    await writeFile(join(sketch, 'partitions.csv'), 'provision,data,0x40,0xFFF001,0x1000,\n');
    await assert.rejects(
      readProvisioningPartition(sketch),
      /4 KiB aligned/,
    );
  } finally {
    await rm(sketch, { recursive: true, force: true });
  }
});
