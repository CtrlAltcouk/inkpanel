import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { chromium } from 'playwright';
import { join } from 'node:path';

test('To Do provider UX preserves local CRUD, versions, both drafts, missing entities and dirty state', async () => {
  const app = express();
  app.get('/harness', (_req, res) => res.type('html').send(`<!doctype html><form><span id="state">Saved</span><div id="editor"></div></form><script type="module">
    import { renderDashboardEditor, collectDashboardSections, collectRememberedDashboardSettings } from '/dashboardEditor.js';
    const root = document.querySelector('#editor');
    document.querySelector('form').addEventListener('input', () => document.querySelector('#state').textContent = 'Unsaved');
    document.querySelector('form').addEventListener('change', () => document.querySelector('#state').textContent = 'Unsaved');
    window.load = (widget, supported = true, remembered = {}, mini = true) => {
      renderDashboardEditor(root, { id: 'p', panelProfileId: mini ? 'ssd1681-200x200-mono' : 'wft0583-800x480-mono', dashboardSections: mini ? [widget] : [widget, {type:'empty', version:1, config:{}}, {type:'empty', version:1, config:{}}, {type:'empty', version:1, config:{}}] }, {}, {}, {}, remembered,
        [{ id: 'home', name: 'Home', items: [{id:'task', text:'Local task', completed:false}] }, {id:'work', name:'Work', items:[]}], [], {},
        { supported, available: supported, lists: supported ? [{entityId:'todo.shopping', name:'Shopping <list>'}, {entityId:'todo.work', name:'Work tasks'}] : [] });
      document.querySelector('#state').textContent = 'Saved';
    };
    window.collect = () => ({ sections: collectDashboardSections(root), remembered: collectRememberedDashboardSettings(root) });
    window.load({type:'todo', version:1, config:{listId:'home'}}, false);
  </script>`));
  app.use(express.static(join(process.cwd(), 'public')));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/harness`);
    await page.locator('[data-todo-list]').waitFor();
    assert.equal(await page.locator('[data-todo-provider]').count(), 0, 'standalone UI unchanged');
    assert.equal((await page.evaluate(() => window.collect())).sections[0].version, 1);
    for (const mini of [true, false]) {
      await page.evaluate((mini) => window.load({ type: 'todo', version: 1, config: { listId: 'home' } }, true, {}, mini), mini);
      assert.equal(await page.locator('[data-todo-provider]').inputValue(), 'local');
      for (const selector of ['[data-todo-create]', '[data-todo-rename-button]', '[data-todo-delete-list]', '[data-todo-add]', '[data-todo-completed]', '[data-todo-move]', '[data-todo-delete-item]']) {
        assert.ok(await page.locator(selector).count(), selector);
      }
      await page.locator('[data-todo-new-task]').fill('Only a task draft');
      assert.equal(await page.locator('#state').textContent(), 'Saved');
      await page.locator('[data-todo-list]').selectOption('work');
      assert.equal(await page.locator('#state').textContent(), 'Unsaved');
      await page.locator('[data-todo-provider]').selectOption('home-assistant');
      assert.equal(await page.locator('[data-todo-create], [data-todo-completed], [data-todo-list]').count(), 0, 'HA provider is read-only');
      assert.match(await page.locator('#editor').textContent(), /Shopping <list>|Read only/);
      await page.locator('[data-ha-todo-list]').selectOption('todo.shopping');
      let saved = await page.evaluate(() => window.collect());
      assert.deepEqual(saved.sections[0], { type: 'todo', version: 2, config: { provider: 'home-assistant', entityId: 'todo.shopping' } });
      assert.equal(saved.remembered.slots[0].filter((widget) => widget.type === 'todo').length, 2);
      await page.locator('[data-todo-provider]').selectOption('local');
      assert.equal(await page.locator('[data-todo-list]').inputValue(), 'work');
      assert.deepEqual((await page.evaluate(() => window.collect())).sections[0], {type:'todo', version:2, config:{provider:'local', listId:'work'}});
      await page.locator('[data-todo-provider]').selectOption('home-assistant');
      assert.equal(await page.locator('[data-ha-todo-list]').inputValue(), 'todo.shopping');
      await page.locator('[data-widget-type]').selectOption('weather');
      await page.locator('[data-widget-type]').selectOption('todo');
      assert.equal(await page.locator('[data-ha-todo-list]').inputValue(), 'todo.shopping');
      saved = await page.evaluate(() => window.collect());
      await page.evaluate((saved) => window.load(saved.sections[0], true, saved.remembered), saved);
      await page.locator('[data-todo-provider]').selectOption('local');
      assert.equal(await page.locator('[data-todo-list]').inputValue(), 'work', 'local draft survives save/reload');
      await page.evaluate((saved) => window.load({type:'weather', version:1, config:{}}, true, {shared:saved.remembered.slots[0]}), saved);
      await page.locator('[data-widget-type]').selectOption('todo');
      assert.equal(await page.locator('[data-ha-todo-list]').inputValue(), 'todo.shopping', 'shared active provider is retained');
    }
    await page.evaluate(() => window.load({type:'todo', version:2, config:{provider:'home-assistant', entityId:'todo.removed'}}, false));
    assert.match(await page.locator('#editor').textContent(), /todo.removed \(missing\/unavailable\)/);
    assert.equal((await page.evaluate(() => window.collect())).sections[0].config.entityId, 'todo.removed');
    assert.equal(await page.locator('#state').textContent(), 'Saved');
    await page.evaluate(() => window.load({type:'todo', version:2, config:{provider:'home-assistant', entityId:'todo.removed'}}, true));
    await page.locator('[data-ha-todo-list]').selectOption('todo.work');
    assert.equal((await page.evaluate(() => window.collect())).sections[0].config.entityId, 'todo.work');
    assert.equal(await page.locator('#state').textContent(), 'Unsaved', 'missing selection changes only on explicit choice');
  } finally { await browser.close(); await new Promise((resolve) => server.close(resolve)); }
});
