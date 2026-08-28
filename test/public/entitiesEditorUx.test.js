import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { chromium } from 'playwright';
import { parse } from 'yaml';
import { createApp } from '../../src/http/app.ts';
import { DeviceStore } from '../../src/devices/store.ts';
import { HomeAssistantClient } from '../../src/homeAssistant/client.ts';
import { createRuntimeState } from '../../src/runtimeConfig.ts';

const appConfig = parse(await readFile(new URL('../../home-assistant/config.yaml', import.meta.url), 'utf8'));
const MINI = 'ssd1681-200x200-mono';
const FULL = 'wft0583-800x480-mono';
const selectedIds = (page) => page.locator('[data-selected-entity]').evaluateAll((rows) => rows.map((row) => row.dataset.selectedEntity));

async function withStudio({ profile = MINI, ha = true, ids = [] } = {}, run) {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-sensors-ui-'));
  const store = new DeviceStore(join(dir, 'config.json'));
  await store.getOrCreate('panel-a', profile);
  const sections = (first) => profile === MINI ? [first] : [first, ...Array.from({ length: 3 }, () => ({ type: 'empty', version: 1, config: {} }))];
  await store.update('panel-a', { claimed: true, dashboardSections: sections({ type: 'entities', version: 1, config: { entityIds: ids } }) });
  let outage = false;
  const client = new HomeAssistantClient({ enabled: ha, token: 'server-only-test-token', fetchImpl: async () => {
    if (outage) return new Response('', { status: 503 });
    return Response.json(Array.from({ length: 26 }, (_, i) => ({ entity_id: `sensor.room_${i}`, state: String(20 + i),
      attributes: { friendly_name: i === 0 ? 'Living Room Temperature' : `Room ${i}`, unit_of_measurement: '°C', secret: 'never-in-studio' } })));
  } });
  const frame = { buffer: Buffer.alloc(profile === MINI ? 5000 : 48000, 255), etag: 'a'.repeat(32), renderedAt: new Date().toISOString() };
  const frames = { warmUp: async () => {}, sourceIssues: () => [], renderedDeviceCount: () => 0,
    frameFor: async () => frame, renderNow: async () => frame, enrolmentFrame: async () => frame };
  const prefix = ha ? '/api/hassio_ingress/sensor-test' : '';
  const app = express();
  app.use(prefix || '/', createApp({ store, frames, homeAssistantClient: client, publicBaseUrl: 'http://panel.test:8080',
    runtimeState: createRuntimeState(), dataDir: dir, firmwareDir: dir, auth: { password: null, secret: randomBytes(32) },
    updateMode: ha ? 'home-assistant' : 'self', homeAssistantRelease: appConfig.version,
    ...(ha ? { access: { mode: 'home-assistant-ingress', isTrustedRequest: () => true } } : {}) }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const requests = [];
    page.on('request', (request) => requests.push({ url: new URL(request.url()), method: request.method() }));
    await page.goto(`http://127.0.0.1:${server.address().port}${prefix}/${appConfig.ingress_entry}`);
    await page.locator('[data-widget-type]').waitFor();
    await run({ page, store, sections, prefix, requests, setOutage: () => { outage = true; } });
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}

for (const profile of [MINI, FULL]) {
  test(`Sensors picker searches, limits, reorders, remembers and saves through release-query Ingress (${profile})`, async () => {
    await withStudio({ profile }, async ({ page, store, prefix, requests, setOutage }) => {
      assert.equal(new URL(page.url()).searchParams.get('inkpanel_release'), appConfig.version);
      assert.equal(await page.locator('[data-widget-type] option[value="entities"]').textContent(), 'Home Assistant Sensors');
      assert.equal(await page.locator('[data-entity-add]').count(), 20, 'large discovery is bounded and searchable');
      const search = page.locator('[data-entity-search]');
      await search.fill('living room');
      assert.equal(await page.locator('[data-entity-add]').count(), 1);
      assert.match(await page.locator('[data-entity-add]').textContent(), /20 °C/);
      await search.press('Tab');
      assert.equal(await page.locator('#save-state').textContent(), 'All changes saved', 'search does not dirty configuration');
      await page.locator('[data-entity-add="sensor.room_0"]').click();
      assert.equal(await page.locator('#save-state').textContent(), 'Unsaved changes');
      for (const index of [1, 2, 3]) {
        await search.fill(`sensor.room_${index}`);
        await page.locator(`[data-entity-add="sensor.room_${index}"]`).click();
      }
      await search.fill('sensor.room_4');
      assert.equal(await page.locator('[data-entity-add="sensor.room_4"]').isDisabled(), true);
      assert.deepEqual(await selectedIds(page), ['sensor.room_0', 'sensor.room_1', 'sensor.room_2', 'sensor.room_3']);
      await page.locator('[data-entity-move="-1"][data-entity-index="3"]').click();
      await page.locator('[data-entity-move="1"][data-entity-index="0"]').click();
      await page.locator('[data-entity-remove="3"]').click();
      const ordered = ['sensor.room_1', 'sensor.room_0', 'sensor.room_3'];
      assert.deepEqual(await selectedIds(page), ordered);
      await page.locator('[data-widget-type]').selectOption('weather');
      await page.locator('[data-widget-type]').selectOption('entities');
      assert.deepEqual(await selectedIds(page), ordered, 'away/back restores the draft order');
      await page.locator('button[type="submit"]').click();
      await page.waitForFunction(() => document.querySelector('#save-state').textContent === 'All changes saved');
      assert.deepEqual((await store.get('panel-a')).dashboardSections[0].config.entityIds, ordered);
      await page.reload();
      await page.locator('[data-selected-entity]').first().waitFor();
      assert.deepEqual(await selectedIds(page), ordered, 'save/reopen retains order');
      if (profile === FULL) {
        await page.locator('[data-dashboard-select="1"]').click();
        await page.locator('[data-widget-type]').selectOption('entities');
        assert.deepEqual(await selectedIds(page), ordered, 'an unconfigured slot uses the shared saved Sensors draft');
        await page.locator('[data-dashboard-select="0"]').click();
      }
      await page.locator('[data-widget-type]').selectOption('weather');
      await page.locator('button[type="submit"]').click();
      await page.waitForFunction(() => document.querySelector('#save-state').textContent === 'All changes saved');
      await page.reload();
      await page.locator('[data-widget-type]').selectOption('entities');
      assert.deepEqual(await selectedIds(page), ordered, 'inactive per-slot Sensors draft survives save/reopen');
      await page.locator('button[type="submit"]').click();
      await page.waitForFunction(() => document.querySelector('#save-state').textContent === 'All changes saved');

      // Missing selection survives both successful discovery and a complete outage.
      const saved = await store.get('panel-a');
      saved.dashboardSections[0].config.entityIds.push('sensor.removed');
      await store.update('panel-a', { dashboardSections: saved.dashboardSections });
      await page.reload();
      await page.locator('[data-selected-entity="sensor.removed"]').waitFor();
      assert.match(await page.locator('[data-selected-entity="sensor.removed"]').textContent(), /Missing\/unavailable/);
      setOutage();
      await page.reload();
      await page.locator('[data-entities-unavailable]').waitFor();
      assert.deepEqual(await selectedIds(page), [...ordered, 'sensor.removed']);
      assert.equal(await page.locator('#save-state').textContent(), 'All changes saved');
      assert.equal(await page.locator('[data-widget-type] option[value="entities"]').count(), 1);
      assert.ok(requests.some(({ url }) => url.pathname === `${prefix}/api/home-assistant/sensors`));
      for (const { url, method } of requests) {
        if (/\.(js|css)$/.test(url.pathname) || url.pathname.includes('/api/')) assert.ok(url.pathname.startsWith(`${prefix}/`), url.href);
        if (url.pathname.includes('/api/home-assistant/')) assert.equal(method, 'GET', 'Sensors do not mutate HA');
      }
      assert.doesNotMatch(await page.content(), /server-only-test-token|never-in-studio/);
    });
  });
}

test('standalone preserves saved Sensors but does not offer Sensors for a new widget', async () => {
  await withStudio({ ha: false, ids: ['sensor.saved_missing'] }, async ({ page, store, sections }) => {
    assert.deepEqual(await selectedIds(page), ['sensor.saved_missing']);
    assert.match(await page.locator('[data-widget-controls]').textContent(), /Saved selections are retained/);
    await store.update('panel-a', { dashboardSections: sections({ type: 'weather', version: 1, config: {} }) });
    await page.reload();
    await page.locator('[data-widget-type]').waitFor();
    assert.equal(await page.locator('[data-widget-type] option[value="entities"]').count(), 0);
  });
});
