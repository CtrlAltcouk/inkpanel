import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import type { DashboardSectionData, MiniDashboardData } from '../../src/model/dashboard.ts';
import { SSD1681_200X200 } from '../../src/panel/profile.ts';
import { loadFontCss } from '../../src/render/fonts.ts';
import { renderMiniHtml } from '../../src/render/miniTemplate.ts';
import { dashboardData } from '../fixtures/dashboard.ts';

const OK = { id: 'test', status: 'ok' as const, fetchedAt: '2026-08-21T08:00:00.000Z', error: null };

function miniData(section: DashboardSectionData): MiniDashboardData {
  const full = dashboardData();
  return { ...full, sections: [section] };
}

test('Mini Bins splits weekday/day and month into separate safe lines', () => {
  const html = renderMiniHtml(miniData({
    type: 'bins',
    health: OK,
    data: {
      next: { date: '2026-08-21', types: ['recycling'] },
      rawLabels: ['Recycling'],
    },
  }), SSD1681_200X200, '');

  assert.match(html, /class="bin-date-primary">FRI 21<\/span><span class="bin-date-month">AUG<\/span>/);
  assert.doesNotMatch(html, />FRI 21 AUG</);
  assert.match(html, /\.bin-date span\{display:block;white-space:nowrap\}/);
});

test('Mini Octopus gives the time range bounded columns and stacks the price unit', () => {
  const html = renderMiniHtml(miniData({
    type: 'octopus',
    health: OK,
    data: {
      cheapest: {
        validFrom: '2026-08-04T12:30:00.000Z',
        validTo: '2026-08-04T13:00:00.000Z',
        pencePerKwh: 20.48,
      },
      isCurrent: false,
    },
  }), SSD1681_200X200, '');

  assert.match(html, /class="octopus-time disp tnum"><span>13:30<\/span><span class="octopus-dash">&ndash;<\/span><span>14:00<\/span>/);
  assert.match(html, /grid-template-columns:minmax\(0,1fr\) auto minmax\(0,1fr\)/);
  assert.match(html, /class="octopus-day">TOMORROW/);
  assert.match(html, /<span class="disp tnum">20\.48p<\/span><span>\/kWh<\/span>/);
  assert.match(html, /\.octopus-price>span:last-child\{display:block/);
});

test('Mini Octopus preserves negative prices and selects compact sizing when needed', () => {
  const html = renderMiniHtml(miniData({
    type: 'octopus',
    health: OK,
    data: {
      cheapest: {
        validFrom: '2026-08-03T12:30:00.000Z',
        validTo: '2026-08-03T13:00:00.000Z',
        pencePerKwh: -20.48,
      },
      isCurrent: false,
    },
  }), SSD1681_200X200, '');

  assert.match(html, /class="disp tnum octopus-price-compact">-20\.48p<\/span>/);
  assert.match(html, /class="octopus-day">TODAY/);
});

test('Mini Bins and Octopus content stays inside the 200x200 canvas with embedded fonts', async () => {
  const fontCss = await loadFontCss();
  const binsHtml = renderMiniHtml(miniData({
    type: 'bins',
    health: OK,
    data: {
      next: { date: '2026-09-30', types: ['general', 'recycling', 'food', 'garden'] },
      rawLabels: ['General waste', 'Recycling', 'Food waste', 'Garden waste'],
    },
  }), SSD1681_200X200, fontCss);
  const octopusHtml = renderMiniHtml(miniData({
    type: 'octopus',
    health: OK,
    data: {
      cheapest: {
        validFrom: '2026-08-04T22:30:00.000Z',
        validTo: '2026-08-04T23:00:00.000Z',
        pencePerKwh: -123.45,
      },
      isCurrent: false,
    },
  }), SSD1681_200X200, fontCss);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 200, height: 200 } });
  try {
    for (const [name, html, selectors] of [
      ['Bins', binsHtml, ['.bin-date-primary', '.bin-date-month', '.bin-list']],
      ['Octopus', octopusHtml, ['.octopus-kicker', '.octopus-time', '.octopus-day', '.octopus-price']],
    ] as const) {
      await page.setContent(html);
      await page.evaluate(() => document.fonts.ready);
      for (const selector of selectors) {
        const box = await page.locator(selector).boundingBox();
        assert.ok(box, `${name} ${selector} is rendered`);
        assert.ok(box.x >= 0 && box.y >= 0, `${name} ${selector} starts inside the canvas`);
        assert.ok(box.x + box.width <= 200, `${name} ${selector} does not clip horizontally`);
        assert.ok(box.y + box.height <= 200, `${name} ${selector} does not clip vertically`);
      }
    }
  } finally {
    await browser.close();
  }
});
