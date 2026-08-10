import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDashboardDraftState,
  dashboardCellHtml,
} from '../../public/dashboardEditor.js';

const sections = [
  { type: 'trains', version: 1, config: { originCrs: 'MKC', destinationCrs: 'EUS' } },
  { type: 'weather', version: 1, config: {} },
  { type: 'empty', version: 1, config: {} },
  { type: 'bins', version: 1, config: { uprn: '' } },
];

test('Train section shows a password-style Consumer key field beside station configuration', () => {
  const slot = createDashboardDraftState(sections)[0];
  const html = dashboardCellHtml('esp32-test', 0, slot, 'Milton Keynes', { configured: false, keyDraft: '' });
  assert.match(html, /National Rail API key/);
  assert.match(html, /type="password"/);
  assert.match(html, /data-train-api-key/);
  assert.match(html, /Paste RDM Consumer key/);
  assert.match(html, /data-station="origin"/);
  assert.match(html, /data-station="destination"/);
});

test('configured status never places the stored key into HTML', () => {
  const slot = createDashboardDraftState(sections)[0];
  const html = dashboardCellHtml('esp32-test', 0, slot, '', { configured: true, keyDraft: '' });
  assert.match(html, /API key configured/);
  assert.match(html, /Configured — leave blank to keep/);
  assert.doesNotMatch(html, /value="[^\"]+"/);
});

test('a newly entered draft is escaped before being put into the password input', () => {
  const slot = createDashboardDraftState(sections)[0];
  const html = dashboardCellHtml('esp32-test', 0, slot, '', {
    configured: false,
    keyDraft: 'abc"<script>1234567890',
  });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&quot;|&#34;/);
});
