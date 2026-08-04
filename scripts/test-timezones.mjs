#!/usr/bin/env node
/**
 * Run the test suite under several server timezones.
 *
 * Date handling bugs in this project are invisible on a single machine: an
 * all-day calendar event materialises at local midnight, so a dev box in
 * London and a container running UTC disagree about which day it falls on.
 * A suite that only ever runs in one zone cannot catch that.
 *
 * No dependency on cross-env — this spawns with an explicit environment so it
 * behaves the same on Windows and Linux.
 */
import { spawnSync } from 'node:child_process';

const ZONES = ['UTC', 'Europe/London', 'America/New_York', 'Pacific/Auckland'];

let failed = false;

for (const timeZone of ZONES) {
  process.stdout.write(`\n=== TZ=${timeZone} ===\n`);
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--test', 'test/**/*.test.ts', 'test/**/*.test.js'],
    { stdio: 'inherit', env: { ...process.env, TZ: timeZone } },
  );
  if (result.status !== 0) {
    failed = true;
    process.stdout.write(`FAILED under TZ=${timeZone}\n`);
  }
}

if (failed) {
  process.stdout.write('\nAt least one timezone failed.\n');
  process.exit(1);
}
process.stdout.write('\nAll timezones passed.\n');
