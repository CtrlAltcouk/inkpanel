import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildManifest } from '../../scripts/firmware-manifest.mjs';

async function fixture(withMerged) {
  const dist = await mkdtemp(join(tmpdir(), 'inkpanel-manifest-modes-'));
  const sketch = await mkdtemp(join(tmpdir(), 'inkpanel-manifest-sketch-'));
  await writeFile(
    join(dist, 'build-report.json'),
    JSON.stringify({ builder_result: { build_properties: ['build.bootloader_addr=0x0'] } }),
  );
  await writeFile(join(dist, 'inkpanel.ino.bootloader.bin'), Buffer.from([0xe9, 1, 2, 3]));
  await writeFile(join(dist, 'inkpanel.ino.partitions.bin'), Buffer.from([1, 2, 3, 4]));
  await writeFile(join(dist, 'inkpanel.ino.bin'), Buffer.from([0xe9, 5, 6, 7]));
  if (withMerged) {
    await writeFile(join(dist, 'inkpanel.ino.merged.bin'), Buffer.from([0xe9, 9, 8, 7]));
  }
  await writeFile(join(sketch, 'config.h'), 'constexpr const char* FIRMWARE_VERSION = "test";\n');
  await writeFile(
    join(sketch, 'partitions.csv'),
    'provision,data,0x40,0xFFF000,0x1000,\n',
  );
  return { dist, sketch };
}

async function cleanup(...dirs) {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
}

test('manifest exposes merged image for fresh install and separate regions for safe update', async () => {
  const { dist, sketch } = await fixture(true);
  try {
    const manifest = await buildManifest(dist, sketch);
    assert.deepEqual(manifest.parts, [
      { path: 'inkpanel.ino.merged.bin', offset: 0 },
    ]);
    assert.deepEqual(manifest.updateParts, [
      { path: 'inkpanel.ino.bootloader.bin', offset: 0 },
      { path: 'inkpanel.ino.partitions.bin', offset: 32768 },
      { path: 'inkpanel.ino.bin', offset: 65536 },
    ]);
    assert.deepEqual(manifest.provisioning, { offset: 0xFFF000, size: 0x1000, format: 1 });
  } finally {
    await cleanup(dist, sketch);
  }
});

test('fresh install falls back to the same region images if merged output is unavailable', async () => {
  const { dist, sketch } = await fixture(false);
  try {
    const manifest = await buildManifest(dist, sketch);
    assert.deepEqual(manifest.parts, manifest.updateParts);
    assert.equal(manifest.parts.length, 3);
    assert.deepEqual(manifest.provisioning, { offset: 0xFFF000, size: 0x1000, format: 1 });
  } finally {
    await cleanup(dist, sketch);
  }
});
