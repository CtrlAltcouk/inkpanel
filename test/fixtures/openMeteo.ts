/** Trimmed but structurally faithful Open-Meteo forecast response. */
export const MK_FORECAST = {
  latitude: 52.04,
  longitude: -0.76,
  timezone: 'Europe/London',
  current: {
    time: '2026-08-03T08:00',
    temperature_2m: 21.6,
    weather_code: 2,
    wind_speed_10m: 12.8,
    wind_direction_10m: 315,
  },
  daily: {
    time: ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06'],
    temperature_2m_max: [23.8, 24.1, 19.4, 21.2],
    temperature_2m_min: [12.9, 14.0, 13.1, 12.4],
    precipitation_probability_max: [10, 5, 70, 35],
    weather_code: [2, 0, 61, 3],
    sunrise: ['2026-08-03T05:34', '2026-08-04T05:36', '2026-08-05T05:37', '2026-08-06T05:39'],
    sunset: ['2026-08-03T20:47', '2026-08-04T20:45', '2026-08-05T20:44', '2026-08-06T20:42'],
  },
};
