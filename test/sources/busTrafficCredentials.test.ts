import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TransportApiCredentialStore } from '../../src/sources/transportApiCredentials.ts';
import { GoogleMapsCredentialStore } from '../../src/sources/googleMapsCredentials.ts';

const BUS_A = { appId: 'app-id-alpha', appKey: 'app-key-alpha-1234567890' };
const BUS_B = { appId: 'app-id-beta', appKey: 'app-key-beta-1234567890' };
const GOOGLE_A = 'AIza' + 'a'.repeat(35);
const GOOGLE_B = 'AIza' + 'b'.repeat(35);

test('TransportAPI credentials persist privately and status exposes no values', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-bus-creds-'));
  const path = join(dir, '.transportapi-credentials.json');
  const store = new TransportApiCredentialStore(path);
  await store.load();
  assert.deepEqual(store.status(), { configured: false, managed: false });

  await store.set(BUS_A);
  assert.deepEqual(store.status(), { configured: true, managed: true });
  assert.deepEqual(store.current(), BUS_A);
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);

  const raw = await readFile(path, 'utf8');
  assert.deepEqual(JSON.parse(raw), BUS_A);
  const reloaded = new TransportApiCredentialStore(path, BUS_B.appId, BUS_B.appKey);
  await reloaded.load();
  assert.deepEqual(reloaded.current(), BUS_A);
});

test('TransportAPI environment fallback requires both values', () => {
  assert.throws(() => new TransportApiCredentialStore('/unused', BUS_A.appId, undefined), /requires both/);
  assert.throws(() => new TransportApiCredentialStore('/unused', undefined, BUS_A.appKey), /requires both/);
});

test('Google Maps key persists privately and managed value overrides environment fallback', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-google-creds-'));
  const path = join(dir, '.google-maps-api-key');
  const store = new GoogleMapsCredentialStore(path, GOOGLE_A);
  await store.load();
  assert.deepEqual(store.status(), { configured: true, managed: false });
  assert.equal(store.current(), GOOGLE_A);

  await store.set(GOOGLE_B);
  assert.equal(store.current(), GOOGLE_B);
  assert.deepEqual(store.status(), { configured: true, managed: true });
  assert.equal((await readFile(path, 'utf8')).trim(), GOOGLE_B);
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
});
