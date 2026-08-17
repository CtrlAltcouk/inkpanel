import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { chromium } from 'playwright';
import { join } from 'node:path';

const IDS = Array.from({ length: 5 }, (_, index) => `${index + 1}1111111-1111-4111-8111-111111111111`);
const initialPrinters = IDS.map((id, index) => ({
  id, name: `Printer ${index + 1}`, baseUrl: `http://printer-${index + 1}.local`, apiKeyConfigured: index === 0,
}));

test('full-size printer selection dirties config while shared connection edits stay immediate and secret-safe', async () => {
  const app = express();
  app.get('/harness', (_req, res) => res.type('html').send(`<!doctype html><html><body>
    <form><span id="save-state">All changes saved</span><img class="panel-preview-image" src="/initial.png"><div id="editor"></div></form>
    <script type="module">
      import { collectDashboardSections, renderDashboardEditor } from '/dashboardEditor.js';
      import { bindPrinterPreviewRefresh } from '/panels.js';
      let tick = 2000; Date.now = () => ++tick;
      const form = document.querySelector('form'); const editor = document.querySelector('#editor');
      form.addEventListener('input', () => { document.querySelector('#save-state').textContent = 'Unsaved changes'; });
      form.addEventListener('change', () => { document.querySelector('#save-state').textContent = 'Unsaved changes'; });
      bindPrinterPreviewRefresh(editor, document, 'panel-a');
      renderDashboardEditor(editor, { id: 'panel-a', locationLabel: 'Home', panelProfileId: 'wft0583-800x480-mono', dashboardSections: [
        { type: 'printers', version: 1, config: { printerIds: window.initialPrinters.slice(0, 2).map((printer) => printer.id) } },
        { type: 'weather', version: 1, config: {} }, { type: 'weather', version: 1, config: {} }, { type: 'weather', version: 1, config: {} },
      ] }, {}, {}, {}, {}, [], window.initialPrinters);
      window.collectPrinterSections = () => collectDashboardSections(editor);
    </script></body></html>`));
  app.use(express.static(join(process.cwd(), 'public')));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  let printers = structuredClone(initialPrinters);
  let updateBody = null;
  await page.addInitScript((value) => { window.initialPrinters = value; }, printers);
  await page.route('**/api/printers**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET') return route.fulfill({ json: { printers } });
    if (request.method() === 'POST' && path.endsWith('/test')) return route.fulfill({ json: { ok: true, status: { state: 'idle', message: null } } });
    if (request.method() === 'PUT') {
      updateBody = request.postDataJSON();
      const id = path.split('/')[3];
      printers = printers.map((printer) => printer.id === id ? { ...printer, name: updateBody.name, baseUrl: updateBody.baseUrl, apiKeyConfigured: true } : printer);
      return route.fulfill({ json: printers.find((printer) => printer.id === id) });
    }
    return route.fulfill({ status: 204 });
  });
  try {
    await page.goto(`${base}/harness`);
    await page.locator('[data-printer-select]').first().waitFor();
    assert.doesNotMatch(await page.content(), /stored-secret/);
    assert.equal(await page.locator('[data-printer-edit-key]').first().inputValue(), '');

    await page.locator(`[data-printer-select][value="${IDS[2]}"]`).check();
    assert.equal(await page.locator('#save-state').textContent(), 'Unsaved changes');
    await page.locator('#save-state').evaluate((node) => { node.textContent = 'All changes saved'; });

    await page.locator(`[data-printer-order="1"][data-printer-id="${IDS[0]}"]`).click();
    assert.equal(await page.locator('#save-state').textContent(), 'Unsaved changes');
    const ordered = await page.evaluate(() => window.collectPrinterSections()[0].config.printerIds);
    assert.deepEqual(ordered, [IDS[1], IDS[0], IDS[2]]);

    await page.locator(`[data-printer-select][value="${IDS[3]}"]`).check();
    await page.locator(`[data-printer-select][value="${IDS[4]}"]`).click();
    assert.equal(await page.locator(`[data-printer-select][value="${IDS[4]}"]`).isChecked(), false);
    assert.match(await page.locator('[data-printer-error]').textContent(), /up to four/);

    await page.locator('#save-state').evaluate((node) => { node.textContent = 'All changes saved'; });
    const previewBefore = await page.locator('.panel-preview-image').getAttribute('src');
    const firstConnection = page.locator('[data-printer-connection]').first();
    await firstConnection.locator('[data-printer-edit]').click();
    await firstConnection.locator('[data-printer-edit-name]').fill('Voron 2.4');
    await firstConnection.locator('[data-printer-edit-key]').fill('new-secret');
    assert.equal(await page.locator('#save-state').textContent(), 'All changes saved');
    await firstConnection.locator('[data-printer-save]').click();
    await page.waitForFunction(() => document.querySelector('[data-printer-connection] strong').textContent === 'Voron 2.4');
    assert.equal(await page.locator('#save-state').textContent(), 'All changes saved');
    assert.notEqual(await page.locator('.panel-preview-image').getAttribute('src'), previewBefore);
    assert.equal(updateBody.apiKey, 'new-secret');
    assert.doesNotMatch(await page.content(), /new-secret/);

    await page.locator('[data-printer-connection]').first().locator('[data-printer-test]').click();
    await page.waitForFunction(() => document.querySelector('[data-printer-test-result]').textContent.includes('Connected'));
    assert.match(await page.locator('[data-printer-test-result]').first().textContent(), /IDLE/);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Mini printer editor provides one selection and serializes exactly one ID', async () => {
  const app = express();
  app.get('/harness', (_req, res) => res.type('html').send(`<!doctype html><html><body><form><span id="save-state">All changes saved</span><div id="editor"></div></form><script type="module">
    import { collectDashboardSections, renderDashboardEditor } from '/dashboardEditor.js';
    const form = document.querySelector('form'); const editor = document.querySelector('#editor');
    form.addEventListener('change', () => { document.querySelector('#save-state').textContent = 'Unsaved changes'; });
    renderDashboardEditor(editor, { id: 'mini', locationLabel: '', panelProfileId: 'ssd1681-200x200-mono', dashboardSections: [{ type: 'printers', version: 1, config: { printerIds: [] } }] }, {}, {}, {}, {}, [], window.initialPrinters);
    window.collectPrinterSections = () => collectDashboardSections(editor);
  </script></body></html>`));
  app.use(express.static(join(process.cwd(), 'public')));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.addInitScript((value) => { window.initialPrinters = value; }, initialPrinters);
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/harness`);
    assert.equal(await page.locator('[data-printer-single]').count(), 1);
    assert.equal(await page.locator('[data-printer-select]').count(), 0);
    await page.locator('[data-printer-single]').selectOption(IDS[1]);
    assert.equal(await page.locator('#save-state').textContent(), 'Unsaved changes');
    assert.deepEqual(await page.evaluate(() => window.collectPrinterSections()[0].config.printerIds), [IDS[1]]);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
