import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// The data directory is read when config loads, so it has to be set before the imports run.
const dataDir = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? '/tmp'}/eink-ai-test-${process.pid}`;
  process.env.DATA_DIR = dir;
  process.env.AUTH_DISABLED = 'true';
  return dir;
});

import { ensureDirs } from '../src/config.js';
import { openDb, schema, setSetting } from '../src/db/index.js';
import { aiState, buildPrompt, collectionConfig, generationDue, generateFor, LEAD_MS, prune, RETRY_MS, sizeFor, targetSize, validateCollectionConfig } from '../src/lib/ai/generate.js';
import { AiError, fillWorkflow, GEMINI_URL, generateImage, imageProviders, openaiSize, testConnection } from '../src/lib/ai/providers.js';
import { aiConfig, aiConfigured, type AiConfig } from '../src/lib/ai/settings.js';
import { commonVars, fetchFeed, fillTemplate, nextFeedItem, parseFeed } from '../src/lib/ai/sources.js';
import { pickFresh } from '../src/lib/selection.js';

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

describe('collection config', () => {
  it('applies defaults and sanitises', () => {
    expect(collectionConfig({ config: {} } as never)).toMatchObject({ source: 'prompt', keep: 20 });
    expect(collectionConfig({ config: { source: 'bogus', keep: -3 } } as never)).toMatchObject({ source: 'prompt', keep: 20 });
    expect(collectionConfig({ config: { keep: 0 } } as never).keep).toBe(0);
  });
  it('requires what each source needs', () => {
    const base = collectionConfig({ config: {} } as never);
    expect(() => validateCollectionConfig({ ...base, source: 'prompt', prompt: '  ' })).toThrow(AiError);
    expect(() => validateCollectionConfig({ ...base, source: 'prompt', prompt: 'a fox' })).not.toThrow();
    expect(() => validateCollectionConfig({ ...base, source: 'rss', feedUrl: 'ftp://x' })).toThrow(AiError);
    expect(() => validateCollectionConfig({ ...base, source: 'rss', feedUrl: 'https://x/feed' })).not.toThrow();
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
  it('needs a key for Gemini and OpenAI, an address and a model for other services, a placeholder workflow for ComfyUI', () => {
    expect(aiConfigured(cfg({}))).toBe(false);
    expect(aiConfigured(cfg({ provider: 'gemini' }))).toBe(false);
    expect(aiConfigured(cfg({ provider: 'gemini', apiKey: 'k' }))).toBe(true);
    expect(aiConfigured(cfg({ provider: 'openai', apiKey: 'k' }))).toBe(true);
    expect(aiConfigured(cfg({ provider: 'openai_compatible', model: 'm' }))).toBe(false);
    expect(aiConfigured(cfg({ provider: 'openai_compatible', url: 'http://llm/v1', model: 'm' }))).toBe(true);
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
    const out = await generateImage(cfg({ provider: 'openai_compatible', url: 'http://llm:8080/v1/', apiKey: 'k', model: 'm' }), 'a fox', { width: 1200, height: 1600 });
    expect(out.equals(png)).toBe(true);
    expect(calls[0].url).toBe('http://llm:8080/v1/images/generations');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer k');
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ model: 'm', prompt: 'a fox', size: '1024x1536' });
  });

  it('follows an image url when no base64 comes back', async () => {
    vi.stubGlobal('fetch', async (url: string) => (url.endsWith('/images/generations') ? jsonRes({ data: [{ url: 'http://cdn/x.png' }] }) : new Response(png)));
    const out = await generateImage(cfg({ provider: 'openai_compatible', url: 'http://llm/v1', model: 'm' }), 'p', { width: 1, height: 1 });
    expect(out.equals(png)).toBe(true);
  });

  it('turns an HTTP error into a readable message', async () => {
    vi.stubGlobal('fetch', async () => new Response('quota exceeded', { status: 429 }));
    await expect(generateImage(cfg({ provider: 'openai_compatible', url: 'http://llm/v1', model: 'm' }), 'p', { width: 1, height: 1 })).rejects.toThrow(/429.*quota exceeded/);
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
    expect(await testConnection(cfg({ provider: 'openai_compatible', url: 'http://llm/v1' }))).toEqual({ server: 'llm', models: [] });
    expect(await testConnection(cfg({ provider: 'comfyui', url: 'http://comfy:8188' }))).toEqual({ server: 'comfy:8188' });
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
    setSetting(db, 'ai.provider', 'openai_compatible');
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

  it('puts the weather at the hub location into the prompt, or says a location is needed', async () => {
    setSetting(db, 'ai.provider', 'openai');
    setSetting(db, 'ai.url', 'http://llm/v1');
    setSetting(db, 'ai.model', 'm');
    const prompts: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      if (String(url).includes('open-meteo')) {
        const hours = Array.from({ length: 24 }, (_, h) => `2026-11-23T${String(h).padStart(2, '0')}:00`);
        return jsonRes({
          current: { time: '2026-11-23T12:10', temperature_2m: 6.4, weather_code: 63, is_day: 1, wind_speed_10m: 12 },
          hourly: { time: hours, temperature_2m: hours.map(() => 6), weather_code: hours.map(() => 63), is_day: hours.map(() => 1), wind_speed_10m: hours.map(() => 12), precipitation_probability: hours.map(() => 50) },
          daily: { time: ['2026-11-23'], weather_code: [63], temperature_2m_max: [8], temperature_2m_min: [3], precipitation_probability_max: [70], sunrise: ['2026-11-23T08:00'], sunset: ['2026-11-23T16:45'] },
        });
      }
      prompts.push(JSON.parse(String(init.body)).prompt);
      return jsonRes({ data: [{ b64_json: png.toString('base64') }] });
    });
    const col = addCollection({ source: 'prompt', prompt: 'Weather: {condition}, {temperature} degrees, {daypart}' });
    setSetting(db, 'location', '');
    expect(await generateFor({ db, log }, col.id)).toBe(false);
    expect(db.select().from(schema.collections).all().find((c) => c.id === col.id)!.syncError).toMatch(/needs a location/);
    setSetting(db, 'location', JSON.stringify({ name: 'Boechout', region: '', country: 'Belgium', countryCode: 'BE', latitude: 51.16, longitude: 4.49 }));
    expect(await generateFor({ db, log }, col.id)).toBe(true);
    expect(prompts).toEqual(['Weather: steady rain, rain streaks falling, wet glistening ground with puddle reflections, 6 degrees, day time']);
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

  it('only drops a picture from the AI collection when another collection holds it too', async () => {
    const col = addCollection({ source: 'prompt', prompt: 'x' });
    const manual = db.insert(schema.collections).values({ name: 'Favourites', type: 'manual', config: {}, createdAt: Date.now() }).returning().get();
    const imgs = [0, 1, 2].map((i) => {
      const img = db.insert(schema.images).values({ source: 'local', filePath: `local/k${col.id}-${i}.png`, createdAt: 5000 + i }).returning().get();
      db.insert(schema.collectionItems).values({ collectionId: col.id, imageId: img.id, position: i }).run();
      return img;
    });
    // The oldest one is a favourite in the manual collection.
    db.insert(schema.collectionItems).values({ collectionId: manual.id, imageId: imgs[0].id, position: 0 }).run();
    await prune(db, col.id, 1);
    const inAi = db.select().from(schema.collectionItems).all().filter((i) => i.collectionId === col.id).map((i) => i.imageId);
    expect(inAi).toEqual([imgs[2].id]);
    const images = db.select().from(schema.images).all().map((i) => i.id);
    expect(images).toContain(imgs[0].id); // kept: still in Favourites
    expect(images).not.toContain(imgs[1].id); // deleted: nowhere else
    expect(db.select().from(schema.collectionItems).all().filter((i) => i.collectionId === manual.id).map((i) => i.imageId)).toEqual([imgs[0].id]);
  });
});

describe('feed size limit', () => {
  it('stops reading a feed that is too large', async () => {
    let pulled = 0;
    const body = new ReadableStream({
      pull(c) {
        pulled++;
        c.enqueue(new Uint8Array(1_000_000));
        if (pulled > 50) c.close();
      },
    });
    vi.stubGlobal('fetch', async () => new Response(body));
    await expect(fetchFeed('http://f/rss')).rejects.toThrow('too large');
    expect(pulled).toBeLessThan(10);
  });

  it('refuses a feed that announces a size over the limit', async () => {
    vi.stubGlobal('fetch', async () => new Response('x', { headers: { 'content-length': '9000000' } }));
    await expect(fetchFeed('http://f/rss')).rejects.toThrow('too large');
  });
});

describe('image providers', () => {
  it('describes the fields of each provider and treats size "none" as no size', async () => {
    expect(imageProviders.map((p) => p.id)).toEqual(['gemini', 'openai', 'comfyui', 'openai_compatible']);
    const keys = (id: string) => imageProviders.find((p) => p.id === id)!.fields.map((f) => f.key);
    expect(keys('gemini')).toEqual(['apiKey', 'model', 'size']);
    expect(keys('openai')).toEqual(['apiKey', 'model', 'size']);
    expect(keys('comfyui')).toEqual(['url', 'username', 'apiKey', 'workflow']);
    expect(keys('openai_compatible')).toEqual(['url', 'apiKey', 'model', 'size']);
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return jsonRes({ data: [{ b64_json: Buffer.from('x').toString('base64') }] });
    });
    await generateImage(cfg({ provider: 'openai_compatible', url: 'http://llm/v1', model: 'm', size: 'none' }), 'p', { width: 1, height: 1 });
    await generateImage(cfg({ provider: 'openai_compatible', url: 'http://llm/v1', model: 'm' }), 'p', { width: 1, height: 1 });
    expect(bodies[0]).not.toHaveProperty('size');
    expect(bodies[1]).toHaveProperty('size', '1024x1024');
  });

  it('sends Gemini and OpenAI to their own address with the default model, whatever address is saved', async () => {
    const calls: { url: string; body: Record<string, unknown>; auth?: string }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)), auth: (init.headers as Record<string, string>).authorization });
      return jsonRes({ data: [{ b64_json: Buffer.from('x').toString('base64') }] });
    });
    await generateImage(cfg({ provider: 'gemini', url: 'http://left-over/v1', apiKey: 'g' }), 'p', { width: 1200, height: 1600 });
    await generateImage(cfg({ provider: 'openai', apiKey: 'o', model: 'dall-e-3' }), 'p', { width: 1200, height: 1600 });
    expect(calls[0]).toMatchObject({ url: `${GEMINI_URL}/images/generations`, auth: 'Bearer g', body: { model: 'gemini-2.5-flash-image' } });
    expect(calls[1]).toMatchObject({ url: 'https://api.openai.com/v1/images/generations', auth: 'Bearer o', body: { model: 'dall-e-3' } });
  });

  it('lists only the image models when testing the connection', async () => {
    const list = { data: [{ id: 'models/gemini-2.5-flash' }, { id: 'gemini-2.5-flash-image' }, { id: 'models/imagen-4.0-generate-001' }, { id: 'gpt-4o' }, { id: 'gpt-image-1' }, { id: 'dall-e-3' }, { id: 'nano-banana-pro-preview' }] };
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      return jsonRes(list);
    });
    expect(await testConnection(cfg({ provider: 'gemini', apiKey: 'g' }))).toEqual({
      server: 'generativelanguage.googleapis.com',
      models: ['gemini-2.5-flash-image', 'imagen-4.0-generate-001', 'nano-banana-pro-preview'],
    });
    expect((await testConnection(cfg({ provider: 'openai', apiKey: 'o' }))).models).toEqual(['dall-e-3', 'gpt-image-1']);
    // Another service: no way to tell image models apart, so all of them.
    expect((await testConnection(cfg({ provider: 'openai_compatible', url: 'http://llm/v1' }))).models).toHaveLength(7);
    expect(urls).toEqual([`${GEMINI_URL}/models`, 'https://api.openai.com/v1/models', 'http://llm/v1/models']);
  });

  it('reads an "openai" setting with its own address as another OpenAI-compatible service', () => {
    const db = openDb(path.join(os.tmpdir(), `eink-ai-migrate-${process.pid}.db`));
    setSetting(db, 'ai.provider', 'openai');
    setSetting(db, 'ai.url', 'http://localai:8080/v1');
    expect(aiConfig(db).provider).toBe('openai_compatible');
    setSetting(db, 'ai.url', '');
    expect(aiConfig(db).provider).toBe('openai');
  });
});

describe('settings API', () => {
  let app: Awaited<ReturnType<(typeof import('../src/app.js'))['buildApp']>>['app'];
  let apiDb: ReturnType<typeof openDb>;
  beforeAll(async () => {
    ensureDirs();
    apiDb = openDb(path.join(os.tmpdir(), `eink-ai-api-${process.pid}.db`));
    const { buildApp } = await import('../src/app.js');
    app = (await buildApp(apiDb, { logger: false })).app;
    return () => app.close();
  });

  it('lists the providers with their fields', async () => {
    const res = (await app.inject({ url: '/api/settings/ai' })).json();
    expect(res.providers.map((p: { id: string }) => p.id)).toEqual(['gemini', 'openai', 'comfyui', 'openai_compatible']);
    expect(res.providers[0]).toMatchObject({ label: 'Google Gemini', defaultModel: 'gemini-2.5-flash-image', listsModels: true });
    expect(res.providers[0].fields[0]).toMatchObject({ key: 'apiKey', type: 'password' });
    expect(res).not.toHaveProperty('apiKey');
  });

  it('lists the saved service\'s image models, and nothing when it can\'t', async () => {
    await app.inject({ method: 'PUT', url: '/api/settings/ai', payload: { provider: 'gemini', apiKey: 'g' } });
    vi.stubGlobal('fetch', async () => jsonRes({ data: [{ id: 'gemini-2.5-flash-image' }, { id: 'gemini-2.5-flash' }] }));
    expect((await app.inject({ url: '/api/settings/ai/models' })).json()).toEqual({ models: ['gemini-2.5-flash-image'] });
    const test = (await app.inject({ method: 'POST', url: '/api/settings/ai/test', payload: {} })).json();
    expect(test).toMatchObject({ ok: true, models: ['gemini-2.5-flash-image'] });
    vi.stubGlobal('fetch', async () => new Response('bad key', { status: 401 }));
    expect((await app.inject({ url: '/api/settings/ai/models' })).json()).toEqual({ models: [] });
  });

  it('tells every user whether AI collections can be made', async () => {
    await app.inject({ method: 'PUT', url: '/api/settings/ai', payload: { provider: '' } });
    expect((await app.inject({ url: '/api/settings' })).json().aiConfigured).toBe(false);
    await app.inject({ method: 'PUT', url: '/api/settings/ai', payload: { provider: 'gemini', apiKey: 'g' } });
    expect((await app.inject({ url: '/api/settings' })).json().aiConfigured).toBe(true);
  });

  it('removes the whole configuration', async () => {
    await app.inject({ method: 'PUT', url: '/api/settings/ai', payload: { provider: 'openai_compatible', url: 'http://llm/v1', apiKey: 'k', model: 'm' } });
    expect((await app.inject({ method: 'DELETE', url: '/api/settings/ai' })).statusCode).toBe(200);
    const res = (await app.inject({ url: '/api/settings/ai' })).json();
    expect(res).toMatchObject({ provider: '', url: '', model: '', apiKeySet: false, configured: false });
  });

  it('rejects an unknown provider with a 400', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/settings/ai', payload: { provider: 'nonsense' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error ?? res.json().message).toMatch(/nonsense/);
  });

  it('forgets the key when another service is chosen', async () => {
    await app.inject({ method: 'PUT', url: '/api/settings/ai', payload: { provider: 'openai', apiKey: 'secret' } });
    expect((await app.inject({ url: '/api/settings/ai' })).json().apiKeySet).toBe(true);
    await app.inject({ method: 'PUT', url: '/api/settings/ai', payload: { provider: 'comfyui' } });
    expect((await app.inject({ url: '/api/settings/ai' })).json().apiKeySet).toBe(false);
  });

  it('only uses the saved key for the address it was saved for', async () => {
    await app.inject({ method: 'PUT', url: '/api/settings/ai', payload: { provider: 'openai_compatible', url: 'http://llm/v1', apiKey: 'secret' } });
    const auth: (string | undefined)[] = [];
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
      auth.push((init.headers as Record<string, string>).authorization);
      return jsonRes({});
    });
    await app.inject({ method: 'POST', url: '/api/settings/ai/test', payload: {} });
    await app.inject({ method: 'POST', url: '/api/settings/ai/test', payload: { url: 'http://llm/v1/' } });
    await app.inject({ method: 'POST', url: '/api/settings/ai/test', payload: { url: 'http://elsewhere/v1' } });
    await app.inject({ method: 'POST', url: '/api/settings/ai/test', payload: { url: 'http://elsewhere/v1', apiKey: 'typed' } });
    expect(auth).toEqual(['Bearer secret', 'Bearer secret', undefined, 'Bearer typed']);
  });

  it('forgets the key when the address is saved without a new key', async () => {
    const key = async () => (await app.inject({ url: '/api/settings/ai' })).json().apiKeySet;
    await app.inject({ method: 'PUT', url: '/api/settings/ai', payload: { provider: 'openai_compatible', url: 'http://llm/v1', apiKey: 'secret' } });
    // Saving the same address again (the form sends no key) keeps it.
    await app.inject({ method: 'PUT', url: '/api/settings/ai', payload: { url: 'http://llm/v1/' } });
    expect(await key()).toBe(true);
    // A new address without a new key forgets it.
    await app.inject({ method: 'PUT', url: '/api/settings/ai', payload: { url: 'http://elsewhere/v1' } });
    expect(await key()).toBe(false);
    // A new address with a new key keeps the new one.
    await app.inject({ method: 'PUT', url: '/api/settings/ai', payload: { url: 'http://third/v1', apiKey: 'new' } });
    expect(await key()).toBe(true);
  });
});
