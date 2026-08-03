import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandCalendar, localDateKey } from '../../src/sources/ical.ts';
import * as fx from '../fixtures/ics.ts';

const TZ = 'Europe/London';
// Monday 3 August 2026, 07:00 UTC (08:00 London).
const NOW = new Date('2026-08-03T07:00:00.000Z');

test('localDateKey formats in the target zone', () => {
  // 23:30 UTC on 2 Aug is 00:30 on 3 Aug in London (BST).
  assert.equal(localDateKey(new Date('2026-08-02T23:30:00.000Z'), TZ), '2026-08-03');
  assert.equal(localDateKey(new Date('2026-08-02T22:30:00.000Z'), TZ), '2026-08-02');
});

test('picks up a single timed event today', () => {
  const cal = expandCalendar([fx.SINGLE_TIMED], NOW, TZ);
  assert.equal(cal.today.length, 1);
  assert.equal(cal.today[0]?.title, 'Team standup');
  assert.equal(cal.today[0]?.allDay, false);
});

test('treats an all-day event as today without timezone drift', () => {
  const cal = expandCalendar([fx.ALL_DAY], NOW, TZ);
  assert.equal(cal.today.length, 1);
  assert.equal(cal.today[0]?.allDay, true);
  assert.equal(cal.today[0]?.title, 'Bank holiday');
});

test('expands a weekly recurrence onto today', () => {
  const cal = expandCalendar([fx.WEEKLY], NOW, TZ);
  assert.equal(cal.today.length, 1, 'Monday 3 Aug is a weekday occurrence');
  assert.equal(cal.today[0]?.title, 'Daily sync');
});

test('honours EXDATE cancellations', () => {
  const cal = expandCalendar([fx.WEEKLY_WITH_EXDATE], NOW, TZ);
  assert.equal(cal.today.length, 0, '3 Aug was cancelled via EXDATE');
  assert.equal(cal.tomorrow.length, 1, 'but 4 Aug still occurs');
});

test('separates tomorrow from today', () => {
  const cal = expandCalendar([fx.SINGLE_TIMED, fx.TOMORROW], NOW, TZ);
  assert.equal(cal.today.length, 1);
  assert.equal(cal.tomorrow.length, 1);
  assert.equal(cal.tomorrow[0]?.title, 'Train to Euston');
});

test('merges multiple calendars and sorts by start time', () => {
  const cal = expandCalendar([fx.TOMORROW, fx.SINGLE_TIMED, fx.WEEKLY], NOW, TZ);
  const titles = cal.today.map((e) => e.title);
  assert.deepEqual(titles, ['Team standup', 'Daily sync'], '08:30 sorts before 09:30');
});

test('handles an empty calendar', () => {
  const cal = expandCalendar([fx.EMPTY], NOW, TZ);
  assert.deepEqual(cal, { today: [], tomorrow: [] });
});

test('one malformed feed does not take down the others', () => {
  const cal = expandCalendar([fx.MALFORMED, fx.SINGLE_TIMED], NOW, TZ);
  assert.equal(cal.today.length, 1, 'the good feed still renders');
});

test('survives the spring DST transition', () => {
  // 29 March 2026 is the UK spring-forward. A 09:30 UTC weekly event still
  // resolves onto the correct local day.
  const dstNow = new Date('2026-03-30T07:00:00.000Z'); // Monday after
  const cal = expandCalendar([fx.WEEKLY], dstNow, TZ);
  assert.equal(cal.today.length, 1);
});

test('a weekend day has no weekday occurrences', () => {
  // Saturday 8 August 2026.
  const saturday = new Date('2026-08-08T07:00:00.000Z');
  const cal = expandCalendar([fx.WEEKLY], saturday, TZ);
  assert.equal(cal.today.length, 0);
  assert.equal(cal.tomorrow.length, 0, 'Sunday is also excluded');
});

test('returns ISO instants, not Date objects', () => {
  const cal = expandCalendar([fx.SINGLE_TIMED], NOW, TZ);
  assert.equal(typeof cal.today[0]?.start, 'string');
  assert.match(cal.today[0]!.start, /^\d{4}-\d{2}-\d{2}T/);
});
