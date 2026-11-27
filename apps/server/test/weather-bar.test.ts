import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'b8hub-weatherbar-'));
process.env.AUTH_DISABLED = 'true';

const { ensureDirs, config } = await import('../src/config.js');
const { openDb, schema, setSetting } = await import('../src/db/index.js');
const { buildApp } = await import('../src/app.js');
const { renderForFrame } = await import('../src/imaging/pipeline.js');
const { skyLabel, skyOf } = await import('../src/imaging/sky.js');
const { assignmentOptions } = await import('../src/lib/display.js');
const { weatherBarFor } = await import('../src/lib/images.js');
const { clearWeatherCache } = await import('../src/lib/weather/index.js');

const db = (ensureDirs(), openDb(config.dbPath));

afterEach(() => {
  vi.unstubAllGlobals();
  clearWeatherCache();
});

const pixels = async (buf: Buffer) => {
  const r = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  return { info: r.info, px: (x: number, y: number) => [...r.data.subarray((y * r.info.width + x) * r.info.channels, (y * r.info.width + x) * r.info.channels + 3)] };
};
const base = { width: 600, height: 800, landscape: false, rotate: 0, fit: 'cover' as const, bg: '#ffffff', format: { type: 'png' as const } };
const picture = (colour: string) => sharp({ create: { width: 600, height: 800, channels: 3, background: colour } }).png().toBuffer();

describe('sky', () => {
  it('turns weather codes into a kind of sky, with a word per language', () => {
    expect([0, 2, 3, 45, 53, 63, 81, 73, 95, 99, 10, null].map((c) => skyOf(c))).toEqual(['clear', 'partly', 'cloudy', 'fog', 'drizzle', 'rain', 'rain', 'snow', 'thunder', 'thunder', null, null]);
    expect(skyLabel('rain', 'nl')).toBe('Regen');
    expect(skyLabel('rain', 'en')).toBe('Rain');
  });
});

describe('weather bar drawing', () => {
  it('draws a label at the bottom right without changing the picture size', async () => {
    const src = await picture('#336699');
    const a = await pixels(await renderForFrame(src, base));
    const b = await pixels(await renderForFrame(src, { ...base, weather: { min: 3, max: 9, rain: 60 } }));
    expect([b.info.width, b.info.height]).toEqual([600, 800]);
    expect(b.px(40, 760)).toEqual(a.px(40, 760));
    expect(b.px(568, 760)).toEqual([255, 255, 255]);
    // With the sky the label gets a second line, so it is taller than without.
    const c = await pixels(await renderForFrame(src, { ...base, weather: { min: 3, max: 9, rain: 60, sky: 'rain', label: 'Regen' } }));
    expect(c.px(568, 720)).toEqual([255, 255, 255]);
    expect(b.px(568, 720)).toEqual(a.px(568, 720));
  });

  it('uses the colours of the date label', async () => {
    const src = await picture('#336699');
    const weather = { min: 3, max: 9, rain: 60 };
    const dark = await pixels(await renderForFrame(src, { ...base, weather, pill: { bg: '#000000', text: '#ffffff', opacity: 100 } }));
    expect(dark.px(568, 760)).toEqual([0, 0, 0]);
    const half = (await pixels(await renderForFrame(src, { ...base, weather, pill: { bg: '#000000', text: '#ffffff', opacity: 50 } }))).px(568, 760);
    expect(half[2]).toBeGreaterThan(40);
    expect(half[2]).toBeLessThan(100);
  });

  it('picks automatic colours from the picture under the label', async () => {
    const weather = { min: 3, max: 9, rain: 60 };
    const auto = { bg: 'auto', text: '#1d1c1a', opacity: 100 };
    const over = async (colour: string) => (await pixels(await renderForFrame(await picture(colour), { ...base, weather, pill: auto }))).px(568, 760);
    expect((await over('#101010'))[0]).toBeGreaterThan(200);
    expect((await over('#f0f0f0'))[0]).toBeLessThan(60);
  });

  it('moves above the date label when the two would meet', async () => {
    const src = await picture('#336699');
    const r = await pixels(await renderForFrame(src, { ...base, caption: '23 november 2026 · Antwerpen, België', weather: { min: 3, max: 9, rain: 60 } }));
    expect(r.px(568, 760)).toEqual([51, 102, 153]);
    expect(r.px(568, 722)).not.toEqual([51, 102, 153]);
  });
});

