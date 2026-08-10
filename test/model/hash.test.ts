import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentHash } from '../../src/model/hash.ts';
import { dashboardData } from '../fixtures/dashboard.ts';

test('hash excludes render and fetch timestamps', () => {
  const base = dashboardData();
  const changed = structuredClone(base);
  changed.generatedAt = '2027-01-01T00:00:00.000Z';
  changed.contentChangedAt = '2027-01-01T00:00:00.000Z';
  changed.headerWeatherHealth.fetchedAt = '2027-01-01T00:00:00.000Z';
  changed.sections[0].type === 'calendar' && (changed.sections[0].health.fetchedAt = '2027-01-01T00:00:00.000Z');
  assert.equal(contentHash(base), contentHash(changed));
});

test('hash includes the displayed minute of a stale badge, but not raw seconds', () => {
  const base = dashboardData();
  if (base.sections[0].type === 'calendar') base.sections[0].health = { id: 'ical', status: 'stale', fetchedAt: '2026-08-03T03:10:01.000Z', error: 'timeout' };
  const sameMinute = structuredClone(base);
  if (sameMinute.sections[0].type === 'calendar') sameMinute.sections[0].health.fetchedAt = '2026-08-03T03:10:59.000Z';
  const nextMinute = structuredClone(base);
  if (nextMinute.sections[0].type === 'calendar') nextMinute.sections[0].health.fetchedAt = '2026-08-03T03:11:00.000Z';
  assert.equal(contentHash(base), contentHash(sameMinute));
  assert.notEqual(contentHash(base), contentHash(nextMinute));
});

test('hash follows ordered section content and independently-owned health', () => {
  const base = dashboardData();
  const reordered = structuredClone(base);
  [reordered.sections[0], reordered.sections[1]] = [reordered.sections[1], reordered.sections[0]];
  assert.notEqual(contentHash(base), contentHash(reordered), 'position is visible');

  const stale = structuredClone(base);
  if (stale.sections[0].type === 'calendar') stale.sections[0].health.status = 'stale';
  assert.notEqual(contentHash(base), contentHash(stale), 'section health is visible');
});

test('changing a selected type or only Calendar A changes the ordered hash', () => {
  const base = dashboardData();
  const typeChanged = structuredClone(base);
  typeChanged.sections[0] = { type: 'empty' };
  assert.notEqual(contentHash(base), contentHash(typeChanged));

  const duplicate = structuredClone(base);
  duplicate.sections[1] = structuredClone(duplicate.sections[0]);
  const calendarAChanged = structuredClone(duplicate);
  if (calendarAChanged.sections[0].type === 'calendar') calendarAChanged.sections[0].data!.today[0]!.title = 'Only A changed';
  assert.notEqual(contentHash(duplicate), contentHash(calendarAChanged));
  assert.deepEqual(calendarAChanged.sections[1], duplicate.sections[1], 'Calendar B remained unchanged');
});

test('hash includes header weather and battery percent but not battery volts', () => {
  const base = dashboardData();
  assert.notEqual(contentHash(base), contentHash(dashboardData({ headerWeather: { ...base.headerWeather!, currentTempC: 30 } })));
  assert.notEqual(contentHash(base), contentHash(dashboardData({ battery: { volts: 3.6, percent: 42 } })));
  assert.equal(contentHash(base), contentHash(dashboardData({ battery: { volts: 4.05, percent: 87 } })));
});

test('hash is deterministic stable hex', () => {
  assert.match(contentHash(dashboardData()), /^[0-9a-f]{32}$/);
  assert.equal(contentHash(dashboardData()), contentHash(dashboardData()));
});
