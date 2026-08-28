import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { chromium } from 'playwright';
import { join } from 'node:path';

test('Studio preserves V1 on unrelated saves, selects HA IDs, and retains provider versions and missing IDs', async () => {
  const app = express();
  app.get('/harness', (_req, res) => res.type('html').send(`<!doctype html><form><span id="state">Saved</span><div id="editor"></div></form><script type="module">
    import { renderDashboardEditor, collectDashboardSections, collectRememberedDashboardSettings } from '/dashboardEditor.js';
    const root = document.querySelector('#editor');
    document.querySelector('form').addEventListener('input', () => document.querySelector('#state').textContent = 'Unsaved');
    document.querySelector('form').addEventListener('change', () => document.querySelector('#state').textContent = 'Unsaved');
    window.load = (widget, discovery) => renderDashboardEditor(root, { id: 'p', panelProfileId: 'wft0583-800x480-mono', dashboardSections: [widget, { type: 'weather', version: 1, config: {} }, { type: 'empty', version: 1, config: {} }, { type: 'bins', version: 1, config: { uprn: '123' } }] }, {}, {}, {}, {}, [], [], discovery);
    window.collect = () => ({ sections: collectDashboardSections(root), remembered: collectRememberedDashboardSettings(root) });
    window.load({ type: 'calendar', version: 1, config: { calendarUrls: ['https://example.com/feed'] } }, { supported: true, available: true, calendars: [{ entityId: 'calendar.family', name: 'Family calendar' }, { entityId: 'calendar.work', name: 'Work calendar' }] });
  </script>`));
  app.use(express.static(join(process.cwd(), 'public')));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/harness`);
    await page.locator('[data-calendar-provider]').waitFor();
    assert.equal(await page.locator('[data-calendar-provider]').inputValue(), 'ical');
    await page.locator('[data-dashboard-select="3"]').click();
    await page.locator('[data-bins-uprn]').fill('456');
    let saved = await page.evaluate(() => window.collect());
    assert.deepEqual(saved.sections[0], { type: 'calendar', version: 1, config: { calendarUrls: ['https://example.com/feed'] } });
    await page.locator('[data-dashboard-select="0"]').click();
    await page.locator('[data-calendar-urls]').fill('https://edited.example/feed');
    assert.equal((await page.evaluate(() => window.collect())).sections[0].version, 1);
    await page.locator('[data-calendar-provider]').selectOption('home-assistant');
    assert.match(await page.locator('#editor').textContent(), /Family calendar/);
    for (const checkbox of await page.locator('[data-ha-calendar]').all()) await checkbox.check();
    saved = await page.evaluate(() => window.collect());
    assert.deepEqual(saved.sections[0], { type: 'calendar', version: 2, config: { provider: 'home-assistant', entityIds: ['calendar.family', 'calendar.work'] } });
    assert.equal(saved.remembered.slots[0][0].version, 2);
    await page.locator('[data-calendar-provider]').selectOption('ical');
    assert.equal(await page.locator('[data-calendar-urls]').inputValue(), 'https://edited.example/feed');
    assert.equal((await page.evaluate(() => window.collect())).sections[0].version, 2);
    await page.locator('[data-calendar-provider]').selectOption('home-assistant');
    assert.equal(await page.locator('[data-ha-calendar]:checked').count(), 2);
    assert.equal(await page.locator('#state').textContent(), 'Unsaved');
    await page.evaluate(() => window.load({ type: 'calendar', version: 2, config: { provider: 'home-assistant', entityIds: ['calendar.deleted'] } }, { supported: true, available: true, calendars: [] }));
    assert.match(await page.locator('#editor').textContent(), /calendar.deleted \(missing\/unavailable\)/);
    assert.deepEqual((await page.evaluate(() => window.collect())).sections[0].config.entityIds, ['calendar.deleted']);
    await page.evaluate(() => window.load({ type: 'calendar', version: 2, config: { provider: 'home-assistant', entityIds: [] } }, { supported: true, available: true, calendars: Array.from({ length: 11 }, (_, i) => ({ entityId: `calendar.c${i}`, name: `Calendar ${i}` })) }));
    for (const checkbox of (await page.locator('[data-ha-calendar]').all()).slice(0, 10)) await checkbox.check();
    await page.locator('[data-ha-calendar]').last().click();
    assert.equal(await page.locator('[data-ha-calendar]:checked').count(), 10);
    assert.match(await page.locator('[data-calendar-error]').textContent(), /at most 10/);
  } finally { await browser.close(); await new Promise((resolve) => server.close(resolve)); }
});
