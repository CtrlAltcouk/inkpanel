import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDashboardDraftState, dashboardCellHtml, serialiseDashboardDraftState } from '../../public/dashboardEditor.js';

const printers = [
  { id: '11111111-1111-4111-8111-111111111111', name: 'Voron <2.4>', baseUrl: 'http://voron.local', apiKeyConfigured: true },
  { id: '22222222-2222-4222-8222-222222222222', name: 'Prusa', baseUrl: 'http://prusa.local', apiKeyConfigured: false },
];

test('3D Printers editor exposes ordered full-size selection and write-only connection controls', () => {
  const html = dashboardCellHtml('panel-a', 0, { type: 'printers', drafts: { printers: { printerIds: printers.map((printer) => printer.id) } } }, '', {}, {}, {}, 'Top Left', [], printers, false);
  assert.match(html, /<option value="printers" selected>3D Printers/);
  assert.equal((html.match(/data-printer-select/g) ?? []).length, 2);
  assert.match(html, /Select up to four printers/);
  assert.match(html, /data-printer-order="-1"/);
  assert.match(html, /API key configured/);
  assert.match(html, /type="password" data-printer-edit-key value=""/);
  assert.doesNotMatch(html, /apiKey|top-secret/);
  assert.match(html, /Voron &lt;2\.4&gt;/);
});

test('Mini editor exposes only a single printer selector', () => {
  const html = dashboardCellHtml('mini', 0, { type: 'printers', drafts: { printers: { printerIds: [printers[0].id] } } }, '', {}, {}, {}, 'Display content', [], printers, true);
  assert.match(html, /data-printer-single/);
  assert.match(html, /InkPanel Mini displays one printer/);
  assert.doesNotMatch(html, /data-printer-select/);
});

test('remembered printer drafts preserve only ordered printer IDs', () => {
  const slots = createDashboardDraftState([{ type: 'weather', version: 1, config: {} }], { shared: [{ type: 'printers', version: 1, config: { printerIds: printers.map((printer) => printer.id) } }], slots: [[]] });
  slots[0].type = 'printers';
  assert.deepEqual(serialiseDashboardDraftState(slots), [{ type: 'printers', version: 1, config: { printerIds: printers.map((printer) => printer.id) } }]);
});
