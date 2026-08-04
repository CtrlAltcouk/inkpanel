import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A Dockerfile pinned to a different Playwright version than package.json
 * fails at runtime with an unhelpful "browser not found", long after the build
 * succeeded. Cheaper to catch here.
 */
test('the Playwright base image matches the installed package version', async () => {
  const dockerfile = await readFile(join(root, 'Dockerfile'), 'utf8');
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  };

  const imageMatch = dockerfile.match(/mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)/);
  assert.ok(imageMatch, 'Dockerfile must pin a versioned Playwright image');

  const declared = pkg.dependencies.playwright?.replace(/^[\^~]/, '');
  assert.equal(
    imageMatch[1],
    declared,
    `Dockerfile pins v${imageMatch[1]} but package.json declares ${declared}`,
  );
});

test('tsx is a runtime dependency, since the container runs it', async () => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  const dockerfile = await readFile(join(root, 'Dockerfile'), 'utf8');

  if (dockerfile.includes('--omit=dev')) {
    assert.ok(
      pkg.dependencies.tsx,
      'the image installs production deps only, so tsx cannot live in devDependencies',
    );
    assert.ok(!pkg.devDependencies.tsx, 'tsx must not be in both');
  }
});

test('the installer ships the update units and the password variable', async () => {
  const installer = await readFile(join(root, 'scripts/proxmox/inkpanel-lxc.sh'), 'utf8');

  assert.match(installer, /inkpanel-update\.path/, 'path unit must be installed');
  assert.match(installer, /inkpanel-update\.service/, 'service unit must be installed');
  assert.match(installer, /systemctl enable --now inkpanel-update\.path/, 'path unit must be enabled');
  assert.match(installer, /INKPANEL_PASSWORD/, 'env file must mention the password');

  // The updater resolves write-status.mjs relative to its own path, so a
  // missing copy breaks every update with only an ENOENT in the journal.
  assert.match(installer, /write-status\.mjs/, 'the status writer must be installed too');

  // The containment argument depends on this: the app must not be able to
  // rewrite the script that runs as root.
  assert.match(installer, /chown root:root [^\n]*\/usr\/local\/bin\/inkpanel-update/);
  assert.match(installer, /chmod 755 [^\n]*\/usr\/local\/bin\/inkpanel-update/);

  // The old inline heredoc updater does not clear the flag file. Leaving it in
  // place while the path unit is enabled means every update retriggers itself
  // and restarts the service in a loop.
  assert.doesNotMatch(installer, /cat > \/usr\/local\/bin\/(?:\$\{APP\}|inkpanel)-update <</,
    'the inline heredoc updater must be gone, replaced by the repo copy');
});
