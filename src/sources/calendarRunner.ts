import type { CalendarData, SourceHealth } from '../model/dashboard.ts';
import type { SourceCache } from './cache.ts';
import { expandCalendar, icalFeedSource, type IcalFeedConfig } from './ical.ts';
import { runSource, type RunOutcome, type RunSourceOptions } from './runner.ts';
import type { Source } from './types.ts';

export interface RunCalendarsOptions extends RunSourceOptions {
  now?: Date;
  source?: Source<IcalFeedConfig, string>;
}

function aggregateError(total: number, unavailable: number, stale: number): string | null {
  const parts: string[] = [];
  if (unavailable > 0) parts.push(`${unavailable} of ${total} calendar feeds unavailable`);
  if (stale > 0) parts.push(`${stale} using cached data`);
  return parts.length > 0 ? parts.join('; ') : null;
}

/**
 * Run every distinct feed concurrently with an independent raw-ICS cache.
 * The oldest available fetchedAt is reported because mixed data is only as
 * fresh as its stalest contributing feed.
 */
export async function runCalendars(
  urls: string[],
  timezone: string,
  cache: SourceCache,
  options: RunCalendarsOptions,
): Promise<RunOutcome<CalendarData>> {
  const uniqueUrls = [...new Set(urls)];
  if (uniqueUrls.length === 0) {
    return {
      data: null,
      health: { id: 'ical', status: 'error', fetchedAt: null, error: 'no calendar URLs configured' },
    };
  }

  const source = options.source ?? icalFeedSource;
  const outcomes = await Promise.all(uniqueUrls.map((url) => runSource(
    source,
    { url },
    cache,
    { deviceId: options.deviceId, timeoutMs: options.timeoutMs },
  )));

  const available = outcomes.filter(
    (outcome): outcome is RunOutcome<string> & { data: string } => outcome.data !== null,
  );
  const unavailable = outcomes.filter((outcome) => outcome.health.status === 'error').length;
  const stale = outcomes.filter((outcome) => outcome.health.status === 'stale').length;
  const fetchedAt = available
    .map((outcome) => outcome.health.fetchedAt)
    .filter((value): value is string => value !== null)
    .sort()[0] ?? null;
  const status: SourceHealth['status'] = unavailable > 0
    ? 'error'
    : stale > 0 ? 'stale' : 'ok';

  return {
    data: available.length > 0
      ? expandCalendar(available.map((outcome) => outcome.data), options.now ?? new Date(), timezone)
      : null,
    health: {
      id: 'ical',
      status,
      fetchedAt,
      error: aggregateError(uniqueUrls.length, unavailable, stale),
    },
  };
}
