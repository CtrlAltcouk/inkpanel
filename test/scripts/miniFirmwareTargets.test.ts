import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const MANIFEST_SCRIPT = join(ROOT, 'scripts', 'firmware-manifest.mjs');
const BUILD_SCRIPT = join(ROOT, 'scripts', 'build-firmware.sh');
const HASH_SCRIPT = join(ROOT, 'scripts', 'firmware-input-hash.sh');
const SKETCH = join(ROOT, 'firmware', 'inkpanel');

async function fakeDist(dir: string) {
  await writeFile(
    join(dir, 'build-report.json'),
    JSON.stringify({ builder_result: { build_properties: ['build.bootloader_addr=0x0'] } }),
  );
  await writeFile(join(dir, 'inkpanel.ino.bootloader.bin'), 'boot');
  await writeFile(join(dir, 'inkpanel.ino.partitions.bin'), 'parts');
  await writeFile(join(dir, 'inkpanel.ino.bin'), 'app');
  await writeFile(join(dir, 'inkpanel.ino.merged.bin'), 'merged');
}

test('Mini manifest uses the Mini firmware version and 8 MB provisioning sector', async () => {
  const dist = await mkdtemp(join(tmpdir(), 'inkpanel-mini-manifest-'));
  const stagedSketch = await mkdtemp(join(tmpdir(), 'inkpanel-mini-sketch-'));
  try {
    await fakeDist(dist);
    await writeFile(join(stagedSketch, 'config.h'), await readFile(join(SKETCH, 'config.h'), 'utf8'));
    await writeFile(join(stagedSketch, 'partitions.csv'), await readFile(join(SKETCH, 'partitions-mini.csv'), 'utf8'));

    const result = spawnSync(process.execPath, [MANIFEST_SCRIPT, dist, stagedSketch, 'mini'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);

    const manifest = JSON.parse(await readFile(join(dist, 'manifest.json'), 'utf8'));
    assert.equal(manifest.target, 'mini');
    assert.equal(manifest.version, '0.2.0-mini.1');
    assert.equal(manifest.provisioning.offset, 0x7ff000);
    assert.equal(manifest.provisioning.size, 0x1000);
  } finally {
    await rm(dist, { recursive: true, force: true });
    await rm(stagedSketch, { recursive: true, force: true });
  }
});

test('production build keeps full-size at dist root and publishes Mini beneath dist/mini', async () => {
  const source = await readFile(BUILD_SCRIPT, 'utf8');
  assert.match(source, /^FQBN=.*XIAO_ESP32S3_Plus/m);
  assert.match(source, /^MINI_FQBN=.*XIAO_ESP32S3\}/m);
  assert.match(source, /MINI_DIST="\$STAGE\/mini"/);
  assert.match(source, /firmware-manifest\.mjs" "\$MINI_DIST" "\$MINI_SKETCH" mini/);
  assert.match(source, /compiler\.cpp\.extra_flags=-DINKPANEL_MINI=1/);
});

test('firmware freshness includes the Mini board target', async () => {
  const source = await readFile(HASH_SCRIPT, 'utf8');
  assert.match(source, /MINI_FQBN_VALUE=.*XIAO_ESP32S3/);
  assert.match(source, /mini_fqbn=%s/);
});
