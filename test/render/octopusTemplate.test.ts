import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WFT0583 } from '../../src/panel/profile.ts';
import { renderHtml } from '../../src/render/template.ts';
import { dashboardData } from '../fixtures/dashboard.ts';

const OK = { id: 'octopus', status: 'ok' as const, fetchedAt: '2026-08-03T07:42:00.000Z', error: null };

test('Octopus cell makes the cheapest time primary and preserves negative prices', () => {
  const data = dashboardData();
  data.sections[2] = {
    type: 'octopus',
    health: OK,
    data: {
      cheapest: {
        validFrom: '2026-08-04T00:00:00.000Z',
        validTo: '2026-08-04T00:30:00.000Z',
        pencePerKwh: -1.092,
      },
      isCurrent: false,
    },
  };

  const html = renderHtml(data, WFT0583, '');
  assert.match(html, /Octopus Agile/);
  assert.match(html, /CHEAPEST UPCOMING/);
  assert.match(html, /01:00&ndash;01:30/);
  assert.match(html, /TOMORROW/);
  assert.match(html, /-1\.09p/);
  assert.match(html, /\/kWh/);
});

test('Octopus current cheapest slot is labelled NOW', () => {
  const data = dashboardData();
  data.sections[2] = {
    type: 'octopus',
    health: OK,
    data: {
      cheapest: {
        validFrom: '2026-08-03T07:30:00.000Z',
        validTo: '2026-08-03T08:00:00.000Z',
        pencePerKwh: 4.25,
      },
      isCurrent: true,
    },
  };
  assert.match(renderHtml(data, WFT0583, ''), />NOW</);
});

test('Octopus distinguishes not set up from configured but unavailable', () => {
  const notSetUp = dashboardData();
  notSetUp.sections[2] = { type: 'octopus', data: null, health: null };
  assert.match(renderHtml(notSetUp, WFT0583, ''), /Octopus — not set up/);

  const unavailable = dashboardData();
  unavailable.sections[2] = {
    type: 'octopus',
    data: null,
    health: { id: 'octopus', status: 'error', fetchedAt: null, error: 'upstream failed' },
  };
  assert.match(renderHtml(unavailable, WFT0583, ''), /Octopus unavailable/);
});
