import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// The data directory is read when config loads, so it has to be set before the imports run.
const dataDir = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? '/tmp'}/eink-ai-test-${process.pid}`;
  process.env.DATA_DIR = dir;
  return dir;
});

import { ensureDirs } from '../src/config.js';
import { openDb, schema, setSetting } from '../src/db/index.js';
import { aiState, buildPrompt, collectionConfig, generationDue, generateFor, LEAD_MS, prune, RETRY_MS, sizeFor, targetSize, validateCollectionConfig } from '../src/lib/ai/generate.js';
import { AiError, fillWorkflow, generateImage, openaiSize, testConnection } from '../src/lib/ai/providers.js';
import { aiConfigured, type AiConfig } from '../src/lib/ai/settings.js';
import { commonVars, fetchDayForecast, fillTemplate, nextFeedItem, parseDayForecast, parseFeed, weatherCondition, weatherLook, weatherVars } from '../src/lib/ai/sources.js';
import { pickFresh } from '../src/lib/selection.js';
import { assignmentOptions } from '../src/lib/display.js';
import { renderForFrame } from '../src/imaging/pipeline.js';
import { skyLabel, skyOf } from '../src/imaging/sky.js';

const cfg = (c: Partial<AiConfig>): AiConfig => ({ provider: '', url: '', apiKey: '', username: '', model: '', size: '', workflow: '', ...c });
const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('prompt templates', () => {
  it('fills known variables and blanks unknown ones', () => {
    expect(fillTemplate('A {condition} day {nope}!', { condition: 'rainy' })).toBe('A rainy day !');
  });
});

describe('feed parsing', () => {
  const rss = `<?xml version="1.0"?><rss><channel><title>News</title>
    <item><title><![CDATA[Cats &amp; dogs <b>unite</b>]]></title><guid>g1</guid><link>https://x/1</link>
      <description>&lt;p&gt;A &amp;quot;big&amp;quot; story&lt;/p&gt;</description><pubDate>Mon, 02 Nov 2026 10:00:00 GMT</pubDate></item>
    <item><title>Second</title><link>https://x/2</link><pubDate>Tue, 03 Nov 2026 10:00:00 GMT</pubDate></item></channel></rss>`;
  const atom = `<feed><title>Blog</title><entry><title>Hello</title><id>urn:1</id><link href="https://y/1"/><summary>Hi there</summary><updated>2026-11-01T10:00:00Z</updated></entry></feed>`;

  it('reads RSS items, decoding entities and dropping markup', () => {
    const items = parseFeed(rss);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ id: 'g1', title: 'Cats & dogs unite', link: 'https://x/1' });
    expect(items[0].description).toBe('A "big" story');
    expect(items[1].id).toBe('https://x/2');
  });
  it('reads Atom entries', () => {
    expect(parseFeed(atom)[0]).toMatchObject({ id: 'urn:1', title: 'Hello', link: 'https://y/1', description: 'Hi there' });
  });
  it('picks the first item not yet seen', () => {
    const items = parseFeed(rss);
    expect(nextFeedItem(items, [])?.id).toBe('g1');
    expect(nextFeedItem(items, ['g1'])?.id).toBe('https://x/2');
    expect(nextFeedItem(items, ['g1', 'https://x/2'])).toBeNull();
  });
});

describe('weather', () => {
  it('describes weather codes', () => {
    expect(weatherCondition(63)).toBe('rain');
    expect(weatherCondition(1234)).toBe('changeable weather');
  });
  it('describes the weather as something a picture can show', () => {
    expect(weatherLook(63, 'day')).toBe('steady rain, rain streaks falling, wet glistening ground with puddle reflections');
    expect(weatherLook(0, 'day')).toBe('clear sky with bright sunshine');
    expect(weatherLook(0, 'sun')).toBe('clear sky');
    expect(weatherLook(0, 'night')).toBe('clear sky with a bright moon and stars');
    expect(weatherLook(63, 'night')).toBe('steady rain, rain streaks falling, wet glistening ground with puddle reflections');
    expect(weatherLook(1234, 'day')).toBe('changeable weather');
  });
  it('turns an Open-Meteo answer into prompt variables', () => {
    const v = weatherVars({ current: { temperature_2m: 12.4, weather_code: 3, is_day: 0, wind_speed_10m: 20.2 }, daily: { temperature_2m_max: [15.6], temperature_2m_min: [8.1] } });
    expect(v).toMatchObject({ condition: 'overcast sky with heavy grey clouds', temperature: '12', high: '16', low: '8', wind: '20', daypart: 'night time, dark night' });
  });
  it('refuses an answer without current weather', () => {
    expect(() => weatherVars({})).toThrow(AiError);
  });
});

