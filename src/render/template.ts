import type {
  BusData,
  BusDeparture,
  CalendarData,
  CalendarEvent,
  DashboardData,
  DashboardSectionData,
  SourceHealth,
  TrafficData,
  TrainData,
  TrainDeparture,
  WeatherData,
} from '../model/dashboard.ts';
import type { BinsData } from '../sources/bins.ts';
import type { PanelProfile } from '../panel/profile.ts';
import { panelCss } from './panel.css.ts';

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function hhmm(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso));
}

function clockOnly(value: string): string {
  return value.includes('T') ? value.slice(11, 16) : value;
}

function staleBadge(health: SourceHealth | null, timezone: string): string {
  if (health?.status !== 'stale' || !health.fetchedAt) return '';
  return `<span class="stale">from ${hhmm(health.fetchedAt, timezone)}</span>`;
}

function emptySlot(caption: string): string {
  return `<div class="slot--empty"><span>${esc(caption)}</span></div>`;
}

function eventRow(event: CalendarEvent, timezone: string): string {
  const time = event.allDay ? 'ALL DAY' : hhmm(event.start, timezone);
  return `<div class="event"><span class="t tnum">${esc(time)}</span><span class="n">${esc(event.title)}</span></div>`;
}

function eventList(events: CalendarEvent[], timezone: string, limit: number): string {
  return `<div class="events">${events.slice(0, limit).map((event) => eventRow(event, timezone)).join('')}</div>`;
}

function agendaCell(calendar: CalendarData | null, timezone: string): string {
  if (!calendar) return emptySlot('Calendar unavailable');
  if (calendar.today.length > 0) return eventList(calendar.today, timezone, 6);
  if (calendar.tomorrow.length > 0) {
    return `<div class="subhead">Nothing today &mdash; tomorrow</div>${eventList(calendar.tomorrow, timezone, 5)}`;
  }
  return emptySlot('Nothing scheduled');
}

function forecastCell(weather: WeatherData | null): string {
  if (!weather) return emptySlot('Weather unavailable');
  const days = weather.forecast.map((day) => `<div><div class="w">${esc(day.weekday)}</div><div class="t disp">${day.highC}&deg;</div><div>${esc(day.conditionText)}</div></div>`).join('');
  return `<div class="days">${days}</div><div class="sun tnum">Sunrise ${esc(clockOnly(weather.sunrise))} &middot; Sunset ${esc(clockOnly(weather.sunset))}</div>`;
}

function banner(data: DashboardData): string {
  const weather = data.headerWeather;
  const battery = data.battery.percent === null ? 'Battery --' : `Battery ${data.battery.percent}%`;
  const weatherHtml = weather
    ? `<div class="banner-wx"><div class="detail tnum">H ${weather.highC}&deg; &nbsp; L ${weather.lowC}&deg;<br>Rain ${weather.precipProbability}%<br>${esc(weather.windDirection)} ${weather.windKph}kph</div><div><div class="temp disp">${weather.currentTempC}&deg;</div><div class="cond">${esc(weather.conditionText)}</div></div></div>`
    : '<div class="banner-wx"><div class="cond">Weather unavailable</div></div>';
  return `<div class="banner"><div class="battery">${esc(battery)}</div><div class="banner-date"><div class="d1 disp">${esc(data.today.weekdayLong.slice(0, 3).toUpperCase())} ${data.today.dayOfMonth}</div><div class="d2 disp">${esc(data.today.monthLong.toUpperCase())}</div></div>${weatherHtml}</div>`;
}

function departureRow(departure: TrainDeparture): string {
  const headline = departure.status === 'delayed' && departure.expected ? departure.expected : departure.scheduled;
  let status: string;
  if (departure.status === 'cancelled') status = 'Cancelled';
  else if (departure.status === 'delayed') {
    status = departure.expected
      ? `<span class="dep-was">${esc(departure.scheduled)}</span> ${departure.delayMinutes} late`
      : 'Delayed';
  } else status = 'On time';
  const timeClass = departure.status === 'cancelled' ? 'dep-time dep-was' : 'dep-time';
  const platform = departure.status !== 'cancelled' && departure.platform
    ? `<span class="dep-platform">Plat ${esc(departure.platform)}</span>` : '';
  return `<div class="dep"><span class="${timeClass}">${esc(headline)}</span><span class="dep-status">${status}</span>${platform}</div>`;
}

function trainLabel(train: TrainData | null): string {
  return train ? `${esc(train.originCrs)} &rarr; ${esc(train.destinationName)}` : 'Trains';
}

