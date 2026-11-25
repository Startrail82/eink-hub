import fs from 'node:fs';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// The data directory is read when config loads, so it has to be set before the imports run.
const dataDir = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? '/tmp'}/eink-weather-test-${process.pid}`;
  process.env.DATA_DIR = dir;
  return dir;
});

import { ensureDirs } from '../src/config.js';
import { openDb, schema } from '../src/db/index.js';
import { renderForFrame } from '../src/imaging/pipeline.js';
import { skyLabel, skyOf } from '../src/imaging/sky.js';
import { assignmentOptions } from '../src/lib/display.js';
import { buildPrompt, collectionConfig, validateCollectionConfig } from '../src/lib/ai/generate.js';
import { AiError } from '../src/lib/ai/providers.js';
import { weatherCondition, weatherLook, weatherVars } from '../src/lib/weather/describe.js';
import { dayForecast, fetchDayForecast } from '../src/lib/weather/forecast.js';
import { cleanOffset, fetchWeatherVars, saveWeatherConfig, weatherConfig, weatherProviders, type WeatherProvider, type WeatherSnapshot } from '../src/lib/weather/index.js';
import { atOffset, openMeteo, snapshotFromOpenMeteo, targetHour } from '../src/lib/weather/openmeteo.js';

afterEach(() => vi.unstubAllGlobals());

const snap = (time: string, code = 0, over: Partial<WeatherSnapshot> = {}): WeatherSnapshot => ({
  code,
  temperature: 5,
  high: 7,
  low: 1,
  wind: 3,
  rain: 20,
  dayCode: code,
  isDay: true,
  time: `2026-11-21T${time}`,
  sunrise: '2026-11-21T07:58',
  sunset: '2026-11-21T16:38',
  ...over,
});

describe('weather words', () => {
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
});

describe('prompt variables from a snapshot', () => {
  it('rounds the figures', () => {
    const v = weatherVars(snap('23:00', 3, { temperature: 12.4, high: 15.6, low: 7.5, wind: 20.2, isDay: false }));
    expect(v).toMatchObject({ condition: 'overcast sky with heavy grey clouds', temperature: '12', high: '16', low: '8', wind: '20', daypart: 'night time, dark night' });
  });
  it('leaves out what the provider does not know', () => {
    expect(weatherVars(snap('12:00', 0, { high: null, low: null, wind: null, sunrise: null, sunset: null }))).toMatchObject({ high: '', low: '', wind: '', sunrise: '', sunset: '', daypart: 'day time' });
  });
  it('falls back to day or night without sun times', () => {
    expect(weatherVars(snap('12:00', 0, { sunrise: null, sunset: null, isDay: false })).daypart).toMatch(/^night time/);
  });
  describe('daypart', () => {
    const at = (time: string, code = 0) => weatherVars(snap(time, code));
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
});

describe('Open-Meteo', () => {
  it('turns its answer into a snapshot', () => {
    expect(
      snapshotFromOpenMeteo({
        current: { time: '2026-11-21T12:00', temperature_2m: 12.4, weather_code: 3, is_day: 0, wind_speed_10m: 20.2 },
        daily: { weather_code: [61], precipitation_probability_max: [40], temperature_2m_max: [15.6], temperature_2m_min: [8], sunrise: ['2026-11-21T07:58'], sunset: ['2026-11-21T16:38'] },
      }),
    ).toEqual({ code: 3, temperature: 12.4, high: 15.6, low: 8, wind: 20.2, rain: 40, dayCode: 61, isDay: false, time: '2026-11-21T12:00', sunrise: '2026-11-21T07:58', sunset: '2026-11-21T16:38' });
  });
  it('copes with a missing daily part', () => {
    expect(snapshotFromOpenMeteo({ current: { temperature_2m: 1, weather_code: 0 } })).toMatchObject({ high: null, low: null, wind: null, rain: null, dayCode: null, sunrise: null, isDay: true });
  });
  it('refuses an answer without current weather', () => {
    expect(() => snapshotFromOpenMeteo({})).toThrow(AiError);
  });
  it('is the default provider and needs no key', () => {
    expect(weatherProviders[0]).toMatchObject({ id: 'open-meteo', key: 'none' });
  });
});

describe('the chosen provider', () => {
  let db: ReturnType<typeof openDb>;
  beforeAll(() => {
    ensureDirs();
    db = openDb();
  });
  afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const fake: WeatherProvider = {
    id: 'fake',
    name: 'Fake',
    key: 'required',
    fetch: async ({ apiKey }) => snap('12:00', 61, { temperature: apiKey === 'secret' ? 9 : 0 }),
  };

  it('defaults to Open-Meteo and ignores unknown names', () => {
    expect(weatherConfig(db)).toEqual({ provider: 'open-meteo', apiKey: '' });
    saveWeatherConfig(db, { provider: 'nonsense' });
    expect(weatherConfig(db).provider).toBe('open-meteo');
  });

  it('builds the prompt from the provider that was chosen, with its key', async () => {
    weatherProviders.push(fake);
    try {
      saveWeatherConfig(db, { provider: 'fake', apiKey: ' secret ' });
      expect(weatherConfig(db)).toEqual({ provider: 'fake', apiKey: 'secret' });
      const base = collectionConfig({ config: { source: 'weather', latitude: 51.2, longitude: 4.4, prompt: '{condition} at {temperature} degrees' } } as never);
      expect((await buildPrompt(base, [], weatherConfig(db))).prompt).toBe('light rain, visible rain streaks falling, wet glistening ground with puddle reflections at 9 degrees');
    } finally {
      weatherProviders.splice(weatherProviders.indexOf(fake), 1);
    }
  });

  it('asks for a key when the provider needs one', async () => {
    weatherProviders.push(fake);
    try {
      await expect(fetchWeatherVars(51, 4, { provider: 'fake', apiKey: '' })).rejects.toThrow(/API key/);
    } finally {
      weatherProviders.splice(weatherProviders.indexOf(fake), 1);
    }
  });

  it('forgets the key when another provider is chosen', () => {
    const other: WeatherProvider = { ...fake, id: 'other', key: 'optional' };
    weatherProviders.push(fake, other);
    try {
      saveWeatherConfig(db, { provider: 'fake', apiKey: 'secret' });
      saveWeatherConfig(db, { provider: 'fake' });
      expect(weatherConfig(db).apiKey).toBe('secret');
      saveWeatherConfig(db, { provider: 'other' });
      expect(weatherConfig(db)).toEqual({ provider: 'other', apiKey: '' });
    } finally {
      weatherProviders.splice(weatherProviders.indexOf(fake), 1);
      weatherProviders.splice(weatherProviders.indexOf(other), 1);
      saveWeatherConfig(db, { provider: 'open-meteo' });
    }
  });

  it('asks Open-Meteo by default', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (u: string) => {
      urls.push(u);
      return new Response(JSON.stringify({ current: { time: '2026-11-21T12:00', temperature_2m: 4.4, weather_code: 63, is_day: 1, wind_speed_10m: 10 } }));
    });
    const v = await fetchWeatherVars(51.2194, 4.4025, { provider: 'open-meteo', apiKey: '' });
    expect(urls[0]).toMatch(/^https:\/\/api\.open-meteo\.com\/v1\/forecast\?.*latitude=51\.2194&longitude=4\.4025/);
    expect(v).toMatchObject({ temperature: '4', wind: '10' });
  });
});

describe('weather collections', () => {
  it('require a place on earth', () => {
    const base = collectionConfig({ config: {} } as never);
    expect(base).toMatchObject({ latitude: null, longitude: null });
    expect(() => validateCollectionConfig({ ...base, source: 'weather' })).toThrow(AiError);
    expect(() => validateCollectionConfig({ ...base, source: 'weather', latitude: 51, longitude: 4 })).not.toThrow();
    expect(() => validateCollectionConfig({ ...base, source: 'weather', latitude: 95, longitude: 4 })).toThrow(AiError);
  });
});

describe('weather bar', () => {
  it('reads the day forecast from a snapshot and rounds it', () => {
    expect(dayForecast(snap('12:00', 63, { high: 12.6, low: 3.4, rain: 64.4, dayCode: 3 }))).toEqual({ min: 3, max: 13, rain: 64, sky: 'cloudy' });
    expect(dayForecast(snap('12:00', 63, { low: -2.6, high: 5, rain: null, dayCode: null }))).toEqual({ min: -3, max: 5, rain: null, sky: 'rain' });
    expect(dayForecast(snap('12:00', 0, { low: -0.3 })).min).toBe(0); // not -0
    expect(dayForecast(snap('12:00', 0, { low: null, high: null, temperature: 6.4 }))).toMatchObject({ min: 6, max: 6 });
    expect([0, 2, 45, 53, 63, 81, 73, 95, 7].map(skyOf)).toEqual(['clear', 'partly', 'fog', 'drizzle', 'rain', 'rain', 'snow', 'thunder', null]);
    expect(skyLabel('cloudy', 'nl')).toBe('Bewolkt');
    expect(skyLabel('cloudy', 'xx' as never)).toBe('Cloudy');
  });

  it('asks the provider once per place for a while', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      return new Response(
        JSON.stringify({
          current: { temperature_2m: 7, weather_code: 3 },
          daily: { weather_code: [3], temperature_2m_max: [10], temperature_2m_min: [4], precipitation_probability_max: [30] },
        }),
      );
    });
    const cfg = { provider: 'open-meteo', apiKey: '' };
    const t0 = Date.now();
    expect(await fetchDayForecast(51.1, 4.4, cfg, t0)).toEqual({ min: 4, max: 10, rain: 30, sky: 'cloudy' });
    await fetchDayForecast(51.1, 4.4, cfg, t0 + 60_000);
    expect(calls).toBe(1);
    await fetchDayForecast(51.1, 4.4, cfg, t0 + 20 * 60_000);
    expect(calls).toBe(2);
  });

  const pixels = async (buf: Buffer) => {
    const r = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
    return { info: r.info, px: (x: number, y: number) => [...r.data.subarray((y * r.info.width + x) * r.info.channels, (y * r.info.width + x) * r.info.channels + 3)] };
  };
  const base = { width: 600, height: 800, landscape: false, rotate: 0, fit: 'cover' as const, bg: '#ffffff', format: { type: 'png' as const } };
  const picture = (colour: string) => sharp({ create: { width: 600, height: 800, channels: 3, background: colour } }).png().toBuffer();

  it('draws a label at the bottom right without changing the picture size', async () => {
    const src = await picture('#336699');
    const a = await pixels(await renderForFrame(src, base));
    const b = await pixels(await renderForFrame(src, { ...base, weather: { min: 3, max: 9, rain: 60 } }));
    expect([b.info.width, b.info.height]).toEqual([600, 800]);
    // Bottom-left stays as it was; bottom-right now has the label (white by default).
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
    expect(half[2]).toBeGreaterThan(40); // the blue of the picture shows through
    expect(half[2]).toBeLessThan(100);
  });

  it('picks automatic colours from the picture under the label', async () => {
    const weather = { min: 3, max: 9, rain: 60 };
    const auto = { bg: 'auto', text: '#1d1c1a', opacity: 100 };
    const over = async (colour: string) => (await pixels(await renderForFrame(await picture(colour), { ...base, weather, pill: auto }))).px(568, 760);
    expect((await over('#101010'))[0]).toBeGreaterThan(200); // a light label over a dark area
    expect((await over('#f0f0f0'))[0]).toBeLessThan(60); // a dark one over a light area
  });

  it('moves above the date label when the two would meet', async () => {
    const src = await picture('#336699');
    const r = await pixels(await renderForFrame(src, { ...base, caption: '23 november 2026 · Antwerpen, België', weather: { min: 3, max: 9, rain: 60 } }));
    expect(r.px(568, 760)).toEqual([51, 102, 153]); // the bottom-right corner is free, the label sits higher
    expect(r.px(568, 722)).not.toEqual([51, 102, 153]);
  });
});

describe('weather bar option', () => {
  it('is only passed on for a weather collection that has it switched on', () => {
    fs.mkdirSync(dataDir, { recursive: true });
    const db = openDb(`${dataDir}/wbar.db`);
    const add = (config: Record<string, unknown>) => db.insert(schema.collections).values({ name: 'W', type: 'ai', config, createdAt: Date.now() }).returning().get().id;
    const assign = (collectionId: number) => ({ collectionId, fit: 'cover', bg: '#ffffff', showDate: false }) as never;
    const place = { latitude: 51.2, longitude: 4.4 };
    expect(assignmentOptions(db, assign(add({ source: 'weather', weatherBar: true, ...place })))).toMatchObject({ weatherBar: place });
    expect(assignmentOptions(db, assign(add({ source: 'weather', weatherBar: false, ...place }))).weatherBar).toBeUndefined();
    expect(assignmentOptions(db, assign(add({ source: 'prompt', weatherBar: true, ...place }))).weatherBar).toBeUndefined();
    expect(assignmentOptions(db, assign(add({ source: 'weather', weatherBar: true }))).weatherBar).toBeUndefined();
  });
});

describe('weather some hours ahead', () => {
  const hours = (day: string) => Array.from({ length: 24 }, (_, h) => `${day}T${String(h).padStart(2, '0')}:00`);
  const forecast = (now: string) => ({
    current: { time: now, temperature_2m: 5, weather_code: 3, is_day: 0, wind_speed_10m: 10 },
    hourly: {
      time: [...hours('2026-11-23'), ...hours('2026-11-24')],
      temperature_2m: Array.from({ length: 48 }, (_, i) => i),
      weather_code: Array.from({ length: 48 }, (_, i) => (i === 11 ? 63 : i === 27 ? 71 : 0)),
      is_day: Array.from({ length: 48 }, (_, i) => (i % 24 >= 8 && i % 24 < 17 ? 1 : 0)),
      wind_speed_10m: Array.from({ length: 48 }, (_, i) => 100 + i),
    },
    daily: {
      time: ['2026-11-23', '2026-11-24'],
      temperature_2m_max: [9.6, 4.2],
      temperature_2m_min: [2.1, -1.4],
      sunrise: ['2026-11-23T08:00', '2026-11-24T08:02'],
      sunset: ['2026-11-23T16:45', '2026-11-24T16:44'],
      precipitation_probability_max: [80, 20],
      weather_code: [3, 71],
    },
  });
  const answer = (body: unknown) => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => JSON.stringify(body) });
  const none = { latitude: 51, longitude: 4.5, apiKey: '' };

  it('keeps hours within 0 to 47', () => {
    expect([undefined, 'x', -3, 0, 4, 4.4, 99].map(cleanOffset)).toEqual([0, 0, 0, 0, 4, 4, 47]);
  });

  it('finds the full hour nearest to then, also past midnight', () => {
    expect(targetHour(forecast('2026-11-23T06:50'), 4)).toMatchObject({ time: '2026-11-23T11:00', hourIndex: 11, dayIndex: 0 });
    expect(targetHour(forecast('2026-11-23T22:40'), 4)).toMatchObject({ time: '2026-11-24T03:00', hourIndex: 27, dayIndex: 1 });
    expect(targetHour(forecast('2026-11-23T22:40'), 40)).toBeNull(); // beyond what was returned
  });

  it("turns the forecast into a reading of that hour, with that day's sun and extremes", () => {
    const v = atOffset(forecast('2026-11-23T06:50'), 4);
    expect(v.current).toMatchObject({ time: '2026-11-23T11:00', temperature_2m: 11, weather_code: 63, is_day: 1, wind_speed_10m: 111 });
    expect(v.daily?.temperature_2m_max).toEqual([9.6]);
    expect(atOffset(forecast('2026-11-23T06:50'), 0).current?.weather_code).toBe(3); // unchanged for 0
    expect(atOffset(forecast('2026-11-23T22:40'), 4).daily?.sunrise).toEqual(['2026-11-24T08:02']);
  });

  it('asks Open-Meteo for the hours and gives a snapshot of that hour', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      expect(String(url)).toContain('hourly=');
      expect(String(url)).toContain('forecast_days=2');
      return answer(forecast('2026-11-23T06:50'));
    });
    const snap = await openMeteo.fetch({ ...none, hours: 4 });
    expect(snap).toMatchObject({ temperature: 11, code: 63, dayCode: 63, isDay: true, high: 9.6, low: 2.1, rain: 80, time: '2026-11-23T11:00' });
    vi.stubGlobal('fetch', async (url: string) => {
      expect(String(url)).not.toContain('hourly=');
      return answer(forecast('2026-11-23T06:50'));
    });
    expect((await openMeteo.fetch({ ...none, hours: 0 })).code).toBe(3);
  });

  it('gives a prompt for the later hour: its condition and light, not the one of now', async () => {
    vi.stubGlobal('fetch', async () => answer(forecast('2026-11-23T06:50')));
    const vars = await fetchWeatherVars(51, 4.5, { provider: 'open-meteo', apiKey: '' }, 4);
    expect(vars.temperature).toBe('11');
    expect(vars.condition).toContain('rain');
    expect(vars.daypart).toBe('day time'); // 07:00 is still dark, 11:00 is not
  });

  it("takes the weather bar's sky from that hour and its numbers from that day", async () => {
    vi.stubGlobal('fetch', async () => answer(forecast('2026-11-23T22:40')));
    const cfg = { provider: 'open-meteo', apiKey: '' };
    expect(await fetchDayForecast(51, 4.5, cfg, 1_000, 4)).toEqual({ min: -1, max: 4, rain: 20, sky: 'snow' });
    // Another offset is another cache entry.
    expect(await fetchDayForecast(51, 4.5, cfg, 1_000, 0)).toMatchObject({ min: 2, max: 10, rain: 80 });
  });

  it('is part of the collection and of the bar option', () => {
    expect(collectionConfig({ config: { source: 'weather', weatherOffset: 99 } } as never).weatherOffset).toBe(47);
    expect(collectionConfig({ config: { source: 'weather' } } as never).weatherOffset).toBe(0);
  });
});
