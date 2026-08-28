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
import { DeviceStore } from '../../src/devices/store.ts';
import { HomeAssistantClient } from '../../src/homeAssistant/client.ts';
import { HomeAssistantUserStore } from '../../src/homeAssistant/userStore.ts';
import { createRuntimeState } from '../../src/runtimeConfig.ts';
import { homeAssistantUsersHtml } from '../../public/homeAssistantUsers.js';

const release = parse(await readFile(new URL('../../home-assistant/config.yaml', import.meta.url), 'utf8')).version;
test('ownership Settings explains observed-user registration and empty assignments without task contents', () => {
  assert.match(homeAssistantUsersHtml([], [], null), /Open InkPanel through Home Assistant Ingress using the account you want to register/);
  assert.match(homeAssistantUsersHtml([{ userId: 'owner', displayName: 'Owner', todoEntityIds: [] }], [], null), /No personal To Do lists assigned/);
});
test('real Ingress Studio supports explicit personal conversion, owner-filtered choices, provider memory and admin Settings', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-users-ux-'));
  const store = new DeviceStore(join(dir, 'config.json'));
  const users = new HomeAssistantUserStore(join(dir, 'users.json'));
  await users.observe({ id: 'chris', username: 'chris', displayName: 'Chris' });
  await users.observe({ id: 'other', username: 'other', displayName: 'Other' });
  await users.assign('chris', ['todo.chris', 'todo.missing']);
  await users.assign('other', ['todo.other']);
  const legacy = { type: 'todo', version: 2, config: { provider: 'home-assistant', entityId: 'todo.shared' } };
  await store.getOrCreate('panel', 'ssd1681-200x200-mono');
  await store.update('panel', { claimed: true, dashboardSections: [legacy] });
  const client = new HomeAssistantClient({ enabled: true, token: 'no-browser-secret', fetchImpl: async (url) => {
    if (String(url).endsWith('/config')) return Response.json({ version: '2026.8.1', location_name: 'Home', time_zone: 'Europe/London' });
    return Response.json(['chris', 'other', 'shared', 'unassigned'].map((id) => ({ entity_id: `todo.${id}`, attributes: { friendly_name: id, token: 'no-browser-secret' } })));
  } });
  const frame = { buffer: Buffer.alloc(5000, 255), etag: 'a'.repeat(32), renderedAt: new Date().toISOString() };
  const frames = { warmUp: async () => {}, sourceIssues: () => [], renderedDeviceCount: () => 0, frameFor: async () => frame, renderNow: async () => frame };
  const prefix = '/api/hassio_ingress/personal-test';
  const app = express();
  app.use(prefix, createApp({ store, frames, homeAssistantClient: client, homeAssistantUserStore: users,
    publicBaseUrl: 'http://panel.test:8080', runtimeState: createRuntimeState(), dataDir: dir, firmwareDir: dir,
    auth: { password: null, secret: randomBytes(32) }, updateMode: 'home-assistant', homeAssistantRelease: release,
    access: { mode: 'home-assistant-ingress', isTrustedRequest: () => true } }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await new Promise((resolve) => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const page = await browser.newPage({ extraHTTPHeaders: { 'x-remote-user-id': 'chris', 'x-remote-user-name': 'chris', 'x-remote-user-display-name': 'Chris' } });
  const base = `http://127.0.0.1:${server.address().port}${prefix}/`;
  await page.goto(`${base}?inkpanel_release=${release}`);
  await page.locator('[data-todo-make-personal]').waitFor();
  assert.match(await page.locator('#dashboard-editor').textContent(), /Legacy shared Home Assistant To Do/);
  assert.equal(await page.locator('#save-state').textContent(), 'All changes saved');
  await page.locator('button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('#save-state')?.textContent === 'All changes saved');
  assert.deepEqual((await store.get('panel')).dashboardSections[0], legacy, 'unrelated save never attaches current user');
  await page.locator('[data-todo-make-personal]').click();
  assert.equal(await page.locator('[data-ha-todo-owner]').inputValue(), 'chris');
  assert.equal(await page.locator('[data-ha-todo-list]').inputValue(), '', 'legacy entity is never inferred as personal');
  const values = () => page.locator('[data-ha-todo-list] option').evaluateAll((options) => options.map((option) => option.value));
  assert.deepEqual(await values(), ['', 'todo.chris', 'todo.missing']);
  assert.match(await page.locator('[data-ha-todo-list]').textContent(), /missing\/unavailable/);
  await page.locator('[data-ha-todo-owner]').selectOption('other');
  assert.deepEqual(await values(), ['', 'todo.other']);
  await page.locator('[data-ha-todo-list]').selectOption('todo.other');
  await page.locator('[data-todo-provider]').selectOption('local');
  await page.locator('[data-todo-provider]').selectOption('home-assistant');
  assert.equal(await page.locator('[data-ha-todo-owner]').inputValue(), 'other');
  assert.equal(await page.locator('[data-ha-todo-list]').inputValue(), 'todo.other');
  await page.locator('button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('#save-state')?.textContent === 'All changes saved');
  assert.deepEqual((await store.get('panel')).dashboardSections[0], { type: 'todo', version: 3, config: { provider: 'home-assistant', ownerUserId: 'other', entityId: 'todo.other' } });
  await page.reload();
  await page.locator('[data-ha-todo-owner]').waitFor();
  assert.equal(await page.locator('[data-ha-todo-owner]').inputValue(), 'other', 'current browser user cannot replace saved owner');
  await page.goto(`${base}#settings`);
  await page.locator('[data-ha-users]').waitFor();
  assert.match(await page.locator('[data-ha-users]').textContent(), /Signed in through Home Assistant as Chris/);
  assert.match(await page.locator('[data-ha-users]').textContent(), /Other InkPanel data remains shared/);
  const card = page.locator('[data-ha-user="chris"]');
  await card.locator('summary').click();
  assert.equal(await card.locator('input[value="todo.other"]').isDisabled(), true);
  assert.equal(await card.locator('input[value="todo.missing"]').isChecked(), true);
  await card.locator('input[value="todo.unassigned"]').check();
  await card.locator('[data-save-assignments]').click();
  await page.waitForFunction(() => !document.querySelector('[data-ha-user="chris"]')?.open);
  assert.equal(await users.assigned('chris', 'todo.unassigned'), true);
  assert.doesNotMatch(await page.content(), /no-browser-secret/);
  const other = page.locator('[data-ha-user="other"]');
  await other.locator('summary').click();
  page.once('dialog', (dialog) => dialog.accept());
  await other.locator('[data-remove-user]').click();
  await other.waitFor({ state: 'detached' });
  assert.equal(await users.assigned('other', 'todo.other'), false);

  // New-widget creation uses the same production editor module as Studio.
  await page.evaluate(async ({ release, prefix }) => {
    const { renderDashboardEditor, collectDashboardSections, collectRememberedDashboardSettings } = await import(`${prefix}/assets/${release}/dashboardEditor.js`);
    const root = document.createElement('div'); root.id = 'new-editor'; document.body.append(root);
    renderDashboardEditor(root, { id: 'new', panelProfileId: 'ssd1681-200x200-mono', dashboardSections: [{ type: 'todo', version: 1, config: { listId: '' } }] }, {}, {}, {}, {}, [], [], {},
      { supported: true, personalSupported: true, available: true, currentUser: { id: 'chris' },
        users: [{ userId: 'chris', displayName: 'Chris', todoEntityIds: ['todo.chris'] }],
        lists: [{ entityId: 'todo.chris', name: 'Chris' }, { entityId: 'todo.other', name: 'Other' }] });
    window.collectPersonal = () => ({ sections: collectDashboardSections(root), remembered: collectRememberedDashboardSettings(root) });
  }, { release, prefix });
  await page.locator('#new-editor [data-todo-provider]').selectOption('home-assistant');
  assert.equal(await page.locator('#new-editor [data-ha-todo-owner]').inputValue(), 'chris');
  assert.deepEqual(await page.locator('#new-editor [data-ha-todo-list] option').evaluateAll((options) => options.map((option) => option.value)), ['', 'todo.chris']);
  await page.locator('#new-editor [data-ha-todo-list]').selectOption('todo.chris');
  assert.deepEqual((await page.evaluate(() => window.collectPersonal())).sections[0], { type: 'todo', version: 3, config: { provider: 'home-assistant', ownerUserId: 'chris', entityId: 'todo.chris' } });
});
