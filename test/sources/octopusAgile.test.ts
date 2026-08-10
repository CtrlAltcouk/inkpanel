import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cheapestUpcomingOctopus,
  createOctopusAgileSource,
  parseOctopusAgileTariffCode,
  type OctopusRateWindow,
} from '../../src/sources/octopusAgile.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('Octopus source derives product from tariff and requests an explicit UTC 24-hour window', async () => {
  const fixedNow = new Date('2026-08-10T21:08:00.000Z');
  let seenUrl = new URL('https://example.invalid/');
  let seenHeaders = new Headers();
  const source = createOctopusAgileSource({
    now: () => fixedNow,
    fetchImpl: (async (input, init) => {
      seenUrl = new URL(String(input));
      seenHeaders = new Headers(init?.headers);
      return jsonResponse({
        results: [
          {
            value_inc_vat: 7.25,
            valid_from: '2026-08-10T22:00:00Z',
            valid_to: '2026-08-10T22:30:00Z',
          },
          {
            value_inc_vat: -1.092,
            valid_from: '2026-08-10T21:30:00Z',
            valid_to: '2026-08-10T22:00:00Z',
          },
          {
            value_inc_vat: 3.5,
            valid_from: '2026-08-10T20:30:00Z',
            valid_to: '2026-08-10T21:00:00Z',
          },
        ],
      });
    }) as typeof fetch,
  });

  const result = await source.fetch(
    { tariffCode: 'e-1r-agile-24-10-01-c' },
    new AbortController().signal,
  );

  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;
  assert.equal(
    seenUrl.pathname,
    '/v1/products/AGILE-24-10-01/electricity-tariffs/E-1R-AGILE-24-10-01-C/standard-unit-rates/',
  );
  assert.equal(seenUrl.searchParams.get('period_from'), '2026-08-10T21:00:00.000Z');
  assert.equal(seenUrl.searchParams.get('period_to'), '2026-08-11T21:00:00.000Z');
  assert.equal(seenHeaders.get('authorization'), null, 'public Agile prices need no account/API secret');
  assert.deepEqual(result.data.slots.map((slot) => slot.pencePerKwh), [-1.092, 7.25]);
  assert.equal(result.data.slots[0]?.validTo, '2026-08-10T22:00:00.000Z');
});

test('cheapest selection supports negative prices and re-evaluates stale windows as slots expire', () => {
  const window: OctopusRateWindow = {
    slots: [
      { validFrom: '2026-08-10T21:00:00.000Z', validTo: '2026-08-10T21:30:00.000Z', pencePerKwh: -2.5 },
      { validFrom: '2026-08-10T21:30:00.000Z', validTo: '2026-08-10T22:00:00.000Z', pencePerKwh: 1.25 },
      { validFrom: '2026-08-10T22:00:00.000Z', validTo: '2026-08-10T22:30:00.000Z', pencePerKwh: 1.25 },
    ],
  };

  const duringCheapSlot = cheapestUpcomingOctopus(window, new Date('2026-08-10T21:10:00.000Z'));
  assert.equal(duringCheapSlot?.cheapest.pencePerKwh, -2.5);
  assert.equal(duringCheapSlot?.isCurrent, true);

  const afterCheapSlot = cheapestUpcomingOctopus(window, new Date('2026-08-10T21:31:00.000Z'));
  assert.equal(afterCheapSlot?.cheapest.validFrom, '2026-08-10T21:30:00.000Z');
  assert.equal(afterCheapSlot?.isCurrent, true);

  const afterEverything = cheapestUpcomingOctopus(window, new Date('2026-08-10T22:31:00.000Z'));
  assert.equal(afterEverything, null);
});

test('tariff parser accepts Agile variants and rejects non-Agile/malformed codes', () => {
  assert.deepEqual(parseOctopusAgileTariffCode('E-1R-AGILE-FLEX-22-11-25-C'), {
    tariffCode: 'E-1R-AGILE-FLEX-22-11-25-C',
    productCode: 'AGILE-FLEX-22-11-25',
  });
  assert.throws(() => parseOctopusAgileTariffCode('E-1R-GO-VAR-22-10-14-C'), /Octopus Agile tariff code/);
  assert.throws(() => parseOctopusAgileTariffCode('AGILE-24-10-01-C'), /Octopus Agile tariff code/);
});

test('Octopus endpoint override must remain HTTPS and credential-free', () => {
  assert.throws(() => createOctopusAgileSource({ baseUrl: 'http://octopus.example.test/v1/' }), /HTTPS/);
  assert.throws(
    () => createOctopusAgileSource({ baseUrl: 'https://user:pass@octopus.example.test/v1/' }),
    /credentials/,
  );
});
