import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildProvisionCommand,
  readyPanel,
  selectFlashManifestParts,
  validateNewBoardConfig,
} from '../../public/flash.js';

function decodeBase64Utf8(encoded) {
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

test('new-board settings accept normal Wi-Fi details and the panel-facing HTTP URL', () => {
  assert.deepEqual(
    validateNewBoardConfig({
      ssid: 'CtrlAlt WiFi',
      password: 'correct horse battery staple',
      serverUrl: 'http://192.168.1.50:8080/',
    }),
    {
      ssid: 'CtrlAlt WiFi',
      password: 'correct horse battery staple',
      serverUrl: 'http://192.168.1.50:8080',
    },
  );
});

test('new-board settings reject HTTPS because panels use the plain HTTP listener', () => {
  assert.throws(
    () => validateNewBoardConfig({ ssid: 'wifi', password: '', serverUrl: 'https://192.168.1.50:8443' }),
    /must begin with http:\/\//,
  );
});

test('new-board settings enforce ESP32 byte limits rather than JavaScript character counts', () => {
  // 17 copies of a two-byte UTF-8 character are only 17 JS characters but 34 bytes.
  assert.throws(
    () => validateNewBoardConfig({ ssid: 'é'.repeat(17), password: '', serverUrl: 'http://host:8080' }),
    /32-byte limit/,
  );
});

test('USB provisioning command preserves Unicode and never places raw credentials in delimiters', () => {
  const command = buildProvisionCommand({
    ssid: 'Café WiFi',
    password: 'p|ass&word',
    serverUrl: 'http://192.168.1.50:8080',
  });

  assert.ok(command.startsWith('INKPANEL_PROVISION_V1|'));
  assert.ok(command.endsWith('\n'));
  assert.equal(command.includes('Café WiFi'), false, 'SSID should be encoded on the wire');
  assert.equal(command.includes('p|ass&word'), false, 'password should be encoded on the wire');

  const fields = command.trim().split('|');
  assert.equal(fields.length, 4, 'base64 fields cannot collide with the protocol delimiter');
  assert.equal(decodeBase64Utf8(fields[1]), 'Café WiFi');
  assert.equal(decodeBase64Utf8(fields[2]), 'p|ass&word');
  assert.equal(decodeBase64Utf8(fields[3]), 'http://192.168.1.50:8080');
});

test('routine update uses only the NVS-safe region image set', () => {
  const manifest = {
    parts: [{ path: 'merged.bin', offset: 0 }],
    updateParts: [
      { path: 'bootloader.bin', offset: 0 },
      { path: 'partitions.bin', offset: 32768 },
      { path: 'app.bin', offset: 65536 },
    ],
  };
  assert.equal(selectFlashManifestParts(manifest, 'preserve'), manifest.updateParts);
  assert.equal(selectFlashManifestParts(manifest, 'new'), manifest.parts);
  assert.equal(selectFlashManifestParts(manifest, 'erase'), manifest.parts);
});

test('routine update refuses to fall back to the full image when safe update regions are absent', () => {
  assert.throws(
    () => selectFlashManifestParts({ parts: [{ path: 'merged.bin', offset: 0 }] }, 'preserve'),
    /Refusing to use the full image because it would erase Wi-Fi settings/,
  );
});

test('Flash UI offers new-board and configure-only paths and prefills the brain IPv4', () => {
  const html = readyPanel({
    version: '0.1.0',
    builtAt: '2026-08-08T19:00:00.000Z',
    serverUrl: 'http://192.168.1.50:8080',
  });
  assert.match(html, /Set up a new board/);
  assert.match(html, /value="new"/);
  assert.match(html, /Configure an unconfigured board/);
  assert.match(html, /value="configure"/);
  assert.match(html, /without reflashing/);
  assert.match(html, /data-new-ssid/);
  assert.match(html, /data-new-password/);
  assert.match(html, /InkPanel brain/);
  assert.match(html, /data-new-server value="http:\/\/192\.168\.1\.50:8080"/);
});

test('configure-only mode provisions over USB before esptool is imported', async () => {
  const source = await readFile(join(process.cwd(), 'public', 'flash.js'), 'utf8');
  const configureBranch = source.indexOf("if (mode === 'configure')");
  const esptoolImport = source.indexOf("import('./vendor/esptool-js.js')");
  assert.ok(configureBranch > -1, 'configure-only mode must have its own execution path');
  assert.ok(esptoolImport > configureBranch,
    'configure-only mode must return before loading/flashing with esptool');
  assert.match(source.slice(configureBranch, esptoolImport), /provisionNewBoard\(/);
  assert.match(source.slice(configureBranch, esptoolImport), /no firmware will be written/);
});
