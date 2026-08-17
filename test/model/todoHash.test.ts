import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentHash } from '../../src/model/hash.ts';
import { dashboardData } from '../fixtures/dashboard.ts';

function todoData(items: string[]) {
  const data = dashboardData();
  data.sections[0] = { type: 'todo', data: { items }, configured: true, health: null };
  return data;
}

test('To Do visible task edits and ordering participate in the content hash', () => {
  const base = todoData(['Put bins out', 'Buy milk']);
  assert.equal(contentHash(base), contentHash(structuredClone(base)), 'unchanged visible tasks keep the ETag input stable');
  assert.notEqual(contentHash(base), contentHash(todoData(['Put both bins out', 'Buy milk'])));
  assert.notEqual(contentHash(base), contentHash(todoData(['Buy milk', 'Put bins out'])));
  assert.notEqual(contentHash(base), contentHash(todoData(['Buy milk'])), 'completing a task removes it from visible state');
});

test('off-screen To Do tasks do not participate in the content hash', () => {
  const visible = ['One', 'Two', 'Three', 'Four', 'Five'];
  assert.equal(
    contentHash(todoData([...visible, 'Hidden sixth'])),
    contentHash(todoData([...visible, 'Changed hidden sixth', 'Hidden seventh'])),
  );
});

test('a valid empty To Do list differs from an unconfigured widget', () => {
  const empty = todoData([]);
  const notConfigured = dashboardData();
  notConfigured.sections[0] = { type: 'todo', data: null, configured: false, health: null };
  assert.notEqual(contentHash(empty), contentHash(notConfigured));
});
