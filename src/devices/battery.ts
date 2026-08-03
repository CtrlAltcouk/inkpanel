const EMPTY_VOLTS = 3.3;
const FULL_VOLTS = 4.2;

/**
 * Crude linear mapping of a single LiPo cell. A real discharge curve is not
 * linear, but the panel only shows a rounded percentage and the value is
 * advisory. Zero means no battery is connected, not a flat one.
 */
export function batteryPercent(volts: number | null): number | null {
  if (volts === null || volts <= 0) return null;
  const ratio = (volts - EMPTY_VOLTS) / (FULL_VOLTS - EMPTY_VOLTS);
  return Math.round(Math.max(0, Math.min(1, ratio)) * 100);
}
