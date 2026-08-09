import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import type { Browser } from 'playwright';
import { Renderer } from '../../src/render/browser.ts';
import { WFT0583 } from '../../src/panel/profile.ts';

const renderer = new Renderer();
after(() => renderer.close());

function fakeBrowser(): Browser {
  return {
    isConnected: () => true,
    close: async () => {},
  } as unknown as Browser;
}

test('concurrent cold warm-ups share one Chromium launch', async () => {
  let launches = 0;
  let release!: (browser: Browser) => void;
  const launched = new Promise<Browser>((resolve) => { release = resolve; });
  const concurrent = new Renderer(async () => {
    launches += 1;
    return launched;
  });

  const first = concurrent.warmUp();
  const second = concurrent.warmUp();
  await Promise.resolve();
  assert.equal(launches, 1);
  release(fakeBrowser());
  await Promise.all([first, second]);
  assert.equal(launches, 1);
  await concurrent.close();
});

test('a failed cold launch clears the shared promise so a later call can retry', async () => {
  let launches = 0;
  const retrying = new Renderer(async () => {
    launches += 1;
    if (launches === 1) throw new Error('first launch failed');
    return fakeBrowser();
  });

  await assert.rejects(retrying.warmUp(), /first launch failed/);
  await assert.doesNotReject(retrying.warmUp());
  assert.equal(launches, 2);
  await retrying.close();
});

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
