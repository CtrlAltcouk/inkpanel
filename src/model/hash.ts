import { createHash } from 'node:crypto';
import type { CalendarEvent, ProfileDashboardData } from './dashboard.ts';

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
    const printerData = section.type === 'printers' && section.data
      ? {
          printers: section.data.printers.map((printer) => {
            const active = printer.state === 'printing' || printer.state === 'paused';
            if (section.data!.printers.length > 1) {
              return {
                name: printer.name,
                state: printer.state,
                progressPercent: active ? printer.progressPercent : null,
              };
            }
            const detailed = active;
            return {
              name: printer.name,
              state: printer.state,
              progressPercent: active
                ? (data.sections.length === 1 ? (printer.progressPercent ?? 0) : printer.progressPercent)
                : null,
              ...(detailed ? {
                filename: printer.filename,
                remainingMinutes: printer.remainingSeconds === null ? null : Math.max(0, Math.round(printer.remainingSeconds / 60)),
                currentLayer: printer.currentLayer,
                totalLayers: printer.totalLayers,
                nozzle: printer.nozzle,
                bed: data.sections.length === 1 && !printer.nozzle ? null : printer.bed,
              } : { message: printer.message }),
            };
          }),
        }
      : null;
    return {
      type: section.type,
      data: section.type === 'todo' && section.data
        ? { items: section.data.items.slice(0, 5) }
        : section.type === 'printers' ? printerData
        : section.type === 'calendar' && section.data
          ? Object.fromEntries(Object.entries(section.data).map(([day, events]) => [
              day, events.map(({ title, start, end, allDay }: CalendarEvent) => ({ title, start, end, allDay })),
            ]))
          : section.data,
      // These widgets visibly distinguish an absent configuration ("not set
      // up") from a configured source whose first/live fetch failed
      // ("unavailable"). Health details themselves remain diagnostic-only.
      ...(section.type === 'bins'
        || section.type === 'trains'
        || section.type === 'bus'
        || section.type === 'traffic'
        || section.type === 'octopus'
        ? { configured: section.health !== null }
        : section.type === 'todo'
          ? { configured: section.configured }
        : section.type === 'printers'
          ? { configured: section.configured }
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
    // Keep the established large-panel global fields; source metadata stays hidden.
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
