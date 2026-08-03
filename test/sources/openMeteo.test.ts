import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapOpenMeteo, describeWeatherCode } from '../../src/sources/openMeteo.ts';
import { describeWindDirection } from '../../src/sources/weatherCodes.ts';
import { MK_FORECAST } from '../fixtures/openMeteo.ts';

test('maps current conditions', () => {
  const w = mapOpenMeteo(MK_FORECAST);
  assert.equal(w.currentTempC, 22, 'rounded for display');
  assert.equal(w.conditionText, 'Partly cloudy');
  assert.equal(w.highC, 24);
  assert.equal(w.lowC, 13);
  assert.equal(w.precipProbability, 10);
  assert.equal(w.windKph, 13);
  assert.equal(w.windDirection, 'NW');
});

test('produces exactly three forecast days, excluding today', () => {
  const w = mapOpenMeteo(MK_FORECAST);
  assert.equal(w.forecast.length, 3);
  assert.deepEqual(w.forecast.map((d) => d.weekday), ['TUE', 'WED', 'THU']);
  assert.equal(w.forecast[1]?.conditionText, 'Rain');
});

test('carries sunrise and sunset through unchanged', () => {
  const w = mapOpenMeteo(MK_FORECAST);
  assert.equal(w.sunrise, '2026-08-03T05:34');
  assert.equal(w.sunset, '2026-08-03T20:47');
});

test('describes WMO codes', () => {
  assert.equal(describeWeatherCode(0), 'Clear');
  assert.equal(describeWeatherCode(61), 'Rain');
  assert.equal(describeWeatherCode(95), 'Thunderstorm');
  assert.equal(describeWeatherCode(999), 'Unknown');
});

test('maps wind bearings to compass points', () => {
  assert.equal(describeWindDirection(0), 'N');
  assert.equal(describeWindDirection(90), 'E');
  assert.equal(describeWindDirection(180), 'S');
  assert.equal(describeWindDirection(315), 'NW');
  assert.equal(describeWindDirection(359), 'N', 'wraps past 360');
  assert.equal(describeWindDirection(360), 'N');
});

test('rejects a malformed payload rather than rendering nonsense', () => {
  assert.throws(() => mapOpenMeteo({ current: {} }), /malformed/i);
  assert.throws(() => mapOpenMeteo(null), /malformed/i);
  assert.throws(() => mapOpenMeteo({ ...MK_FORECAST, daily: { ...MK_FORECAST.daily, time: ['2026-08-03'] } }), /malformed/i);
});
