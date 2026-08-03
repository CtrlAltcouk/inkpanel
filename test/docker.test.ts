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
