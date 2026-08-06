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
  bins: null,
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
  // Was: the bottom-right "Bins & tasks — coming soon" placeholder, which
  // this task's bins render replaces. An event title now supplies the "&"
  // instead, exercising the same esc() path.
  const withAmpersand = structuredClone(data);
  withAmpersand.calendar!.today[0]!.title = 'Tea & Toast';
  const html = renderHtml(withAmpersand, WFT0583, '');
  assert.match(html, /Tea &amp; Toast/, 'ampersand is escaped for HTML');
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
  assert.match(html, /MKC/, 'the route is the heading, using the short CRS code for the origin');
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

test('a cancelled service with a platform still shows no platform', () => {
  // buildDepartures deliberately passes the raw platform through for
  // cancelled services; the render layer is where the omission belongs.
  // The mixedBoard fixture's cancelled entry already has platform: null,
  // which would let this guard be deleted without any test noticing.
  const withTrains = structuredClone(data);
  withTrains.train = {
    ...structuredClone(mixedBoard),
    departures: [
      { scheduled: '08:19', expected: null, status: 'cancelled', delayMinutes: null, platform: '2' },
    ],
  };
  withTrains.sourceHealth = [{ id: 'train', status: 'ok', fetchedAt: '2026-08-04T07:40:00.000Z', error: null }];

  const html = renderHtml(withTrains, WFT0583, '');
  assert.match(html, /Cancelled/);
  assert.doesNotMatch(html, /Plat/, 'a platform must never be printed for a cancelled service');
});

test('a delay of unknown length shows "Delayed" with no minute count', () => {
  const withTrains = structuredClone(data);
  withTrains.train = {
    ...structuredClone(mixedBoard),
    departures: [
      { scheduled: '08:19', expected: null, status: 'delayed', delayMinutes: null, platform: '2' },
    ],
  };
  withTrains.sourceHealth = [{ id: 'train', status: 'ok', fetchedAt: '2026-08-04T07:40:00.000Z', error: null }];

  const html = renderHtml(withTrains, WFT0583, '');
  assert.match(html, /Delayed/);
  // \b avoids a false match inside the embedded stylesheet's "grid-template".
  assert.doesNotMatch(html, /\blate\b/, 'no minute count when the length is unknown');
  assert.doesNotMatch(html, /null/, 'must never leak the literal null');
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

test('renders the next bin collection with its types', () => {
  const withBins = structuredClone(data);
  withBins.bins = {
    // Real Milton Keynes wording (test/fixtures/bins.ts), not invented copy.
    next: { date: '2026-08-06', types: ['recycling', 'food'] },
    rawLabels: ['Collect Recycling Red', 'Collect Food and Garden'],
  };
  withBins.sourceHealth = [{ id: 'bins', status: 'ok', fetchedAt: '2026-08-04T07:00:00.000Z', error: null }];

  const html = renderHtml(withBins, WFT0583, '');
  // 2026-08-06 is a Thursday, not the Wednesday the brief's draft assumed.
  assert.match(html, /THU 6 AUG/i, 'the date is the headline');
  assert.match(html, /Collect Recycling Red/, 'the council wording is shown, not our normalised type');
  assert.match(html, /Collect Food and Garden/);
  // Match the swatch markup itself, not merely the class name — the
  // stylesheet defines .bin--recycling and .bin--food unconditionally on
  // every render, so a bare /bin--recycling/ would pass even if every row
  // used the same swatch.
  assert.match(html, /class="bin-swatch bin--recycling"/, 'each type gets its own swatch class');
  assert.match(html, /class="bin-swatch bin--food"/);
});

test('bins with no upcoming collection says so rather than looking broken', () => {
  const quiet = structuredClone(data);
  quiet.bins = { next: null, rawLabels: [] };
  quiet.sourceHealth = [{ id: 'bins', status: 'ok', fetchedAt: '2026-08-04T07:00:00.000Z', error: null }];

  const html = renderHtml(quiet, WFT0583, '');
  assert.match(html, /No collection scheduled/);
  assert.doesNotMatch(html, /Bins unavailable/, 'a successful fetch is not a failure');
});

test('bins unavailable is distinct from bins not set up', () => {
  const failed = structuredClone(data);
  failed.bins = null;
  failed.sourceHealth = [{ id: 'bins', status: 'error', fetchedAt: null, error: 'lookup responded 500' }];
  assert.match(renderHtml(failed, WFT0583, ''), /Bins unavailable/);

  const unset = structuredClone(data);
  unset.bins = null;
  unset.sourceHealth = [];
  assert.match(renderHtml(unset, WFT0583, ''), /Bins &mdash; not set up|Bins — not set up/);
});

test('a stale bin collection is shown with its age, not hidden', () => {
  const stale = structuredClone(data);
  stale.bins = { next: { date: '2026-08-06', types: ['general'] }, rawLabels: ['Collect Refuse'] };
  stale.sourceHealth = [{ id: 'bins', status: 'stale', fetchedAt: '2026-08-04T03:10:00.000Z', error: 'timeout' }];

  const html = renderHtml(stale, WFT0583, '');
  assert.match(html, /Collect Refuse/, 'stale data is still useful');
  assert.match(html, /04:10/, 'but its age is shown');
});

test('an unrecognised bin label still renders', () => {
  const odd = structuredClone(data);
  odd.bins = { next: { date: '2026-08-06', types: ['general'] }, rawLabels: ['Some New Scheme 2027'] };
  odd.sourceHealth = [{ id: 'bins', status: 'ok', fetchedAt: '2026-08-04T07:00:00.000Z', error: null }];
  assert.match(renderHtml(odd, WFT0583, ''), /Some New Scheme 2027/);
});

test('escapes bin labels to prevent injection', () => {
  const hostile = structuredClone(data);
  hostile.bins = { next: { date: '2026-08-06', types: ['general'] }, rawLabels: ['<script>alert(1)</script>'] };
  hostile.sourceHealth = [{ id: 'bins', status: 'ok', fetchedAt: '2026-08-04T07:00:00.000Z', error: null }];
  const html = renderHtml(hostile, WFT0583, '');
  assert.ok(!html.includes('<script>alert(1)</script>'), 'must not inject raw markup');
  assert.match(html, /&lt;script&gt;/, 'hostile label must be escaped');
});

test('pairs labels with types when their counts differ, falling back to first type', () => {
  const mismatch = structuredClone(data);
  mismatch.bins = {
    next: { date: '2026-08-06', types: ['recycling'] },
    rawLabels: ['Collect Recycling Red', 'Collect Recycling Blue'],
  };
  mismatch.sourceHealth = [{ id: 'bins', status: 'ok', fetchedAt: '2026-08-04T07:00:00.000Z', error: null }];
  const html = renderHtml(mismatch, WFT0583, '');
  // Count occurrences of the full swatch markup to verify both rows have the swatch.
  // Matching the class in the markup prevents false passes from the stylesheet.
  const swatchMatches = (html.match(/class="bin-swatch bin--recycling"/g) ?? []).length;
  assert.equal(swatchMatches, 2, 'both labels must be paired with the single type');
  assert.match(html, /Collect Recycling Red/);
  assert.match(html, /Collect Recycling Blue/);
});
