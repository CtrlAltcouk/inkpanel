import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDashboardDraftState,
  dashboardCellHtml,
  serialiseDashboardDraftState,
  stationPickerOptions,
  switchDashboardDraft,
} from '../../public/dashboardEditor.js';

test('per-section per-type drafts survive switching away and back', () => {
  const slots = createDashboardDraftState([
    { type: 'calendar', version: 1, config: { calendarUrls: ['https://one.example/a.ics'] } },
    { type: 'empty', version: 1, config: {} },
    { type: 'empty', version: 1, config: {} },
    { type: 'empty', version: 1, config: {} },
  ]);
  switchDashboardDraft(slots, 0, 'bins', { calendarUrls: ['https://edited.example/b.ics'] });
  switchDashboardDraft(slots, 0, 'calendar', { uprn: '100080152345' });
  assert.deepEqual(serialiseDashboardDraftState(slots)[0], {
    type: 'calendar', version: 1, config: { calendarUrls: ['https://edited.example/b.ics'] },
  });
  switchDashboardDraft(slots, 0, 'bins', { calendarUrls: ['https://edited.example/b.ics'] });
  assert.deepEqual(serialiseDashboardDraftState(slots)[0].config, { uprn: '100080152345' });
});

test('drafts remain isolated between duplicate widgets', () => {
  const sections = [0, 1, 2, 3].map((index) => ({ type: 'calendar', version: 1, config: { calendarUrls: [`https://${index}.example/feed.ics`] } }));
  const slots = createDashboardDraftState(sections);
  switchDashboardDraft(slots, 0, 'weather', { calendarUrls: ['https://edited.example/feed.ics'] });
  assert.deepEqual(slots[1].drafts.calendar.calendarUrls, ['https://1.example/feed.ics']);
});

test('cell HTML exposes the correct controls for every widget type and position', () => {
  const configs = {
    calendar: { calendarUrls: ['https://calendar.example/feed.ics'] }, weather: {},
    trains: { originCrs: 'MKC', destinationCrs: 'EUS' }, bins: { uprn: '100080152345' }, empty: {},
  };
  const html = Object.entries(configs).map(([type, config], index) => dashboardCellHtml('panel-a', index % 4, { type, drafts: { [type]: config } }, 'Milton Keynes')).join('\n');
  assert.match(html, /Top Left/);
  assert.match(html, /Secret iCal URLs/);
  assert.match(html, /Uses panel location: Milton Keynes/);
  assert.match(html, /data-station="origin"/);
  assert.match(html, /data-bins-uprn/);
  assert.match(html, /dashboard section will be blank/);
  assert.equal((dashboardCellHtml('panel-a', 0, { type: 'empty', drafts: { empty: {} } }).match(/data-widget-type/g) ?? []).length, 1);
});

test('station picker identities are unique across sections and endpoints', () => {
  const identities = [0, 1].flatMap((section) => ['origin', 'destination'].map((endpoint) => {
    const options = stationPickerOptions('panel-a', section, endpoint, endpoint, '');
    return `station-${options.id}-${options.field}`;
  }));
  assert.equal(new Set(identities).size, identities.length);
});

test('serialization always emits exactly four versioned sections', () => {
  const slots = createDashboardDraftState(['calendar', 'weather', 'trains', 'bins'].map((type) => ({
    type, version: 1, config: type === 'calendar' ? { calendarUrls: [] } : type === 'trains' ? { originCrs: '', destinationCrs: '' } : type === 'bins' ? { uprn: '' } : {},
  })));
  const saved = serialiseDashboardDraftState(slots);
  assert.equal(saved.length, 4);
  assert.ok(saved.every((section) => section.version === 1));
});
