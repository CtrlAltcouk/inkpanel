/** Trimmed but structurally faithful Open-Meteo geocoding response. */
export const MILTON_KEYNES = {
  results: [
    {
      id: 2642465, name: 'Milton Keynes', latitude: 52.04172, longitude: -0.75583,
      country_code: 'GB', admin1: 'England', admin2: 'Milton Keynes',
      timezone: 'Europe/London', country: 'United Kingdom', population: 229941,
    },
    {
      id: 2642466, name: 'Milton Keynes Village', latitude: 52.0417, longitude: -0.7,
      country_code: 'GB', admin1: 'England', timezone: 'Europe/London',
    },
  ],
};

/** A city with no admin1, which is common outside large countries. */
export const NO_ADMIN1 = {
  results: [
    { id: 1, name: 'Monaco', latitude: 43.73, longitude: 7.42, country_code: 'MC', timezone: 'Europe/Monaco' },
  ],
};

/** Open-Meteo omits `results` entirely when nothing matches. */
export const NO_MATCHES = { generationtime_ms: 0.4 };
