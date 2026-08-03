import type { DeviceRecord } from '../devices/types.ts';

export const MIN_WAKE_SECONDS = 60;
const DAY_SECONDS = 24 * 3600;

export interface WakeInput {
  now: Date;
  device: DeviceRecord;
  batteryVolts: number | null;
}

interface LocalClock {
  hour: number;
  minute: number;
  second: number;
}

function localClock(now: Date, timezone: string): LocalClock {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const num = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  // en-GB renders midnight as "24" in some ICU versions.
  return { hour: num('hour') % 24, minute: num('minute'), second: num('second') };
}

function inQuietHours(clock: LocalClock, start: number, end: number): boolean {
  if (start === end) return false; // quiet hours disabled
  return start < end
    ? clock.hour >= start && clock.hour < end
    : clock.hour >= start || clock.hour < end; // window crosses midnight
}

function secondsUntilHour(clock: LocalClock, hour: number): number {
  const nowSeconds = clock.hour * 3600 + clock.minute * 60 + clock.second;
  const targetSeconds = hour * 3600;
  const delta = targetSeconds - nowSeconds;
  return delta > 0 ? delta : delta + DAY_SECONDS;
}

/**
 * Decide how long the device should sleep. Rules are evaluated in order.
 *
 * Around a DST transition this can be an hour out for a single wake, because
 * it works in local wall-clock time rather than absolute offsets. That is an
 * accepted trade for keeping the arithmetic comprehensible.
 */
export function nextWakeSeconds({ now, device, batteryVolts }: WakeInput): number {
  const clamp = (seconds: number) =>
    Math.max(MIN_WAKE_SECONDS, Math.min(DAY_SECONDS, Math.round(seconds)));

  if (!device.claimed) return clamp(device.unclaimedIntervalSeconds);

  if (batteryVolts !== null && batteryVolts < device.lowBatteryVolts) {
    return clamp(device.lowBatteryIntervalSeconds);
  }

  const clock = localClock(now, device.timezone);
  if (inQuietHours(clock, device.quietHoursStart, device.quietHoursEnd)) {
    return clamp(secondsUntilHour(clock, device.quietHoursEnd));
  }

  return clamp(device.activeIntervalSeconds);
}
