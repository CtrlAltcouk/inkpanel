import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderHtml } from '../../src/render/template.ts';
import { panelCss } from '../../src/render/panel.css.ts';
import { loadFontCss } from '../../src/render/fonts.ts';
import { WFT0583 } from '../../src/panel/profile.ts';
import { mixedBoard } from '../fixtures/train.ts';
import { dashboardData, OK_CALENDAR, OK_WEATHER, WEATHER } from '../fixtures/dashboard.ts';

test('renders header weather and the four configured sections in order', () => {
  const data = dashboardData({ sections: [
    { type: 'bins', data: { next: { date: '2026-08-06', types: ['recycling'] }, rawLabels: ['Collect Recycling Red'] }, health: { id: 'bins', status: 'ok', fetchedAt: null, error: null } },
    { type: 'calendar', data: { today: [], tomorrow: [] }, health: OK_CALENDAR },
    { type: 'trains', data: mixedBoard, health: { id: 'train', status: 'ok', fetchedAt: null, error: null } },
    { type: 'weather', data: WEATHER, health: OK_WEATHER },
  ] });
  const html = renderHtml(data, WFT0583, '');
  assert.ok(html.indexOf('Collect Recycling Red') < html.indexOf('Nothing scheduled'));
  assert.ok(html.indexOf('Nothing scheduled') < html.indexOf('London Euston'));
  assert.match(html, /Partly cloudy/);
});

test('duplicates render independently and empty renders a genuinely blank cell', () => {
  const html = renderHtml(dashboardData({ sections: [
    { type: 'calendar', data: { today: [], tomorrow: [] }, health: OK_CALENDAR },
    { type: 'empty' },
    { type: 'calendar', data: null, health: { id: 'ical', status: 'error', fetchedAt: null, error: 'failed' } },
    { type: 'empty' },
  ] }), WFT0583, '');
  assert.match(html, /Nothing scheduled/);
  assert.match(html, /Calendar unavailable/);
  assert.equal((html.match(/<div class="cell cell--(?:tr|br)"><\/div>/g) ?? []).length, 2);
});

test('Calendar renders bottom-right and duplicate calendars keep separate data', () => {
  const html = renderHtml(dashboardData({ sections: [
    { type: 'calendar', data: { today: [{ uid: 'a', title: 'Work only', start: '2026-08-03T08:00:00.000Z', end: '2026-08-03T09:00:00.000Z', allDay: false }], tomorrow: [] }, health: OK_CALENDAR },
    { type: 'empty' },
    { type: 'empty' },
    { type: 'calendar', data: { today: [{ uid: 'b', title: 'Personal only', start: '2026-08-03T18:00:00.000Z', end: '2026-08-03T19:00:00.000Z', allDay: false }], tomorrow: [] }, health: { ...OK_CALENDAR } },
  ] }), WFT0583, '');
  assert.match(html, /cell--tl[^]*Work only/);
  assert.match(html, /cell--br[^]*Personal only/);
  assert.equal((html.match(/Work only/g) ?? []).length, 1);
  assert.equal((html.match(/Personal only/g) ?? []).length, 1);
});

test('duplicate Trains widgets keep independent route and departure data', () => {
  const otherBoard = { ...structuredClone(mixedBoard), originCrs: 'EUS', destinationName: 'Birmingham New Street', departures: [{ scheduled: '10:15', expected: null, status: 'on-time' as const, delayMinutes: 0, platform: '4' }] };
  const html = renderHtml(dashboardData({ sections: [
    { type: 'trains', data: mixedBoard, health: { id: 'train', status: 'ok', fetchedAt: null, error: null } },
    { type: 'trains', data: otherBoard, health: { id: 'train', status: 'ok', fetchedAt: null, error: null } },
    { type: 'empty' }, { type: 'empty' },
  ] }), WFT0583, '');
  assert.match(html, /London Euston/);
  assert.match(html, /Birmingham New Street/);
  assert.match(html, /10:15/);
});

test('empty, unavailable, quiet, and stale section semantics remain distinct', () => {
  const html = renderHtml(dashboardData({ sections: [
    { type: 'calendar', data: { today: [], tomorrow: [] }, health: OK_CALENDAR },
    { type: 'weather', data: null, health: { id: 'weather', status: 'error', fetchedAt: null, error: 'timeout' } },
    { type: 'bins', data: { next: null, rawLabels: [] }, health: { id: 'bins', status: 'ok', fetchedAt: null, error: null } },
    { type: 'bins', data: { next: { date: '2026-08-06', types: ['general'] }, rawLabels: ['Collect Refuse'] }, health: { id: 'bins', status: 'stale', fetchedAt: '2026-08-03T03:10:00.000Z', error: 'timeout' } },
  ] }), WFT0583, '');
  assert.match(html, /Nothing scheduled/);
  assert.match(html, /Weather unavailable/);
  assert.match(html, /No collection scheduled/);
  assert.match(html, /Collect Refuse/);
  assert.match(html, /04:10/);
});

test('calendar keeps local-time, tomorrow fallback, all-day, and quiet-day behaviour', () => {
  const tomorrow = dashboardData({ sections: [
    { type: 'calendar', data: { today: [], tomorrow: [{ uid: 't', title: 'Train tomorrow', start: '2026-08-04T07:15:00.000Z', end: '2026-08-04T08:00:00.000Z', allDay: false }] }, health: OK_CALENDAR },
    { type: 'calendar', data: { today: [{ uid: 'a', title: 'Bank holiday', start: '2026-08-03T00:00:00.000Z', end: '2026-08-04T00:00:00.000Z', allDay: true }], tomorrow: [] }, health: OK_CALENDAR },
    { type: 'empty' }, { type: 'empty' },
  ] });
  const html = renderHtml(tomorrow, WFT0583, '');
  assert.match(html, /Nothing today/);
  assert.match(html, /08:15/, '07:15 UTC is 08:15 BST');
  assert.match(html, /ALL DAY/);
  assert.doesNotMatch(html, /Nothing scheduled/);
});

