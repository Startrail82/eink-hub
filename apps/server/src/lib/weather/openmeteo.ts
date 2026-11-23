import { AiError } from '../ai/providers.js';
import { fetchText } from '../ai/sources.js';
import type { WeatherProvider, WeatherSnapshot } from './provider.js';

interface OpenMeteo {
  current?: { time?: string; temperature_2m?: number; weather_code?: number; is_day?: number; wind_speed_10m?: number };
  daily?: {
    weather_code?: number[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    precipitation_probability_max?: (number | null)[];
    sunrise?: string[];
    sunset?: string[];
  };
}

/** Open-Meteo's answer as a neutral snapshot. Its weather codes already are WMO codes. */
export function snapshotFromOpenMeteo(w: OpenMeteo): WeatherSnapshot {
  const c = w.current;
  if (!c || c.weather_code === undefined || c.temperature_2m === undefined) throw new AiError('Open-Meteo returned no current weather');
  return {
    code: c.weather_code,
    temperature: c.temperature_2m,
    high: w.daily?.temperature_2m_max?.[0] ?? null,
    low: w.daily?.temperature_2m_min?.[0] ?? null,
    wind: c.wind_speed_10m ?? null,
    rain: w.daily?.precipitation_probability_max?.[0] ?? null,
    dayCode: w.daily?.weather_code?.[0] ?? null,
    isDay: c.is_day !== 0,
    time: c.time ?? '',
    sunrise: w.daily?.sunrise?.[0] ?? null,
    sunset: w.daily?.sunset?.[0] ?? null,
  };
}

/** The default provider: free and without an account (https://open-meteo.com/). */
export const openMeteo: WeatherProvider = {
  id: 'open-meteo',
  name: 'Open-Meteo',
  key: 'none',
  async fetch({ latitude, longitude }) {
    const q = new URLSearchParams({
      latitude: String(latitude),
      longitude: String(longitude),
      current: 'temperature_2m,weather_code,is_day,wind_speed_10m',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset',
      timezone: 'auto',
      forecast_days: '1',
    });
    return snapshotFromOpenMeteo(JSON.parse(await fetchText(`https://api.open-meteo.com/v1/forecast?${q}`, 'application/json', 200_000)) as OpenMeteo);
  },
};
