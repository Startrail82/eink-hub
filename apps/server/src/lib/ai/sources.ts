import { AiError } from './providers.js';

export type PromptVars = Record<string, string>;

/**
 * Replace {name} with its value; unknown names become empty so a typo never leaks into the prompt.
 * {pick: a | b | c} becomes one of its options, chosen at random for every picture (options may
 * contain {name} tags too).
 */
export function fillTemplate(template: string, vars: PromptVars, random: () => number = Math.random): string {
  return template
    .replace(/\{pick:((?:[^{}]|\{\w+\})*)\}/g, (_, list: string) => {
      const options = list.split('|').map((o) => o.trim()).filter(Boolean);
      return options.length ? options[Math.floor(random() * options.length)] : '';
    })
    .replace(/\{(\w+)\}/g, (_, name: string) => vars[name] ?? '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** Variables every source offers. */
function nearestHour(now: Date) {
  const d = new Date(now);
  d.setMinutes(d.getMinutes() >= 30 ? 60 : 0, 0, 0);
  return d;
}

export function commonVars(now = new Date()): PromptVars {
  return {
    date: new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(now),
    // Nearest full hour in the Hub's time zone: a picture is made ~10 minutes before the Canvas changes.
    time: `${String(nearestHour(now).getHours()).padStart(2, '0')}:00`,
    season: ['winter', 'winter', 'spring', 'spring', 'spring', 'summer', 'summer', 'summer', 'autumn', 'autumn', 'autumn', 'winter'][now.getMonth()],
  };
}

async function fetchText(url: string, accept: string, limit: number): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept, 'user-agent': 'eink-hub' }, signal: AbortSignal.timeout(15_000), redirect: 'follow' });
  } catch (err) {
    throw new AiError(`${new URL(url).host}: ${(err as Error).name === 'TimeoutError' ? 'no answer in time' : ((err as Error).cause as Error | undefined)?.message ?? (err as Error).message}`);
  }
  if (!res.ok) throw new AiError(`${new URL(url).host} answered ${res.status}`);
  const text = await res.text();
  if (text.length > limit) throw new AiError(`${new URL(url).host}: the answer is too large`);
  return text;
}

// --- RSS / Atom ---------------------------------------------------------------------------

export interface FeedItem {
  /** Stable identifier used to remember which items were already illustrated. */
  id: string;
  title: string;
  description: string;
  link: string;
  published: number | null;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(?:#(\d+)|#x([\da-f]+)|(\w+));/gi, (m, dec, hex, name) => {
      const code = dec ? +dec : hex ? parseInt(hex, 16) : undefined;
      if (code !== undefined) return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
      return ENTITIES[(name as string).toLowerCase()] ?? m;
    });
}

