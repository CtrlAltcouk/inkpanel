import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WFT0583 } from '../../src/panel/profile.ts';
import { renderHtml } from '../../src/render/template.ts';
import type { DashboardData } from '../../src/model/dashboard.ts';

const ok = (id: string) => ({ id, status: 'ok' as const, fetchedAt: '2026-08-10T19:00:00.000Z', error: null });

function data(): DashboardData {
  return {
    generatedAt: '2026-08-10T19:00:00.000Z',
    contentChangedAt: '2026-08-10T19:00:00.000Z',
    timezone: 'Europe/London',
    today: { iso: '2026-08-10', weekdayLong: 'Monday', dayOfMonth: 10, monthLong: 'August' },
    headerWeather: null,
    headerWeatherHealth: { id: 'weather', status: 'error', fetchedAt: null, error: 'test' },
    sections: [
      {
        type: 'bus',
        health: ok('bus'),
        data: {
          stopCode: '049000000001',
          stopName: 'Central Station',
          departures: [
            { line: '6', destination: 'Lakes Estate', scheduled: '20:24', expected: '20:28', status: 'live' },
          ],
        },
      },
      {
        type: 'traffic',
        health: ok('traffic'),
        data: {
          origin: 'MK9 1EA', destination: 'London Euston',
          durationText: '36 mins', staticDurationText: '24 mins',
          description: 'A5 and M1', warning: null,
        },
      },
      { type: 'empty' },
      { type: 'empty' },
    ],
    battery: { volts: null, percent: null },
  };
}

test('Bus and Traffic cells render independent content and provider attribution', () => {
  const html = renderHtml(data(), WFT0583, '');
  assert.match(html, /Bus &middot; Central Station/);
  assert.match(html, />6</);
  assert.match(html, />20:28</);
  assert.match(html, /Lakes Estate/);
  assert.match(html, /source: http:\/\/transportapi\.com\//);
  assert.match(html, /36 mins/);
  assert.match(html, /Traffic-aware/);
  assert.match(html, /Without traffic: 24 mins/);
  assert.doesNotMatch(html, /\+12 min traffic/);
  assert.match(html, /A5 and M1/);
  assert.match(html, /translate="no">Google Maps/);
});

test('Traffic warns rather than silently dropping a provider warning', () => {
  const value = data();
  const traffic = value.sections[1];
  if (traffic.type !== 'traffic' || !traffic.data) throw new Error('fixture');
  traffic.data.warning = 'Private road restrictions may apply';
  const html = renderHtml(value, WFT0583, '');
  assert.match(html, /Private road restrictions may apply/);
});
