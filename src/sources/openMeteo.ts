import { z } from 'zod';
import type { DayForecast, WeatherData } from '../model/dashboard.ts';
import type { Source, SourceResult } from './types.ts';
import { describeWeatherCode, describeWindDirection } from './weatherCodes.ts';

export { describeWeatherCode };

const schema = z.object({
  current: z.object({
    temperature_2m: z.number(),
    weather_code: z.number(),
    wind_speed_10m: z.number(),
    wind_direction_10m: z.number(),
  }),
  daily: z.object({
    time: z.array(z.string()).min(4),
    temperature_2m_max: z.array(z.number()).min(4),
    temperature_2m_min: z.array(z.number()).min(4),
    precipitation_probability_max: z.array(z.number()).min(1),
    weather_code: z.array(z.number()).min(4),
    sunrise: z.array(z.string()).min(1),
    sunset: z.array(z.string()).min(1),
  }),
});

function weekdayFor(isoDate: string): string {
  return new Date(`${isoDate}T12:00:00.000Z`)
    .toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' })
    .slice(0, 3)
    .toUpperCase();
}

export function mapOpenMeteo(raw: unknown): WeatherData {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`malformed Open-Meteo response: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
  }
  const { current, daily } = parsed.data;

  const forecast: DayForecast[] = [1, 2, 3].map((i) => ({
    weekday: weekdayFor(daily.time[i]!),
    highC: Math.round(daily.temperature_2m_max[i]!),
    lowC: Math.round(daily.temperature_2m_min[i]!),
    conditionText: describeWeatherCode(daily.weather_code[i]!),
  }));

  return {
    currentTempC: Math.round(current.temperature_2m),
    conditionText: describeWeatherCode(current.weather_code),
    highC: Math.round(daily.temperature_2m_max[0]!),
    lowC: Math.round(daily.temperature_2m_min[0]!),
    precipProbability: Math.round(daily.precipitation_probability_max[0]!),
    windKph: Math.round(current.wind_speed_10m),
    windDirection: describeWindDirection(current.wind_direction_10m),
    sunrise: daily.sunrise[0]!,
    sunset: daily.sunset[0]!,
    forecast,
  };
}

export interface OpenMeteoConfig {
  latitude: number;
  longitude: number;
  timezone: string;
}

export const openMeteoSource: Source<OpenMeteoConfig, WeatherData> = {
  id: 'weather',
  async fetch(config, signal): Promise<SourceResult<WeatherData>> {
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.searchParams.set('latitude', String(config.latitude));
    url.searchParams.set('longitude', String(config.longitude));
    url.searchParams.set('timezone', config.timezone);
    url.searchParams.set('forecast_days', '4');
    url.searchParams.set('current', 'temperature_2m,weather_code,wind_speed_10m,wind_direction_10m');
    url.searchParams.set(
      'daily',
      'temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code,sunrise,sunset',
    );

    try {
      const res = await globalThis.fetch(url, { signal });
      if (!res.ok) throw new Error(`Open-Meteo responded ${res.status}`);
      return {
        status: 'ok',
        data: mapOpenMeteo(await res.json()),
        fetchedAt: new Date().toISOString(),
      };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },
};