describe('collection config', () => {
  it('applies defaults and sanitises', () => {
    expect(collectionConfig({ config: {} } as never)).toMatchObject({ source: 'prompt', keep: 20, latitude: null });
    expect(collectionConfig({ config: { source: 'bogus', keep: -3 } } as never)).toMatchObject({ source: 'prompt', keep: 20 });
    expect(collectionConfig({ config: { keep: 0 } } as never).keep).toBe(0);
  });
  it('requires what each source needs', () => {
    const base = collectionConfig({ config: {} } as never);
    expect(() => validateCollectionConfig({ ...base, source: 'prompt', prompt: '  ' })).toThrow(AiError);
    expect(() => validateCollectionConfig({ ...base, source: 'prompt', prompt: 'a fox' })).not.toThrow();
    expect(() => validateCollectionConfig({ ...base, source: 'rss', feedUrl: 'ftp://x' })).toThrow(AiError);
    expect(() => validateCollectionConfig({ ...base, source: 'rss', feedUrl: 'https://x/feed' })).not.toThrow();
    expect(() => validateCollectionConfig({ ...base, source: 'weather' })).toThrow(AiError);
    expect(() => validateCollectionConfig({ ...base, source: 'weather', latitude: 51, longitude: 4 })).not.toThrow();
    expect(() => validateCollectionConfig({ ...base, source: 'weather', latitude: 95, longitude: 4 })).toThrow(AiError);
  });
});

describe('daypart', () => {
  const at = (time: string, code = 0) =>
    weatherVars({
      current: { time: `2026-11-21T${time}`, temperature_2m: 5, weather_code: code, is_day: 1, wind_speed_10m: 3 },
      daily: { sunrise: ['2026-11-21T07:58'], sunset: ['2026-11-21T16:38'] },
    });
  it('knows night, sunrise, day time and sunset', () => {
    expect(at('03:10').daypart).toBe('night time, dark night');
    expect(at('07:40').daypart).toMatch(/^sunrise/); // hour 08:00
    expect(at('12:20').daypart).toBe('day time');
    expect(at('16:20').daypart).toMatch(/^sunset/); // hour 16:00
    expect(at('17:10').daypart).toMatch(/^sunset/); // hour 17:00
    expect(at('21:00').daypart).toMatch(/^night time/);
  });
  it('does not depend on the weather', () => {
    expect(at('12:20', 95).daypart).toBe('day time'); // thunderstorm
    expect(at('03:10', 3).daypart).toMatch(/^night time/);
  });
  it('gives the weather a visible form for the time of day', () => {
    expect(at('03:10').condition).toBe('clear sky with a bright moon and stars');
    expect(at('12:20').condition).toBe('clear sky with bright sunshine');
    expect(at('16:20').condition).toBe('clear sky');
  });
  it('gives the sun times', () => {
    expect(at('12:00')).toMatchObject({ sunrise: '07:58', sunset: '16:38' });
  });
});

describe('time tag', () => {
  it('gives the nearest full hour', () => {
    const at = (h: number, m: number) => commonVars(new Date(2026, 10, 21, h, m)).time;
    expect(at(13, 15)).toBe('13:00');
    expect(at(13, 50)).toBe('14:00');
    expect(at(23, 40)).toBe('00:00');
  });
});

describe('sizes', () => {
  it('follows the frame shape with the longest side capped and multiples of 8', () => {
    expect(targetSize({ width: 1200, height: 1600, orientation: 'portrait' })).toEqual({ width: 912, height: 1216 });
    expect(targetSize({ width: 1200, height: 1600, orientation: 'landscape' })).toEqual({ width: 1216, height: 912 });
    expect(targetSize(undefined)).toEqual({ width: 912, height: 1216 });
  });

  it('sizes a picture for the collection panel and orientation, not the frame', () => {
    const cfg = (panel: string | null, orientation: 'portrait' | 'landscape') => collectionConfig({ config: { panel, orientation } } as never);
    const landscapeFrame = { width: 1200, height: 1600, orientation: 'landscape' as const };
    expect(sizeFor(cfg('1200x1600', 'portrait'), landscapeFrame)).toEqual({ width: 912, height: 1216 });
    expect(sizeFor(cfg('480x800', 'landscape'), undefined)).toEqual({ width: 800, height: 480 });
    // No panel chosen (older collection): follow the frame.
    expect(sizeFor(cfg(null, 'portrait'), landscapeFrame)).toEqual({ width: 1216, height: 912 });
    expect(collectionConfig({ config: { panel: 'nonsense' } } as never)).toMatchObject({ panel: null, orientation: 'portrait' });
  });
  it('picks an OpenAI size by aspect', () => {
    expect(openaiSize(1200, 1600)).toBe('1024x1536');
    expect(openaiSize(1600, 1200)).toBe('1536x1024');
    expect(openaiSize(1000, 1000)).toBe('1024x1024');
  });
});

