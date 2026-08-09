import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_HTTPS_PORT, resolveHttpsPort,
} from '../src/runtimeConfig.ts';

test('HTTPS port defaults once on the server and accepts an explicit TCP port', () => {
  assert.deepEqual(resolveHttpsPort(undefined), { httpsPort: DEFAULT_HTTPS_PORT, error: null });
  assert.deepEqual(resolveHttpsPort(' 9443 '), { httpsPort: 9443, error: null });
});

test('invalid HTTPS_PORT disables optional HTTPS with a clear error', () => {
  for (const value of ['', '0', '65536', '1.5', '1e3', 'not-a-port']) {
    const resolved = resolveHttpsPort(value);
    assert.equal(resolved.httpsPort, null);
    assert.match(resolved.error ?? '', /integer between 1 and 65535/);
  }
});
