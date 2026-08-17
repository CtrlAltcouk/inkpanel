import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const APP_JS = fileURLToPath(new URL('../../public/app.js', import.meta.url));

test('sidebar discovers panels that enrol after the browser is already open', async () => {
  const source = await readFile(APP_JS, 'utf8');

  assert.match(source, /SIDEBAR_REFRESH_INTERVAL_MS\s*=\s*5000/);
  assert.match(source, /document\.visibilityState\s*!==\s*['"]visible['"]/);
  assert.match(
    source,
    /setInterval\([\s\S]*refreshSidebarPanels\(\)[\s\S]*SIDEBAR_REFRESH_INTERVAL_MS/,
    'the visible browser should periodically re-read the lightweight device list',
  );
});

test('explicit device-change events still refresh the sidebar immediately', async () => {
  const source = await readFile(APP_JS, 'utf8');
  assert.match(
    source,
    /addEventListener\(['"]inkpanel:devices-changed['"][\s\S]*refreshSidebarPanels\(\)/,
    'save/configuration changes should not wait for the polling interval',
  );
});
