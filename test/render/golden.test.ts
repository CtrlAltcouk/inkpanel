import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Renderer } from '../../src/render/browser.ts';
import { renderHtml } from '../../src/render/template.ts';
import { loadFontCss } from '../../src/render/fonts.ts';
import { quantisePng, bufferToPng } from '../../src/panel/quantise.ts';
import { WFT0583 } from '../../src/panel/profile.ts';
import type { DashboardData } from '../../src/model/dashboard.ts';

const here = dirname(fileURLToPath(import.meta.url));
const goldenDir = join(here, '..', 'fixtures', 'golden');
const renderer = new Renderer();
after(() => renderer.close());

const FIXTURE: DashboardData = {
  generatedAt: '2026-08-03T07:42:00.000Z',
  contentChangedAt: '2026-08-03T07:42:00.000Z',
  timezone: 'Europe/London',
  today: { iso: '2026-08-03', weekdayLong: 'Monday', dayOfMonth: 3, monthLong: 'August' },
  calendar: {
    today: [
      { uid: '1', title: 'Team standup', start: '2026-08-03T08:30:00.000Z', end: '2026-08-03T08:45:00.000Z', allDay: false },
      { uid: '2', title: 'Lunch — The Swan', start: '2026-08-03T12:00:00.000Z', end: '2026-08-03T13:00:00.000Z', allDay: false },
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
};

test('dashboard layout matches the golden buffer', async (t) => {
  const html = renderHtml(FIXTURE, WFT0583, await loadFontCss());
  const actual = await quantisePng(await renderer.screenshot(html, WFT0583), WFT0583);
  const goldenPath = join(goldenDir, 'dashboard.bin');

  if (process.env.UPDATE_GOLDENS === '1') {
    await mkdir(goldenDir, { recursive: true });
    await writeFile(goldenPath, actual);
    await writeFile(join(goldenDir, 'dashboard.png'), await bufferToPng(actual, WFT0583));
    return;
  }

  let expected: Buffer;
  try {
    expected = await readFile(goldenPath);
  } catch {
    // Skip rather than fail. A golden is only meaningful when generated in the
    // same environment that renders in production — font rasterisation differs
    // between platforms — so an absent one means "not yet established here",
    // not "broken". See test/fixtures/golden/README.md.
    t.skip('no golden committed for this environment; run UPDATE_GOLDENS=1 npm test');
    return;
  }

  if (!actual.equals(expected)) {
    // Write the actual output so the difference can be eyeballed.
    await writeFile(join(goldenDir, 'actual.png'), await bufferToPng(actual, WFT0583));
    const differing = actual.reduce((n, byte, i) => (byte === expected[i] ? n : n + 1), 0);
    assert.fail(
      `${differing} of ${actual.length} bytes differ. ` +
        `Compare fixtures/golden/dashboard.png with actual.png. ` +
        `If the change is intended, re-run with UPDATE_GOLDENS=1.`,
    );
  }
});
