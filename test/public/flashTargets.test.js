import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFlashParts, fetchBinary, readyPanel } from '../../public/flash.js';

const fullManifest = {
  available: true,
  target: 'full',
  version: '0.1.4',
  builtAt: '2026-08-17T12:00:00.000Z',
  serverUrl: 'http://inkpanel.local:8080',
  parts: [{ path: 'full.bin', offset: 0 }],
  updateParts: [{ path: 'full-app.bin', offset: 65536 }],
  provisioning: { offset: 0xfff000, size: 4096, format: 1 },
};

const miniManifest = {
  available: true,
  target: 'mini',
  version: '0.2.0-mini.1',
  builtAt: '2026-08-17T12:01:00.000Z',
  serverUrl: 'http://inkpanel.local:8080',
  parts: [{ path: 'mini.bin', offset: 0 }],
  updateParts: [{ path: 'mini-app.bin', offset: 65536 }],
  provisioning: { offset: 0x7ff000, size: 4096, format: 1 },
};

const catalog = {
  defaultTarget: 'full',
  targets: [
    { id: 'full', label: 'InkPanel 7.5-inch', hardware: 'XIAO ESP32-S3 Plus + EE04', manifest: fullManifest },
    { id: 'mini', label: 'InkPanel Mini 1.54-inch', hardware: 'XIAO ESP32-S3 + ePaper Driver Board + SSD1681', manifest: miniManifest },
  ],
};

test('ready panel shows explicit full-size and Mini hardware choices', () => {
  const html = readyPanel(fullManifest, catalog);
  assert.match(html, /name="hardware-target" value="full" checked/);
  assert.match(html, /name="hardware-target" value="mini"/);
  assert.match(html, /InkPanel Mini 1\.54-inch/);
  assert.match(html, /ePaper Driver Board \+ SSD1681/);
  assert.match(html, /0\.2\.0-mini\.1/);
});

test('legacy one-target ready panel does not add a redundant hardware chooser', () => {
  const html = readyPanel(fullManifest);
  assert.doesNotMatch(html, /hardware-target/);
  assert.match(html, /Firmware 0\.1\.4/);
});

test('Mini binary fetch uses only the target-specific endpoint', async () => {
  const previousFetch = globalThis.fetch;
  let requested = '';
  globalThis.fetch = async (url) => {
    requested = String(url);
    return new Response(Uint8Array.from([0xe9, 1, 2, 3]), { status: 200 });
  };
  try {
    const data = await fetchBinary('inkpanel.ino.merged.bin', 'mini');
    assert.equal(requested, '/api/firmware/targets/mini/bin/inkpanel.ino.merged.bin');
    assert.equal(data.charCodeAt(0), 0xe9);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('full-size binary fetch keeps the historical endpoint', async () => {
  const previousFetch = globalThis.fetch;
  let requested = '';
  globalThis.fetch = async (url) => {
    requested = String(url);
    return new Response(Uint8Array.from([0xe9]), { status: 200 });
  };
  try {
    await fetchBinary('inkpanel.ino.merged.bin');
    assert.equal(requested, '/api/firmware/bin/inkpanel.ino.merged.bin');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('buildFlashParts forwards the selected hardware target to binary loading', async () => {
  const seen = [];
  const parts = await buildFlashParts(
    [{ path: 'mini-app.bin', offset: 65536 }],
    async (path, target) => {
      seen.push([path, target]);
      return '\u00e9';
    },
    'mini',
  );
  assert.deepEqual(seen, [['mini-app.bin', 'mini']]);
  assert.equal(parts[0].address, 65536);
});
