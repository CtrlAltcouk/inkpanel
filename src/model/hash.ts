import { createHash } from 'node:crypto';
import type { DashboardData } from './dashboard.ts';

/**
 * Hash only what is visible on the panel.
 *
 * generatedAt, contentChangedAt and per-source fetchedAt are deliberately
 * excluded: including them would make every render unique, so the ETag would
 * always change, 304 would never fire, and the panel would flash on every
 * wake. Battery volts are excluded because only the rounded percent is drawn.
 */
export function contentHash(data: DashboardData): string {
  const visible = {
    timezone: data.timezone,
    today: data.today,
    calendar: data.calendar,
    weather: data.weather,
    train: data.train,
    sourceHealth: data.sourceHealth.map((s) => ({
      id: s.id,
      status: s.status,
      error: s.error,
    })),
    batteryPercent: data.battery.percent,
  };
  return createHash('sha256').update(JSON.stringify(visible)).digest('hex').slice(0, 32);
}
