import { AiError } from '../ai/providers.js';
import { fetchText } from '../ai/sources.js';
import { cleanOffset, type WeatherProvider, type WeatherSnapshot } from './provider.js';

interface OpenMeteo {
  current?: { time?: string; temperature_2m?: number; weather_code?: number; is_day?: number; wind_speed_10m?: number };
  hourly?: { time?: string[]; temperature_2m?: number[]; weather_code?: number[]; is_day?: number[]; wind_speed_10m?: number[] };
  daily?: {
    time?: string[];
    weather_code?: number[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    precipitation_probability_max?: (number | null)[];
    sunrise?: string[];
    sunset?: string[];
  };
}

/**
 * Where the forecast for `hours` from now sits: the full hour nearest to then, in the place's own
 * clock (Open-Meteo answers in local time), and which of the returned days that falls on.
 */
export function targetHour(w: OpenMeteo, hours: number): { hourIndex: number; dayIndex: number; time: string } | null {
  const now = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/.exec(w.current?.time ?? '')?.[1];
  if (!now) return null;
  // Calendar arithmetic on the local wall clock: treat it as UTC so no zone or DST gets involved.
  const target = new Date(Date.parse(`${now}:00Z`) + hours * 3600_000);
  target.setUTCMinutes(Math.round((target.getUTCMinutes() + target.getUTCSeconds() / 60) / 60) * 60, 0, 0);
  const time = target.toISOString().slice(0, 16);
  const hourIndex = w.hourly?.time?.indexOf(time) ?? -1;
  const dayIndex = w.daily?.time?.indexOf(time.slice(0, 10)) ?? -1;
  return hourIndex < 0 || dayIndex < 0 ? null : { hourIndex, dayIndex, time };
}

/** The forecast for `hours` from now, shaped like a reading of now so the same code can use it. */
export function atOffset(w: OpenMeteo, hours: number): OpenMeteo {
  if (hours <= 0) return w;
  const t = targetHour(w, hours);
  const h = w.hourly;
  if (!t || !h) throw new AiError('Open-Meteo returned no forecast for that hour');
  const day = <T>(a: T[] | undefined) => (a?.[t.dayIndex] === undefined ? undefined : [a[t.dayIndex]]);
  const code = h.weather_code?.[t.hourIndex];
  return {
    current: {
      time: t.time,
      temperature_2m: h.temperature_2m?.[t.hourIndex],
      weather_code: code,
      is_day: h.is_day?.[t.hourIndex],
      wind_speed_10m: h.wind_speed_10m?.[t.hourIndex],
    },
    daily: {
      // The sky of the bar is the one of that hour, not of the whole day.
      weather_code: code === undefined ? undefined : [code],
      temperature_2m_max: day(w.daily?.temperature_2m_max),
      temperature_2m_min: day(w.daily?.temperature_2m_min),
      precipitation_probability_max: day(w.daily?.precipitation_probability_max),
      sunrise: day(w.daily?.sunrise),
      sunset: day(w.daily?.sunset),
    },
  };
}

/** Days to ask for so the hour `hours` from now is in the answer (the current hour may be late in the day). */
const daysFor = (hours: number) => Math.floor(hours / 24) + 2;

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
  async fetch({ latitude, longitude, hours }) {
    const offset = cleanOffset(hours);
    const q = new URLSearchParams({
      latitude: String(latitude),
      longitude: String(longitude),
      current: 'temperature_2m,weather_code,is_day,wind_speed_10m',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset',
      timezone: 'auto',
      forecast_days: String(offset ? daysFor(offset) : 1),
    });
    if (offset) q.set('hourly', 'temperature_2m,weather_code,is_day,wind_speed_10m');
    const raw = JSON.parse(await fetchText(`https://api.open-meteo.com/v1/forecast?${q}`, 'application/json', 400_000)) as OpenMeteo;
    return snapshotFromOpenMeteo(atOffset(raw, offset));
  },
};
