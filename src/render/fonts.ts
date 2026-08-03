import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

/**
 * Find a woff2 in a @fontsource package by exact filename suffix.
 *
 * Suffix rather than fragment matching: `dela-gothic-one-latin-ext-400-normal`
 * also contains "latin" and "400", so a fragment match could silently pick the
 * extended subset depending on readdir order.
 */
async function findFont(pkg: string, subset: string, weight: number): Promise<Buffer> {
  const filesDir = join(dirname(require.resolve(`${pkg}/package.json`)), 'files');
  const entries = await readdir(filesDir);
  const suffix = `-${subset}-${weight}-normal.woff2`;
  const match = entries.find((f) => f.endsWith(suffix));
  if (!match) {
    throw new Error(`no ${suffix} in ${pkg}; found: ${entries.slice(0, 12).join(', ')}`);
  }
  return readFile(join(filesDir, match));
}

function face(family: string, weight: number, data: Buffer): string {
  return `@font-face{font-family:"${family}";font-style:normal;font-weight:${weight};` +
    `src:url(data:font/woff2;base64,${data.toString('base64')}) format("woff2");}`;
}

/**
 * Fonts are embedded as data URIs because the container has no system fonts.
 * Omit this and the preview looks perfect while the panel renders in a
 * fallback face.
 */
export async function loadFontCss(): Promise<string> {
  const [display, regular, semibold, bold] = await Promise.all([
    findFont('@fontsource/dela-gothic-one', 'latin', 400),
    findFont('@fontsource/inter', 'latin', 400),
    findFont('@fontsource/inter', 'latin', 600),
    findFont('@fontsource/inter', 'latin', 700),
  ]);
  return [
    face('Dela Gothic One', 400, display),
    face('Inter', 400, regular),
    face('Inter', 600, semibold),
    face('Inter', 700, bold),
  ].join('');
}
