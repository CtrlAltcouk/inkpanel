import { z } from 'zod';

/** A calendar entity ID is data, never a URL or a relative REST path. */
export const calendarEntityIdSchema = z.string().max(255).regex(/^calendar\.[a-z0-9_]+$/, 'invalid Home Assistant calendar entity ID');
export const calendarEntityIdsSchema = z.array(calendarEntityIdSchema).max(10)
  .refine((ids) => new Set(ids).size === ids.length, 'calendar entity IDs must be unique');

export const homeAssistantCalendarListSchema = z.array(z.object({
  entity_id: calendarEntityIdSchema,
  name: z.string().trim().min(1).max(255),
}));

const date = z.iso.date();
const dateTime = z.iso.datetime({ offset: true });
const details = {
  summary: z.string().optional(),
  uid: z.preprocess((value) => typeof value === 'string' && value.trim().length <= 1024
    ? value.trim() || undefined : undefined, z.string().optional()),
};
// Unknown optional HA metadata is stripped, never cached or sent to a renderer.
export const homeAssistantCalendarEventSchema = z.union([
  z.object({ ...details, start: z.object({ date, dateTime: z.never().optional() }), end: z.object({ date, dateTime: z.never().optional() }) })
    .refine((event) => event.end.date > event.start.date, 'invalid all-day event range'),
  z.object({ ...details, start: z.object({ dateTime, date: z.never().optional() }), end: z.object({ dateTime, date: z.never().optional() }) })
    .refine((event) => Date.parse(event.end.dateTime) >= Date.parse(event.start.dateTime), 'invalid timed event range'),
]);
export const homeAssistantCalendarEventsSchema = z.array(homeAssistantCalendarEventSchema);
export type HomeAssistantCalendarEvent = z.infer<typeof homeAssistantCalendarEventSchema>;
