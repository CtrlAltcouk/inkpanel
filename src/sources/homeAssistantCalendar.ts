import { createHash } from 'node:crypto';
import type { HomeAssistantClient } from '../homeAssistant/client.ts';
import { calendarEntityIdSchema, homeAssistantCalendarEventsSchema, type HomeAssistantCalendarEvent } from '../homeAssistant/calendarSchemas.ts';
import type { CalendarData, CalendarEvent } from '../model/dashboard.ts';
import type { SourceCache } from './cache.ts';
import { localDateKey } from './ical.ts';
import { runSource, type RunOutcome, type RunSourceOptions } from './runner.ts';
import type { Source } from './types.ts';

const SOURCE_ID = 'home-assistant-calendar';
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** Bounded UTC envelope around two panel-local dates, including every UTC offset and DST. */
export function homeAssistantCalendarWindow(now: Date, timezone: string) {
  const today = localDateKey(now, timezone);
  return { start: `${addDays(today, -1)}T00:00:00.000Z`, end: `${addDays(today, 3)}T00:00:00.000Z` };
}

export function normalizeHomeAssistantCalendars(
  calendars: Array<{ entityId: string; events: HomeAssistantCalendarEvent[] }>, now: Date, timezone: string,
): CalendarData {
  const todayKey = localDateKey(now, timezone);
  const tomorrowKey = addDays(todayKey, 1);
  const result: CalendarData = { today: [], tomorrow: [] };
  for (const { entityId, events } of calendars) {
    for (const event of events) {
      const allDay = 'date' in event.start;
      const start = 'date' in event.start ? `${event.start.date}T00:00:00.000Z` : new Date(event.start.dateTime).toISOString();
      const end = 'date' in event.end ? `${event.end.date}T00:00:00.000Z` : new Date(event.end.dateTime).toISOString();
      const title = event.summary?.trim() || '(no title)';
      const uid = event.uid || createHash('sha256').update(JSON.stringify([entityId, start, end, title])).digest('hex');
      const normalized: CalendarEvent = { uid, title, start, end, allDay };
      const includes = (day: string) => allDay
        // Date-only events are floating local dates, never instants converted across zones.
        ? start.slice(0, 10) <= day && day < end.slice(0, 10)
        : localDateKey(new Date(start), timezone) === day;
      if (includes(todayKey)) result.today.push(normalized);
      if (includes(tomorrowKey)) result.tomorrow.push(normalized);
    }
  }
  const compare = (a: CalendarEvent, b: CalendarEvent) => a.start.localeCompare(b.start)
    || a.title.localeCompare(b.title) || a.end.localeCompare(b.end) || Number(a.allDay) - Number(b.allDay)
    || a.uid.localeCompare(b.uid);
  result.today.sort(compare);
  result.tomorrow.sort(compare);
  return result;
}

interface CalendarSourceConfig { instance: string; entityId: string; start: string; end: string }

/** Per-entity last-good raw events, scoped to instance + bounded window + device. No credentials. */
export async function runHomeAssistantCalendars(
  entityIds: string[], timezone: string, client: HomeAssistantClient | undefined, cache: SourceCache,
  options: RunSourceOptions & { now?: Date },
): Promise<RunOutcome<CalendarData>> {
  const unavailable = (error: string): RunOutcome<CalendarData> => ({
    data: null, health: { id: SOURCE_ID, status: 'error', fetchedAt: null, error },
  });
  const instance = client?.calendarCacheScope;
  if (!client || !instance) return unavailable('Home Assistant calendars are unavailable');
  const ids = [...new Set(entityIds)];
  if (ids.length === 0) return unavailable('no Home Assistant calendars selected');
  if (ids.length > 10 || ids.some((id) => !calendarEntityIdSchema.safeParse(id).success)) {
    return unavailable('invalid Home Assistant calendar selection');
  }
  const now = options.now ?? new Date();
  const window = homeAssistantCalendarWindow(now, timezone);
  const source: Source<CalendarSourceConfig, HomeAssistantCalendarEvent[]> = {
    id: SOURCE_ID,
    async fetch(config, signal) {
      const result = await client.getCalendarEvents(config.entityId, config.start, config.end, signal);
      return result.available
        ? { status: 'ok', data: result.data, fetchedAt: new Date().toISOString() }
        : { status: 'error', error: result.error };
    },
  };
  const outcomes = await Promise.all(ids.map(async (entityId) => {
    const outcome = await runSource(source, { instance, entityId, ...window }, cache, options);
    // Cache files are not a trusted API boundary either. Never render malformed saved data.
    const parsed = homeAssistantCalendarEventsSchema.safeParse(outcome.data);
    return { entityId, outcome: parsed.success ? { ...outcome, data: parsed.data } : {
      data: null, health: { id: SOURCE_ID, status: 'error' as const, fetchedAt: null, error: 'Home Assistant calendar data unavailable' },
    } };
  }));
  const available = outcomes.filter(({ outcome }) => outcome.data !== null);
  const failed = outcomes.filter(({ outcome }) => outcome.health.status === 'error').length;
  const stale = outcomes.filter(({ outcome }) => outcome.health.status === 'stale').length;
  const errors = [
    ...(failed ? [`${failed} of ${ids.length} Home Assistant calendars unavailable`] : []),
    ...(stale ? [`${stale} using cached data`] : []),
  ];
  return {
    data: available.length ? normalizeHomeAssistantCalendars(available.map(({ entityId, outcome }) => ({
      entityId, events: outcome.data!,
    })), now, timezone) : null,
    health: {
      id: SOURCE_ID, status: failed ? 'error' : stale ? 'stale' : 'ok',
      fetchedAt: available.map(({ outcome }) => outcome.health.fetchedAt).filter((v): v is string => v !== null).sort()[0] ?? null,
      error: errors.join('; ') || null,
    },
  };
}
