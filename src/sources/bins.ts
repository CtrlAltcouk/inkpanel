import { z } from 'zod';
import type { Source, SourceResult } from './types.ts';

export type BinType = 'recycling' | 'food' | 'garden' | 'general';

export interface BinCollection {
  /** ISO date, YYYY-MM-DD. */
  date: string;
  types: BinType[];
}

export interface BinsData {
  next: BinCollection | null;
  /** The council's own wording, for display. */
  rawLabels: string[];
}

/**
 * Map free-text council wording to a known type.
 *
 * The council returns descriptive strings that can change without notice, so
 * matching is by keyword rather than exact value. Anything unrecognised becomes
 * `general` and is still rendered: showing an unfamiliar bin is better than
 * silently dropping one that needs putting out.
 */
export function normaliseBinType(label: string): BinType {
  const text = label.toLowerCase();
  if (text.includes('recycl')) return 'recycling';
  if (text.includes('food')) return 'food';
  if (text.includes('garden') || text.includes('green')) return 'garden';
  return 'general';
}

const SESSION_URL =
  'https://mycouncil.milton-keynes.gov.uk/authapi/isauthenticated' +
  '?uri=https%253A%252F%252Fmycouncil.milton-keynes.gov.uk%252Fen%252Fservice%252FWaste_Collection_Round_Checker' +
  '&hostname=mycouncil.milton-keynes.gov.uk&withCredentials=true';

const LOOKUP_URL = 'https://mycouncil.milton-keynes.gov.uk/apibroker/runLookup';

// A form identifier baked into the council's own web form. Undocumented and
// liable to change without notice — the first thing to check when bins break.
const FORM_ID = '64d9feda3a507';

/**
 * The calendar date "today" falls on in the UK, as YYYY-MM-DD.
 *
 * `toISOString().slice(0, 10)` would give the UTC calendar day instead, which
 * during BST is wrong for the hour between UK-local midnight and 01:00 (the
 * UTC clock still reads the previous day). Milton Keynes bin collections are
 * a Europe/London concept, not a UTC one, so the cutoff has to be computed in
 * that zone — the same approach `localDateKey` in ical.ts uses, via
 * `Intl.DateTimeFormat` rather than the Date object's UTC getters.
 *
 * Europe/London is hardcoded rather than threaded through as config: this
 * source only ever talks to Milton Keynes council, so there is no timezone
 * for a caller to supply.
 */
function londonDateKey(instant: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The council's `apibroker/runLookup` response, trimmed to the fields this
 * mapper reads. `rows_data` is an object keyed by row index (not an array) —
 * one entry per bin round — and each row's `NextInstance` is already the
 * council's own computed "next occurrence" for that round, advanced past
 * whatever was last completed. So there is no completed/upcoming filtering
 * to do per-round; the only remaining question is which round's date is
 * soonest relative to "today".
 */
const rowSchema = z.object({
  TaskTypeName: z.string(),
  NextInstance: z.unknown(),
});

const responseSchema = z.object({
  integration: z.object({
    transformed: z.object({
      rows_data: z.record(z.string(), rowSchema),
    }),
  }),
});

function extractRows(raw: unknown): { date: string; label: string }[] {
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`malformed Milton Keynes bin response: ${parsed.error.issues[0]?.message ?? 'unrecognised shape'}`);
  }

  return Object.values(parsed.data.integration.transformed.rows_data)
    // A round with no usable date (e.g. suspended, or the council sending
    // NextInstance: null) is dropped rather than treated as an error: the
    // other rounds are still valid.
    .filter((row): row is { TaskTypeName: string; NextInstance: string } =>
      typeof row.NextInstance === 'string' && ISO_DATE.test(row.NextInstance),
    )
    .map((row) => ({ date: row.NextInstance, label: row.TaskTypeName }));
}

export function mapBins(raw: unknown, today: Date): BinsData {
  const rows = extractRows(raw);

  const cutoff = londonDateKey(today);
  const upcoming = rows.filter((r) => r.date >= cutoff).sort((a, b) => a.date.localeCompare(b.date));
  if (upcoming.length === 0) return { next: null, rawLabels: [] };

  const nextDate = upcoming[0]!.date;
  const sameDay = upcoming.filter((r) => r.date === nextDate);
  const types = [...new Set(sameDay.map((r) => normaliseBinType(r.label)))];

  return { next: { date: nextDate, types }, rawLabels: sameDay.map((r) => r.label) };
}

export const binsSource: Source<{ uprn: string }, BinsData> = {
  id: 'bins',
  async fetch(config, signal): Promise<SourceResult<BinsData>> {
    if (!config.uprn) return { status: 'error', error: 'no UPRN configured' };

    try {
      const sessionRes = await globalThis.fetch(SESSION_URL, { signal });
      if (!sessionRes.ok) throw new Error(`session responded ${sessionRes.status}`);
      const setCookies = sessionRes.headers.getSetCookie?.() ?? [];
      const cookieHeader = setCookies.map((c) => c.split(';')[0]).join('; ');
      const sid = ((await sessionRes.json()) as { 'auth-session'?: string })['auth-session'];
      if (!sid) throw new Error('no auth-session returned');

      const params = new URLSearchParams({
        id: FORM_ID,
        repeat_against: '',
        noRetry: 'false',
        getOnlyTokens: 'undefined',
        log_id: '',
        app_name: 'AF-Renderer::Self',
        _: String(Date.now()),
        sid,
      });

      const res = await globalThis.fetch(`${LOOKUP_URL}?${params}`, {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 'Mozilla/5.0',
          'X-Requested-With': 'XMLHttpRequest',
          Referer: 'https://mycouncil.milton-keynes.gov.uk/fillform/?iframe_id=fillform-frame-1&db_id=',
          // The session step sets a PHPSESSID (etc.) that the lookup step
          // requires; without forwarding it here the lookup responds 403
          // with {"result":"logout"} even though `sid` is valid.
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        },
        body: JSON.stringify({ formValues: { 'Section 1': { uprnCore: { value: config.uprn } } } }),
      });
      if (!res.ok) throw new Error(`bin lookup responded ${res.status}`);

      return {
        status: 'ok',
        data: mapBins(await res.json(), new Date()),
        fetchedAt: new Date().toISOString(),
      };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },
};
