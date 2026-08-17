import type {
  BusDeparture,
  CalendarEvent,
  DashboardSectionData,
  MiniDashboardData,
  OctopusAgileData,
  SourceHealth,
  TrainDeparture,
} from '../model/dashboard.ts';
import type { PanelProfile } from '../panel/profile.ts';

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function hhmm(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

function clockOnly(value: string): string {
  return value.includes('T') ? value.slice(11, 16) : value;
}

function stale(health: SourceHealth | null, timezone: string): string {
  if (health?.status !== 'stale' || !health.fetchedAt) return '';
  return `<div class="stale">STALE ${esc(hhmm(health.fetchedAt, timezone))}</div>`;
}

function state(title: string, message: string): string {
  return `<div class="mini-head">${esc(title)}</div><div class="state">${esc(message)}</div>`;
}

function eventRow(event: CalendarEvent, timezone: string): string {
  const time = event.allDay ? 'ALL' : hhmm(event.start, timezone);
  return `<div class="agenda-row"><span class="row-time">${esc(time)}</span><span class="row-text">${esc(event.title)}</span></div>`;
}

function calendar(section: Extract<DashboardSectionData, { type: 'calendar' }>, data: MiniDashboardData): string {
  if (!section.data) return state('CALENDAR', 'Unavailable');
  const events = section.data.today.length > 0 ? section.data.today : section.data.tomorrow;
  const day = section.data.today.length > 0 ? 'TODAY' : 'TOMORROW';
  if (events.length === 0) return state('CALENDAR', 'Nothing scheduled');
  return `<div class="mini-head">CALENDAR <span>${day}</span></div>
    <div class="agenda">${events.slice(0, 4).map((event) => eventRow(event, data.timezone)).join('')}</div>
    ${stale(section.health, data.timezone)}`;
}

function weather(section: Extract<DashboardSectionData, { type: 'weather' }>, data: MiniDashboardData): string {
  if (!section.data) return state('WEATHER', 'Unavailable');
  const wx = section.data;
  return `<div class="mini-head">WEATHER</div>
    <div class="weather-temp disp">${wx.currentTempC}&deg;</div>
    <div class="weather-cond">${esc(wx.conditionText)}</div>
    <div class="weather-range tnum">H ${wx.highC}&deg; &nbsp; L ${wx.lowC}&deg;</div>
    <div class="weather-detail tnum">Rain ${wx.precipProbability}% &middot; ${esc(wx.windDirection)} ${wx.windKph}kph</div>
    <div class="weather-sun tnum">${esc(clockOnly(wx.sunrise))} &uarr; &nbsp; ${esc(clockOnly(wx.sunset))} &darr;</div>
    ${stale(section.health, data.timezone)}`;
}

function departureStatus(departure: TrainDeparture): string {
  if (departure.status === 'cancelled') return 'CANCELLED';
  if (departure.status === 'delayed') return departure.expected ? `${departure.delayMinutes ?? ''} LATE`.trim() : 'DELAYED';
  return departure.platform ? `PLAT ${departure.platform}` : 'ON TIME';
}

function trains(section: Extract<DashboardSectionData, { type: 'trains' }>, data: MiniDashboardData): string {
  if (!section.health) return state('TRAINS', 'Not set up');
  if (!section.data) return state('TRAINS', 'Unavailable');
  if (section.data.departures.length === 0) return state('TRAINS', 'No departures');
  const rows = section.data.departures.slice(0, 3).map((departure) => {
    const time = departure.status === 'delayed' && departure.expected ? departure.expected : departure.scheduled;
    const cls = departure.status === 'cancelled' ? ' cancelled' : '';
    return `<div class="departure${cls}"><span class="dep-time">${esc(time)}</span><span class="dep-state">${esc(departureStatus(departure))}</span></div>`;
  }).join('');
  return `<div class="mini-head">${esc(section.data.originCrs)} &rarr; ${esc(section.data.destinationCrs)}</div>
    <div class="route-name">${esc(section.data.destinationName)}</div>
    <div class="departures">${rows}</div>
    ${stale(section.health, data.timezone)}`;
}

function busTime(departure: BusDeparture): string {
  if (departure.status === 'cancelled') return departure.scheduled ?? '--:--';
  return departure.expected ?? departure.scheduled ?? '--:--';
}

function bus(section: Extract<DashboardSectionData, { type: 'bus' }>, data: MiniDashboardData): string {
  if (!section.health) return state('BUS', 'Not set up');
  if (!section.data) return state('BUS', 'Unavailable');
  if (section.data.departures.length === 0) return state('BUS', 'No departures');
  const rows = section.data.departures.slice(0, 3).map((departure) => `<div class="bus-row">
    <span class="bus-line">${esc(departure.line)}</span>
    <span class="bus-time${departure.status === 'cancelled' ? ' cancelled' : ''}">${esc(busTime(departure))}</span>
    <span class="bus-dest">${esc(departure.status === 'cancelled' ? 'Cancelled' : departure.destination)}</span>
  </div>`).join('');
  return `<div class="mini-head">BUS</div><div class="route-name">${esc(section.data.stopName)}</div>
    <div class="bus-list">${rows}</div>
    <div class="provider">TransportAPI</div>${stale(section.health, data.timezone)}`;
}

function traffic(section: Extract<DashboardSectionData, { type: 'traffic' }>, data: MiniDashboardData): string {
  if (!section.health) return state('TRAFFIC', 'Not set up');
  if (!section.data) return state('TRAFFIC', 'Unavailable');
  const route = section.data.warning ?? section.data.description ?? '';
  return `<div class="mini-head">TRAFFIC</div>
    <div class="traffic-time disp">${esc(section.data.durationText)}</div>
    <div class="traffic-label">TRAFFIC-AWARE</div>
    <div class="traffic-static">Without traffic<br><strong>${esc(section.data.staticDurationText)}</strong></div>
    ${route ? `<div class="traffic-route">${esc(route)}</div>` : ''}
    <div class="provider google" translate="no">Google Maps</div>${stale(section.health, data.timezone)}`;
}

function addIsoDay(iso: string): string {
  const date = new Date(`${iso}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function localIsoDate(iso: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(iso));
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function octopusDayLabel(octopus: OctopusAgileData, data: MiniDashboardData): string {
  if (octopus.isCurrent) return 'NOW';
  const slotDate = localIsoDate(octopus.cheapest.validFrom, data.timezone);
  if (slotDate === data.today.iso) return 'TODAY';
  if (slotDate === addIsoDay(data.today.iso)) return 'TOMORROW';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: data.timezone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(new Date(octopus.cheapest.validFrom)).toUpperCase();
}

function octopus(section: Extract<DashboardSectionData, { type: 'octopus' }>, data: MiniDashboardData): string {
  if (!section.health) return state('OCTOPUS AGILE', 'Not set up');
  if (!section.data) return state('OCTOPUS AGILE', 'Unavailable');
  const from = hhmm(section.data.cheapest.validFrom, data.timezone);
  const to = hhmm(section.data.cheapest.validTo, data.timezone);
  const price = `${section.data.cheapest.pencePerKwh.toFixed(2)}p`;
  const priceSize = price.length >= 9 ? ' octopus-price-tight' : price.length >= 7 ? ' octopus-price-compact' : '';
  return `<div class="mini-head">OCTOPUS AGILE</div>
    <div class="octopus-kicker">CHEAPEST UPCOMING</div>
    <div class="octopus-time disp tnum"><span>${esc(from)}</span><span class="octopus-dash">&ndash;</span><span>${esc(to)}</span></div>
    <div class="octopus-day">${esc(octopusDayLabel(section.data, data))}</div>
    <div class="octopus-price"><span class="disp tnum${priceSize}">${esc(price)}</span><span>/kWh</span></div>
    ${stale(section.health, data.timezone)}`;
}

const BIN_DATE_FORMAT: Intl.DateTimeFormatOptions = {
  weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
};

function bins(section: Extract<DashboardSectionData, { type: 'bins' }>, data: MiniDashboardData): string {
  if (!section.health) return state('BINS', 'Not set up');
  if (!section.data) return state('BINS', 'Unavailable');
  if (!section.data.next) return state('BINS', 'No collection scheduled');
  const dateParts = new Intl.DateTimeFormat('en-GB', BIN_DATE_FORMAT)
    .formatToParts(new Date(`${section.data.next.date}T12:00:00.000Z`));
  const datePart = (type: Intl.DateTimeFormatPartTypes) =>
    dateParts.find((part) => part.type === type)?.value.toUpperCase() ?? '';
  const primaryDate = `${datePart('weekday')} ${datePart('day')}`;
  const month = datePart('month');
  const labels = section.data.rawLabels.length > 0
    ? section.data.rawLabels
    : section.data.next.types.map((type) => type.toUpperCase());
  return `<div class="mini-head">BINS</div><div class="bin-date disp"><span class="bin-date-primary">${esc(primaryDate)}</span><span class="bin-date-month">${esc(month)}</span></div>
    <div class="bin-list">${labels.slice(0, 4).map((label) => `<div class="bin-row"><span class="box"></span><span>${esc(label)}</span></div>`).join('')}</div>
    ${stale(section.health, data.timezone)}`;
}

function todo(section: Extract<DashboardSectionData, { type: 'todo' }>): string {
  if (!section.configured || !section.data) return state('TO DO', 'Not set up');
  if (section.data.items.length === 0) return state('TO DO', 'ALL DONE');
  return `<div class="mini-head">TO DO</div><div class="mini-todo-list">${section.data.items.slice(0, 5).map((text) => `<div class="mini-todo-row"><span class="mini-todo-box"></span><span>${esc(text)}</span></div>`).join('')}</div>`;
}

const TODO_CSS = `.mini-todo-list{display:flex;flex-direction:column;gap:3px;padding-top:6px;overflow:hidden}.mini-todo-row{display:grid;grid-template-columns:13px minmax(0,1fr);gap:7px;align-items:center;height:25px;font-size:11px;font-weight:650;line-height:1.08}.mini-todo-row>span:last-child{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;max-height:24px;overflow:hidden}.mini-todo-box{width:11px;height:11px;border:2px solid #000}`;

function renderWidget(section: DashboardSectionData, data: MiniDashboardData): string {
  switch (section.type) {
    case 'calendar': return calendar(section, data);
    case 'weather': return weather(section, data);
    case 'trains': return trains(section, data);
    case 'bus': return bus(section, data);
    case 'traffic': return traffic(section, data);
    case 'octopus': return octopus(section, data);
    case 'todo': return todo(section);
    case 'bins': return bins(section, data);
    case 'empty': return '<div class="empty-brand disp">INKPANEL<br>MINI</div>';
  }
}

function css(profile: PanelProfile): string {
  return `
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${profile.width}px;height:${profile.height}px;overflow:hidden;background:#fff;color:#000}
body{font-family:"Inter",Arial,sans-serif;-webkit-font-smoothing:none}
.disp{font-family:"Dela Gothic One",Arial Black,sans-serif;font-weight:400;letter-spacing:-.04em}
.tnum{font-variant-numeric:tabular-nums}
.mini{position:relative;width:200px;height:200px;padding:12px;border:3px solid #000;background:#fff;overflow:hidden}
.mini-head{height:22px;border-bottom:2px solid #000;font-size:12px;font-weight:800;letter-spacing:.08em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mini-head span{float:right;font-size:9px;line-height:15px}
.state{display:flex;align-items:center;justify-content:center;height:148px;text-align:center;font-size:17px;font-weight:700}
.stale{position:absolute;right:9px;bottom:6px;font-size:7px;font-weight:800;letter-spacing:.04em;background:#fff;padding-left:4px}
.agenda{padding-top:7px}.agenda-row{display:grid;grid-template-columns:43px 1fr;gap:5px;min-height:33px;align-items:start;border-bottom:1px solid #000;padding:5px 0}.agenda-row:last-child{border-bottom:0}.row-time{font-family:"Dela Gothic One",Arial Black,sans-serif;font-size:12px}.row-text{font-size:11px;font-weight:650;line-height:1.12;max-height:25px;overflow:hidden}
.weather-temp{font-size:66px;line-height:.95;margin-top:12px;text-align:center}.weather-cond{text-align:center;font-size:17px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}.weather-range{text-align:center;font-size:15px;font-weight:800;margin-top:8px}.weather-detail{text-align:center;font-size:9px;margin-top:7px}.weather-sun{text-align:center;font-size:8px;margin-top:5px}
.route-name{font-size:10px;font-weight:700;margin-top:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.departures{margin-top:5px}.departure{height:41px;border-top:1px solid #000;display:grid;grid-template-columns:72px 1fr;align-items:center}.dep-time{font-family:"Dela Gothic One",Arial Black,sans-serif;font-size:20px}.dep-state{font-size:9px;font-weight:800;text-align:right}.cancelled{text-decoration:line-through}
.bus-list{margin-top:3px}.bus-row{display:grid;grid-template-columns:30px 48px 1fr;gap:4px;align-items:center;height:39px;border-top:1px solid #000}.bus-line{font-family:"Dela Gothic One",Arial Black,sans-serif;font-size:15px}.bus-time{font-weight:900;font-size:13px}.bus-dest{font-size:9px;font-weight:650;line-height:1.05;max-height:20px;overflow:hidden}.provider{position:absolute;left:11px;bottom:6px;font-size:6px;font-weight:700}.google{font-size:8px;font-weight:800}
.traffic-time{text-align:center;font-size:43px;line-height:1;margin-top:18px}.traffic-label{text-align:center;font-size:9px;font-weight:900;letter-spacing:.08em;margin-top:3px}.traffic-static{text-align:center;font-size:10px;line-height:1.3;margin-top:13px}.traffic-static strong{font-size:16px}.traffic-route{text-align:center;font-size:8px;line-height:1.1;margin:8px 8px 0;max-height:18px;overflow:hidden}
.octopus-kicker{text-align:center;font-size:8px;font-weight:900;letter-spacing:.08em;margin-top:9px}.octopus-time{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);align-items:center;width:100%;font-size:23px;line-height:1.05;margin-top:7px;white-space:nowrap;text-align:center;letter-spacing:-.06em}.octopus-time>span{min-width:0}.octopus-dash{padding:0 2px}.octopus-day{text-align:center;font-size:11px;font-weight:900;letter-spacing:.06em;margin-top:2px}.octopus-price{margin-top:10px;text-align:center}.octopus-price .disp{display:block;font-size:40px;line-height:.95;white-space:nowrap}.octopus-price .octopus-price-compact{font-size:34px}.octopus-price .octopus-price-tight{font-size:29px}.octopus-price>span:last-child{display:block;font-size:11px;font-weight:800;line-height:1;margin-top:3px}
.bin-date{line-height:.94;margin-top:8px}.bin-date span{display:block;white-space:nowrap}.bin-date-primary{font-size:30px}.bin-date-month{font-size:23px;margin-top:2px}.bin-list{margin-top:5px}.bin-row{display:grid;grid-template-columns:11px 1fr;gap:7px;align-items:center;font-size:10px;font-weight:650;min-height:20px}.box{width:9px;height:9px;border:2px solid #000}.empty-brand{height:170px;display:flex;align-items:center;justify-content:center;text-align:center;font-size:29px;line-height:1.1}
`;
}

/** Dedicated 200×200 single-widget renderer. Never scales/crops the 800×480 dashboard. */
export function renderMiniHtml(data: MiniDashboardData, profile: PanelProfile, fontCss: string): string {
  const todoCss = data.sections[0].type === 'todo' ? TODO_CSS : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${fontCss}${css(profile)}${todoCss}</style></head><body><div class="mini">${renderWidget(data.sections[0], data)}</div></body></html>`;
}