describe('provider configuration', () => {
  it('needs a model for OpenAI and a placeholder workflow for ComfyUI', () => {
    expect(aiConfigured(cfg({}))).toBe(false);
    expect(aiConfigured(cfg({ provider: 'openai' }))).toBe(false);
    expect(aiConfigured(cfg({ provider: 'openai', model: 'gpt-image-1' }))).toBe(true);
    expect(aiConfigured(cfg({ provider: 'comfyui', url: 'http://c:8188', workflow: '{}' }))).toBe(false);
    expect(aiConfigured(cfg({ provider: 'comfyui', url: 'http://c:8188', workflow: '{"a":"{{prompt}}"}' }))).toBe(true);
  });
});

describe('ComfyUI workflow', () => {
  const wf = JSON.stringify({ '6': { inputs: { text: 'cartoon: {{prompt}}, bold', seed: '{{seed}}', w: '{{width}}', h: '{{height}}' } } });
  it('fills the prompt in text and numbers for seed and size', () => {
    const out = fillWorkflow(wf, 'a "quoted" fox', { width: 768, height: 1024 }, 42) as { '6': { inputs: Record<string, unknown> } };
    expect(out['6'].inputs).toEqual({ text: 'cartoon: a "quoted" fox, bold', seed: 42, w: 768, h: 1024 });
  });
  it('rejects broken JSON', () => {
    expect(() => fillWorkflow('{nope', 'x', { width: 1, height: 1 })).toThrow(AiError);
  });
});

