import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { chromium } from 'playwright';
import { join } from 'node:path';

const HOME_ID = '11111111-1111-4111-8111-111111111111';
const WORK_ID = '22222222-2222-4222-8222-222222222222';

function initialLists() {
  return [
    {
      id: HOME_ID,
      name: 'Home',
      items: [
        { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', text: 'Buy milk', completed: false },
        { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', text: 'Put bins out', completed: false },
      ],
    },
    { id: WORK_ID, name: 'Work', items: [] },
  ];
}

function clone(value) { return structuredClone(value); }

test('shared To Do mutations stay saved while visible changes reload the preview', async () => {
  const app = express();
  app.get('/harness', (_req, res) => res.type('html').send(`<!doctype html><html><body>
    <form><span id="save-state">All changes saved</span><img class="panel-preview-image" src="/initial.png"><div id="editor"></div></form>
    <script type="module">
      import { renderDashboardEditor } from '/dashboardEditor.js';
      import { bindTodoPreviewRefresh } from '/panels.js';
      let tick = 1000; Date.now = () => ++tick;
      const form = document.querySelector('form');
      const editor = document.querySelector('#editor');
      form.addEventListener('input', () => { document.querySelector('#save-state').textContent = 'Unsaved changes'; });
      form.addEventListener('change', () => { document.querySelector('#save-state').textContent = 'Unsaved changes'; });
      bindTodoPreviewRefresh(editor, document, 'panel-a');
      renderDashboardEditor(editor, {
        id: 'panel-a', locationLabel: 'Home', panelProfileId: 'ssd1681-200x200-mono',
        dashboardSections: [{ type: 'todo', version: 1, config: { listId: '${HOME_ID}' } }],
      }, {}, {}, {}, {}, window.initialTodoLists);
    </script>
  </body></html>`));
  app.use(express.static(join(process.cwd(), 'public')));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  let lists = initialLists();
  let nextItem = 0;

  await page.addInitScript((value) => { window.initialTodoLists = value; }, clone(lists));
  await page.route('**/api/todo-lists**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const parts = path.split('/').filter(Boolean);
    const listId = parts[2];
    const itemId = parts[4];
    const body = request.postDataJSON?.() ?? {};
    const list = lists.find((candidate) => candidate.id === listId);

    if (method === 'GET' && parts.length === 2) {
      await route.fulfill({ json: { lists: clone(lists) } });
      return;
    }
    if (method === 'POST' && parts.length === 2) {
      const created = { id: `33333333-3333-4333-8333-33333333333${lists.length}`, name: body.name, items: [] };
      lists.push(created);
      await route.fulfill({ status: 201, json: clone(created) });
      return;
    }
    if (method === 'PUT' && parts.length === 3 && list) {
      list.name = body.name;
      await route.fulfill({ json: clone(list) });
      return;
    }
    if (method === 'POST' && parts[3] === 'items' && parts.length === 4 && list) {
      nextItem += 1;
      const item = { id: `cccccccc-cccc-4ccc-8ccc-ccccccccccc${nextItem}`, text: body.text, completed: false };
      list.items.push(item);
      await route.fulfill({ status: 201, json: clone(item) });
      return;
    }
    if (method === 'PUT' && parts[3] === 'items' && parts[4] === 'order' && list) {
      const byId = new Map(list.items.map((item) => [item.id, item]));
      list.items = body.itemIds.map((id) => byId.get(id));
      await route.fulfill({ json: clone(list) });
      return;
    }
    if (method === 'PUT' && parts[3] === 'items' && itemId && list) {
      const item = list.items.find((candidate) => candidate.id === itemId);
      Object.assign(item, body);
      await route.fulfill({ json: clone(item) });
      return;
    }
    if (method === 'DELETE' && parts[3] === 'items' && itemId && list) {
      list.items = list.items.filter((candidate) => candidate.id !== itemId);
      await route.fulfill({ status: 204 });
      return;
    }
    await route.fulfill({ status: 404, json: { error: 'not found' } });
  });

  const saved = async () => assert.equal(await page.locator('#save-state').textContent(), 'All changes saved');
  const preview = () => page.locator('.panel-preview-image').getAttribute('src');
  const waitForPreviewAfter = async (before) => page.waitForFunction(
    (previous) => document.querySelector('.panel-preview-image').getAttribute('src') !== previous,
    before,
  );

  try {
    await page.goto(`${base}/harness`);
    await page.locator('[data-todo-list]').waitFor();

    let before = await preview();
    await page.locator('[data-todo-completed]').first().check();
    await page.locator('.todo-editor-row--done').waitFor();
    await waitForPreviewAfter(before);
    await saved();

    before = await preview();
    const taskText = page.locator('[data-todo-text]').nth(1);
    await taskText.fill('Put both bins out');
    await saved();
    await taskText.press('Tab');
    await page.waitForFunction(() => [...document.querySelectorAll('[data-todo-text]')].some((input) => input.value === 'Put both bins out'));
    await waitForPreviewAfter(before);
    await saved();

    before = await preview();
    await page.locator('[data-todo-new-task]').fill('Water plants');
    await saved();
    await page.locator('[data-todo-add]').click();
    await page.waitForFunction(() => [...document.querySelectorAll('[data-todo-text]')].some((input) => input.value === 'Water plants'));
    await waitForPreviewAfter(before);
    await saved();

    before = await preview();
    await page.locator('[data-todo-item]').last().locator('[data-todo-delete-item]').click();
    await page.waitForFunction(() => ![...document.querySelectorAll('[data-todo-text]')].some((input) => input.value === 'Water plants'));
    await waitForPreviewAfter(before);
    await saved();

    before = await preview();
    const firstId = await page.locator('[data-todo-item]').first().getAttribute('data-todo-item');
    await page.locator('[data-todo-item]').first().locator('[data-todo-move="1"]').click();
    await page.waitForFunction((previous) => document.querySelector('[data-todo-item]').dataset.todoItem !== previous, firstId);
    await waitForPreviewAfter(before);
    await saved();

    before = await preview();
    await page.locator('[data-todo-rename]').fill('Household');
    await saved();
    await page.locator('[data-todo-rename-button]').click();
    await page.waitForFunction(() => document.querySelector('[data-todo-rename]').value === 'Household');
    assert.equal(await preview(), before, 'renaming a list does not reload physical-content preview');
    await saved();

    await page.locator('[data-todo-list]').selectOption(WORK_ID);
    assert.equal(await page.locator('#save-state').textContent(), 'Unsaved changes');

    await page.locator('#save-state').evaluate((node) => { node.textContent = 'All changes saved'; });
    await page.locator('[data-widget-type]').selectOption('weather');
    assert.equal(await page.locator('#save-state').textContent(), 'Unsaved changes', 'existing non-To Do editor changes still dirty the form');
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
