import type { CalendarEvent, DashboardData, TrainDeparture } from '../model/dashboard.ts';
import type { PanelProfile } from '../panel/profile.ts';
import { panelCss } from './panel.css.ts';

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function hhmm(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso));
}

/** Open-Meteo returns naive local times like "2026-08-03T20:47". */
function clockOnly(value: string): string {
  return value.includes('T') ? value.slice(11, 16) : value;
}

function staleBadge(data: DashboardData, id: string): string {
  const health = data.sourceHealth.find((s) => s.id === id);
  if (health?.status !== 'stale' || !health.fetchedAt) return '';
  return `<span class="stale">from ${hhmm(health.fetchedAt, data.timezone)}</span>`;
}

function emptySlot(caption: string): string {
  return `<div class="slot--empty"><span>${esc(caption)}</span></div>`;
}

function eventRow(event: CalendarEvent, timezone: string): string {
  const time = event.allDay ? 'ALL DAY' : hhmm(event.start, timezone);
  return `<div class="event"><span class="t tnum">${esc(time)}</span><span class="n">${esc(event.title)}</span></div>`;
}

function eventList(events: CalendarEvent[], timezone: string, limit: number): string {
  return `<div class="events">${events.slice(0, limit).map((e) => eventRow(e, timezone)).join('')}</div>`;
}

function agendaCell(data: DashboardData): string {
  if (!data.calendar) return emptySlot('Calendar unavailable');

  const { today, tomorrow } = data.calendar;
  if (today.length > 0) return eventList(today, data.timezone, 6);

  // A free day is far more useful showing what is coming than showing a box
  // that says nothing. It also distinguishes "working, quiet day" from
  // "calendar broken", which an empty panel alone does not.
  if (tomorrow.length > 0) {
    return `<div class="subhead">Nothing today &mdash; tomorrow</div>
      ${eventList(tomorrow, data.timezone, 5)}`;
  }

  return emptySlot('Nothing scheduled');
}

function forecastCell(data: DashboardData): string {
  const weather = data.weather;
  if (!weather) return emptySlot('Weather unavailable');
  const days = weather.forecast
    .map((d) => `<div><div class="w">${esc(d.weekday)}</div><div class="t disp">${d.highC}&deg;</div><div>${esc(d.conditionText)}</div></div>`)
    .join('');
  return `<div class="days">${days}</div>
    <div class="sun tnum">Sunrise ${esc(clockOnly(weather.sunrise))} &middot; Sunset ${esc(clockOnly(weather.sunset))}</div>`;
}

function banner(data: DashboardData): string {
  const weather = data.weather;
  const wx = weather
    ? `<div class="banner-wx">
         <div class="detail tnum">H ${weather.highC}&deg; &nbsp; L ${weather.lowC}&deg;<br>Rain ${weather.precipProbability}%<br>${esc(weather.windDirection)} ${weather.windKph}kph</div>
         <div><div class="temp disp">${weather.currentTempC}&deg;</div><div class="cond">${esc(weather.conditionText)}</div></div>
       </div>`
    : `<div class="banner-wx"><div class="cond">Weather unavailable</div></div>`;

  return `<div class="banner">
    <div class="banner-date">
      <div class="d1 disp">${esc(data.today.weekdayLong.slice(0, 3).toUpperCase())} ${data.today.dayOfMonth}</div>
      <div class="d2 disp">${esc(data.today.monthLong.toUpperCase())}</div>
    </div>
    ${wx}
  </div>`;
}

function departureRow(departure: TrainDeparture): string {
  // For a delay the revised time is the one to act on, so it takes the large
  // slot and the original is struck through in the status beside it.
  const headline = departure.status === 'delayed' && departure.expected
    ? departure.expected
    : departure.scheduled;

  let status: string;
  if (departure.status === 'cancelled') {
    status = 'Cancelled';
  } else if (departure.status === 'delayed') {
    status = departure.expected
      ? `<span class="dep-was">${esc(departure.scheduled)}</span> ${departure.delayMinutes} late`
      : 'Delayed';
  } else {
    status = 'On time';
  }

  const timeClass = departure.status === 'cancelled' ? 'dep-time dep-was' : 'dep-time';

  // No platform for a cancelled service — printing one sends someone to it.
  // An absent platform omits the column rather than rendering an empty one.
  const platform = departure.status !== 'cancelled' && departure.platform
    ? `<span class="dep-platform">Plat ${esc(departure.platform)}</span>`
    : '';

  return `<div class="dep"><span class="${timeClass}">${esc(headline)}</span><span class="dep-status">${status}</span>${platform}</div>`;
}

function trainLabel(data: DashboardData): string {
  if (!data.train) return 'Trains';
  return `${esc(data.train.originCrs)} &rarr; ${esc(data.train.destinationName)}`;
}

function trainCell(data: DashboardData): string {
  const health = data.sourceHealth.find((s) => s.id === 'train');

  if (!health) return emptySlot('Trains — not set up');
  if (!data.train) return emptySlot('Trains unavailable');
  // A successful fetch that found nothing is not a failure. It happens every
  // night, and "No departures" is the true answer.
  if (data.train.departures.length === 0) return emptySlot('No departures');

  return data.train.departures.map(departureRow).join('');
}

export function renderHtml(data: DashboardData, profile: PanelProfile, fontCss: string): string {
  const battery = data.battery.percent === null ? 'Battery --' : `Battery ${data.battery.percent}%`;
  const changed = hhmm(data.contentChangedAt, data.timezone);

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<style>${fontCss}${panelCss(profile)}</style></head><body>
${banner(data)}
<div class="rule"></div>
<div class="grid">
  <div class="cell cell--tl">
    <div class="label">Today${staleBadge(data, 'ical')}</div>
    ${agendaCell(data)}
  </div>
  <div class="cell cell--tr">
    <div class="label">Next 3 days${staleBadge(data, 'weather')}</div>
    ${forecastCell(data)}
  </div>
  <div class="cell cell--bl">
    <div class="label">${trainLabel(data)}${staleBadge(data, 'train')}</div>
    ${trainCell(data)}
  </div>
  <div class="cell cell--br">${emptySlot('Bins & tasks — coming soon')}</div>
</div>
<div class="footer"><span class="tnum">Updated ${esc(changed)}</span><span>${esc(battery)}</span></div>
</body></html>`;
}
