import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderHtml } from '../../src/render/template.ts';
import { panelCss } from '../../src/render/panel.css.ts';
import { loadFontCss } from '../../src/render/fonts.ts';
import { WFT0583 } from '../../src/panel/profile.ts';
import type { DashboardData } from '../../src/model/dashboard.ts';
import { mixedBoard } from '../fixtures/train.ts';

const data: DashboardData = {
  generatedAt: '2026-08-03T07:42:00.000Z',
  contentChangedAt: '2026-08-03T07:42:00.000Z',
  timezone: 'Europe/London',
  today: { iso: '2026-08-03', weekdayLong: 'Monday', dayOfMonth: 3, monthLong: 'August' },
  calendar: {
    today: [
      { uid: '1', title: 'Team standup', start: '2026-08-03T08:30:00.000Z', end: '2026-08-03T08:45:00.000Z', allDay: false },
    ],
    tomorrow: [],
  },
  weather: {
    currentTempC: 22, conditionText: 'Partly cloudy', highC: 24, lowC: 13,
    precipProbability: 10, windKph: 13, windDirection: 'NW',
    sunrise: '2026-08-03T05:34', sunset: '2026-08-03T20:47',
    forecast: [
      { weekday: 'TUE', highC: 24, lowC: 14, conditionText: 'Sunny' },
      { weekday: 'WED', highC: 19, lowC: 13, conditionText: 'Rain' },
      { weekday: 'THU', highC: 21, lowC: 12, conditionText: 'Overcast' },
    ],
  },
  sourceHealth: [
    { id: 'ical', status: 'ok', fetchedAt: '2026-08-03T07:42:00.000Z', error: null },
    { id: 'weather', status: 'ok', fetchedAt: '2026-08-03T07:42:00.000Z', error: null },
  ],
  battery: { volts: 4.02, percent: 87 },
  train: null,
};

test('renders the event and the temperature', () => {
  const html = renderHtml(data, WFT0583, '');
  assert.match(html, /Team standup/);
  assert.match(html, /22/);
  assert.match(html, /MON 3/i);
  assert.match(html, /AUGUST/i);
});

test('renders event times in the device timezone', () => {
  const html = renderHtml(data, WFT0583, '');
  // 08:30 UTC is 09:30 in London during BST.
  assert.match(html, /09:30/, 'times must be local to the panel, not UTC');
});

test('escapes event titles', () => {
  const hostile = structuredClone(data);
  hostile.calendar!.today[0]!.title = '<script>alert(1)</script>';
  const html = renderHtml(hostile, WFT0583, '');
  assert.ok(!html.includes('<script>alert(1)</script>'), 'must not inject raw markup');
  assert.match(html, /&lt;script&gt;/);
});

test('renders an unavailable state when a source has no data', () => {
  const broken = structuredClone(data);
  broken.weather = null;
  broken.sourceHealth = [{ id: 'weather', status: 'error', fetchedAt: null, error: 'timeout' }];
  const html = renderHtml(broken, WFT0583, '');
  assert.match(html, /slot--empty/, 'the weather card falls back to the empty state');
  assert.doesNotMatch(html, /NaN|undefined/, 'no leaked placeholder values');
});

test('renders an empty agenda as a designed state, not a blank box', () => {
  const quiet = structuredClone(data);
  quiet.calendar = { today: [], tomorrow: [] };
  const html = renderHtml(quiet, WFT0583, '');
  assert.match(html, /Nothing scheduled/);
});

test('falls back to tomorrow when today is free', () => {
  const quiet = structuredClone(data);
  quiet.calendar = {
    today: [],
    tomorrow: [
      { uid: 't1', title: 'Train to Euston', start: '2026-08-04T07:15:00.000Z', end: '2026-08-04T08:15:00.000Z', allDay: false },
    ],
  };
  const html = renderHtml(quiet, WFT0583, '');
  assert.match(html, /Nothing today/, 'says so explicitly');
  assert.match(html, /Train to Euston/, 'and shows what is coming');
  // Not "Nothing scheduled" — that is the genuinely-empty state, and it must
  // not appear when there is something to show. Matching on slot--empty would
  // be useless here: it is a class name in the embedded stylesheet too.
  assert.doesNotMatch(html, /Nothing scheduled/, 'not the fully-empty state');
});

test('shows a stale marker but keeps the data', () => {
  const stale = structuredClone(data);
  stale.sourceHealth = [{ id: 'weather', status: 'stale', fetchedAt: '2026-08-03T03:10:00.000Z', error: 'timeout' }];
  const html = renderHtml(stale, WFT0583, '');
  assert.match(html, /Partly cloudy/, 'stale data is still shown');
  assert.match(html, /04:10/, 'with its age, in local time');
});

test('handles an unknown battery without printing null', () => {
  const noBattery = structuredClone(data);
  noBattery.battery = { volts: null, percent: null };
  const html = renderHtml(noBattery, WFT0583, '');
  assert.match(html, /Battery --/);
  assert.doesNotMatch(html, /null/);
});

