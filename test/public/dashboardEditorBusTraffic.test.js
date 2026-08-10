import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDashboardDraftState, dashboardCellHtml } from '../../public/dashboardEditor.js';

const busSections = [
  { type: 'bus', version: 1, config: { stopCode: '049000000001', stopLabel: 'Central Station', routeFilter: '6' } },
  { type: 'traffic', version: 1, config: { origin: 'MK9 1EA', destination: 'London Euston' } },
  { type: 'weather', version: 1, config: {} },
  { type: 'empty', version: 1, config: {} },
];

test('widget selector exposes Bus and Traffic as separate content types', () => {
  const slot = createDashboardDraftState(busSections)[2];
  const html = dashboardCellHtml('esp32-test', 2, slot);
  assert.match(html, /<option value="bus"/);
  assert.match(html, /<option value="traffic"/);
});

test('Bus editor keeps credentials separate from stop/route config', () => {
  const slot = createDashboardDraftState(busSections)[0];
  const html = dashboardCellHtml(
    'esp32-test', 0, slot, '', {},
    { configured: true, appIdDraft: '', appKeyDraft: '' },
  );
  assert.match(html, /TransportAPI app ID/);
  assert.match(html, /TransportAPI app key/);
  assert.match(html, /type="password" data-bus-app-id value=""/);
  assert.match(html, /type="password" data-bus-app-key value=""/);
  assert.match(html, /data-bus-stop/);
  assert.match(html, /data-bus-route-filter/);
  assert.match(html, /value="6"/);
});

test('Traffic editor shows Google key plus independent From and To fields', () => {
  const slot = createDashboardDraftState(busSections)[1];
  const html = dashboardCellHtml(
    'esp32-test', 1, slot, '', {}, {},
    { configured: true, keyDraft: '' },
  );
  assert.match(html, /Google Maps API key/);
  assert.match(html, /type="password" data-traffic-api-key value=""/);
  assert.match(html, /data-traffic-origin value="MK9 1EA"/);
  assert.match(html, /data-traffic-destination value="London Euston"/);
  assert.match(html, /Google Maps attribution is shown on the panel/);
});
