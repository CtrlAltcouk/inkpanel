import type { TrainData } from '../sources/train.ts';

export interface CalendarEvent {
  uid: string;
  title: string;
  /** ISO 8601 instant. */
  start: string;
  end: string;
  allDay: boolean;
}

export interface CalendarData {
  today: CalendarEvent[];
  tomorrow: CalendarEvent[];
}

export interface DayForecast {
  /** Three-letter uppercase weekday, e.g. "TUE". */
  weekday: string;
  highC: number;
  lowC: number;
  conditionText: string;
}

export interface WeatherData {
  currentTempC: number;
  conditionText: string;
  highC: number;
  lowC: number;
  /** Percentage, 0-100. */
  precipProbability: number;
  windKph: number;
  windDirection: string;
  sunrise: string;
  sunset: string;
  forecast: DayForecast[];
}

export type SourceStatus = 'ok' | 'stale' | 'error';

export interface SourceHealth {
  id: string;
  status: SourceStatus;
  fetchedAt: string | null;
  error: string | null;
}

export interface TodayInfo {
  iso: string;
  weekdayLong: string;
  dayOfMonth: number;
  monthLong: string;
}

export interface BatteryInfo {
  volts: number | null;
  /** Rounded percentage, or null when unknown. Only this is rendered. */
  percent: number | null;
}

export interface DashboardData {
  /** When this object was built. Excluded from the content hash. */
  generatedAt: string;
  /** When the rendered content last actually changed. Shown in the footer. */
  contentChangedAt: string;
  timezone: string;
  today: TodayInfo;
  calendar: CalendarData | null;
  weather: WeatherData | null;
  train: TrainData | null;
  sourceHealth: SourceHealth[];
  battery: BatteryInfo;
}

export type { TrainData, TrainDeparture, DepartureStatus } from '../sources/train.ts';
