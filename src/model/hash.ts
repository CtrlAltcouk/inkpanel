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
  const visibleSection = (section: DashboardData['sections'][number]) => {
    if (section.type === 'empty') return section;
    return {
      type: section.type,
      data: section.data,
      // Bins and Trains render "not set up" when health is absent and
      // "unavailable" when a configured source has no data.
      ...(section.type === 'bins' || section.type === 'trains'
        ? { configured: section.health !== null }
        : {}),
      displayedStaleTime: displayedStaleTime(section.health),
    };
  };
  const visible = {
    timezone: data.timezone,
    today: data.today,
    headerWeather: data.headerWeather,
    sections: data.sections.map(visibleSection),
    batteryPercent: data.battery.percent,
  };
  return createHash('sha256').update(JSON.stringify(visible)).digest('hex').slice(0, 32);
}
