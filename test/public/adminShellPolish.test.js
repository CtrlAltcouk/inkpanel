import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const indexUrl = new URL('../../public/index.html', import.meta.url);
const stylesUrl = new URL('../../public/styles.css', import.meta.url);
const faviconUrl = new URL('../../public/favicon.svg', import.meta.url);

test('admin shell declares the InkPanel favicon and theme colour', async () => {
  const html = await readFile(indexUrl, 'utf8');
  assert.ok(html.includes('<title>InkPanel</title>'));
  assert.ok(html.includes('<link rel="icon" href="./favicon.svg" type="image/svg+xml">'));
  assert.ok(html.includes('<meta name="theme-color" content="#0a0a0b">'));
});

test('admin form controls keep narrow layouts inside their cards', async () => {
  const css = await readFile(stylesUrl, 'utf8');

  assert.ok(css.includes('box-sizing: border-box;'));
  assert.ok(css.includes('min-width: 0;'));
  assert.ok(css.includes('max-width: 100%;'));
  assert.ok(css.includes('overflow-wrap: anywhere;'));
  assert.ok(css.includes('flex-wrap: wrap;'));

  const controlsStart = css.indexOf('input[type="text"],');
  const controlsEnd = css.indexOf('\n}', controlsStart);
  assert.notEqual(controlsStart, -1);
  assert.notEqual(controlsEnd, -1);
  const controls = css.slice(controlsStart, controlsEnd);
  assert.ok(controls.includes('width: 100%;'));
  assert.ok(controls.includes('min-width: 0;'));
  assert.ok(controls.includes('max-width: 100%;'));
});

test('favicon is a self-contained CtrlAlt-coloured SVG', async () => {
  const svg = await readFile(faviconUrl, 'utf8');
  assert.ok(svg.includes('viewBox="0 0 64 64"'));
  assert.ok(svg.includes('#f7a4a2'));
  assert.ok(svg.includes('#0a0a0b'));
});
