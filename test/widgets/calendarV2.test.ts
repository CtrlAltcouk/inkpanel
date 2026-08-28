import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendarWidgetConfigV1Schema, calendarWidgetV1Schema, dashboardWidgetSchema } from '../../src/widgets/registry.ts';

test('Calendar V1 stays frozen and Calendar V2 has strict separate providers', () => {
  const legacy = { type: 'calendar', version: 1, config: { calendarUrls: ['http://192.168.1.2/feed'] } };
  assert.deepEqual(calendarWidgetV1Schema.parse(legacy), legacy);
  assert.equal(calendarWidgetConfigV1Schema.safeParse({ provider: 'ical', calendarUrls: [] }).success, false);
  for (const config of [
    { provider: 'ical', calendarUrls: ['https://calendar.example/feed'] },
    { provider: 'home-assistant', entityIds: ['calendar.family', 'calendar.birthdays'] },
  ]) assert.deepEqual(dashboardWidgetSchema.parse({ type: 'calendar', version: 2, config }).config, config);
  for (const config of [
    { provider: 'ical', calendarUrls: [], entityIds: [] },
    { provider: 'home-assistant', entityIds: [], calendarUrls: [] },
    { provider: 'home-assistant', entityIds: ['light.kitchen'] },
    { provider: 'home-assistant', entityIds: ['calendar.home/../../config'] },
    { provider: 'home-assistant', entityIds: ['calendar.home?x=secret'] },
    { provider: 'home-assistant', entityIds: ['calendar.home', 'calendar.home'] },
    { provider: 'home-assistant', entityIds: Array.from({ length: 11 }, (_, i) => `calendar.c${i}`) },
    { provider: 'ical', calendarUrls: Array(11).fill('https://calendar.example/feed') },
    { calendarUrls: [] },
  ]) assert.equal(dashboardWidgetSchema.safeParse({ type: 'calendar', version: 2, config }).success, false);
});
