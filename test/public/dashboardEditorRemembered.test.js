import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDashboardDraftState,
  dashboardCellHtml,
  switchDashboardDraft,
} from '../../public/dashboardEditor.js';

const sections = [
  { type: 'calendar', version: 1, config: { calendarUrls: ['https://active.example/calendar.ics'] } },
  { type: 'weather', version: 1, config: {} },
  { type: 'trains', version: 1, config: { originCrs: 'MKC', destinationCrs: 'EUS' } },
  { type: 'bins', version: 1, config: { uprn: '25006645' } },
];

test('active config beats per-panel remembered config, which beats shared fallback', () => {
  const remembered = {
    shared: [
      { type: 'bins', version: 1, config: { uprn: '11111111' } },
      { type: 'octopus', version: 1, config: { tariffCode: 'E-1R-AGILE-24-10-01-C' } },
    ],
    slots: [
      [{ type: 'bins', version: 1, config: { uprn: '22222222' } }],
      [],
      [],
      [{ type: 'bins', version: 1, config: { uprn: '33333333' } }],
    ],
  };
  const slots = createDashboardDraftState(sections, remembered);

  assert.deepEqual(slots[0].drafts.bins, { uprn: '22222222' }, 'this panel/slot beats shared');
  assert.deepEqual(slots[0].drafts.octopus, { tariffCode: 'E-1R-AGILE-24-10-01-C' }, 'shared fills a type never used in this slot');
  assert.deepEqual(slots[3].drafts.bins, { uprn: '25006645' }, 'currently active DeviceStore config beats remembered state');

  switchDashboardDraft(slots, 0, 'bins', { calendarUrls: ['https://edited.example/calendar.ics'] });
  assert.deepEqual(slots[0].drafts.bins, { uprn: '22222222' });
});

test('widget controls expose official setup/help links next to their inputs', () => {
  const make = (type, config, api = {}) => dashboardCellHtml(
    'panel-a',
    0,
    { type, drafts: { [type]: config } },
    'Milton Keynes',
    api.train ?? {},
    api.bus ?? {},
    api.traffic ?? {},
  );

  assert.match(make('calendar', { calendarUrls: [] }), /support\.google\.com\/calendar\/answer\/37648/);
  assert.match(make('trains', { originCrs: '', destinationCrs: '' }), /raildata\.org\.uk/);
  assert.match(make('bus', { stopCode: '', stopLabel: '', routeFilter: '' }), /developer\.transportapi\.com/);
  assert.match(make('traffic', { origin: '', destination: '' }), /developers\.google\.com\/maps\/documentation\/routes\/get-api-key/);
  assert.match(make('octopus', { tariffCode: '' }), /developer\.octopus\.energy\/guides\/rest\/api-endpoints/);
  assert.match(make('bins', { uprn: '' }), /findmyaddress\.co\.uk/);
});
