import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import type { DashboardSectionData, MiniDashboardData } from '../../src/model/dashboard.ts';
import { SSD1681_200X200, WFT0583 } from '../../src/panel/profile.ts';
import { loadFontCss } from '../../src/render/fonts.ts';
import { renderMiniHtml } from '../../src/render/miniTemplate.ts';
import { renderHtml } from '../../src/render/template.ts';
import { dashboardData } from '../fixtures/dashboard.ts';

function section(items: string[], configured = true): DashboardSectionData {
  return { type: 'todo', data: configured ? { items } : null, configured, health: null };
}

function miniData(todo: DashboardSectionData): MiniDashboardData {
  const full = dashboardData();
  return { ...full, sections: [todo] };
}

test('full-size To Do renders five active rows safely and escapes task text', () => {
  const data = dashboardData();
  data.sections[0] = section(['Put bins out', 'Order <black> filament', 'Email garage', 'Charge batteries', 'Buy milk', 'Hidden sixth']);
  const html = renderHtml(data, WFT0583, '');
  assert.match(html, /<div class="label">To Do/);
  assert.equal((html.match(/class="todo-row"/g) ?? []).length, 5);
  assert.match(html, /Order &lt;black&gt; filament/);
  assert.doesNotMatch(html, /Hidden sixth/);
  assert.match(html, /\.todo-row>span:last-child\{white-space:nowrap;overflow:hidden;text-overflow:ellipsis/);
});

test('full-size and Mini To Do distinguish not set up from an empty completed list', () => {
  const full = dashboardData();
  full.sections[0] = section([], true);
  assert.match(renderHtml(full, WFT0583, ''), /All done/);
  assert.match(renderMiniHtml(miniData(section([], true)), SSD1681_200X200, ''), /ALL DONE/);
  assert.match(renderMiniHtml(miniData(section([], false)), SSD1681_200X200, ''), /Not set up/);
});

test('To Do styles are absent from existing widget template output', () => {
  const existing = dashboardData();
  assert.doesNotMatch(renderHtml(existing, WFT0583, ''), /\.todo-list|\.mini-todo-list/);
  assert.doesNotMatch(renderMiniHtml(miniData(existing.sections[0]), SSD1681_200X200, ''), /\.todo-list|\.mini-todo-list/);
});

test('Mini To Do shows the maximum five useful rows and omits excess tasks', () => {
  const html = renderMiniHtml(miniData(section([
    'One long task that wraps cleanly',
    'Two long task that also wraps safely',
    'Three', 'Four', 'Five', 'Six must not render',
  ])), SSD1681_200X200, '');
  assert.equal((html.match(/class="mini-todo-row"/g) ?? []).length, 5);
  assert.match(html, /One long task that wraps cleanly/);
  assert.doesNotMatch(html, /Six must not render/);
});

test('full-size and Mini To Do rows stay within real bounds with production fonts', async () => {
  const fontCss = await loadFontCss();
  const tasks = [
    'Put the recycling and general waste bins outside tonight',
    'Order black and white printer filament for the workshop',
    'Email the garage about the annual service appointment',
    'Charge every battery before the weekend trip',
    'Buy milk, bread, coffee, and washing-up liquid',
  ];
  const full = dashboardData();
  full.sections[3] = section(tasks);
  const examples = [
    { name: 'full', html: renderHtml(full, WFT0583, fontCss), viewport: { width: 800, height: 480 }, container: '.cell--br', rows: '.todo-row' },
    { name: 'Mini', html: renderMiniHtml(miniData(section(tasks)), SSD1681_200X200, fontCss), viewport: { width: 200, height: 200 }, container: '.mini', rows: '.mini-todo-row' },
  ];
  const browser = await chromium.launch({ headless: true });
  try {
    for (const example of examples) {
      const page = await browser.newPage({ viewport: example.viewport });
      await page.setContent(example.html);
      await page.evaluate(() => document.fonts.ready);
      const container = await page.locator(example.container).boundingBox();
      assert.ok(container);
      const rows = await page.locator(example.rows).all();
      assert.equal(rows.length, 5);
      for (const row of rows) {
        const box = await row.boundingBox();
        assert.ok(box);
        assert.ok(box.x >= container.x && box.y >= container.y, `${example.name} row starts inside its panel area`);
        assert.ok(box.x + box.width <= container.x + container.width, `${example.name} row does not clip horizontally`);
        assert.ok(box.y + box.height <= container.y + container.height, `${example.name} row does not clip vertically`);
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
});
