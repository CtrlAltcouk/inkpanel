import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { chromium } from 'playwright';
import { createApp } from '../../src/http/app.ts';
import { DeviceStore } from '../../src/devices/store.ts';
import { createRuntimeState } from '../../src/runtimeConfig.ts';
import { parse } from 'yaml';

const MINI = 'ssd1681-200x200-mono';
const FULL = 'wft0583-800x480-mono';
const appConfig = parse(await readFile(new URL('../../home-assistant/config.yaml', import.meta.url), 'utf8'));

async function withStudio({ ha = true, prefix = '', profile = MINI, realEntry = false } = {}, run) {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-studio-reliability-'));
  const store = new DeviceStore(join(dir, 'config.json'));
  await store.getOrCreate('panel-a', profile);
  const sections = (first) => profile === MINI ? [first] : [first, ...Array.from({ length: 3 }, () => ({ type: 'weather', version: 1, config: {} }))];
  await store.update('panel-a', { claimed: realEntry, dashboardSections: sections({ type: 'todo', version: 1, config: { listId: '' } }) });
  const calls = { enrolment: 0, dashboard: 0, push: 0 };
  const frame = (fill) => ({ buffer: Buffer.alloc(profile === MINI ? 5000 : 48000, fill), etag: 'a'.repeat(32), renderedAt: new Date().toISOString() });
  const frames = {
    warmUp: async () => {}, sourceIssues: () => [], renderedDeviceCount: () => 0,
    enrolmentFrame: async () => { calls.enrolment++; return frame(0); },
    frameFor: async () => { calls.dashboard++; return frame(255); },
    renderNow: async () => { calls.push++; return frame(255); },
  };
  let discoveryFails = true;
  const router = express.Router();
  router.get('/harness', (_req, res) => res.type('html').send(`<!doctype html><div id="root"></div>
    <script type="module">
      import { renderPanels } from './panels.js';
      Date.now = () => 1234567890000;
      window.reopen = () => renderPanels(document.querySelector('#root'));
      await window.reopen();
      window.ready = true;
    </script>`));
  for (const [endpoint, key, entityId] of [['calendars', 'calendars', 'calendar.family'], ['todo-lists', 'lists', 'todo.shopping']]) {
    router.get(`/api/home-assistant/${endpoint}`, (_req, res) => {
      if (discoveryFails) return res.status(503).json({ error: 'Discovery unavailable' });
      // Deliberately contradictory support: runtime, not discovery, owns it.
      res.json({ supported: !ha, available: true, [key]: [{ entityId, name: 'Family' }] });
    });
  }
  router.use(createApp({
    store, frames, publicBaseUrl: 'http://panel.test:8080', runtimeState: createRuntimeState(),
    dataDir: dir, firmwareDir: dir, auth: { password: null, secret: randomBytes(32) },
    updateMode: ha ? 'home-assistant' : 'self',
    homeAssistantRelease: appConfig.version,
    ...(prefix ? { access: { mode: 'home-assistant-ingress', isTrustedRequest: () => true } } : {}),
  }));
  const app = express();
  app.use(prefix || '/', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const requests = [];
    page.on('request', (request) => requests.push(new URL(request.url())));
    await page.goto(`http://127.0.0.1:${server.address().port}${prefix}/${realEntry ? appConfig.ingress_entry : 'harness'}`);
    if (realEntry) await page.locator('[data-widget-type]').waitFor();
    else await page.waitForFunction(() => window.ready);
    await run({ page, store, calls, sections, requests, recoverDiscovery: () => { discoveryFails = false; } });
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}

for (const profile of [MINI, FULL]) {
  test(`fresh release-query Ingress document loads real Studio and claimed preview (${profile})`, async () => {
    const prefix = '/api/hassio_ingress/test-token';
    await withStudio({ profile, prefix, realEntry: true }, async ({ page, calls, requests, recoverDiscovery }) => {
      assert.equal(new URL(page.url()).pathname, `${prefix}/`);
      assert.equal(new URL(page.url()).searchParams.get('inkpanel_release'), appConfig.version);
      const runtime = await page.evaluate(async () => {
        const { getJson } = await import('./api.js');
        return getJson('/api/runtime-config');
      });
      assert.equal(runtime.updateMode, 'home-assistant');
      assert.equal(runtime.release, appConfig.version);
      await page.locator('[data-todo-provider]').selectOption('home-assistant');
      assert.match(await page.locator('[data-widget-controls]').textContent(), /To Do lists are unavailable/);
      await page.locator('[data-widget-type]').selectOption('calendar');
      await page.locator('[data-calendar-provider]').selectOption('home-assistant');
      assert.match(await page.locator('[data-widget-controls]').textContent(), /calendars are unavailable/);

      await page.waitForFunction(() => document.querySelector('.panel-preview-image').naturalWidth > 0);
      const initial = await page.locator('.panel-preview-image').getAttribute('src');
      assert.match(initial, /render\.png\?t=\d+-\d+$/);
      assert.equal(calls.enrolment, 0);
      assert.equal(calls.dashboard, 1, 'claimed dashboard loads without Push');
      await page.locator('[data-push]').click();
      await page.waitForFunction((previous) => document.querySelector('.panel-preview-image').getAttribute('src') !== previous, initial);
      assert.equal(calls.push, 1);

      recoverDiscovery();
      await page.reload();
      await page.locator('[data-todo-provider]').selectOption('home-assistant');
      assert.equal(await page.locator('[data-ha-todo-list] option[value="todo.shopping"]').count(), 1);
      await page.locator('[data-widget-type]').selectOption('calendar');
      await page.locator('[data-calendar-provider]').selectOption('home-assistant');
      assert.equal(await page.locator('[data-ha-calendar][value="calendar.family"]').count(), 1);

      const paths = new Set(requests.map((url) => url.pathname));
      for (const path of ['/app.js', '/styles.css', '/studio.css', '/cityPicker.js', '/stationPicker.js', '/flash.js', '/api/devices', '/api/runtime-config', '/api/home-assistant/calendars', '/api/home-assistant/todo-lists', '/api/printers', '/api/todo-lists', '/api/devices/panel-a/push']) {
        assert.ok(paths.has(prefix + path), path);
      }
      for (const url of requests.filter((url) => /\.(js|css)$/.test(url.pathname) || url.pathname.includes('/api/'))) {
        assert.ok(url.pathname.startsWith(prefix + '/'), url.href);
      }
    });
  });

  test(`HA provider capability survives failed discovery and retains saved entities (${profile})`, async () => {
    await withStudio({ profile, prefix: '/api/hassio_ingress/test-token' }, async ({ page, store, sections, recoverDiscovery }) => {
      const todo = page.locator('[data-todo-provider]');
      assert.equal(await todo.count(), 1);
      assert.equal(await todo.locator('option[value="home-assistant"]').isDisabled(), false);
      await todo.selectOption('home-assistant');
      assert.match(await page.locator('[data-widget-controls]').textContent(), /To Do lists are unavailable/);

      await store.update('panel-a', { dashboardSections: sections({ type: 'todo', version: 2, config: { provider: 'home-assistant', entityId: 'todo.saved_missing' } }) });
      await page.evaluate(() => window.reopen());
      assert.equal(await page.locator('[data-ha-todo-list]').inputValue(), 'todo.saved_missing');
      assert.match(await page.locator('[data-widget-controls]').textContent(), /Saved selection is retained/);
      assert.equal(await page.locator('[data-todo-add]').count(), 0, 'HA editor remains read-only');

      await page.locator('[data-widget-type]').selectOption('calendar');
      await page.locator('[data-calendar-provider]').selectOption('home-assistant');
      assert.match(await page.locator('[data-widget-controls]').textContent(), /calendars are unavailable/);
      await store.update('panel-a', { dashboardSections: sections({ type: 'calendar', version: 2, config: { provider: 'home-assistant', entityIds: ['calendar.saved_missing'] } }) });
      await page.evaluate(() => window.reopen());
      assert.equal(await page.locator('[data-ha-calendar][value="calendar.saved_missing"]').isChecked(), true);
      assert.match(await page.locator('[data-widget-controls]').textContent(), /Saved selections are retained/);

      recoverDiscovery();
      await page.evaluate(() => window.reopen());
      assert.equal(await page.locator('[data-ha-calendar][value="calendar.family"]').count(), 1);
      assert.equal(await page.locator('[data-ha-calendar][value="calendar.saved_missing"]').isChecked(), true);
      await page.locator('[data-widget-type]').selectOption('todo');
      await page.locator('[data-todo-provider]').selectOption('home-assistant');
      assert.equal(await page.locator('[data-ha-todo-list] option[value="todo.shopping"]').count(), 1);
    });
  });

  test(`open/save/reopen/Push preview URLs are fresh without changing frame routing (${profile})`, async () => {
    const prefix = profile === MINI ? '/api/hassio_ingress/test-token' : '';
    await withStudio({ profile, prefix }, async ({ page, store, calls }) => {
      const image = page.locator('.panel-preview-image');
      const loaded = () => page.waitForFunction(() => {
        const img = document.querySelector('.panel-preview-image');
        return img.complete && img.naturalWidth > 0;
      });
      const pixel = () => image.evaluate((img) => {
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        context.drawImage(img, 0, 0);
        return context.getImageData(0, 0, 1, 1).data[0];
      });
      await loaded();
      const enrolmentUrl = await image.getAttribute('src');
      assert.match(enrolmentUrl, /render\.png\?t=\d+-\d+$/);
      assert.ok(enrolmentUrl.startsWith(`${prefix}/api/devices/panel-a/`));
      const enrolmentPixel = await pixel();
      assert.equal(calls.enrolment, 1);
      assert.equal(calls.dashboard, 0);

      await page.locator('[data-panel-tab="device"]').click();
      await page.locator('[name="claimed"]').check();
      await page.locator('[name="name"]').fill('Claimed panel');
      await page.locator('button[type="submit"]').click();
      await page.waitForFunction((previous) => document.querySelector('.panel-preview-image').getAttribute('src') !== previous, enrolmentUrl);
      await page.waitForFunction(() => document.querySelector('[data-widget-type]'));
      await loaded();
      const claimedUrl = await image.getAttribute('src');
      assert.notEqual(claimedUrl, enrolmentUrl);
      assert.notEqual(await pixel(), enrolmentPixel, 'save immediately loads dashboard, not enrolment');
      assert.equal((await store.get('panel-a')).claimed, true);
      assert.equal((await store.get('panel-a')).name, 'Claimed panel');
      assert.equal(await page.locator('#save-state').textContent(), 'All changes saved');
      assert.equal(calls.push, 0, 'claiming does not require Push');
      assert.equal(calls.dashboard, 1);

      await page.evaluate(() => window.reopen());
      await loaded();
      const reopenedUrl = await image.getAttribute('src');
      assert.notEqual(reopenedUrl, claimedUrl, 'same-millisecond reopen still gets a new revision');
      assert.notEqual(reopenedUrl, enrolmentUrl);
      assert.notEqual(await pixel(), enrolmentPixel);
      assert.equal(calls.dashboard, 2);
      await page.locator('[data-panel-tab="dashboard"]').click();
      await page.locator('[data-push]').click();
      await page.waitForFunction((previous) => document.querySelector('.panel-preview-image').getAttribute('src') !== previous, reopenedUrl);
      await loaded();
      assert.equal(calls.push, 1);
      assert.equal(calls.dashboard, 3);
      assert.equal(calls.enrolment, 1);
    });
  });
}

test('standalone keeps HA providers hidden regardless of discovery support or failure', async () => {
  await withStudio({ ha: false }, async ({ page, recoverDiscovery }) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.equal(await page.locator('[data-todo-provider]').count(), 0);
      assert.equal(await page.locator('[data-todo-list]').count(), 1);
      await page.locator('[data-widget-type]').selectOption('calendar');
      assert.equal(await page.locator('[data-calendar-provider]').count(), 0);
      assert.equal(await page.locator('[data-calendar-urls]').count(), 1);
      recoverDiscovery();
      await page.evaluate(() => window.reopen());
    }
  });
});
