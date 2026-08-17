import type { TrainData } from '../sources/train.ts';
import type { BinsData } from '../sources/bins.ts';
import type { BusData } from '../sources/transportApiBus.ts';
import type { TrafficData } from '../sources/googleTraffic.ts';
import type { OctopusAgileData } from '../sources/octopusAgile.ts';

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

/** Renderer-visible To Do state. Persistence IDs and completed items stay local. */
export interface TodoData {
  items: string[];
}

export type DashboardSectionData =
  | { type: 'calendar'; data: CalendarData | null; health: SourceHealth }
  | { type: 'weather'; data: WeatherData | null; health: SourceHealth }
  | { type: 'trains'; data: TrainData | null; health: SourceHealth | null }
  | { type: 'bus'; data: BusData | null; health: SourceHealth | null }
  | { type: 'traffic'; data: TrafficData | null; health: SourceHealth | null }
  | { type: 'octopus'; data: OctopusAgileData | null; health: SourceHealth | null }
  | { type: 'todo'; data: TodoData | null; configured: boolean; health: null }
  | { type: 'bins'; data: BinsData | null; health: SourceHealth | null }
  | { type: 'empty' };

/** Existing 800×480 renderer contract. Keep this exact four-slot shape. */
export type DashboardSectionDataTuple = [
  DashboardSectionData,
  DashboardSectionData,
  DashboardSectionData,
  DashboardSectionData,
];

export type MiniDashboardSectionDataTuple = [DashboardSectionData];

interface DashboardDataBase {
  /** When this object was built. Excluded from the content hash. */
  generatedAt: string;
  /** When the rendered content last actually changed. Not rendered. */
  contentChangedAt: string;
  timezone: string;
  today: TodayInfo;
  headerWeather: WeatherData | null;
  headerWeatherHealth: SourceHealth;
  battery: BatteryInfo;
}

/** Existing large-panel model. Deliberately still exactly four sections. */
export interface DashboardData extends DashboardDataBase {
  sections: DashboardSectionDataTuple;
}

/** 1.54-inch Mini model. It has exactly one section, not three hidden slots. */
export interface MiniDashboardData extends DashboardDataBase {
  sections: MiniDashboardSectionDataTuple;
}

export type ProfileDashboardData = DashboardData | MiniDashboardData;

export type { TrainData, TrainDeparture, DepartureStatus } from '../sources/train.ts';
export type { BinsData, BinCollection, BinType } from '../sources/bins.ts';
export type { BusData, BusDeparture, BusDepartureStatus } from '../sources/transportApiBus.ts';
export type { TrafficData } from '../sources/googleTraffic.ts';
export type { OctopusAgileData, OctopusRateSlot } from '../sources/octopusAgile.ts';
