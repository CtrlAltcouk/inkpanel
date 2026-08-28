import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import type { DashboardSectionData, EntityDisplayItem } from '../../src/model/dashboard.ts';
import { renderHtml } from '../../src/render/template.ts';
import { renderMiniHtml } from '../../src/render/miniTemplate.ts';
import { formatEntityValue } from '../../src/render/entities.ts';
import { WFT0583, SSD1681_200X200 } from '../../src/panel/profile.ts';
import { loadFontCss } from '../../src/render/fonts.ts';
import { dashboardData } from '../fixtures/dashboard.ts';

const item = (name = 'Living Room Temperature', value = '21.4', unit: string | null = '°C', available = true): EntityDisplayItem => ({ name, value, unit, available });
const section = (items: EntityDisplayItem[] | null, configured = true): DashboardSectionData => ({ type: 'entities', configured, data: items ? { items } : null, health: null });

test('one formatting helper preserves states/units and avoids invalid placeholders', () => {
  for (const [value, unit, expected] of [['21.4', '°C', '21.4°C'], ['89', '%', '89%'], ['312', 'W', '312 W'], ['0.312', 'kW', '0.312 kW'], ['-2.50', null, '-2.50']] as const) {
    assert.equal(formatEntityValue(item('Name', value, unit)), expected);
  }
  for (const value of ['unknown', 'unavailable', 'NaN', 'undefined', 'null', '']) assert.equal(formatEntityValue(item('Name', value)), 'UNAVAILABLE');
  assert.equal(formatEntityValue(item('Name', '21.4', '°C', false)), 'UNAVAILABLE');
});

test('Sensors distinguish hero, rows, not configured and unavailable on both profiles', () => {
  for (const mini of [false, true]) {
    const render = (s: DashboardSectionData) => {
      const full = dashboardData(); full.sections[0] = s;
      return mini ? renderMiniHtml({ ...full, sections: [s] }, SSD1681_200X200, '') : renderHtml(full, WFT0583, '');
    };
    assert.match(render(section([item('<Room>')])), /entities-hero/);
    assert.match(render(section([item('<Room>')])), /&lt;Room&gt;/);
    assert.equal((render(section([item(), item(), item(), item()])).match(/class="entities-row"/g) ?? []).length, 4);
    assert.match(render(section(null, false)), /Sensors — not set up/);
    assert.match(render(section(null)), /Sensors unavailable/);
    assert.match(render(section([item('Garden', '', null, false)])), /UNAVAILABLE/);
  }
});

test('deterministic Sensors layouts stay inside full-size/Mini bounds with production fonts', async () => {
  const cases = [
    [item()], [item(), item('Humidity', '46', '%')],
    [item(), item('Humidity', '46', '%'), item('House Power', '312', 'W'), item('Battery', '89', '%')],
    [item('An extremely long friendly name that must never escape the screen', '123456789012345678901234567890', 'Mbps')],
    [item('Long '.repeat(30)), item('Long value', '1234567890'.repeat(10), 'kWh'), item('No unit', 'online', null), item('Garden Temperature', '', null, false)],
    [item('Garden', '', null, false)],
  ];
  const browser = await chromium.launch({ headless: true });
  const fontCss = await loadFontCss();
  try {
    for (const mini of [false, true]) {
      const profile = mini ? SSD1681_200X200 : WFT0583;
      const page = await browser.newPage({ viewport: { width: profile.width, height: profile.height } });
      for (const items of cases) {
        const full = dashboardData(); full.sections[0] = section(items);
        const html = mini ? renderMiniHtml({ ...full, sections: [section(items)] }, profile, fontCss) : renderHtml(full, profile, fontCss);
        await page.setContent(html); await page.evaluate(() => document.fonts.ready);
        const bounds = await page.locator(mini ? '.mini' : '.cell--tl').boundingBox(); assert.ok(bounds);
        for (const element of await page.locator('[class^="entities-"] .entities-name, [class^="entities-"] .entities-value, .entities-row').all()) {
          const box = await element.boundingBox(); assert.ok(box);
          assert.ok(box.x >= bounds.x && box.y >= bounds.y, 'starts inside widget');
          assert.ok(box.x + box.width <= bounds.x + bounds.width + 0.1, 'no horizontal overflow');
          assert.ok(box.y + box.height <= bounds.y + bounds.height + 0.1, 'no vertical overflow');
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), profile.width);
        const first = await page.screenshot();
        assert.deepEqual(await page.screenshot(), first, 'fixed sensor input produces deterministic pixels');
      }
      await page.close();
    }
  } finally { await browser.close(); }
});
