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
  const health = (source: DashboardData['headerWeatherHealth'] | null, showStaleTime = false) => source && ({
    id: source.id,
    status: source.status,
    error: source.error,
    displayedStaleTime: showStaleTime && source.status === 'stale' && source.fetchedAt
      ? new Intl.DateTimeFormat('en-GB', {
          timeZone: data.timezone, hour: '2-digit', minute: '2-digit', hour12: false,
        }).format(new Date(source.fetchedAt))
      : null,
  });
  const visible = {
    timezone: data.timezone,
    today: data.today,
    headerWeather: data.headerWeather,
    headerWeatherHealth: health(data.headerWeatherHealth),
    sections: data.sections.map((section) => section.type === 'empty'
      ? section
      : { ...section, health: health(section.health, true) }),
    batteryPercent: data.battery.percent,
  };
  return createHash('sha256').update(JSON.stringify(visible)).digest('hex').slice(0, 32);
}
