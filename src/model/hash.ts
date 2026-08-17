import { createHash } from 'node:crypto';
import type { ProfileDashboardData } from './dashboard.ts';

/**
 * Hash only what is visible on the panel.
 *
 * generatedAt, contentChangedAt and per-source fetchedAt are deliberately
 * excluded: including them would make every render unique, so the ETag would
 * always change, 304 would never fire, and the panel would flash on every
 * wake. Battery volts are excluded because only the rounded percent is drawn
 * on the existing large-panel banner. Mini has no global banner, so its hash
 * intentionally omits global weather/battery fields altogether.
 */
export function contentHash(data: ProfileDashboardData): string {
  const displayedStaleTime = (source: ProfileDashboardData['headerWeatherHealth'] | null) =>
    source?.status === 'stale' && source.fetchedAt
      ? new Intl.DateTimeFormat('en-GB', {
          timeZone: data.timezone, hour: '2-digit', minute: '2-digit', hour12: false,
        }).format(new Date(source.fetchedAt))
      : null;
  const visibleSection = (section: ProfileDashboardData['sections'][number]) => {
    if (section.type === 'empty') return section;
    return {
      type: section.type,
      data: section.data,
      // These widgets visibly distinguish an absent configuration ("not set
      // up") from a configured source whose first/live fetch failed
      // ("unavailable"). Health details themselves remain diagnostic-only.
      ...(section.type === 'bins'
        || section.type === 'trains'
        || section.type === 'bus'
        || section.type === 'traffic'
        || section.type === 'octopus'
        ? { configured: section.health !== null }
        : {}),
      displayedStaleTime: displayedStaleTime(section.health),
    };
  };

  let visible: unknown;
  if (data.sections.length === 1) {
    const section = data.sections[0];
    visible = {
      ...(section.type === 'empty' ? {} : { timezone: data.timezone }),
      ...(section.type === 'octopus' ? { today: data.today } : {}),
      sections: [visibleSection(section)],
    };
  } else {
    // Keep the established large-panel hash shape byte-for-byte equivalent.
    visible = {
      timezone: data.timezone,
      today: data.today,
      headerWeather: data.headerWeather,
      sections: data.sections.map(visibleSection),
      batteryPercent: data.battery.percent,
    };
  }
  return createHash('sha256').update(JSON.stringify(visible)).digest('hex').slice(0, 32);
}
