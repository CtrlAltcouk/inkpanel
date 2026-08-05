import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDepartures, buildTrainData } from '../../src/sources/train.ts';

test('an on-time departure carries no expected time', () => {
  const [d] = buildDepartures([{ scheduled: '07:42', expected: 'On time', platform: '3' }]);
  assert.equal(d?.status, 'on-time');
  assert.equal(d?.expected, null, 'nothing to show beside the scheduled time');
  assert.equal(d?.delayMinutes, 0);
  assert.equal(d?.platform, '3');
});

test('a null expected time is treated as on time, not as an error', () => {
  // Darwin omits etd on some services. Absent is not the same as broken.
  assert.equal(buildDepartures([{ scheduled: '07:42', expected: null, platform: null }])[0]?.status, 'on-time');
});

test('an expected time later than scheduled is a delay, with the minutes computed', () => {
  const [d] = buildDepartures([{ scheduled: '07:58', expected: '08:01', platform: '1' }]);
  assert.equal(d?.status, 'delayed');
  assert.equal(d?.expected, '08:01');
  assert.equal(d?.delayMinutes, 3);
});

test('a delay across midnight is 9 minutes, not 1431', () => {
  // Naive subtraction gives 7 - 1438 = -1431. The panel would show a nonsense
  // number on the one service most likely to be delayed.
  const [d] = buildDepartures([{ scheduled: '23:58', expected: '00:07', platform: null }]);
  assert.equal(d?.status, 'delayed');
  assert.equal(d?.delayMinutes, 9);
});

test('an expected time equal to or earlier than scheduled is on time', () => {
  assert.equal(buildDepartures([{ scheduled: '07:42', expected: '07:42', platform: null }])[0]?.status, 'on-time');
  assert.equal(buildDepartures([{ scheduled: '07:42', expected: '07:40', platform: null }])[0]?.status, 'on-time');
});

test('a cancelled service is cancelled regardless of wording', () => {
  for (const wording of ['Cancelled', 'CANCELLED', 'Cancelled at Rugby']) {
    const [d] = buildDepartures([{ scheduled: '08:34', expected: wording, platform: '2' }]);
    assert.equal(d?.status, 'cancelled', wording);
  }
});

test('"Delayed" with no replacement time is a delay of unknown length', () => {
  const [d] = buildDepartures([{ scheduled: '08:34', expected: 'Delayed', platform: null }]);
  assert.equal(d?.status, 'delayed');
  assert.equal(d?.delayMinutes, null, 'unknown is null, never 0 — 0 would render "0 late"');
  assert.equal(d?.expected, null);
});

test('caps at three departures, because that is what the cell fits', () => {
  const many = ['07:42', '08:01', '08:19', '08:34', '08:50'].map((scheduled) => ({
    scheduled, expected: 'On time', platform: null,
  }));
  assert.equal(buildDepartures(many).length, 3);
  assert.equal(buildDepartures(many, 2).length, 2);
});

test('fewer than three departures is valid, not an error', () => {
  assert.equal(buildDepartures([{ scheduled: '23:47', expected: 'On time', platform: '1' }]).length, 1);
  assert.deepEqual(buildDepartures([]), []);
});

test('a departure with an unparseable scheduled time is dropped, not rendered', () => {
  const out = buildDepartures([
    { scheduled: 'nonsense', expected: 'On time', platform: null },
    { scheduled: '07:42', expected: 'On time', platform: null },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.scheduled, '07:42');
});

test('an empty platform string becomes null so the column is omitted', () => {
  assert.equal(buildDepartures([{ scheduled: '07:42', expected: 'On time', platform: '  ' }])[0]?.platform, null);
});

test('buildTrainData resolves station names from the bundled list', () => {
  const data = buildTrainData('MKC', 'EUS', [{ scheduled: '07:42', expected: 'On time', platform: '3' }]);
  assert.equal(data.originCrs, 'MKC');
  assert.match(data.originName, /Milton Keynes/);
  assert.match(data.destinationName, /Euston/);
  assert.equal(data.departures.length, 1);
});

test('an unknown CRS falls back to the code itself rather than blank', () => {
  const data = buildTrainData('ZZZ', 'QQQ', []);
  assert.equal(data.originName, 'ZZZ', 'a code is more useful than an empty heading');
  assert.equal(data.destinationName, 'QQQ');
});
