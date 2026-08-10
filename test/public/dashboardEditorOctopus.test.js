import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDashboardDraftState,
  dashboardCellHtml,
  serialiseDashboardDraftState,
  switchDashboardDraft,
} from '../../public/dashboardEditor.js';

test('dashboard selector exposes Octopus Agile with one tariff-code field', () => {
  const html = dashboardCellHtml('panel-a', 0, {
    type: 'octopus',
    drafts: { octopus: { tariffCode: 'E-1R-AGILE-24-10-01-C' } },
  });
  assert.match(html, />Octopus Agile<\/option>/);
  assert.match(html, /Octopus Agile tariff code/);
  assert.match(html, /data-octopus-tariff/);
  assert.match(html, /E-1R-AGILE-24-10-01-C/);
  assert.match(html, /no Octopus API key is required/i);
});

test('Octopus tariff draft survives switching widget types', () => {
  const slots = createDashboardDraftState([
    { type: 'octopus', version: 1, config: { tariffCode: 'E-1R-AGILE-24-10-01-C' } },
    { type: 'empty', version: 1, config: {} },
    { type: 'empty', version: 1, config: {} },
    { type: 'empty', version: 1, config: {} },
  ]);
  switchDashboardDraft(slots, 0, 'weather', { tariffCode: 'E-1R-AGILE-FLEX-22-11-25-C' });
  switchDashboardDraft(slots, 0, 'octopus', {});
  assert.deepEqual(serialiseDashboardDraftState(slots)[0], {
    type: 'octopus',
    version: 1,
    config: { tariffCode: 'E-1R-AGILE-FLEX-22-11-25-C' },
  });
});
