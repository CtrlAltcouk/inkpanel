import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const indexUrl = new URL('../../public/index.html', import.meta.url);
const stylesUrl = new URL('../../public/styles.css', import.meta.url);
const faviconUrl = new URL('../../public/favicon.svg', import.meta.url);

function ruleBodies(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...css.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'g'))]
    .map((match) => match[1]);
}

test('admin shell declares the InkPanel favicon and theme colour', async () => {
  const html = await readFile(indexUrl, 'utf8');
  assert.match(html, /<title>InkPanel<\/title>/);
  assert.match(html, /rel="icon" href="\.\/favicon\.svg" type="image\/svg\+xml"/);
  assert.match(html, /name="theme-color" content="#0a0a0b"/);
});

test('admin form controls use border-box sizing and wrap narrow helper text', async () => {
  const css = await readFile(stylesUrl, 'utf8');
  assert.match(css, /\*,\s*\*::before,\s*\*::after\s*\{[^}]*box-sizing:\s*border-box;/s);
  assert.match(css, /input\[type="text"\],[\s\S]*?textarea\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;/);
  assert.ok(ruleBodies(css, '.meta').some((body) => /overflow-wrap:\s*anywhere;/.test(body)));
  assert.ok(ruleBodies(css, '.actions').some((body) => /flex-wrap:\s*wrap;/.test(body)));
});

test('favicon is a self-contained CtrlAlt-coloured SVG', async () => {
  const svg = await readFile(faviconUrl, 'utf8');
  assert.match(svg, /viewBox="0 0 64 64"/);
  assert.match(svg, /#f7a4a2/);
  assert.match(svg, /#0a0a0b/);
});
