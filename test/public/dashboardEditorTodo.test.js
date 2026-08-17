import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDashboardDraftState,
  dashboardCellHtml,
  serialiseDashboardDraftState,
} from '../../public/dashboardEditor.js';

const lists = [{
  id: 'home',
  name: 'Home <shared>',
  items: [
    { id: '11111111-1111-4111-8111-111111111111', text: 'Buy <milk>', completed: false },
    { id: '22222222-2222-4222-8222-222222222222', text: 'Already done', completed: true },
  ],
}];

test('To Do appears in the Content selector and renders compact list/task CRUD controls', () => {
  const html = dashboardCellHtml(
    'panel-a', 0,
    { type: 'todo', drafts: { todo: { listId: 'home' } } },
    '', {}, {}, {}, 'Top Left', lists,
  );
  assert.match(html, /<option value="todo" selected>To Do<\/option>/);
  assert.match(html, /data-todo-list/);
  assert.match(html, /data-todo-create/);
  assert.match(html, /data-todo-rename-button/);
  assert.match(html, /data-todo-delete-list/);
  assert.match(html, /data-todo-add/);
  assert.match(html, /data-todo-completed/);
  assert.match(html, /data-todo-move="-1"/);
  assert.match(html, /data-todo-delete-item/);
});

test('To Do editor escapes list and task text and marks completed rows', () => {
  const html = dashboardCellHtml(
    'panel-a', 0,
    { type: 'todo', drafts: { todo: { listId: 'home' } } },
    '', {}, {}, {}, 'Top Left', lists,
  );
  assert.match(html, /Home &lt;shared&gt;/);
  assert.match(html, /Buy &lt;milk&gt;/);
  assert.doesNotMatch(html, /Home <shared>|Buy <milk>/);
  assert.match(html, /todo-editor-row--done/);
  assert.match(html, /data-todo-completed checked/);
});

test('remembered To Do drafts contain only listId and survive widget switching', () => {
  const slots = createDashboardDraftState([
    { type: 'weather', version: 1, config: {} },
  ], {
    shared: [{ type: 'todo', version: 1, config: { listId: 'home' } }],
    slots: [[]],
  });
  slots[0].type = 'todo';
  assert.deepEqual(serialiseDashboardDraftState(slots), [
    { type: 'todo', version: 1, config: { listId: 'home' } },
  ]);
  assert.equal('items' in slots[0].drafts.todo, false);
});