const hours = (day: string) => Array.from({ length: 24 }, (_, h) => `${day}T${String(h).padStart(2, '0')}:00`);
const answer = {
  current: { time: '2026-11-23T06:50', temperature_2m: 5, weather_code: 3, is_day: 0, wind_speed_10m: 10 },
  hourly: {
    time: [...hours('2026-11-23'), ...hours('2026-11-24')],
    temperature_2m: Array.from({ length: 48 }, (_, i) => i),
    weather_code: Array.from({ length: 48 }, (_, i) => (i === 11 ? 63 : 0)),
    is_day: Array.from({ length: 48 }, () => 1),
    wind_speed_10m: Array.from({ length: 48 }, () => 5),
    precipitation_probability: Array.from({ length: 48 }, () => 10),
  },
  daily: {
    time: ['2026-11-23', '2026-11-24'],
    weather_code: [3, 71],
    temperature_2m_max: [9.6, 4.2],
    temperature_2m_min: [2.1, -1.4],
    precipitation_probability_max: [80, 20],
    sunrise: ['2026-11-23T08:00', '2026-11-24T08:02'],
    sunset: ['2026-11-23T16:45', '2026-11-24T16:44'],
  },
};
const stub = (calls: string[] = []) =>
  vi.stubGlobal('fetch', async (url: string) => {
    calls.push(url);
    return { ok: true, status: 200, text: async () => JSON.stringify(answer) };
  });
const ctx = { db, log: { warn: () => {} } } as never;
const frame = (location?: object) => ({ config: location ? { location } : {} }) as never;
const boechout = { name: 'Boechout', region: '', country: 'Belgium', countryCode: 'BE', latitude: 51.16, longitude: 4.49 };
const lier = { ...boechout, name: 'Lier', latitude: 51.13, longitude: 4.57 };

describe('weather bar content', () => {
  it('has no bar without a location, and none when the source fails', async () => {
    setSetting(db, 'location', '');
    expect(await weatherBarFor(ctx, frame(), 0)).toBeNull();
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 500, text: async () => '' }));
    expect(await weatherBarFor(ctx, frame(boechout), 0)).toBeNull();
  });

  it("shows the day's low, high and rain with the sky now, in the hub's language", async () => {
    stub();
    expect(await weatherBarFor(ctx, frame(boechout), 0)).toEqual({ min: 2, max: 10, rain: 80, sky: 'cloudy', label: expect.any(String) });
  });

  it('takes the sky from the hour it looks ahead to, and the numbers from that day', async () => {
    stub();
    expect(await weatherBarFor(ctx, frame(boechout), 4)).toMatchObject({ min: 2, max: 10, rain: 80, sky: 'rain' });
  });

  it("uses the Canvas's own location, otherwise the hub's", async () => {
    const calls: string[] = [];
    stub(calls);
    setSetting(db, 'location', JSON.stringify(boechout));
    await weatherBarFor(ctx, frame(), 0);
    await weatherBarFor(ctx, frame(lier), 0);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('latitude=51.16');
    expect(calls[1]).toContain('latitude=51.13');
    setSetting(db, 'location', '');
  });
});

describe('weather bar option on a schedule', () => {
  let app: Awaited<ReturnType<typeof buildApp>>['app'];
  beforeAll(async () => {
    app = (await buildApp(db, { logger: false })).app;
  });
  afterAll(() => app.close());

  it('saves the options, clamps the hours and keeps them for older clients', async () => {
    const f = db.insert(schema.frames).values({ name: 'Test', host: '127.0.0.1:1', upstreamToken: 'bar-test', mode: 'push', createdAt: Date.now() }).returning().get();
    const col = (await app.inject({ method: 'POST', url: '/api/collections', payload: { name: 'Manual', type: 'manual' } })).json();
    const put = async (payload: object) => (await app.inject({ method: 'PUT', url: `/api/frames/${f.id}/assignment`, payload: { collectionId: col.id, ...payload } })).json();
    expect(await put({})).toMatchObject({ weatherBar: false, weatherHours: 0 });
    expect(await put({ weatherBar: true, weatherHours: 4 })).toMatchObject({ weatherBar: true, weatherHours: 4 });
    expect(await put({ fit: 'contain' })).toMatchObject({ weatherBar: true, weatherHours: 4 });
    expect(await put({ weatherHours: 400 })).toMatchObject({ weatherHours: 47 });
    expect(await put({ weatherBar: 'no', weatherHours: -2 })).toMatchObject({ weatherBar: true, weatherHours: 0 });
  });

  it('is passed on to the render only when switched on', () => {
    const col = db.insert(schema.collections).values({ name: 'M', type: 'manual', config: {}, createdAt: Date.now() }).returning().get();
    const assign = (over: object) => ({ collectionId: col.id, fit: 'cover', bg: '#ffffff', showDate: false, weatherBar: false, weatherHours: 0, ...over }) as never;
    expect(assignmentOptions(db, assign({})).weatherBar).toBeUndefined();
    expect(assignmentOptions(db, assign({ weatherBar: true, weatherHours: 5 })).weatherBar).toEqual({ hours: 5 });
    expect(assignmentOptions(db, assign({ weatherBar: true, weatherHours: 99 })).weatherBar).toEqual({ hours: 47 });
  });
});
