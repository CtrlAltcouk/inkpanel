import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendarControlsHtml, switchCalendarProvider } from '../../public/calendarEditor.js';
import { createDashboardDraftState, serialiseDashboardDraftState, serialiseRememberedDashboardDrafts, switchDashboardDraft } from '../../public/dashboardEditor.js';

const v1 = { type: 'calendar', version: 1, config: { calendarUrls: ['https://example.com/feed'] } };
const ha = { type: 'calendar', version: 2, config: { provider: 'home-assistant', entityIds: ['calendar.family'] } };

test('draft versions follow active > slot > shared precedence and survive unrelated widget edits', () => {
  const slots = createDashboardDraftState([v1, { type: 'empty', version: 1, config: {} }, { type: 'weather', version: 1, config: {} }], {
    shared: [ha], slots: [[ha], [{ ...ha, config: { provider: 'ical', calendarUrls: ['https://slot.example/feed'] } }], []],
  });
  assert.deepEqual(serialiseDashboardDraftState(slots)[0], v1);
  switchDashboardDraft(slots, 1, 'calendar', {});
  assert.deepEqual(serialiseDashboardDraftState(slots)[1], { ...ha, config: { provider: 'ical', calendarUrls: ['https://slot.example/feed'] } });
  switchDashboardDraft(slots, 2, 'calendar', {});
  assert.deepEqual(serialiseDashboardDraftState(slots)[2], ha);
  switchDashboardDraft(slots, 1, 'weather', slots[1].drafts.calendar);
  assert.deepEqual(serialiseDashboardDraftState(slots)[0], v1);
  const remembered = serialiseRememberedDashboardDrafts(slots);
  assert.equal(remembered.slots[1].find((widget) => widget.type === 'calendar').version, 2);
  assert.equal(remembered.slots[0].find((widget) => widget.type === 'calendar').version, 1);
});

test('explicit provider switches upgrade V1 and retain separate provider choices as V2', () => {
  const [slot] = createDashboardDraftState([v1], { shared: [ha] });
  switchCalendarProvider(slot, 'home-assistant');
  assert.deepEqual(serialiseDashboardDraftState([slot])[0], ha);
  slot.drafts.calendar.entityIds.push('calendar.work');
  switchCalendarProvider(slot, 'ical');
  assert.deepEqual(serialiseDashboardDraftState([slot])[0], { ...v1, version: 2, config: { provider: 'ical', calendarUrls: v1.config.calendarUrls } });
  switchCalendarProvider(slot, 'home-assistant');
  assert.deepEqual(slot.drafts.calendar.entityIds, ['calendar.family', 'calendar.work']);
  switchDashboardDraft([slot], 0, 'bins', slot.drafts.calendar);
  switchDashboardDraft([slot], 0, 'calendar', { uprn: '123' });
  assert.equal(serialiseDashboardDraftState([slot])[0].version, 2);
});

test('Calendar controls retain iCal help and safely show HA discovery, empty, missing, and unavailable states', () => {
  const standalone = calendarControlsHtml(v1.config, { supported: false });
  assert.match(standalone, /Secret iCal URLs, one per line/);
  assert.match(standalone, /support.google.com/);
  assert.doesNotMatch(standalone, /data-calendar-provider/);
  const legacy = calendarControlsHtml(v1.config, { supported: true });
  assert.match(legacy, /value="ical" selected/);
  const html = calendarControlsHtml(ha.config, { supported: true, available: true, calendars: [{ entityId: 'calendar.work', name: 'Work & Play' }] });
  assert.match(html, /Work &amp; Play/);
  assert.match(html, /value="calendar.family" checked/);
  assert.match(html, /calendar.family \(missing\/unavailable\)/);
  assert.doesNotMatch(html, /Secret iCal|support.google.com/);
  assert.match(calendarControlsHtml(ha.config, { supported: true, available: true, calendars: [] }), /No Home Assistant calendars found/);
  assert.match(calendarControlsHtml(ha.config, { supported: true, available: false }), /Saved selections are retained/);
  assert.match(calendarControlsHtml(ha.config, { supported: false, available: false }), /value="home-assistant" selected disabled/);
});