describe('generating', () => {
  const png = Buffer.from('png-bytes');

  it('asks an OpenAI-compatible endpoint and decodes base64', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonRes({ data: [{ b64_json: png.toString('base64') }] });
    });
    const out = await generateImage(cfg({ provider: 'openai', url: 'http://llm:8080/v1/', apiKey: 'k', model: 'm' }), 'a fox', { width: 1200, height: 1600 });
    expect(out.equals(png)).toBe(true);
    expect(calls[0].url).toBe('http://llm:8080/v1/images/generations');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer k');
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ model: 'm', prompt: 'a fox', size: '1024x1536' });
  });

  it('follows an image url when no base64 comes back', async () => {
    vi.stubGlobal('fetch', async (url: string) => (url.endsWith('/images/generations') ? jsonRes({ data: [{ url: 'http://cdn/x.png' }] }) : new Response(png)));
    const out = await generateImage(cfg({ provider: 'openai', url: 'http://llm/v1', model: 'm' }), 'p', { width: 1, height: 1 });
    expect(out.equals(png)).toBe(true);
  });

  it('turns an HTTP error into a readable message', async () => {
    vi.stubGlobal('fetch', async () => new Response('quota exceeded', { status: 429 }));
    await expect(generateImage(cfg({ provider: 'openai', url: 'http://llm/v1', model: 'm' }), 'p', { width: 1, height: 1 })).rejects.toThrow(/429.*quota exceeded/);
  });

  it('queues a ComfyUI workflow, waits for the history and downloads the image', async () => {
    let polls = 0;
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      seen.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/prompt')) {
        expect(JSON.parse(String(init?.body)).prompt['3'].inputs.text).toBe('a fox');
        return jsonRes({ prompt_id: 'abc' });
      }
      if (url.includes('/history/abc')) return jsonRes(++polls < 2 ? {} : { abc: { status: { completed: true }, outputs: { '9': { images: [{ filename: 'o.png', subfolder: '', type: 'output' }] } } } });
      if (url.includes('/view?')) {
        expect(url).toContain('filename=o.png');
        return new Response(png);
      }
      throw new Error(`unexpected ${url}`);
    });
    const out = await generateImage(cfg({ provider: 'comfyui', url: 'http://comfy:8188/', workflow: '{"3":{"inputs":{"text":"{{prompt}}"}}}' }), 'a fox', { width: 512, height: 512 });
    expect(out.equals(png)).toBe(true);
    expect(seen[0]).toBe('POST http://comfy:8188/prompt');
  }, 15000);

  it('signs in with HTTP Basic when ComfyUI sits behind a login', async () => {
    const auths: (string | undefined)[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      auths.push((init?.headers as Record<string, string> | undefined)?.authorization);
      if (url.endsWith('/prompt')) return jsonRes({ prompt_id: 'a' });
      if (url.includes('/history/')) return jsonRes({ a: { outputs: { '1': { images: [{ filename: 'o.png' }] } } } });
      return new Response(png);
    });
    await generateImage(cfg({ provider: 'comfyui', url: 'https://comfy', username: 'eink-hub', apiKey: 'pw', workflow: '{"a":"{{prompt}}"}' }), 'p', { width: 8, height: 8 });
    expect(auths).toHaveLength(3);
    for (const a of auths) expect(a).toBe(`Basic ${Buffer.from('eink-hub:pw').toString('base64')}`);
    await testConnection(cfg({ provider: 'comfyui', url: 'https://comfy', username: 'eink-hub', apiKey: 'pw' }));
    expect(auths[3]).toBe(auths[0]);
  }, 15000);

  it('reports a ComfyUI error status', async () => {
    vi.stubGlobal('fetch', async (url: string) => (url.endsWith('/prompt') ? jsonRes({ prompt_id: 'e' }) : jsonRes({ e: { status: { status_str: 'error' } } })));
    await expect(generateImage(cfg({ provider: 'comfyui', url: 'http://c', workflow: '{"a":"{{prompt}}"}' }), 'p', { width: 8, height: 8 })).rejects.toThrow(/error/);
  }, 15000);

  it('tests a connection without generating', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      return jsonRes({});
    });
    expect(await testConnection(cfg({ provider: 'openai', url: 'http://llm/v1' }))).toBe('llm');
    expect(await testConnection(cfg({ provider: 'comfyui', url: 'http://comfy:8188' }))).toBe('comfy:8188');
    expect(urls).toEqual(['http://llm/v1/models', 'http://comfy:8188/system_stats']);
  });
});

describe('ahead of the frame', () => {
  const now = 1_000_000_000;
  it('waits until the lead window opens', () => {
    expect(generationDue([now + LEAD_MS + 1000], null, null, now)).toBe(false);
    expect(generationDue([now + LEAD_MS - 1000], null, null, now)).toBe(true);
  });
  it('does nothing without a scheduled change', () => {
    expect(generationDue([], null, null, now)).toBe(false);
    expect(generationDue([null], null, null, now)).toBe(false);
  });
  it('generates once per change', () => {
    const next = now + 5 * 60_000;
    expect(generationDue([next], now - 60_000, null, now)).toBe(false);
    expect(generationDue([next], next - LEAD_MS - 1000, null, now)).toBe(true);
  });
  it('still generates when the change is overdue', () => {
    expect(generationDue([now - 3 * 60_000], now - 3600_000, null, now)).toBe(true);
  });
  it('backs off after a failure', () => {
    const next = now + 60_000;
    expect(generationDue([next], null, now - 60_000, now)).toBe(false);
    expect(generationDue([next], null, now - RETRY_MS - 1, now)).toBe(true);
  });
  it('follows the earliest of several frames', () => {
    expect(generationDue([now + 3600_000, now + 60_000], now - 3600_000, null, now)).toBe(true);
  });
});

describe('choosing a generated picture', () => {
  const c = [1, 2, 3].map((id) => ({ id, position: id, takenAt: id * 1000 }));
  it('takes the newest one that was not shown yet', () => {
    expect(pickFresh(c, [])).toBe(3);
    expect(pickFresh(c, [3])).toBe(2);
    expect(pickFresh(c, [4, 3, 2])).toBe(1);
  });
  it('picks a new one even when older ones were shown after it', () => {
    expect(pickFresh([...c, { id: 4, position: 4, takenAt: 4000 }], [2, 1, 3])).toBe(4);
  });
  it('falls back to a repeat when all were shown, but not the last one', () => {
    for (let i = 0; i < 30; i++) expect(pickFresh(c, [1, 2, 3])).not.toBe(1);
    expect(pickFresh([], [])).toBeNull();
  });
});

