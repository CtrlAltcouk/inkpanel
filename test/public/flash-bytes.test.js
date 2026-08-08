import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareFlashParts } from '../../public/flash.js';

test('prepareFlashParts converts binary strings to Uint8Array without UTF-8 expansion', () => {
  // A valid ESP32 image begins with E9. The browser downloader historically
  // represents each byte as one JS character, so 0xE9 is character U+00E9.
  // esptool-js 0.6.x requires Uint8Array; passing that string directly into
  // its compressor UTF-8-encodes U+00E9 as C3 A9 and corrupts the boot image.
  const binary = String.fromCharCode(0xe9, 0x03, 0x02, 0x80, 0xff);

  const [part] = prepareFlashParts([{ address: 0, data: binary }]);

  assert.ok(part.data instanceof Uint8Array);
  assert.deepEqual([...part.data], [0xe9, 0x03, 0x02, 0x80, 0xff]);
});

test('prepareFlashParts rejects the exact UTF-8-expanded header seen on hardware', () => {
  // The reported ROM error was "invalid header: 0x0203a9c3". On little-endian
  // ESP32 that is the byte sequence C3 A9 03 02: UTF-8 encoding of the valid
  // E9 03 02 header. Refuse it before a single flash write is attempted.
  const corrupted = new Uint8Array([0xc3, 0xa9, 0x03, 0x02]);

  assert.throws(
    () => prepareFlashParts([{ address: 0, data: corrupted }]),
    /invalid ESP header C3 A9 03 02; expected E9/i,
  );
});

test('prepareFlashParts leaves an already-correct Uint8Array byte-for-byte intact', () => {
  const bytes = new Uint8Array([0xe9, 0x03, 0x02, 0x01, 0x80, 0xff]);

  const [part] = prepareFlashParts([{ address: 0, data: bytes }]);

  assert.strictEqual(part.data, bytes, 'no copy or text conversion is needed for real byte arrays');
  assert.deepEqual([...part.data], [...bytes]);
});

test('prepareFlashParts checks only the image at address zero for ESP boot magic', () => {
  // Partition/app payloads can begin with arbitrary bytes. The safety check is
  // specifically for the merged image or bootloader that the ROM executes at
  // flash address zero.
  const parts = prepareFlashParts([
    { address: 0, data: String.fromCharCode(0xe9, 0x03, 0x02) },
    { address: 0x8000, data: String.fromCharCode(0xaa, 0xbb, 0xcc) },
  ]);

  assert.deepEqual([...parts[1].data], [0xaa, 0xbb, 0xcc]);
});
