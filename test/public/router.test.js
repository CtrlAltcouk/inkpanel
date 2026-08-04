import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRouteName } from '../../public/router.js';

const ROUTES = { panels: () => {}, settings: () => {} };

test('resolves a known hash to its route name', () => {
  assert.equal(resolveRouteName('#panels', ROUTES, 'panels'), 'panels');
  assert.equal(resolveRouteName('#settings', ROUTES, 'panels'), 'settings');
});

test('an empty hash resolves to the fallback', () => {
  assert.equal(resolveRouteName('', ROUTES, 'panels'), 'panels');
  assert.equal(resolveRouteName('#', ROUTES, 'panels'), 'panels');
});

test('an unrecognised hash resolves to the fallback, not itself', () => {
  // This is the bug from the review: highlighting must key off the
  // *resolved* name, or an unknown hash like "#foo" renders the fallback
  // view while leaving every tab unhighlighted.
  assert.equal(resolveRouteName('#foo', ROUTES, 'panels'), 'panels');
});
