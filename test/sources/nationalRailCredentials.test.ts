import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  NationalRailCredentialStore,
  validateNationalRailApiKey,
} from '../../src/sources/nationalRailCredentials.ts';

const KEY_A = 'A'.repeat(48);
const KEY_B = 'B'.repeat(48);

test('managed National Rail key persists without being exposed by status', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-rail-key-'));
  const path = join(dir, '.national-rail-api-key');
  const store = new NationalRailCredentialStore(path);

  await store.load();
  assert.deepEqual(store.status(), { configured: false, managed: false });
  assert.equal(store.current(), null);

  await store.set(KEY_A);
  assert.deepEqual(store.status(), { configured: true, managed: true });
  assert.equal(store.current(), KEY_A);
  assert.equal((await readFile(path, 'utf8')).trim(), KEY_A);
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);

  const reloaded = new NationalRailCredentialStore(path);
  await reloaded.load();
  assert.equal(reloaded.current(), KEY_A);
  assert.deepEqual(reloaded.status(), { configured: true, managed: true });
});

test('managed key overrides an environment fallback immediately', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-rail-key-'));
  const store = new NationalRailCredentialStore(join(dir, '.national-rail-api-key'), KEY_A);
  await store.load();
  assert.equal(store.current(), KEY_A);
  assert.deepEqual(store.status(), { configured: true, managed: false });

  await store.set(KEY_B);
  assert.equal(store.current(), KEY_B);
  assert.deepEqual(store.status(), { configured: true, managed: true });
});

test('API key validation rejects blanks, whitespace and control characters', () => {
  assert.equal(validateNationalRailApiKey(`  ${KEY_A}  `), KEY_A);
  assert.throws(() => validateNationalRailApiKey(''), /16-256/);
  assert.throws(() => validateNationalRailApiKey('short'), /16-256/);
  assert.throws(() => validateNationalRailApiKey(`123456789012345\n67890`), /16-256/);
});
