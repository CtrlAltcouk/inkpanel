import { findStation } from './stations.ts';

/**
 * A departure as published, before interpretation.
 *
 * This is the seam the transport plugs into. Both candidate protocols supply
 * these same three fields — Darwin names them std / etd / platform — so
 * everything below is independent of how they were fetched.
 */
export interface RawDeparture {
  /** Scheduled departure, 'HH:MM'. */
  scheduled: string;
  /** 'On time' | 'Cancelled' | 'Delayed' | 'HH:MM' | null. */
  expected: string | null;
  platform: string | null;
}

export type DepartureStatus = 'on-time' | 'delayed' | 'cancelled';

export interface TrainDeparture {
  scheduled: string;
  /** The revised time, set only when it differs from `scheduled`. */
  expected: string | null;
  status: DepartureStatus;
  /** Null when the operator says "Delayed" without saying by how long. */
  delayMinutes: number | null;
  platform: string | null;
}

export interface TrainData {
  originCrs: string;
  originName: string;
  destinationCrs: string;
  destinationName: string;
  departures: TrainDeparture[];
}

/** The cell fits three rows at a size readable at arm's length. */
const MAX_DEPARTURES = 3;

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function minutesOfDay(value: string): number | null {
  const match = HHMM.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Difference in minutes, allowing for the clock rolling past midnight.
 *
 * A service scheduled 23:58 and expected 00:07 is nine minutes late, not
 * 1,431 minutes early. Late-night services are among the most likely to be
 * delayed, so this is the ordinary case rather than an edge case.
 */
function delayBetween(scheduled: number, expected: number): number {
  const diff = expected - scheduled;
  return diff < -720 ? diff + 1440 : diff;
}

export function buildDepartures(raw: RawDeparture[], limit = MAX_DEPARTURES): TrainDeparture[] {
  const out: TrainDeparture[] = [];

  for (const item of raw) {
    const scheduledMinutes = minutesOfDay(item.scheduled);
    // A row we cannot place in time is worse than a missing row.
    if (scheduledMinutes === null) continue;

    const scheduled = item.scheduled.trim();
    const platform = item.platform?.trim() ? item.platform.trim() : null;
    const status = (item.expected ?? '').trim();

    if (/cancel/i.test(status)) {
      out.push({ scheduled, expected: null, status: 'cancelled', delayMinutes: null, platform });
    } else {
      const expectedMinutes = minutesOfDay(status);
      if (expectedMinutes === null) {
        // Either 'On time', absent, or a free-text disruption note. Only an
        // explicit 'Delayed' is treated as a delay; anything else we cannot
        // interpret is shown as on time rather than as alarming nonsense.
        const delayed = /delay/i.test(status);
        out.push({
          scheduled,
          expected: null,
          status: delayed ? 'delayed' : 'on-time',
          // Unknown must be null, never 0 — 0 would render as "0 late".
          delayMinutes: delayed ? null : 0,
          platform,
        });
      } else {
        const delay = delayBetween(scheduledMinutes, expectedMinutes);
        out.push(
          delay > 0
            ? { scheduled, expected: status, status: 'delayed', delayMinutes: delay, platform }
            : { scheduled, expected: null, status: 'on-time', delayMinutes: 0, platform },
        );
      }
    }

    if (out.length === limit) break;
  }

  return out;
}

export function buildTrainData(
  originCrs: string,
  destinationCrs: string,
  raw: RawDeparture[],
): TrainData {
  const origin = findStation(originCrs);
  const destination = findStation(destinationCrs);
  return {
    originCrs: originCrs.toUpperCase(),
    originName: origin?.name ?? originCrs.toUpperCase(),
    destinationCrs: destinationCrs.toUpperCase(),
    destinationName: destination?.name ?? destinationCrs.toUpperCase(),
    departures: buildDepartures(raw),
  };
}
