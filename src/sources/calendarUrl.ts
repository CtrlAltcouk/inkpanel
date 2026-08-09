import { isIP } from 'node:net';
import { z } from 'zod';

export class CalendarUrlError extends Error {
  readonly name = 'CalendarUrlError';
}

function isDnsHostname(value: string): boolean {
  if (value.length === 0 || value.length > 253 || value.includes('..')) return false;
  const hostname = value.endsWith('.') ? value.slice(0, -1) : value;
  return hostname.length > 0 && hostname.split('.').every((label) =>
    label.length >= 1 && label.length <= 63 &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label));
}

/** Parse a calendar URL without ever reflecting its secret path/query in errors. */
export function parseCalendarUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new CalendarUrlError('calendar URL must be a valid absolute URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new CalendarUrlError('calendar URL must use HTTP or HTTPS');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new CalendarUrlError('calendar URL must not contain credentials');
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname) === 0 && !isDnsHostname(hostname)) {
    throw new CalendarUrlError('calendar URL must contain a valid hostname');
  }
  return parsed;
}

/** Stricter schema for new management writes; frozen persistence schemas do not use it. */
export const calendarUrlInputSchema = z.string().superRefine((value, ctx) => {
  try {
    parseCalendarUrl(value);
  } catch (err) {
    ctx.addIssue({
      code: 'custom',
      message: err instanceof CalendarUrlError ? err.message : 'invalid calendar URL',
    });
  }
});

export function calendarHostDescription(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
}