describe('collections end to end', () => {
  let db: ReturnType<typeof openDb>;
  let png: Buffer;
  const log = { warn: () => {}, info: () => {}, error: () => {} } as never;

  beforeAll(async () => {
    ensureDirs();
    db = openDb(path.join(os.tmpdir(), `eink-ai-${process.pid}.db`));
    png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#c33' } }).png().toBuffer();
    return () => fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const addCollection = (config: Record<string, unknown>) =>
    db.insert(schema.collections).values({ name: 'AI', type: 'ai', config, createdAt: Date.now() }).returning().get();

  it('generates a picture from a prompt, adds it to the collection and remembers it', async () => {
    setSetting(db, 'ai.provider', 'openai');
    setSetting(db, 'ai.url', 'http://llm/v1');
    setSetting(db, 'ai.model', 'm');
    const prompts: string[] = [];
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
      prompts.push(JSON.parse(String(init.body)).prompt);
      return jsonRes({ data: [{ b64_json: png.toString('base64') }] });
    });
    const col = addCollection({ source: 'prompt', prompt: 'A fox in {season}' });
    expect(await generateFor({ db, log }, col.id)).toBe(true);
    expect(prompts[0]).toMatch(/^A fox in (winter|spring|summer|autumn)$/);
    const row = db.select().from(schema.collections).all().find((c) => c.id === col.id)!;
    expect(row.itemCount).toBe(1);
    expect(row.syncError).toBeNull();
    expect(aiState(db, col.id).lastGenerated).not.toBeNull();
  });

  it('illustrates each feed item once', async () => {
    const feed = `<rss><channel><item><title>New</title><guid>n</guid><pubDate>Tue, 03 Nov 2026 10:00:00 GMT</pubDate></item><item><title>Old</title><guid>o</guid><pubDate>Mon, 02 Nov 2026 10:00:00 GMT</pubDate></item></channel></rss>`;
    vi.stubGlobal('fetch', async () => new Response(feed));
    const base = collectionConfig({ config: { source: 'rss', feedUrl: 'http://f/rss', prompt: 'Cartoon: {title}' } } as never);
    const first = await buildPrompt(base, []);
    expect(first).toEqual({ prompt: 'Cartoon: New', itemId: 'n' });
    expect((await buildPrompt(base, ['n'])).itemId).toBe('o');
    expect((await buildPrompt(base, ['n', 'o'])).itemId).toBe('n');
  });

  it('records a failure on the collection instead of throwing', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 500 }));
    const col = addCollection({ source: 'prompt', prompt: 'x' });
    expect(await generateFor({ db, log }, col.id)).toBe(false);
    const row = db.select().from(schema.collections).all().find((c) => c.id === col.id)!;
    expect(row.syncError).toMatch(/500/);
    expect(row.itemCount).toBe(0);
  });

  it('keeps only the newest N, but never removes a picture that is on a frame', async () => {
    const col = addCollection({ source: 'prompt', prompt: 'x' });
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      const img = db.insert(schema.images).values({ source: 'local', filePath: `local/t${col.id}-${i}.png`, createdAt: 1000 + i }).returning().get();
      ids.push(img.id);
      db.insert(schema.collectionItems).values({ collectionId: col.id, imageId: img.id, position: i }).run();
    }
    db.insert(schema.frames)
      .values({ name: 'f', host: 'h', upstreamToken: 't', mode: 'pull', createdAt: 1, currentImageId: ids[0] } as never)
      .run();
    await prune(db, col.id, 2);
    const left = db.select().from(schema.collectionItems).all().filter((i) => i.collectionId === col.id).map((i) => i.imageId).sort();
    expect(left).toEqual([ids[0], ids[3], ids[4]].sort());
    await prune(db, col.id, 0);
    expect(db.select().from(schema.collectionItems).all().filter((i) => i.collectionId === col.id)).toHaveLength(3);
  });
});