/** Plain text of a feed field: entities decoded, markup dropped, whitespace tidied. */
function text(s: string): string {
  return decode(decode(s).replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : '';
}

/** A minimal reader for RSS 2.0 and Atom: enough to get titles and summaries out of a news feed. */
export function parseFeed(xml: string): FeedItem[] {
  const blocks = [...xml.matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)].map((m) => m[2]);
  const items: FeedItem[] = [];
  for (const b of blocks) {
    const title = text(tag(b, 'title'));
    if (!title) continue;
    const atomLink = b.match(/<link\b[^>]*\bhref=["']([^"']+)["']/i)?.[1];
    const link = text(tag(b, 'link')) || (atomLink ? decode(atomLink) : '');
    const date = Date.parse(text(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date')));
    items.push({
      id: text(tag(b, 'guid') || tag(b, 'id')) || link || title,
      title,
      description: text(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content')).slice(0, 500),
      link,
      published: Number.isFinite(date) ? date : null,
    });
  }
  return items;
}

/** The feed's items, newest first (feeds that list oldest first are reordered by date). */
export async function fetchFeed(url: string): Promise<FeedItem[]> {
  const items = parseFeed(await fetchText(url, 'application/rss+xml, application/atom+xml, application/xml, text/xml', 3_000_000));
  if (!items.length) throw new AiError('No items found in the feed');
  return items.every((i) => i.published !== null) ? [...items].sort((a, b) => b.published! - a.published!) : items;
}

/** Newest item whose id is not in `seen`. */
export function nextFeedItem(items: FeedItem[], seen: string[]): FeedItem | null {
  const done = new Set(seen);
  return items.find((i) => !done.has(i.id)) ?? null;
}

// --- Weather (Open-Meteo, no key needed) --------------------------------------------------

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

interface OpenMeteo {
  current?: { time?: string; temperature_2m?: number; weather_code?: number; is_day?: number; wind_speed_10m?: number };
  daily?: { temperature_2m_max?: number[]; temperature_2m_min?: number[]; sunrise?: string[]; sunset?: string[] };
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

/** Minutes after midnight and "HH:MM" of an Open-Meteo local time ("2026-11-21T07:58"). */
function clock(iso: string | undefined) {
  const m = /T(\d{2}):(\d{2})/.exec(iso ?? '');
  return m ? { minutes: Number(m[1]) * 60 + Number(m[2]), text: `${m[1]}:${m[2]}` } : null;
}

/** Night, sunrise, daytime or sunset for the full hour nearest to now, at the location. */
function daypart(w: OpenMeteo): string {
  const now = clock(w.current?.time);
  const rise = clock(w.daily?.sunrise?.[0]);
  const set = clock(w.daily?.sunset?.[0]);
  if (!now || !rise || !set) return w.current?.is_day === 0 ? DAYPARTS.night : DAYPARTS.daytime;
  const hour = Math.round(now.minutes / 60) * 60;
  if (Math.abs(hour - rise.minutes) <= SUN_WINDOW_MIN) return DAYPARTS.sunrise;
  if (Math.abs(hour - set.minutes) <= SUN_WINDOW_MIN) return DAYPARTS.sunset;
  return hour > rise.minutes && hour < set.minutes ? DAYPARTS.daytime : DAYPARTS.night;
}

/** Variables for a prompt: {condition}, {temperature}, {high}, {low}, {wind}, {daypart}, {sunrise}, {sunset}. */
export function weatherVars(w: OpenMeteo): PromptVars {
  const c = w.current;
  if (!c || c.weather_code === undefined || c.temperature_2m === undefined) throw new AiError('Open-Meteo returned no current weather');
  const round = (n: number | undefined) => (n === undefined ? '' : String(Math.round(n)));
  const part = daypart(w);
  return {
    condition: weatherLook(c.weather_code, part === DAYPARTS.night ? 'night' : part === DAYPARTS.daytime ? 'day' : 'sun'),
    temperature: round(c.temperature_2m),
    high: round(w.daily?.temperature_2m_max?.[0]),
    low: round(w.daily?.temperature_2m_min?.[0]),
    wind: round(c.wind_speed_10m),
    daypart: part,
    sunrise: clock(w.daily?.sunrise?.[0])?.text ?? '',
    sunset: clock(w.daily?.sunset?.[0])?.text ?? '',
  };
}

export async function fetchWeather(latitude: number, longitude: number): Promise<PromptVars> {
  const q = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    current: 'temperature_2m,weather_code,is_day,wind_speed_10m',
    daily: 'temperature_2m_max,temperature_2m_min,sunrise,sunset',
    timezone: 'auto',
    forecast_days: '1',
  });
  return weatherVars(JSON.parse(await fetchText(`https://api.open-meteo.com/v1/forecast?${q}`, 'application/json', 200_000)) as OpenMeteo);
}

/** Today's minimum, maximum and chance of rain at a place, for the bar drawn on the picture. */
export interface DayForecast {
  min: number;
  max: number;
  /** Percent; null when the service has no probability for this place. */
  rain: number | null;
}

const forecastCache = new Map<string, { at: number; value: DayForecast }>();
const FORECAST_TTL_MS = 15 * 60_000;

export async function fetchDayForecast(latitude: number, longitude: number, now = Date.now()): Promise<DayForecast> {
  const key = `${latitude.toFixed(3)},${longitude.toFixed(3)}`;
  const hit = forecastCache.get(key);
  if (hit && now - hit.at < FORECAST_TTL_MS) return hit.value;
  const q = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    timezone: 'auto',
    forecast_days: '1',
  });
  const value = parseDayForecast(JSON.parse(await fetchText(`https://api.open-meteo.com/v1/forecast?${q}`, 'application/json', 200_000)));
  forecastCache.set(key, { at: now, value });
  return value;
}

export function parseDayForecast(raw: { daily?: { temperature_2m_max?: number[]; temperature_2m_min?: number[]; precipitation_probability_max?: (number | null)[] } }): DayForecast {
  const d = raw.daily;
  const max = d?.temperature_2m_max?.[0];
  const min = d?.temperature_2m_min?.[0];
  if (typeof max !== 'number' || typeof min !== 'number') throw new AiError('Open-Meteo returned no forecast');
  const rain = d?.precipitation_probability_max?.[0];
  return { min: Math.round(min), max: Math.round(max), rain: typeof rain === 'number' ? Math.round(rain) : null };
}
