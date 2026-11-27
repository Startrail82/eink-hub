import type { PromptVars } from './sources.js';
import type { WeatherSnapshot } from '../weather/provider.js';

const WMO: Record<number, string> = {
  0: 'clear sky', 1: 'mostly clear sky', 2: 'partly cloudy', 3: 'overcast',
  45: 'fog', 48: 'freezing fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 56: 'freezing drizzle', 57: 'heavy freezing drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'heavy freezing rain',
  71: 'light snowfall', 73: 'snowfall', 75: 'heavy snowfall', 77: 'snow grains',
  80: 'light rain showers', 81: 'rain showers', 82: 'violent rain showers', 85: 'snow showers', 86: 'heavy snow showers',
  95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'severe thunderstorm with hail',
};

export function weatherCondition(code: number): string {
  return WMO[code] ?? 'changeable weather';
}

/**
 * The weather as something a picture can show, for {condition}: the plain name first, then what
 * you would see. A clear sky shows nothing by itself, so by night it gets a moon and stars.
 */
const LOOK: Record<number, string> = {
  0: 'clear sky', 1: 'mostly clear sky with a few small clouds', 2: 'partly cloudy sky with drifting clouds',
  3: 'overcast sky with heavy grey clouds',
  45: 'thick swirling fog', 48: 'thick swirling fog with frost on the trees',
  51: 'light drizzle, fine rain streaks falling, wet glistening ground, damp misty air', 53: 'drizzle, fine rain streaks falling, wet glistening ground, damp misty air', 55: 'heavy drizzle, rain streaks falling, wet glistening ground, damp misty air',
  56: 'freezing drizzle with glistening ice', 57: 'heavy freezing drizzle with glistening ice',
  61: 'light rain, visible rain streaks falling, wet glistening ground with puddle reflections', 63: 'steady rain, rain streaks falling, wet glistening ground with puddle reflections', 65: 'heavy rain, dense rain streaks pouring down, splashing puddles, wet glistening ground',
  66: 'freezing rain with glistening ice', 67: 'heavy freezing rain with glistening ice',
  71: 'light snowfall, snowflakes drifting through the air, snow-dusted ground', 73: 'snowfall, snowflakes drifting through the air, snow-covered ground', 75: 'heavy snowfall, thick snowflakes filling the air, deep snow',
  77: 'fine snow grains falling',
  80: 'light rain showers, visible rain streaks, wet glistening ground', 81: 'rain showers, rain streaks falling, wet glistening ground with puddle reflections', 82: 'heavy rain showers, dense rain streaks pouring down, splashing puddles',
  85: 'snow showers with drifting snowflakes', 86: 'heavy snow showers with thick snowflakes',
  95: 'thunderstorm with dark clouds and flashes of lightning', 96: 'thunderstorm with dark clouds, lightning and hail',
  99: 'severe thunderstorm with dark clouds, lightning and hail',
};
const LOOK_NIGHT: Record<number, string> = {
  0: 'clear sky with a bright moon and stars', 1: 'mostly clear sky with a moon, stars and a few small clouds',
  2: 'partly cloudy sky with a moon behind drifting clouds',
};

export function weatherLook(code: number, when: 'night' | 'sun' | 'day'): string {
  if (when === 'night' && LOOK_NIGHT[code]) return LOOK_NIGHT[code];
  if (when === 'day' && code === 0) return 'clear sky with bright sunshine';
  return LOOK[code] ?? 'changeable weather';
}

/** Within this many minutes of sunrise or sunset the picture gets that light. */
const SUN_WINDOW_MIN = 45;

/** Plain moments of the day: neutral, so they never contradict {condition} (a thunderstorm at "day time" is fine). */
const DAYPARTS = {
  night: 'night time, dark night',
  sunrise: 'sunrise, soft golden light on the horizon',
  daytime: 'day time',
  sunset: 'sunset, warm glowing sky',
};

/** Minutes after midnight and "HH:MM" of a local time such as "2026-11-21T07:58". */
function clock(iso: string | null | undefined) {
  const m = /T(\d{2}):(\d{2})/.exec(iso ?? '');
  return m ? { minutes: Number(m[1]) * 60 + Number(m[2]), text: `${m[1]}:${m[2]}` } : null;
}

/** Night, sunrise, daytime or sunset for the full hour nearest to now, at the location. */
function daypart(w: WeatherSnapshot): string {
  const now = clock(w.time);
  const rise = clock(w.sunrise);
  const set = clock(w.sunset);
  if (!now || !rise || !set) return w.isDay ? DAYPARTS.daytime : DAYPARTS.night;
  const hour = Math.round(now.minutes / 60) * 60;
  if (Math.abs(hour - rise.minutes) <= SUN_WINDOW_MIN) return DAYPARTS.sunrise;
  if (Math.abs(hour - set.minutes) <= SUN_WINDOW_MIN) return DAYPARTS.sunset;
  return hour > rise.minutes && hour < set.minutes ? DAYPARTS.daytime : DAYPARTS.night;
}

/** Variables for a prompt: {condition}, {temperature}, {high}, {low}, {wind}, {daypart}, {sunrise}, {sunset}. */
export function weatherVars(w: WeatherSnapshot): PromptVars {
  const round = (n: number | null) => (n === null ? '' : String(Math.round(n)));
  const part = daypart(w);
  return {
    condition: weatherLook(w.code, part === DAYPARTS.night ? 'night' : part === DAYPARTS.daytime ? 'day' : 'sun'),
    temperature: round(w.temperature),
    high: round(w.high),
    low: round(w.low),
    wind: round(w.wind),
    daypart: part,
    sunrise: clock(w.sunrise)?.text ?? '',
    sunset: clock(w.sunset)?.text ?? '',
  };
}

/** The placeholders that need the weather; a prompt without them never asks for it. */
export const WEATHER_TAGS = ['condition', 'temperature', 'high', 'low', 'wind', 'daypart', 'sunrise', 'sunset'] as const;

export function usesWeather(template: string): boolean {
  return [...template.matchAll(/\{(\w+)\}/g)].some((m) => (WEATHER_TAGS as readonly string[]).includes(m[1]));
}
