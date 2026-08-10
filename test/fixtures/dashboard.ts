import type { CalendarData, DashboardData, SourceHealth, WeatherData } from '../../src/model/dashboard.ts';

export const OK_CALENDAR: SourceHealth = { id: 'ical', status: 'ok', fetchedAt: '2026-08-03T07:42:00.000Z', error: null };
export const OK_WEATHER: SourceHealth = { id: 'weather', status: 'ok', fetchedAt: '2026-08-03T07:42:00.000Z', error: null };

export const CALENDAR: CalendarData = {
  today: [{ uid: '1', title: 'Team standup', start: '2026-08-03T08:30:00.000Z', end: '2026-08-03T08:45:00.000Z', allDay: false }],
  tomorrow: [],
};

export const WEATHER: WeatherData = {
  currentTempC: 22, conditionText: 'Partly cloudy', highC: 24, lowC: 13,
  precipProbability: 10, windKph: 13, windDirection: 'NW',
  sunrise: '2026-08-03T05:34', sunset: '2026-08-03T20:47',
  forecast: [
    { weekday: 'TUE', highC: 24, lowC: 14, conditionText: 'Sunny' },
    { weekday: 'WED', highC: 19, lowC: 13, conditionText: 'Rain' },
    { weekday: 'THU', highC: 21, lowC: 12, conditionText: 'Overcast' },
  ],
};

export function dashboardData(overrides: Partial<DashboardData> = {}): DashboardData {
  return {
    generatedAt: '2026-08-03T07:42:00.000Z',
    contentChangedAt: '2026-08-03T07:42:00.000Z',
    timezone: 'Europe/London',
    today: { iso: '2026-08-03', weekdayLong: 'Monday', dayOfMonth: 3, monthLong: 'August' },
    headerWeather: WEATHER,
    headerWeatherHealth: OK_WEATHER,
    sections: [
      { type: 'calendar', data: CALENDAR, health: OK_CALENDAR },
      { type: 'weather', data: WEATHER, health: OK_WEATHER },
      { type: 'trains', data: null, health: null },
      { type: 'bins', data: null, health: null },
    ],
    battery: { volts: 4.02, percent: 87 },
    ...overrides,
  };
}