function trainCell(train: TrainData | null, health: SourceHealth | null): string {
  if (!health) return emptySlot('Trains — not set up');
  if (!train) return emptySlot('Trains unavailable');
  if (train.departures.length === 0) return emptySlot('No departures');
  return train.departures.map(departureRow).join('');
}

function busRow(departure: BusDeparture): string {
  const time = departure.status === 'cancelled'
    ? (departure.scheduled ?? '--:--')
    : (departure.expected ?? departure.scheduled ?? '--:--');
  const statusClass = departure.status === 'cancelled' ? 'bus-time dep-was' : 'bus-time';
  const destination = departure.status === 'cancelled' ? 'Cancelled' : departure.destination;
  return `<div class="bus-row"><span class="bus-line">${esc(departure.line)}</span><span class="${statusClass}">${esc(time)}</span><span class="bus-dest">${esc(destination)}</span></div>`;
}

function busLabel(bus: BusData | null): string {
  return bus ? `Bus &middot; ${esc(bus.stopName)}` : 'Bus';
}

function busCell(bus: BusData | null, health: SourceHealth | null): string {
  if (!health) return emptySlot('Bus — not set up');
  if (!bus) return emptySlot('Bus unavailable');
  if (bus.departures.length === 0) return emptySlot('No bus departures');
  return `<div class="bus-rows">${bus.departures.slice(0, 4).map(busRow).join('')}</div><div class="provider">source: http://transportapi.com/</div>`;
}

function trafficCell(traffic: TrafficData | null, health: SourceHealth | null): string {
  if (!health) return emptySlot('Traffic — not set up');
  if (!traffic) return emptySlot('Traffic unavailable');
  const route = traffic.warning ?? traffic.description ?? (traffic.distanceMiles === null ? '' : `${traffic.distanceMiles} miles`);
  // Show the two Google-provided route durations directly rather than deriving
  // a new delay metric from Google Maps Content.
  return `<div class="traffic-time disp">${traffic.durationMinutes} min</div><div class="traffic-delay">Traffic-aware</div><div class="traffic-static">No live traffic: ${traffic.staticDurationMinutes} min</div>${route ? `<div class="traffic-route">${esc(route)}</div>` : ''}<div class="provider provider--google" translate="no">Google Maps</div>`;
}

const BIN_DATE_FORMAT: Intl.DateTimeFormatOptions = {
  weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
};

function binsCell(bins: BinsData | null, health: SourceHealth | null): string {
  if (!health) return emptySlot('Bins — not set up');
  if (!bins) return emptySlot('Bins unavailable');
  if (!bins.next) return emptySlot('No collection scheduled');
  const when = new Intl.DateTimeFormat('en-GB', BIN_DATE_FORMAT)
    .format(new Date(`${bins.next.date}T12:00:00.000Z`)).toUpperCase();
  const rows = bins.rawLabels.length > 0
    ? bins.rawLabels.map((label, index) => ({
        label,
        type: bins.next!.types[index] ?? bins.next!.types[0] ?? 'general',
      }))
    : bins.next.types.map((type) => ({ label: type, type }));
  const list = rows.map((row) => `<div class="bin-row"><span class="bin-swatch bin--${esc(row.type)}"></span><span>${esc(row.label)}</span></div>`).join('');
  return `<div class="bin-date disp">${esc(when)}</div>${list}`;
}

function renderSection(section: DashboardSectionData, data: DashboardData, position: string): string {
  if (section.type === 'empty') return `<div class="cell cell--${position}"></div>`;
  let label: string;
  let content: string;
  switch (section.type) {
    case 'calendar':
      label = 'Today';
      content = agendaCell(section.data, data.timezone);
      break;
    case 'weather':
      label = 'Next 3 days';
      content = forecastCell(section.data);
      break;
    case 'trains':
      label = trainLabel(section.data);
      content = trainCell(section.data, section.health);
      break;
    case 'bus':
      label = busLabel(section.data);
      content = busCell(section.data, section.health);
      break;
    case 'traffic':
      label = 'Traffic';
      content = trafficCell(section.data, section.health);
      break;
    case 'bins':
      label = 'Bins';
      content = binsCell(section.data, section.health);
      break;
  }
  return `<div class="cell cell--${position}"><div class="label">${label}${staleBadge(section.health, data.timezone)}</div>${content}</div>`;
}

export function renderHtml(data: DashboardData, profile: PanelProfile, fontCss: string): string {
  const positions = ['tl', 'tr', 'bl', 'br'];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${fontCss}${panelCss(profile)}</style></head><body>${banner(data)}<div class="rule"></div><div class="grid">${data.sections.map((section, index) => renderSection(section, data, positions[index]!)).join('')}</div></body></html>`;
}
