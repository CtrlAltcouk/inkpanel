import sharp from 'sharp';
import type { PanelProfile } from './profile.ts';

/** Luminance below this is ink. */
export const DEFAULT_THRESHOLD = 128;

/**
 * Pack 8-bit greyscale into the panel's 1-bit format.
 * MSB of each byte is the leftmost pixel; a set bit means black.
 */
export function packGrayscale(
  gray: Uint8Array,
  profile: PanelProfile,
  threshold: number = DEFAULT_THRESHOLD,
): Buffer {
  const expected = profile.width * profile.height;
  if (gray.length !== expected) {
    throw new Error(`expected ${expected} greyscale pixels, received ${gray.length}`);
  }

  const out = Buffer.alloc(profile.bytes, 0);
  for (let y = 0; y < profile.height; y++) {
    const rowStart = y * profile.width;
    const byteRow = y * profile.stride;
    for (let x = 0; x < profile.width; x++) {
      if (gray[rowStart + x]! < threshold) {
        out[byteRow + (x >> 3)]! |= 0x80 >> (x & 7);
      }
    }
  }
  return out;
}

/** Decode a PNG, flatten onto white, reduce to greyscale, then pack. */
export async function quantisePng(png: Buffer, profile: PanelProfile): Promise<Buffer> {
  const { data, info } = await sharp(png)
    .flatten({ background: '#ffffff' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (info.width !== profile.width || info.height !== profile.height) {
    throw new Error(
      `image is ${info.width}x${info.height}, profile expects ${profile.width}x${profile.height}`,
    );
  }
  if (info.channels !== 1) {
    throw new Error(`expected 1 channel after greyscale, got ${info.channels}`);
  }

  return packGrayscale(new Uint8Array(data), profile);
}

/** Inverse of packGrayscale. Used by tooling to view what the panel will show. */
export function unpackToGrayscale(packed: Buffer, profile: PanelProfile): Uint8Array {
  if (packed.length !== profile.bytes) {
    throw new Error(`expected ${profile.bytes} bytes, received ${packed.length}`);
  }
  const gray = new Uint8Array(profile.width * profile.height);
  for (let y = 0; y < profile.height; y++) {
    const byteRow = y * profile.stride;
    const pixelRow = y * profile.width;
    for (let x = 0; x < profile.width; x++) {
      const bit = packed[byteRow + (x >> 3)]! & (0x80 >> (x & 7));
      gray[pixelRow + x] = bit ? 0 : 255;
    }
  }
  return gray;
}

/** Render a packed buffer back to a viewable PNG. */
export async function bufferToPng(packed: Buffer, profile: PanelProfile): Promise<Buffer> {
  return sharp(Buffer.from(unpackToGrayscale(packed, profile)), {
    raw: { width: profile.width, height: profile.height, channels: 1 },
  }).png().toBuffer();
}
