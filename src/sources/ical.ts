import ical from 'node-ical';
import type { CalendarResponse, VEvent } from 'node-ical';
import type { CalendarData, CalendarEvent } from '../model/dashboard.ts';
import type { Source, SourceResult } from './types.ts';

/** The calendar day an instant falls on, in the given zone: "YYYY-MM-DD". */
export function localDateKey(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function utcDateKey(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

/**
 * Recover the authored calendar date of an all-day event.
 *
 * All-day events carry a *floating* date with no zone. node-ical materialises
 * these as `new Date(year, month, day)` — that is, midnight in whatever
 * timezone the **server process** happens to run in. Reading such a Date as
 * UTC shifts it a day west of Greenwich and is wrong in the other direction
 * east of it, so the bug only appears on some machines: a dev box in London
 * disagrees with a container running UTC.
 *
 * Using the system-local getters is the exact inverse of that construction,
 * so it recovers the authored date whatever the server's timezone is.
 */
function floatingDateKey(instant: Date): string {
  const year = instant.getFullYear();
  const month = String(instant.getMonth() + 1).padStart(2, '0');
  const day = String(instant.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addDays(key: string, days: number): string {
  const d = new Date(`${key}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return utcDateKey(d);
}

/**
 * A CalendarResponse holds VEVENTs alongside VTIMEZONEs, VTODOs and calendar
 * metadata, so entries must be narrowed rather than assumed.
 */
function isVEvent(entry: unknown): entry is VEvent {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    (entry as { type?: unknown }).type === 'VEVENT'
  );
}

function toEvent(uid: string, title: string, start: Date, end: Date, allDay: boolean): CalendarEvent {
  return {
    uid,
    title: title.trim() || '(no title)',
    start: start.toISOString(),
    end: end.toISOString(),
    allDay,
  };
}

/**
 * Expand one or more iCalendar documents into today's and tomorrow's events.
 *
 * Recurrence is expanded over a window that generously brackets the two days
 * of interest, then filtered by local date key. Comparing date keys rather
 * than computing zone offsets keeps DST out of the arithmetic entirely.
 */
export function expandCalendar(icsTexts: string[], now: Date, timezone: string): CalendarData {
  const todayKey = localDateKey(now, timezone);
  const tomorrowKey = addDays(todayKey, 1);

  const windowStart = new Date(`${addDays(todayKey, -1)}T00:00:00.000Z`);
  const windowEnd = new Date(`${addDays(todayKey, 3)}T00:00:00.000Z`);

  const collected: CalendarEvent[] = [];

  for (const text of icsTexts) {
    let parsed: CalendarResponse;
    try {
      parsed = ical.sync.parseICS(text);
    } catch {
      continue; // A malformed feed must not take the others down.
    }

    for (const entry of Object.values(parsed)) {
      if (!isVEvent(entry)) continue;
      const event = entry;
      if (!event.start || !event.end) continue;

      const allDay = event.datetype === 'date';
      const durationMs = event.end.getTime() - event.start.getTime();
      const summary = typeof event.summary === 'string' ? event.summary : '';

      if (!event.rrule) {
        collected.push(toEvent(event.uid, summary, event.start, event.end, allDay));
        continue;
      }

      const excluded = new Set(
        Object.values(event.exdate ?? {})
          .filter((d): d is Date => d instanceof Date)
          .map((d) => d.toISOString()),
      );

      for (const occurrence of event.rrule.between(windowStart, windowEnd, true)) {
        if (excluded.has(occurrence.toISOString())) continue;

        // A modified instance (RECURRENCE-ID) overrides the generated one.
        // node-ical keys these by both date-only and full ISO timestamp; the
        // date-only form is the one that matches a generated occurrence.
        const override = event.recurrences?.[utcDateKey(occurrence)];
        const overrideStart = override?.start;
        const overrideEnd = override?.end;

        // instanceof rather than a cast: Omit<VEvent, 'recurrences'> widens
        // these to {}, and this is a real runtime guard as well as a narrowing.
        if (overrideStart instanceof Date && overrideEnd instanceof Date) {
          collected.push(
            toEvent(event.uid, String(override?.summary ?? summary), overrideStart, overrideEnd, allDay),
          );
        } else {
          collected.push(
            toEvent(event.uid, summary, occurrence, new Date(occurrence.getTime() + durationMs), allDay),
          );
        }
      }
    }
  }

  const keyOf = (e: CalendarEvent) =>
    e.allDay ? floatingDateKey(new Date(e.start)) : localDateKey(new Date(e.start), timezone);

  const byStart = (a: CalendarEvent, b: CalendarEvent) => a.start.localeCompare(b.start);

  return {
    today: collected.filter((e) => keyOf(e) === todayKey).sort(byStart),
    tomorrow: collected.filter((e) => keyOf(e) === tomorrowKey).sort(byStart),
  };
}

export interface IcalConfig {
  urls: string[];
  timezone: string;
}

export const icalSource: Source<IcalConfig, CalendarData> = {
  id: 'ical',
  async fetch(config, signal): Promise<SourceResult<CalendarData>> {
    if (config.urls.length === 0) {
      return { status: 'error', error: 'no calendar URLs configured' };
    }
    try {
      const texts = await Promise.all(
        config.urls.map(async (url) => {
          const res = await globalThis.fetch(url, { signal });
          if (!res.ok) throw new Error(`${url} responded ${res.status}`);
          return res.text();
        }),
      );
      return {
        status: 'ok',
        data: expandCalendar(texts, new Date(), config.timezone),
        fetchedAt: new Date().toISOString(),
      };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },
};
