import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packGrayscale, unpackToGrayscale, bufferToPng } from '../../src/panel/quantise.ts';
import { WFT0583 } from '../../src/panel/profile.ts';

test('unpack is the inverse of pack', () => {
  const gray = new Uint8Array(800 * 480);
  for (let i = 0; i < gray.length; i++) gray[i] = i % 3 === 0 ? 0 : 255;

  const roundTripped = unpackToGrayscale(packGrayscale(gray, WFT0583), WFT0583);
  assert.equal(roundTripped.length, gray.length);
  for (let i = 0; i < gray.length; i++) {
    assert.equal(roundTripped[i], gray[i], `pixel ${i} changed`);
  }
});

test('rejects a buffer of the wrong size', () => {
  assert.throws(() => unpackToGrayscale(Buffer.alloc(10), WFT0583), /expected 48000/);
});

test('bufferToPng produces a real PNG at panel size', async () => {
  const png = await bufferToPng(Buffer.alloc(WFT0583.bytes, 0), WFT0583);
  assert.deepEqual(png.subarray(0, 4), Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'PNG magic');
});
