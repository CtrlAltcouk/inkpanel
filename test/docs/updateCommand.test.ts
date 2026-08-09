import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * A real user hit this directly: `pct exec <CTID> -- inkpanel-update` failed
 * with "No such file or directory" even though the script was genuinely
 * installed and working. `pct exec` does not carry /usr/local/bin on PATH the
 * way an interactive login shell would — the same root cause the installer's
 * arduino-cli step was fixed for — so the bare command name can never be
 * found by PATH lookup, regardless of whether it exists. The systemd unit
 * that triggers updates automatically is unaffected, because it already
 * invokes the script by full path; only the documented manual command was
 * wrong. This pins the fix in the docs so it can't quietly regress.
 */
const BARE_FORM = /pct exec\s+\S+\s+--\s+inkpanel-update\b/;
const FULL_PATH_FORM = /pct exec\s+\S+\s+--\s+\/usr\/local\/bin\/inkpanel-update\b/;

/** Only fenced ```bash blocks are what a reader actually copy-pastes. */
function bashBlocks(text: string): string[] {
  return [...text.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]!);
}

test('deployment.md hands the reader the full-path update command in a runnable block, never the bare form', async () => {
  const text = await readFile(join(root, 'docs/deployment.md'), 'utf8');
  const blocks = bashBlocks(text);
  assert.ok(blocks.length > 0, 'found no ```bash blocks to check');

  for (const block of blocks) {
    assert.doesNotMatch(
      block,
      BARE_FORM,
      `a runnable block hands the reader the bare "inkpanel-update" command, which pct exec cannot resolve via PATH:\n${block}`,
    );
  }
  assert.ok(
    blocks.some((b) => FULL_PATH_FORM.test(b)),
    'expected a runnable block with the full path, /usr/local/bin/inkpanel-update',
  );
});

test('deployment.md explains why the full path matters, so the fix is not just a silent substitution', async () => {
  const text = await readFile(join(root, 'docs/deployment.md'), 'utf8');
  assert.match(text, /does not carry.*PATH|PATH.*does not carry/i);
});

test('existing-LXC helper refresh leaves the live checkout untouched until the updater runs', async () => {
  const text = await readFile(join(root, 'docs/deployment.md'), 'utf8');
  const block = bashBlocks(text).find((candidate) => candidate.includes('HELPER_REF='));
  assert.ok(block, 'expected a pinned, root-owned helper refresh block');
  assert.doesNotMatch(block, /git\s+(?:-C\s+\S+\s+)?(?:pull|reset)\b/);
  assert.doesNotMatch(block, /\/opt\/inkpanel\/app\/scripts\/proxmox\/files/);
  assert.match(block, /chown root:root \/opt\/inkpanel/);
  assert.match(block, /chmod 755 \/opt\/inkpanel/);
  assert.doesNotMatch(block, /chown\s+-R[^\n]*\/opt\/inkpanel/);
  assert.match(block, /raw\.githubusercontent\.com\/CtrlAltcouk\/inkpanel\/\$HELPER_REF/);
  assert.match(block, /\/usr\/local\/bin\/inkpanel-update/);
});

// flashing.md never hands out its own copy of this command — it defers to
// deployment.md — so it has no ```bash block for this at all. It only needs
// to never show the broken bare form anywhere, prose included.
test('flashing.md never shows the bare, unresolvable form of the update command', async () => {
  const text = await readFile(join(root, 'docs/flashing.md'), 'utf8');
  assert.doesNotMatch(text, BARE_FORM);
});
