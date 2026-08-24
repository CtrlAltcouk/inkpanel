import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePanelBaseUrl, runtimeEnvironment } from '../../scripts/home-assistant-start.mjs';

test('App options become the fixed three-listener runtime environment', () => {
  assert.deepEqual(runtimeEnvironment({
    panel_base_url: ' http://192.168.1.20:8080/ ',
    lan_password: ' correct horse battery staple ',
  }, {}), {
    DATA_DIR: '/data', PORT: '8080', PUBLIC_BASE_URL: 'http://192.168.1.20:8080',
    INKPANEL_PASSWORD: 'correct horse battery staple', HTTPS_PORT: '8443',
    HOME_ASSISTANT_MODE: '1', HOME_ASSISTANT_INGRESS_PORT: '8099',
    HOME_ASSISTANT_BASE_URL: 'http://supervisor/core/api',
  });
});

test('panel base URL must be a clean LAN origin and LAN password is required', () => {
  assert.equal(normalizePanelBaseUrl('https://panel.local:8443/'), 'https://panel.local:8443');
  for (const value of ['ftp://panel.local', 'http://user:pass@panel.local', 'http://panel.local/path', 'not a url']) {
    assert.throws(() => normalizePanelBaseUrl(value));
  }
  assert.throws(() => runtimeEnvironment({ panel_base_url: 'http://panel.local', lan_password: ' ' }), /lan_password/);
});