describe('weather bar', () => {
  it('reads the day forecast and rounds it', () => {
    expect(parseDayForecast({ daily: { weather_code: [3], temperature_2m_max: [12.6], temperature_2m_min: [3.4], precipitation_probability_max: [64.4] } })).toEqual({ min: 3, max: 13, rain: 64, sky: 'cloudy' });
    expect(parseDayForecast({ daily: { temperature_2m_max: [5], temperature_2m_min: [-2.6] } })).toEqual({ min: -3, max: 5, rain: null, sky: null });
    expect(parseDayForecast({ daily: { temperature_2m_max: [5], temperature_2m_min: [-0.3] } }).min).toBe(0); // not -0
    expect([0, 2, 45, 53, 63, 81, 73, 95, 7].map(skyOf)).toEqual(['clear', 'partly', 'fog', 'drizzle', 'rain', 'rain', 'snow', 'thunder', null]);
    expect(skyLabel('cloudy', 'nl')).toBe('Bewolkt');
    expect(skyLabel('cloudy', 'xx' as never)).toBe('Cloudy');
    expect(() => parseDayForecast({})).toThrow(AiError);
  });

  it('asks Open-Meteo once per place for a while', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      return jsonRes({ daily: { temperature_2m_max: [10], temperature_2m_min: [4], precipitation_probability_max: [30] } });
    });
    const t0 = Date.now();
    expect(await fetchDayForecast(51.1, 4.4, t0)).toEqual({ min: 4, max: 10, rain: 30, sky: null });
    await fetchDayForecast(51.1, 4.4, t0 + 60_000);
    expect(calls).toBe(1);
    await fetchDayForecast(51.1, 4.4, t0 + 20 * 60_000);
    expect(calls).toBe(2);
  });

  it('draws a label at the bottom right without changing the picture size', async () => {
    const src = await sharp({ create: { width: 600, height: 800, channels: 3, background: '#336699' } }).png().toBuffer();
    const base = { width: 600, height: 800, landscape: false, rotate: 0, fit: 'cover' as const, bg: '#ffffff', format: { type: 'png' as const } };
    const plain = await renderForFrame(src, base);
    const withBar = await renderForFrame(src, { ...base, weather: { min: 3, max: 9, rain: 60 }, pill: { bg: '#ffffff', text: '#1d1c1a', opacity: 72 } });
    const [a, b] = await Promise.all([sharp(plain).raw().toBuffer({ resolveWithObject: true }), sharp(withBar).raw().toBuffer({ resolveWithObject: true })]);
    expect([b.info.width, b.info.height]).toEqual([600, 800]);
    const px = (r: typeof a, x: number, y: number) => [...r.data.subarray((y * r.info.width + x) * r.info.channels, (y * r.info.width + x) * r.info.channels + 3)];
    // Bottom-left stays as it was; bottom-right now has the translucent label (lighter than the picture).
    expect(px(b, 40, 760)).toEqual(px(a, 40, 760));
    const [r0, g0] = px(a, 560, 760);
    const [r1, g1] = px(b, 560, 760);
    expect(r1).toBeGreaterThan(r0);
    expect(g1).toBeGreaterThan(g0);
    // Translucent: still tinted by the picture, not pure white.
    expect(r1).toBeLessThan(255);
    // With the sky the label gets a second line, so it is taller than without.
    const sky = await renderForFrame(src, { ...base, weather: { min: 3, max: 9, rain: 60, sky: 'rain', label: 'Regen' } });
    const c = await sharp(sky).raw().toBuffer({ resolveWithObject: true });
    const lit = (r: typeof a, y: number) => px(r, 560, y)[0] > px(a, 560, y)[0];
    expect(lit(c, 720)).toBe(true);
    expect(lit(b, 720)).toBe(false);
  });
});

describe('weather bar option', () => {
  it('is only passed on for a weather collection that has it switched on', () => {
    const db = openDb(path.join(os.tmpdir(), `eink-wbar-${process.pid}.db`));
    const add = (config: Record<string, unknown>) => db.insert(schema.collections).values({ name: 'W', type: 'ai', config, createdAt: Date.now() }).returning().get().id;
    const assign = (collectionId: number) => ({ collectionId, fit: 'cover', bg: '#ffffff', showDate: false }) as never;
    const place = { latitude: 51.2, longitude: 4.4 };
    expect(assignmentOptions(db, assign(add({ source: 'weather', weatherBar: true, ...place })))).toMatchObject({ weatherBar: place });
    expect(assignmentOptions(db, assign(add({ source: 'weather', weatherBar: false, ...place }))).weatherBar).toBeUndefined();
    expect(assignmentOptions(db, assign(add({ source: 'prompt', weatherBar: true, ...place }))).weatherBar).toBeUndefined();
    expect(assignmentOptions(db, assign(add({ source: 'weather', weatherBar: true }))).weatherBar).toBeUndefined();
  });
});
