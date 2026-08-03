import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { Renderer } from '../../src/render/browser.ts';
import { WFT0583 } from '../../src/panel/profile.ts';

const renderer = new Renderer();
after(() => renderer.close());

test('screenshots at exactly the profile size', async () => {
  const png = await renderer.screenshot('<html><body></body></html>', WFT0583);
  const meta = await sharp(png).metadata();
  assert.equal(meta.width, 800);
  assert.equal(meta.height, 480);
});

test('reuses one browser across renders', async () => {
  const a = await renderer.screenshot('<html><body>A</body></html>', WFT0583);
  const b = await renderer.screenshot('<html><body>B</body></html>', WFT0583);
  assert.ok(a.length > 0 && b.length > 0);
  assert.notDeepEqual(a, b, 'different content must produce different pixels');
});

test('renders identical HTML deterministically', async () => {
  const html = '<html><body><h1>Same</h1></body></html>';
  const a = await renderer.screenshot(html, WFT0583);
  const b = await renderer.screenshot(html, WFT0583);
  assert.deepEqual(a, b, 'non-determinism here would make golden tests useless');
});

test('recovers if the browser is closed underneath it', async () => {
  await renderer.close();
  const png = await renderer.screenshot('<html><body>After close</body></html>', WFT0583);
  const meta = await sharp(png).metadata();
  assert.equal(meta.width, 800, 'must relaunch rather than throw');
});
