import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentHash } from '../../src/model/hash.ts';
import { dashboardData } from '../fixtures/dashboard.ts';

test('Octopus not-set-up and configured-unavailable states have different visible hashes', () => {
  const notSetUp = dashboardData();
  notSetUp.sections[2] = { type: 'octopus', data: null, health: null };

  const unavailable = structuredClone(notSetUp);
  unavailable.sections[2] = {
    type: 'octopus',
    data: null,
    health: { id: 'octopus', status: 'error', fetchedAt: null, error: 'request failed' },
  };

  assert.notEqual(contentHash(notSetUp), contentHash(unavailable));
});

test('Octopus cheapest slot and NOW state are part of the visible hash', () => {
  const first = dashboardData();
  first.sections[2] = {
    type: 'octopus',
    health: { id: 'octopus', status: 'ok', fetchedAt: '2026-08-03T07:42:00.000Z', error: null },
    data: {
      cheapest: {
        validFrom: '2026-08-03T08:00:00.000Z',
        validTo: '2026-08-03T08:30:00.000Z',
        pencePerKwh: 4.25,
      },
      isCurrent: false,
    },
  };

  const priceChanged = structuredClone(first);
  if (priceChanged.sections[2].type === 'octopus' && priceChanged.sections[2].data) {
    priceChanged.sections[2].data.cheapest.pencePerKwh = -1.5;
  }
  assert.notEqual(contentHash(first), contentHash(priceChanged));

  const currentChanged = structuredClone(first);
  if (currentChanged.sections[2].type === 'octopus' && currentChanged.sections[2].data) {
    currentChanged.sections[2].data.isCurrent = true;
  }
  assert.notEqual(contentHash(first), contentHash(currentChanged));
});
