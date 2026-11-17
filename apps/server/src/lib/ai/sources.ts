import { AiError } from './providers.js';

export type PromptVars = Record<string, string>;

/** Replace {name} with its value; unknown names become empty so a typo never leaks into the prompt. */
export function fillTemplate(template: string, vars: PromptVars): string {
  return template
    .replace(/\{(\w+)\}/g, (_, name: string) => vars[name] ?? '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** Variables every source offers. */
export function commonVars(now = new Date()): PromptVars {
  return {
    date: new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(now),
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

interface OpenMeteo {
  current?: { temperature_2m?: number; weather_code?: number; is_day?: number; wind_speed_10m?: number };
  daily?: { temperature_2m_max?: number[]; temperature_2m_min?: number[] };
}

/** Variables for a prompt: {condition}, {temperature}, {high}, {low}, {wind}, {daypart}. */
export function weatherVars(w: OpenMeteo): PromptVars {
  const c = w.current;
  if (!c || c.weather_code === undefined || c.temperature_2m === undefined) throw new AiError('Open-Meteo returned no current weather');
  const round = (n: number | undefined) => (n === undefined ? '' : String(Math.round(n)));
  return {
    condition: weatherCondition(c.weather_code),
    temperature: round(c.temperature_2m),
    high: round(w.daily?.temperature_2m_max?.[0]),
    low: round(w.daily?.temperature_2m_min?.[0]),
    wind: round(c.wind_speed_10m),
    daypart: c.is_day === 0 ? 'night' : 'day',
  };
}

export async function fetchWeather(latitude: number, longitude: number): Promise<PromptVars> {
  const q = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    current: 'temperature_2m,weather_code,is_day,wind_speed_10m',
    daily: 'temperature_2m_max,temperature_2m_min',
    timezone: 'auto',
    forecast_days: '1',
  });
  return weatherVars(JSON.parse(await fetchText(`https://api.open-meteo.com/v1/forecast?${q}`, 'application/json', 200_000)) as OpenMeteo);
}
