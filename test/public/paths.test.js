import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { appPath, browserBasePath } from '../../public/paths.js';

test('browser paths remain root-relative in standalone InkPanel', () => {
  assert.equal(browserBasePath('/'), '/');
  assert.equal(browserBasePath('/index.html'), '/');
  assert.equal(appPath('/api/devices', '/'), '/api/devices');
});

test('one helper prefixes APIs, pages and images under arbitrary Ingress paths', () => {
  const ingress = '/api/hassio_ingress/opaque-session-token/';
  assert.equal(browserBasePath(ingress), ingress);
  assert.equal(appPath('/api/devices', ingress), `${ingress}api/devices`);
  assert.equal(appPath('/login.html', `${ingress}index.html`), `${ingress}login.html`);
  assert.equal(appPath('/api/devices/mini/render.png?t=1', ingress), `${ingress}api/devices/mini/render.png?t=1`);
});

test('API, preview, and login navigation all use the central path helper', async () => {
  const root = fileURLToPath(new URL('../../public/', import.meta.url));
  const api = await readFile(`${root}api.js`, 'utf8');
  const panels = await readFile(`${root}panels.js`, 'utf8');
  const login = await readFile(`${root}login.html`, 'utf8');
  assert.match(api, /fetch\(appPath\(path\)/);
  assert.match(api, /location\.href = appPath\('\/login\.html'\)/);
  assert.match(panels, /appPath\(`\/api\/devices\/\$\{encodeURIComponent\(device\.id\)\}\/render\.png`\)/);
  assert.match(panels, /appPath\(`\/api\/devices\/\$\{encodeURIComponent\(deviceId\)\}\/render\.png\?t=/);
  assert.match(login, /fetch\(appPath\('\/api\/auth\/login'\)/);
  assert.match(login, /location\.href = appPath\('\/'\)/);
});
