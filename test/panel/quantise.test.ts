import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packGrayscale } from '../../src/panel/quantise.ts';
import type { PanelProfile } from '../../src/panel/profile.ts';
import { SSD1681_200X200, WFT0583 } from '../../src/panel/profile.ts';

// A tiny 8x1 profile so the expected byte can be worked out by hand.
const TINY: PanelProfile = {
  id: 'tiny-8x1', width: 8, height: 1,
  bitDepth: 1, bitOrder: 'msb-first', inkBit: 1,
  stride: 1, bytes: 1, dashboardSlots: 1,
};

test('packs MSB-first with 1 = black', () => {
  // Luminance 0 is black, 255 is white.
  // Pixels:      B    W    W    W    B    B    W    B
  const gray = Uint8Array.from([0, 255, 255, 255, 0, 0, 255, 0]);
  // Expected bits: 1 0 0 0 1 1 0 1  = 0x8D
  const packed = packGrayscale(gray, TINY);
  assert.equal(packed.length, 1);
  assert.equal(packed[0], 0x8d);
});

test('thresholds at the midpoint', () => {
  const gray = Uint8Array.from([127, 128, 0, 0, 0, 0, 0, 0]);
  // 127 < 128 → black (1); 128 is not < 128 → white (0)
  // bits: 1 0 1 1 1 1 1 1 = 0xBF
  assert.equal(packGrayscale(gray, TINY)[0], 0xbf);
});

test('WFT0583 profile matches the wire format the firmware expects', () => {
  assert.equal(WFT0583.width, 800);
  assert.equal(WFT0583.height, 480);
  assert.equal(WFT0583.stride, 100);
  assert.equal(WFT0583.bytes, 48000);
  assert.equal(WFT0583.dashboardSlots, 4);
  assert.equal(WFT0583.inkBit, 1);
  assert.equal(WFT0583.bitOrder, 'msb-first');
});

test('SSD1681 Mini profile is one 200x200 packed framebuffer', () => {
  assert.equal(SSD1681_200X200.width, 200);
  assert.equal(SSD1681_200X200.height, 200);
  assert.equal(SSD1681_200X200.stride, 25);
  assert.equal(SSD1681_200X200.bytes, 5000);
  assert.equal(SSD1681_200X200.dashboardSlots, 1);
  const gray = new Uint8Array(200 * 200).fill(255);
  assert.equal(packGrayscale(gray, SSD1681_200X200).length, 5000);
});

test('produces exactly one full buffer for the real panel', () => {
  const gray = new Uint8Array(800 * 480).fill(255);
  const packed = packGrayscale(gray, WFT0583);
  assert.equal(packed.length, 48000);
  assert.ok(packed.every((b) => b === 0x00), 'an all-white page must pack to all zero bits');
});

test('rejects a greyscale buffer of the wrong length', () => {
  assert.throws(() => packGrayscale(new Uint8Array(7), TINY), /expected 8 greyscale pixels/);
});

test('places rows at the correct stride offset', () => {
  // 8x2: row 0 all black, row 1 all white.
  const profile: PanelProfile = { ...TINY, id: 'tiny-8x2', height: 2, bytes: 2 };
  const gray = Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255]);
  const packed = packGrayscale(gray, profile);
  assert.equal(packed[0], 0xff, 'row 0 is ink');
  assert.equal(packed[1], 0x00, 'row 1 is paper');
});
