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
  const displayedStaleTime = (source: DashboardData['headerWeatherHealth'] | null) =>
    source?.status === 'stale' && source.fetchedAt
      ? new Intl.DateTimeFormat('en-GB', {
          timeZone: data.timezone, hour: '2-digit', minute: '2-digit', hour12: false,
        }).format(new Date(source.fetchedAt))
      : null;
  const visible = {
    timezone: data.timezone,
    today: data.today,
    headerWeather: data.headerWeather,
    sections: data.sections.map((section) => section.type === 'empty'
      ? section
      : { type: section.type, data: section.data, displayedStaleTime: displayedStaleTime(section.health) }),
    batteryPercent: data.battery.percent,
  };
  return createHash('sha256').update(JSON.stringify(visible)).digest('hex').slice(0, 32);
}
