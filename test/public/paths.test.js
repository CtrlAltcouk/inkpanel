import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { appPath, browserBasePath } from '../../public/paths.js';
import { parse } from 'yaml';

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

test('release-specific Ingress query preserves every Studio API and module base path', async () => {
  const config = parse(await readFile(new URL('../../home-assistant/config.yaml', import.meta.url), 'utf8'));
  const prefix = 'https://ha.example/api/hassio_ingress/session-token/';
  const entry = new URL(prefix + config.ingress_entry);
  assert.equal(browserBasePath(entry.pathname), '/api/hassio_ingress/session-token/');
  for (const path of [
    '/api/devices', '/api/runtime-config', '/api/home-assistant/calendars', '/api/home-assistant/todo-lists',
    '/api/devices/panel/render.png?t=123-1', '/api/devices/panel/push', '/api/geocode?q=York',
    '/api/stations?q=London', '/api/printers', '/api/todo-lists', '/api/dashboard-editor/panel',
    '/api/firmware/manifest', '/api/firmware/mini/manifest',
  ]) assert.equal(appPath(path, entry.pathname), `${new URL(prefix).pathname}${path.slice(1)}`, path);
  for (const module of ['app.js', 'cityPicker.js', 'stationPicker.js', 'dashboardEditor.js', 'flash.js', 'vendor/esptool-js.js', 'styles.css', 'studio.css']) {
    assert.equal(new URL(`./${module}`, entry).href, `${prefix}${module}`);
  }
});

test('API, preview, and login navigation all use the central path helper', async () => {
  const root = fileURLToPath(new URL('../../public/', import.meta.url));
  const api = await readFile(`${root}api.js`, 'utf8');
  const panels = await readFile(`${root}panels.js`, 'utf8');
  const login = await readFile(`${root}login.html`, 'utf8');
  assert.match(api, /fetch\(appPath\(path\)/);
  assert.match(api, /location\.href = appPath\('\/login\.html'\)/);
  assert.match(panels, /src="\$\{panelPreviewUrl\(device\.id\)\}"/);
  assert.match(panels, /img\.src = panelPreviewUrl\(deviceId\)/);
  assert.match(panels, /appPath\(`\/api\/devices\/\$\{encodeURIComponent\(deviceId\)\}\/render\.png\?t=/);
  assert.match(login, /fetch\(appPath\('\/api\/auth\/login'\)/);
  assert.match(login, /location\.href = appPath\('\/'\)/);
});
