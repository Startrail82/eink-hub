import { skyOf, type Sky } from '../../imaging/sky.js';
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

export async function fetchText(url: string, accept: string, limit: number): Promise<string> {
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
