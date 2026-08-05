import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentHash } from '../../src/model/hash.ts';
import type { DashboardData } from '../../src/model/dashboard.ts';
import { mixedBoard } from '../fixtures/train.ts';

function sample(overrides: Partial<DashboardData> = {}): DashboardData {
  return {
    generatedAt: '2026-08-03T07:42:00.000Z',
    contentChangedAt: '2026-08-03T07:42:00.000Z',
    timezone: 'Europe/London',
    today: { iso: '2026-08-03', weekdayLong: 'Monday', dayOfMonth: 3, monthLong: 'August' },
    calendar: {
      today: [{ uid: 'a', title: 'Standup', start: '2026-08-03T08:30:00.000Z', end: '2026-08-03T08:45:00.000Z', allDay: false }],
      tomorrow: [],
    },
    weather: {
      currentTempC: 22, conditionText: 'Partly cloudy', highC: 24, lowC: 13,
      precipProbability: 10, windKph: 13, windDirection: 'NW',
      sunrise: '2026-08-03T04:34:00.000Z', sunset: '2026-08-03T19:47:00.000Z',
      forecast: [{ weekday: 'TUE', highC: 24, lowC: 14, conditionText: 'Sunny' }],
    },
    sourceHealth: [{ id: 'ical', status: 'ok', fetchedAt: '2026-08-03T07:42:00.000Z', error: null }],
    battery: { volts: 4.02, percent: 87 },
    train: null,
    ...overrides,
  };
}

test('ignores generatedAt so unchanged content keeps its ETag', () => {
  const a = contentHash(sample());
  const b = contentHash(sample({ generatedAt: '2026-08-03T09:15:00.000Z' }));
  assert.equal(a, b);
});

test('ignores contentChangedAt', () => {
  const a = contentHash(sample());
  const b = contentHash(sample({ contentChangedAt: '2026-08-03T09:15:00.000Z' }));
  assert.equal(a, b);
});

test('ignores per-source fetchedAt', () => {
  const a = contentHash(sample());
  const b = contentHash(sample({
    sourceHealth: [{ id: 'ical', status: 'ok', fetchedAt: '2026-08-03T09:15:00.000Z', error: null }],
  }));
  assert.equal(a, b);
});

test('changes when an event changes', () => {
  const a = contentHash(sample());
  const b = contentHash(sample({
    calendar: { today: [{ uid: 'a', title: 'Standup MOVED', start: '2026-08-03T08:30:00.000Z', end: '2026-08-03T08:45:00.000Z', allDay: false }], tomorrow: [] },
  }));
  assert.notEqual(a, b);
});

test('changes when a source degrades to stale', () => {
  const a = contentHash(sample());
  const b = contentHash(sample({
    sourceHealth: [{ id: 'ical', status: 'stale', fetchedAt: null, error: 'timeout' }],
  }));
  assert.notEqual(a, b, 'a stale badge is visible on the panel, so it must change the hash');
});

test('changes when the battery percent changes', () => {
  const a = contentHash(sample());
  const b = contentHash(sample({ battery: { volts: 3.6, percent: 42 } }));
  assert.notEqual(a, b, 'battery is rendered in the footer');
});

test('ignores battery volts when percent is unchanged', () => {
  const a = contentHash(sample());
  const b = contentHash(sample({ battery: { volts: 4.05, percent: 87 } }));
  assert.equal(a, b, 'volts are not rendered, only percent');
});

test('changes when the weather changes', () => {
  const a = contentHash(sample());
  const b = contentHash(sample({ weather: { ...sample().weather!, currentTempC: 23 } }));
  assert.notEqual(a, b);
});

test('changes when the day rolls over', () => {
  const a = contentHash(sample());
  const b = contentHash(sample({
    today: { iso: '2026-08-04', weekdayLong: 'Tuesday', dayOfMonth: 4, monthLong: 'August' },
  }));
  assert.notEqual(a, b, 'the date is on the panel, so midnight must force a refresh');
});

test('is a stable 32-character hex string', () => {
  assert.match(contentHash(sample()), /^[0-9a-f]{32}$/);
  assert.equal(contentHash(sample()), contentHash(sample()), 'must be deterministic');
});

test('changes when a departure is delayed', () => {
  const onTime = sample({ train: structuredClone(mixedBoard) });
  const delayed = structuredClone(mixedBoard);
  delayed.departures[0] = { scheduled: '07:42', expected: '07:55', status: 'delayed', delayMinutes: 13, platform: '3' };

  // This is exactly why §4 of the spec accepts more frequent refreshes: live
  // times are drawn on the panel, so they must be part of the hash.
  assert.notEqual(contentHash(onTime), contentHash(sample({ train: delayed })));
});
