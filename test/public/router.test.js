import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fallbackRouteForUpdateMode,
  removeManagedUpdateNavigation,
  resolveRouteName,
  routesForUpdateMode,
} from '../../public/router.js';

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

test('Home Assistant removes Updates navigation and the updater route', () => {
  let removed = false;
  const root = { querySelector: () => ({ remove: () => { removed = true; } }) };
  const routes = { ...ROUTES, updates: () => 'standalone updater' };
  const available = routesForUpdateMode(routes, 'home-assistant');
  removeManagedUpdateNavigation(root, 'home-assistant');

  assert.equal(removed, true);
  assert.equal('updates' in available, false);
  const fallback = fallbackRouteForUpdateMode('#updates', 'home-assistant');
  assert.equal(fallback, 'settings');
  assert.equal(resolveRouteName('#updates', available, fallback), 'settings');
});

test('standalone keeps Updates navigation and routing unchanged', () => {
  let removed = false;
  const root = { querySelector: () => ({ remove: () => { removed = true; } }) };
  const routes = { ...ROUTES, updates: () => 'standalone updater' };
  const available = routesForUpdateMode(routes, 'self');
  removeManagedUpdateNavigation(root, 'self');

  assert.equal(removed, false);
  assert.equal(available, routes);
  assert.equal(resolveRouteName('#updates', available, 'panels'), 'updates');
});