test('the stylesheet contains no greys', () => {
  const css = panelCss(WFT0583);
  assert.doesNotMatch(css, /rgba?\(/i, 'no rgb/rgba colours');
  assert.doesNotMatch(css, /opacity\s*:/i, 'no opacity');
  const hexes = css.match(/#[0-9a-f]{3,8}\b/gi) ?? [];
  const allowed = new Set(['#000', '#fff', '#000000', '#ffffff']);
  for (const hex of hexes) {
    assert.ok(allowed.has(hex.toLowerCase()), `${hex} is not pure black or white`);
  }
});

test('escapes captions exactly once', () => {
  const html = renderHtml(data, WFT0583, '');
  assert.match(html, /Bins &amp; tasks/, 'ampersand is escaped for HTML');
  assert.doesNotMatch(html, /&amp;amp;/, 'but not double-escaped, which renders literally');
});

test('the page is locked to the profile size', () => {
  const css = panelCss(WFT0583);
  assert.match(css, /width:\s*800px/);
  assert.match(css, /height:\s*480px/);
});

test('loads all four faces as embedded woff2, not latin-ext', async () => {
  const css = await loadFontCss();
  assert.equal((css.match(/@font-face/g) ?? []).length, 4);
  assert.equal((css.match(/data:font\/woff2;base64,/g) ?? []).length, 4);
  assert.match(css, /font-family:"Dela Gothic One"/);
  assert.match(css, /font-family:"Inter"/);
  assert.doesNotMatch(css, /url\(\.|https?:/, 'no external or relative references may survive');
});

test('renders departures with times, statuses and platforms', () => {
  const withTrains = structuredClone(data);
  withTrains.train = structuredClone(mixedBoard);
  withTrains.sourceHealth = [{ id: 'train', status: 'ok', fetchedAt: '2026-08-04T07:40:00.000Z', error: null }];

  const html = renderHtml(withTrains, WFT0583, '');
  assert.match(html, /MILTON KEYNES CENTRAL|Milton Keynes Central/i, 'the route is the heading');
  assert.match(html, /London Euston/i);
  assert.match(html, /07:42/);
  assert.match(html, /On time/);
  assert.match(html, /Plat 3/);
});

test('a delayed service shows the new time large and the old struck through', () => {
  const withTrains = structuredClone(data);
  withTrains.train = structuredClone(mixedBoard);
  withTrains.sourceHealth = [{ id: 'train', status: 'ok', fetchedAt: '2026-08-04T07:40:00.000Z', error: null }];

  const html = renderHtml(withTrains, WFT0583, '');
  // The panel has no colour, so the strike-through is the whole signal.
  assert.match(html, /dep-time[^>]*>08:01/, 'the time you must act on is the big one');
  assert.match(html, /dep-was[^>]*>07:58/, 'the original is struck through beside it');
  assert.match(html, /9 late/);
});

test('a cancelled service says so and shows no platform', () => {
  const withTrains = structuredClone(data);
  withTrains.train = structuredClone(mixedBoard);
  withTrains.sourceHealth = [{ id: 'train', status: 'ok', fetchedAt: '2026-08-04T07:40:00.000Z', error: null }];

  const html = renderHtml(withTrains, WFT0583, '');
  assert.match(html, /Cancelled/);
  // A platform for a train that is not running would send someone to it.
  assert.doesNotMatch(html, /Plat\s*&mdash;|Plat\s*—/);
});

test('no departures is different from trains unavailable', () => {
  const quiet = structuredClone(data);
  quiet.train = { ...structuredClone(mixedBoard), departures: [] };
  quiet.sourceHealth = [{ id: 'train', status: 'ok', fetchedAt: '2026-08-04T23:40:00.000Z', error: null }];
  const html = renderHtml(quiet, WFT0583, '');
  assert.match(html, /No departures/);
  assert.doesNotMatch(html, /Trains unavailable/);
});

test('trains unavailable is distinct from trains not set up', () => {
  const failed = structuredClone(data);
  failed.train = null;
  failed.sourceHealth = [{ id: 'train', status: 'error', fetchedAt: null, error: 'timeout' }];
  assert.match(renderHtml(failed, WFT0583, ''), /Trains unavailable/);

  const unset = structuredClone(data);
  unset.train = null;
  unset.sourceHealth = [];
  assert.match(renderHtml(unset, WFT0583, ''), /Trains &mdash; not set up|Trains — not set up/);
});

test('a single departure renders — late at night that is the whole board', () => {
  const late = structuredClone(data);
  late.train = {
    ...structuredClone(mixedBoard),
    departures: [{ scheduled: '23:47', expected: null, status: 'on-time', delayMinutes: 0, platform: '1' }],
  };
  late.sourceHealth = [{ id: 'train', status: 'ok', fetchedAt: '2026-08-04T23:00:00.000Z', error: null }];
  assert.match(renderHtml(late, WFT0583, ''), /23:47/);
});
