import { skyOf, type Sky } from '../../imaging/sky.js';
import { cleanOffset, fetchSnapshot, type WeatherConfig } from './index.js';
import type { WeatherSnapshot } from './provider.js';

/** Today's minimum, maximum and chance of rain at a place, for the bar drawn on the picture. */
export interface DayForecast {
  min: number;
  max: number;
  /** Percent; null when the provider has no probability for this place. */
  rain: number | null;
  /** Today's sky, for the icon and word in the bar; null when the code is unknown. */
  sky: Sky | null;
}

/** Figures of the day and the sky of the hour asked for (see WeatherRequest.hours). */
export function dayForecast(w: WeatherSnapshot): DayForecast {
  // `|| 0` turns a rounded -0 into 0. Without a daily range the current temperature stands for both.
  return {
    min: Math.round(w.low ?? w.temperature) || 0,
    max: Math.round(w.high ?? w.temperature) || 0,
    rain: w.rain === null ? null : Math.round(w.rain),
    sky: skyOf(w.dayCode ?? w.code),
  };
}

const cache = new Map<string, { at: number; value: DayForecast }>();
const TTL_MS = 15 * 60_000;

export async function fetchDayForecast(latitude: number, longitude: number, cfg: WeatherConfig, now = Date.now(), hours = 0): Promise<DayForecast> {
  const offset = cleanOffset(hours);
  const key = `${cfg.provider},${latitude.toFixed(3)},${longitude.toFixed(3)},${offset}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.value;
  const value = dayForecast(await fetchSnapshot(latitude, longitude, cfg, offset));
  cache.set(key, { at: now, value });
  return value;
}
