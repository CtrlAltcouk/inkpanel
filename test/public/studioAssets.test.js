import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { chromium } from 'playwright';
import { parse } from 'yaml';
import { createApp } from '../../src/http/app.ts';
import { studioAssetBase } from '../../src/http/studioAssets.ts';
import { DeviceStore } from '../../src/devices/store.ts';
import { HomeAssistantClient } from '../../src/homeAssistant/client.ts';
import { createRuntimeState } from '../../src/runtimeConfig.ts';

const config = parse(await readFile(new URL('../../home-assistant/config.yaml', import.meta.url), 'utf8'));
const release = config.version;
const previous = '0.1.0-ha.10';

async function withStudio({ ha = true, prefix = '', mini = true, password = null } = {}, run) {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-assets-'));
  const store = new DeviceStore(join(dir, 'config.json'));
  const profile = mini ? 'ssd1681-200x200-mono' : 'wft0583-800x480-mono';
  const device = await store.getOrCreate('panel', profile);
  await store.update('panel', { claimed: true, dashboardSections: device.dashboardSections.map(() => ({ type: 'weather', version: 1, config: {} })) });
  const frame = { buffer: Buffer.alloc(mini ? 5000 : 48000, 255), etag: 'a'.repeat(32), renderedAt: new Date().toISOString() };
  const deps = { store, frames: { warmUp: async () => {}, sourceIssues: () => [], renderedDeviceCount: () => 0,
    frameFor: async () => frame, renderNow: async () => frame, enrolmentFrame: async () => frame },
    publicBaseUrl: 'http://panel.test:8080', runtimeState: createRuntimeState(), dataDir: dir, firmwareDir: dir,
    auth: { password, secret: randomBytes(32) }, updateMode: ha ? 'home-assistant' : 'self',
    homeAssistantClient: new HomeAssistantClient({ enabled: ha, token: 'not-for-browser', fetchImpl: async () => Response.json([]) }),
    ...(prefix ? { access: { mode: 'home-assistant-ingress', isTrustedRequest: () => true } } : {}) };
  const current = createApp({ ...deps, homeAssistantRelease: release });
  // The pre-ha.11 document used stable root assets even with a release query.
  const old = createApp(deps);
  let upgraded = true;
  let staleHits = 0;
  const router = express.Router();
  // Emulate a cache/proxy retaining old modules despite fresh document queries.
  router.get(['/panels.js', `/assets/${previous}/panels.js`], (_req, res, next) => {
    if (!ha) return next();
    staleHits++;
    res.set('Cache-Control', 'public, max-age=86400').type('js').send('export function setSelectedPanel(){}; export async function renderPanels(root){root.innerHTML="<p id=stale>Old frontend without Sensors</p>"}');
  });
  router.use((req, res, next) => (upgraded ? current : old)(req, res, next));
  const serverApp = express(); serverApp.use(prefix || '/', router);
  const server = serverApp.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}${prefix}`;
  try { await run({ base, store, setUpgraded: (value) => { upgraded = value; }, staleHits: () => staleHits }); }
  finally { await new Promise((resolve) => server.close(resolve)); await rm(dir, { recursive: true, force: true }); }
}

test('asset release is validated build metadata, not a request-controlled path', () => {
  assert.equal(studioAssetBase(), './');
  assert.equal(studioAssetBase(release), `./assets/${release}/`);
  assert.notEqual(studioAssetBase(previous), studioAssetBase(release));
  for (const bad of ['', '../secret', 'a/b', 'a\\b', 'a?x=1', 'a#x', '<script>', '%2e%2e', 'x'.repeat(65)]) {
    assert.throws(() => studioAssetBase(bad), /Invalid Studio asset release/);
  }
});

test('HA documents, nested assets, MIME types and cache headers share one release namespace', async () => {
  await withStudio({ prefix: '/api/hassio_ingress/assets-test' }, async ({ base }) => {
    for (const doc of ['/', '/index.html', '/login.html', '/terms.html', '/privacy.html']) {
      const response = await fetch(`${base}${doc}?inkpanel_release=attacker-controlled`);
      const html = await response.text();
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('etag'), null);
      assert.equal(response.headers.get('last-modified'), null);
      const assets = [...html.matchAll(/(?:src|href)="([^"#]+\.(?:js|css|svg))"/g)].map((match) => match[1]);
      assert.ok(assets.length);
      assert.ok(assets.every((url) => url.startsWith(`./assets/${release}/`)), doc);
      assert.doesNotMatch(html, /<base\b|attacker-controlled/);
      if (doc === '/') {
        assert.match(html, /href="\.\/terms.html"/);
        assert.match(html, /href="\.\/privacy.html"/);
      }
    }
    for (const file of ['app.js', 'panels.js', 'dashboardEditor.js', 'entitiesEditor.js', 'calendarEditor.js', 'todoEditor.js', 'cityPicker.js', 'login.js', 'styles.css', 'flash.css', 'studio.css', 'favicon.svg', 'vendor/esptool-js.js', 'vendor/colors_and_type.css']) {
      const response = await fetch(`${base}/assets/${release}/${file}`, { headers: { 'if-none-match': '"old"', 'if-modified-since': 'Wed, 01 Jan 2099 00:00:00 GMT' } });
      assert.equal(response.status, 200, file);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('etag'), null);
      assert.equal(response.headers.get('last-modified'), null);
      assert.match(response.headers.get('content-type'), file.endsWith('.js') ? /javascript/ : file.endsWith('.css') ? /text\/css/ : /image\/svg/);
      await response.arrayBuffer();
    }
    const font = await fetch(`${base}/assets/${release}/vendor/fonts/inter-latin-400-normal.woff2`);
    assert.equal(font.status, 200); assert.match(font.headers.get('cache-control'), /immutable/); await font.arrayBuffer();
    for (const path of [`/assets/${previous}/app.js`, `/assets/${release}/index.html`, `/assets/${release}/index.%68tml`, `/assets/${release}/`, `/assets/${release}/.env`, `/assets/${release}/%2e%2e%2f%2e%2e%2fpackage.json`]) {
      const response = await fetch(base + path); assert.ok([400, 403, 404].includes(response.status), path); await response.arrayBuffer();
    }
  });
});

for (const options of [{ ha: true, prefix: '/api/hassio_ingress/assets-test', mini: true }, { ha: true, prefix: '/api/hassio_ingress/assets-test', mini: false }, { ha: true, prefix: '' }, { ha: false, prefix: '' }]) {
  test(`real Studio loads the full module graph without changing API roots ${JSON.stringify(options)}`, async () => {
    await withStudio(options, async ({ base, setUpgraded, staleHits }) => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        if (options.ha) {
          setUpgraded(false);
          await page.goto(`${base}/?inkpanel_release=${previous}`);
          await page.locator('#stale').waitFor();
          assert.ok(staleHits() > 0, 'the old release really loaded a stale nested module');
          setUpgraded(true);
        }
        const oldHits = staleHits(); const requests = []; const errors = [];
        page.on('request', (request) => requests.push(new URL(request.url())));
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(`${base}/?inkpanel_release=${release}`); // Normal navigation, same cache/context.
        await page.locator('[data-widget-type]').waitFor();
        assert.equal(new URL(page.url()).pathname, `${options.prefix}/`);
        const assets = `${options.prefix}/${options.ha ? `assets/${release}/` : ''}`;
        for (const file of ['app.js', 'panels.js', 'dashboardEditor.js', 'entitiesEditor.js', 'calendarEditor.js', 'todoEditor.js', 'cityPicker.js', 'flash.js', 'paths.js', 'styles.css', 'flash.css', 'studio.css', 'vendor/colors_and_type.css']) {
          assert.ok(requests.some((url) => url.pathname === assets + file), file);
        }
        for (const url of requests.filter((url) => /\.(js|css)$/.test(url.pathname))) assert.ok(url.pathname.startsWith(assets), url.href);
        assert.equal(staleHits(), oldHits, 'current release never requests stale stable/previous module URLs');
        assert.equal(await page.locator('[data-widget-type] option[value="entities"]').count(), options.ha ? 1 : 0);
        await page.locator('[data-widget-type]').selectOption('calendar');
        assert.equal(await page.locator('[data-calendar-provider]').count(), options.ha ? 1 : 0);
        await page.locator('[data-widget-type]').selectOption('todo');
        assert.equal(await page.locator('[data-todo-provider]').count(), options.ha ? 1 : 0);
        assert.ok(await page.locator('[data-todo-create]').count(), 'local To Do controls remain available');
        const pathResult = await page.evaluate(async (assetPath) => {
          const { appPath } = await import(`${assetPath}paths.js`);
          await import(`${assetPath}vendor/esptool-js.js`); // WebFlash lazy dependency stays versioned too.
          return appPath('/api/devices');
        }, assets);
        assert.equal(pathResult, `${options.prefix}/api/devices`);
        for (const path of ['devices', 'runtime-config', 'home-assistant/calendars', 'home-assistant/todo-lists', 'home-assistant/sensors', 'todo-lists', 'printers']) {
          assert.ok(requests.some((url) => url.pathname === `${options.prefix}/api/${path}`), path);
        }
        assert.ok(!requests.some((url) => /\/assets\/[^/]+\/api\//.test(url.pathname)));
        assert.deepEqual(errors, []);
      } finally { await browser.close(); }
    });
  });
}

test('versioned LAN login preserves authentication and document navigation', async () => {
  await withStudio({ password: 'test-password' }, async ({ base }) => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(`${base}/login.html`);
      assert.match(await page.locator('script[type="module"]').getAttribute('src'), new RegExp(`/assets/${release}/login.js$`));
      await page.locator('#password').fill('wrong'); await page.locator('button').click();
      await page.locator('#error:not([hidden])').waitFor();
      await page.locator('#password').fill('test-password'); await page.locator('button').click();
      await page.locator('[data-widget-type]').waitFor();
      assert.equal(new URL(page.url()).pathname, '/');
    } finally { await browser.close(); }
  });
});
