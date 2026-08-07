import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, readFile, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const INSTALLER = join(root, 'scripts', 'proxmox', 'inkpanel-lxc.sh');
const PATH_SEP = process.platform === 'win32' ? ';' : ':';

/**
 * Debian's mirror lists both architectures under names that differ only in
 * that suffix. A fresh install on 2026-08-07 downloaded the arm64 build on a
 * real x86_64 Proxmox host: the container created successfully and then
 * failed at `pct start` with no clearer signal than "startup...failed",
 * because `sort -V | tail -1` on the whole filename can put "arm64" after
 * "amd64". This is the real `pveam available --section system` column shape
 * (`awk '{print $2}'` pulls the filename out of column 2) — a stand-in for
 * pveam, not a real Proxmox host, but the exact same pipeline downstream.
 */
const FAKE_PVEAM_OUTPUT = [
  'system\tdebian-12-standard_12.7-1_amd64.tar.zst',
  'system\tdebian-13-standard_13.6-1_amd64.tar.zst',
  'system\tdebian-13-standard_13.6-1_arm64.tar.zst',
].join('\n');

/**
 * Extracts the real TEMPLATE_NAME pipeline out of the shipped script and runs
 * it for real, rather than asserting against a hand-copied re-description of
 * it. If this block is ever edited, the test exercises whatever is actually
 * there — the same reason firmwareRebuild.test.ts extracts its block from
 * the live inkpanel-update rather than a fixture.
 */
function extractTemplatePipeline(script: string): string {
  const start = script.indexOf('TEMPLATE_NAME="$(pveam available');
  const marker = '| sort -V | tail -1)"';
  const end = script.indexOf(marker, start);
  assert.ok(start > -1 && end > start, 'could not locate the TEMPLATE_NAME pipeline in the installer');
  return script.slice(start, end + marker.length);
}

async function withStubPveam(dir: string): Promise<string> {
  const bin = join(dir, 'stubbin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'pveam'), `#!/usr/bin/env bash\ncat <<'EOF'\n${FAKE_PVEAM_OUTPUT}\nEOF\n`);
  await chmod(join(bin, 'pveam'), 0o755);
  return bin;
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-template-arch-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('template selection picks the host architecture, not just the newest version', async () => {
  await withTempDir(async (dir) => {
    const script = await readFile(INSTALLER, 'utf8');
    const pipeline = extractTemplatePipeline(script);
    const stubbin = await withStubPveam(dir);

    const { stdout } = await run('bash', ['-c', `${pipeline}\necho "$TEMPLATE_NAME"`], {
      env: { ...process.env, PATH: `${stubbin}${PATH_SEP}${process.env.PATH}`, HOST_ARCH: 'amd64' },
    });

    const picked = stdout.trim();
    assert.equal(picked, 'debian-13-standard_13.6-1_amd64.tar.zst');
    assert.doesNotMatch(picked, /arm64/, 'must never pick an architecture pct create cannot boot on this host');
  });
});

test('a host with no matching-architecture template fails with a clear message, not silently', async () => {
  await withTempDir(async (dir) => {
    const script = await readFile(INSTALLER, 'utf8');
    const pipeline = extractTemplatePipeline(script);
    const stubbin = await withStubPveam(dir);

    // No riscv64 template exists in the fake list at all.
    const { stdout } = await run('bash', ['-c', `${pipeline}\necho "$TEMPLATE_NAME"`], {
      env: { ...process.env, PATH: `${stubbin}${PATH_SEP}${process.env.PATH}`, HOST_ARCH: 'riscv64' },
    });

    assert.equal(stdout.trim(), '', 'an unmatched architecture must yield nothing for the die() check below it to catch');
  });
});

test('the installer detects the architecture instead of assuming amd64', async () => {
  const script = await readFile(INSTALLER, 'utf8');
  assert.match(script, /HOST_ARCH="\$\(dpkg --print-architecture\)"/);
  assert.match(script, /no Debian standard template for \$\{HOST_ARCH\}/);
});