test('train departure status, delay, cancellation, platform, and empty states remain intact', () => {
  const board = structuredClone(mixedBoard);
  board.departures[2]!.platform = '2';
  const html = renderHtml(dashboardData({ sections: [
    { type: 'trains', data: board, health: { id: 'train', status: 'ok', fetchedAt: null, error: null } },
    { type: 'trains', data: { ...board, departures: [] }, health: { id: 'train', status: 'ok', fetchedAt: null, error: null } },
    { type: 'trains', data: null, health: { id: 'train', status: 'error', fetchedAt: null, error: 'timeout' } },
    { type: 'trains', data: null, health: null },
  ] }), WFT0583, '');
  assert.match(html, /On time/);
  assert.match(html, /dep-time[^>]*>08:01/);
  assert.match(html, /dep-was[^>]*>07:58/);
  assert.match(html, /9 late/);
  assert.match(html, /Cancelled/);
  assert.doesNotMatch(html, /Plat 2/, 'cancelled services never show a platform');
  assert.match(html, /No departures/);
  assert.match(html, /Trains unavailable/);
  assert.match(html, /Trains — not set up/);
});

test('unknown-length delays never leak null or invent a minute count', () => {
  const board = { ...structuredClone(mixedBoard), departures: [{ scheduled: '08:19', expected: null, status: 'delayed' as const, delayMinutes: null, platform: '2' }] };
  const html = renderHtml(dashboardData({ sections: [
    { type: 'trains', data: board, health: { id: 'train', status: 'ok', fetchedAt: null, error: null } },
    { type: 'empty' }, { type: 'empty' }, { type: 'empty' },
  ] }), WFT0583, '');
  assert.match(html, /Delayed/);
  assert.doesNotMatch(html, /\blate\b/);
  assert.doesNotMatch(html, />null</);
});

test('bins preserve labels, monochrome type patterns, fallback pairing, escaping, and setup states', () => {
  const html = renderHtml(dashboardData({ sections: [
    { type: 'bins', data: { next: { date: '2026-08-06', types: ['recycling'] }, rawLabels: ['Collect Recycling Red', 'Collect Recycling Blue'] }, health: { id: 'bins', status: 'ok', fetchedAt: null, error: null } },
    { type: 'bins', data: { next: { date: '2026-08-06', types: ['general'] }, rawLabels: ['<script>alert(1)</script>'] }, health: { id: 'bins', status: 'ok', fetchedAt: null, error: null } },
    { type: 'bins', data: null, health: { id: 'bins', status: 'error', fetchedAt: null, error: 'failed' } },
    { type: 'bins', data: null, health: null },
  ] }), WFT0583, '');
  assert.match(html, /THU 6 AUG/);
  assert.equal((html.match(/class="bin-swatch bin--recycling"/g) ?? []).length, 2);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /Bins unavailable/);
  assert.match(html, /Bins — not set up/);
});

test('fixed header keeps date, current weather, battery, and unknown-battery semantics', () => {
  const html = renderHtml(dashboardData(), WFT0583, '');
  assert.match(html, /MON 3/);
  assert.match(html, /AUGUST/);
  assert.match(html, /Battery 87%/);
  assert.match(html, /22&deg;/);
  assert.doesNotMatch(html, /class="footer"|Updated\s+\d{2}:\d{2}/);
  assert.match(renderHtml(dashboardData({ battery: { volts: null, percent: null } }), WFT0583, ''), /Battery --/);
});

test('section borders depend only on position', () => {
  const html = renderHtml(dashboardData(), WFT0583, '');
  for (const position of ['tl', 'tr', 'bl', 'br']) assert.match(html, new RegExp(`cell--${position}`));
  const css = panelCss(WFT0583);
  assert.match(css, /\.cell--tl\{border-right:2px solid #000;border-bottom:2px solid #000/);
  assert.match(css, /\.cell--tr\{border-bottom:2px solid #000/);
  assert.match(css, /\.cell--bl\{border-right:2px solid #000/);
});

test('escapes source content and preserves stale state', () => {
  const data = dashboardData();
  if (data.sections[0].type === 'calendar') {
    data.sections[0].data!.today[0]!.title = '<script>alert(1)</script>';
    data.sections[0].health = { id: 'ical', status: 'stale', fetchedAt: '2026-08-03T03:10:00.000Z', error: 'timeout' };
  }
  const html = renderHtml(data, WFT0583, '');
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /04:10/);
});

test('page remains exactly 800x480 pure black and white', () => {
  const css = panelCss(WFT0583);
  assert.match(css, /width:800px;height:480px/);
  assert.equal(132 + 3 + 345, 480);
  assert.doesNotMatch(css, /rgba?\(|opacity\s*:/i);
  const allowed = new Set(['#000', '#fff', '#000000', '#ffffff']);
  for (const hex of css.match(/#[0-9a-f]{3,8}\b/gi) ?? []) {
    assert.ok(allowed.has(hex.toLowerCase()), `${hex} is not pure black or white`);
  }
});

test('loads all embedded font faces', async () => {
  const css = await loadFontCss();
  assert.equal((css.match(/@font-face/g) ?? []).length, 4);
  assert.equal((css.match(/data:font\/woff2;base64,/g) ?? []).length, 4);
  assert.match(css, /font-family:"Dela Gothic One"/);
  assert.match(css, /font-family:"Inter"/);
  assert.doesNotMatch(css, /url\(\.|https?:/, 'rendering cannot depend on external font references');
});
