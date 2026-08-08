import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FLASH_PROVISION_HEADER_SIZE,
  FLASH_PROVISION_MAGIC,
  addFlashProvisioning,
  buildFlashProvisioningImage,
  crc32,
} from '../../public/flashProvisioningImage.js';

const partition = { offset: 0xFF0000, size: 0x1000, format: 1 };

function concat(...parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

test('CRC32 implementation matches the standard reference vector', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
});

test('flash-time provisioning image is byte-exact, CRC-protected and padded with erased bytes', () => {
  const config = {
    ssid: 'Café WiFi',
    password: 'p|ass&word',
    serverUrl: 'http://192.168.1.50:8080',
  };
  const image = buildFlashProvisioningImage(config, partition);
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  const decoder = new TextDecoder();

  assert.equal(image.length, 0x1000);
  assert.equal(decoder.decode(image.subarray(0, 8)), FLASH_PROVISION_MAGIC);
  assert.equal(view.getUint16(8, true), 1);

  const ssidLength = view.getUint16(10, true);
  const passwordLength = view.getUint16(12, true);
  const urlLength = view.getUint16(14, true);
  assert.equal(ssidLength, new TextEncoder().encode(config.ssid).length);
  assert.equal(passwordLength, config.password.length);
  assert.equal(urlLength, config.serverUrl.length);

  let cursor = FLASH_PROVISION_HEADER_SIZE;
  const ssid = image.subarray(cursor, cursor + ssidLength);
  cursor += ssidLength;
  const password = image.subarray(cursor, cursor + passwordLength);
  cursor += passwordLength;
  const serverUrl = image.subarray(cursor, cursor + urlLength);
  cursor += urlLength;

  assert.equal(decoder.decode(ssid), config.ssid);
  assert.equal(decoder.decode(password), config.password);
  assert.equal(decoder.decode(serverUrl), config.serverUrl);

  const expectedCrc = crc32(concat(image.subarray(8, 16), image.subarray(20, cursor)));
  assert.equal(view.getUint32(16, true), expectedCrc);
  assert.ok(image.subarray(cursor).every((value) => value === 0xFF),
    'unused bytes must stay erased so the record is deterministic and compresses well');
});

test('merged full-flash image is patched in-place logically without mutating the downloaded source', () => {
  const source = new Uint8Array(0x1000000);
  source.fill(0xFF);
  source[0] = 0xE9;

  const result = addFlashProvisioning(
    [{ address: 0, data: source }],
    { ssid: 'wifi', password: 'secret', serverUrl: 'http://10.0.0.2:8080' },
    partition,
  );

  assert.equal(result.length, 1, 'a merged image should remain one esptool write');
  assert.notEqual(result[0].data, source, 'do not mutate the cached/downloaded firmware buffer');
  assert.equal(source[partition.offset], 0xFF, 'source merged image must remain untouched');
  assert.equal(
    new TextDecoder().decode(result[0].data.subarray(partition.offset, partition.offset + 8)),
    FLASH_PROVISION_MAGIC,
  );
});

test('separate-image builds append the reserved provisioning sector as an extra write', () => {
  const parts = [
    { address: 0, data: Uint8Array.of(0xE9, 1, 2, 3) },
    { address: 0x8000, data: new Uint8Array(32) },
    { address: 0x10000, data: new Uint8Array(64) },
  ];

  const result = addFlashProvisioning(
    parts,
    { ssid: 'wifi', password: '', serverUrl: 'http://10.0.0.2:8080' },
    partition,
  );

  assert.equal(result.length, 4);
  assert.equal(result[3].address, partition.offset);
  assert.equal(result[3].data.length, partition.size);
  assert.equal(new TextDecoder().decode(result[3].data.subarray(0, 8)), FLASH_PROVISION_MAGIC);
});

test('browser refuses a provisioning address that is not a 4 KiB-aligned manifest partition', () => {
  assert.throws(
    () => buildFlashProvisioningImage(
      { ssid: 'wifi', password: '', serverUrl: 'http://10.0.0.2:8080' },
      { offset: 123, size: 0x1000, format: 1 },
    ),
    /invalid provisioning partition offset/,
  );
});
