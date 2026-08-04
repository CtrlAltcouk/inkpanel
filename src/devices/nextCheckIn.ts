import type { DeviceRecord } from './types.ts';

export interface CheckInEstimate {
  /** ISO instant the panel should next collect a frame, if it is on schedule. */
  willAppearBy: string | null;
  /** ISO instant it was expected, if that moment has already passed. */
  overdueSince: string | null;
}

/**
 * When will this panel next pick something up?
 *
 * The device sleeps with its radio off, so nothing can be pushed to it. The
 * best the server can say is when it expects the next check-in, derived from
 * when it last appeared and what it was told to sleep for.
 *
 * A device with no history returns nulls throughout — unknown is deliberately
 * distinct from overdue.
 */
export function nextCheckIn(device: DeviceRecord, now: Date): CheckInEstimate {
  if (!device.lastSeenAt || device.lastWakeSeconds === null || device.lastWakeSeconds === undefined) {
    return { willAppearBy: null, overdueSince: null };
  }

  const due = new Date(new Date(device.lastSeenAt).getTime() + device.lastWakeSeconds * 1000);
  if (Number.isNaN(due.getTime())) return { willAppearBy: null, overdueSince: null };

  return due.getTime() > now.getTime()
    ? { willAppearBy: due.toISOString(), overdueSince: null }
    : { willAppearBy: null, overdueSince: due.toISOString() };
}
