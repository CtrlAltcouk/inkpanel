import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentHash } from '../../src/model/hash.ts';
import type { PrinterStatus } from '../../src/printers/moonraker.ts';
import { dashboardData } from '../fixtures/dashboard.ts';

function status(overrides: Partial<PrinterStatus> = {}): PrinterStatus {
  return {
    name: 'Voron', state: 'printing', filename: 'Benchy.gcode', progressPercent: 68,
    elapsedSeconds: 1000, remainingSeconds: 500, currentLayer: 10, totalLayers: 20,
    nozzle: { current: 220, target: 220 }, bed: { current: 60, target: 60 }, message: null,
    ...overrides,
  };
}
function data(printers: PrinterStatus[]) {
  const value = dashboardData();
  value.sections[0] = { type: 'printers', data: { printers }, configured: true, health: null };
  return value;
}

test('renderer-visible printer changes affect content hash while hidden elapsed/raw state does not', () => {
  const base = data([status()]);
  assert.equal(contentHash(base), contentHash(structuredClone(base)));
  assert.notEqual(contentHash(base), contentHash(data([status({ progressPercent: 69 })])));
  assert.notEqual(contentHash(base), contentHash(data([status({ state: 'paused' })])));
  assert.notEqual(contentHash(base), contentHash(data([status({ currentLayer: 11 })])));
  assert.notEqual(contentHash(base), contentHash(data([status({ nozzle: { current: 221, target: 220 } })])));
  assert.equal(contentHash(base), contentHash(data([status({ elapsedSeconds: 1234 })])), 'elapsed time is normalized but not rendered');
  assert.equal(contentHash(base), contentHash(data([status({ remainingSeconds: 501 })])), 'sub-minute ETA changes that render identically stay stable');
  assert.notEqual(contentHash(base), contentHash(data([status({ remainingSeconds: 560 })])));
});

test('multi-printer hash excludes hero-only details but preserves order and visible progress', () => {
  const first = status({ name: 'One' });
  const second = status({ name: 'Two', progressPercent: 20 });
  const base = data([first, second]);
  assert.equal(contentHash(base), contentHash(data([{ ...first, filename: 'hidden.gcode', remainingSeconds: 999, nozzle: null }, second])));
  assert.notEqual(contentHash(base), contentHash(data([second, first])));
  assert.notEqual(contentHash(base), contentHash(data([first, { ...second, progressPercent: 21 }])));
});

test('offline and unconfigured printer states have distinct hashes', () => {
  const offline = data([status({ state: 'offline', progressPercent: null, filename: null, message: 'Moonraker unavailable' })]);
  const unconfigured = dashboardData();
  unconfigured.sections[0] = { type: 'printers', data: null, configured: false, health: null };
  assert.notEqual(contentHash(offline), contentHash(unconfigured));
  assert.equal(
    contentHash(data([status({ state: 'idle', progressPercent: 68, message: null })])),
    contentHash(data([status({ state: 'idle', progressPercent: 12, message: null })])),
    'non-rendered retained progress does not change an idle frame',
  );
});
