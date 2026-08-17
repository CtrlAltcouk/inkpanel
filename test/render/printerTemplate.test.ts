import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import type { DashboardSectionData, MiniDashboardData, PrinterStatus } from '../../src/model/dashboard.ts';
import { SSD1681_200X200, WFT0583 } from '../../src/panel/profile.ts';
import { loadFontCss } from '../../src/render/fonts.ts';
import { renderMiniHtml } from '../../src/render/miniTemplate.ts';
import { renderHtml } from '../../src/render/template.ts';
import { dashboardData } from '../fixtures/dashboard.ts';

function printer(overrides: Partial<PrinterStatus> = {}): PrinterStatus {
  return { name: 'Voron 2.4', state: 'printing', filename: 'Benchy.gcode', progressPercent: 68, elapsedSeconds: 1000, remainingSeconds: 4320, currentLayer: 184, totalLayers: 271, nozzle: { current: 220, target: 220 }, bed: { current: 60, target: 60 }, message: null, ...overrides };
}
function section(printers: PrinterStatus[], configured = true): DashboardSectionData {
  return { type: 'printers', data: configured ? { printers } : null, configured, health: null };
}
function miniData(value: DashboardSectionData): MiniDashboardData {
  const full = dashboardData();
  return { ...full, sections: [value] };
}

test('full-size switches between rich single-printer hero and compact 2-4 overview', () => {
  const full = dashboardData();
  full.sections[0] = section([printer()]);
  const hero = renderHtml(full, WFT0583, '');
  assert.match(hero, /printer-hero/);
  assert.match(hero, /68%/);
  assert.match(hero, /Benchy\.gcode/);
  assert.match(hero, /1h 12m remaining/);
  assert.match(hero, /Layer 184 \/ 271/);
  assert.match(hero, /NOZZLE 220° \/ 220°/);
  for (const count of [2, 3, 4]) {
    full.sections[0] = section(Array.from({ length: count }, (_, index) => printer({ name: `Printer ${index + 1}`, progressPercent: index * 20 })));
    const multi = renderHtml(full, WFT0583, '');
    assert.match(multi, /printer-multi/);
    assert.equal((multi.match(/class="printer-multi-row"/g) ?? []).length, count);
    assert.doesNotMatch(multi, /NOZZLE|Layer/);
  }
});

test('printer layouts escape long values and intentionally render paused, idle, offline and error states', () => {
  const long = printer({ name: 'Very long <printer> name that must not escape', filename: 'deep/path/<unsafe>-very-long-filename.gcode', state: 'paused' });
  const mini = renderMiniHtml(miniData(section([long])), SSD1681_200X200, '');
  assert.match(mini, /PAUSED/);
  assert.match(mini, /&lt;printer&gt;/);
  assert.doesNotMatch(mini, /<unsafe>/);
  for (const state of ['complete', 'cancelled', 'idle', 'offline', 'error'] as const) {
    const html = renderMiniHtml(miniData(section([printer({ state, progressPercent: state === 'idle' ? 68 : null, filename: null, message: state === 'offline' ? 'Moonraker unavailable' : null })])), SSD1681_200X200, '');
    assert.match(html, new RegExp(state.toUpperCase()));
    if (state === 'idle') assert.doesNotMatch(html, /68%/, 'stale virtual-SD progress never overrides idle state');
  }
  assert.match(renderMiniHtml(miniData(section([], false)), SSD1681_200X200, ''), /Not set up/);
});

test('progress widths clamp at normalized 0, 1, 99 and 100 percent values', () => {
  for (const percent of [0, 1, 99, 100]) {
    const html = renderMiniHtml(miniData(section([printer({ progressPercent: percent })])), SSD1681_200X200, '');
    assert.match(html, new RegExp(`width:${percent}%`));
  }
});

test('full hero, four-printer overview, and Mini hero stay inside real bounds with production fonts', async () => {
  const fontCss = await loadFontCss();
  const long = printer({ name: 'A very long printer name that needs ellipsis', filename: 'a/very/long/path/to/an-extremely-long-print-filename-that-must-fit.gcode' });
  const fullHero = dashboardData(); fullHero.sections[3] = section([long]);
  const fullMulti = dashboardData(); fullMulti.sections[3] = section([long, printer({ name: 'Offline printer', state: 'offline', progressPercent: null }), printer({ name: 'Paused printer', state: 'paused' }), printer({ name: 'Idle printer', state: 'idle', progressPercent: null })]);
  const examples = [
    { html: renderHtml(fullHero, WFT0583, fontCss), viewport: { width: 800, height: 480 }, root: '.cell--br' },
    { html: renderHtml(fullMulti, WFT0583, fontCss), viewport: { width: 800, height: 480 }, root: '.cell--br' },
    { html: renderMiniHtml(miniData(section([long])), SSD1681_200X200, fontCss), viewport: { width: 200, height: 200 }, root: '.mini' },
  ];
  const browser = await chromium.launch({ headless: true });
  try {
    for (const example of examples) {
      const page = await browser.newPage({ viewport: example.viewport });
      await page.setContent(example.html);
      await page.evaluate(() => document.fonts.ready);
      const bounds = await page.locator(example.root).evaluate((element) => ({
        clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
        clientHeight: element.clientHeight, scrollHeight: element.scrollHeight,
      }));
      assert.ok(bounds.scrollWidth <= bounds.clientWidth, `${example.root} has no horizontal overflow`);
      assert.ok(bounds.scrollHeight <= bounds.clientHeight, `${example.root} has no vertical overflow`);
      await page.close();
    }
  } finally { await browser.close(); }
});

test('existing widget output does not receive printer-only styles', () => {
  const existing = dashboardData();
  assert.doesNotMatch(renderHtml(existing, WFT0583, ''), /\.printer-hero|\.mini-printer-head/);
  assert.doesNotMatch(renderMiniHtml(miniData(existing.sections[0]), SSD1681_200X200, ''), /\.printer-hero|\.mini-printer-head/);
});
