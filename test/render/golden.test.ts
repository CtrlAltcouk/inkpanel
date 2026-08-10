import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Renderer } from '../../src/render/browser.ts';
import { renderHtml } from '../../src/render/template.ts';
import { loadFontCss } from '../../src/render/fonts.ts';
import { quantisePng, bufferToPng } from '../../src/panel/quantise.ts';
import { WFT0583 } from '../../src/panel/profile.ts';
import { dashboardData } from '../fixtures/dashboard.ts';

const goldenDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'golden');
const renderer = new Renderer();
after(() => renderer.close());

test('dashboard layout matches the golden buffer', async (t) => {
  const actual = await quantisePng(
    await renderer.screenshot(renderHtml(dashboardData(), WFT0583, await loadFontCss()), WFT0583),
    WFT0583,
  );
  const goldenPath = join(goldenDir, 'dashboard.bin');
  if (process.env.UPDATE_GOLDENS === '1') {
    await mkdir(goldenDir, { recursive: true });
    await writeFile(goldenPath, actual);
    await writeFile(join(goldenDir, 'dashboard.png'), await bufferToPng(actual, WFT0583));
    return;
  }
  let expected: Buffer;
  try { expected = await readFile(goldenPath); }
  catch { t.skip('no golden committed for this rendering environment'); return; }
  if (!actual.equals(expected)) {
    await writeFile(join(goldenDir, 'actual.png'), await bufferToPng(actual, WFT0583));
    const differing = actual.reduce((count, byte, index) => byte === expected[index] ? count : count + 1, 0);
    assert.fail(`${differing} of ${actual.length} bytes differ; inspect fixtures/golden/actual.png`);
  }
});
