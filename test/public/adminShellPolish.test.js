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

test('admin stylesheet contains narrow-layout overflow safeguards', async () => {
  const css = await readFile(stylesUrl, 'utf8');
  const safeguards = [
    'box-sizing: border-box;',
    'min-width: 0;',
    'max-width: 100%;',
    'overflow-wrap: anywhere;',
    'flex-wrap: wrap;',
  ];

  for (const safeguard of safeguards) {
    assert.ok(css.includes(safeguard), `missing admin layout safeguard: ${safeguard}`);
  }
});

test('favicon is a self-contained CtrlAlt-coloured SVG', async () => {
  const svg = await readFile(faviconUrl, 'utf8');
  assert.ok(svg.includes('viewBox="0 0 64 64"'));
  assert.ok(svg.includes('#f7a4a2'));
  assert.ok(svg.includes('#0a0a0b'));
});
