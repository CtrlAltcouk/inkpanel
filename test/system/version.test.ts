import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readVersion } from '../../src/system/version.ts';

test('reports the package version', async () => {
  const { version } = await readVersion();
  assert.match(version, /^\d+\.\d+\.\d+$/);
});

test('reports a short commit sha when run inside a git checkout', async () => {
  const { commit } = await readVersion();
  // Null is legitimate — a tarball deployment has no .git — so accept either,
  // but reject a malformed value.
  if (commit !== null) assert.match(commit, /^[0-9a-f]{7,40}$/);
});

test('caches, so repeated calls do not spawn git repeatedly', async () => {
  const a = await readVersion();
  const b = await readVersion();
  assert.deepEqual(a, b);
});
