import fs from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// The data directory is read when config loads, so it has to be set before the imports run.
const dataDir = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? '/tmp'}/eink-weather-test-${process.pid}`;
  process.env.DATA_DIR = dir;
  return dir;
});

import { ensureDirs } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { buildPrompt, collectionConfig, validateCollectionConfig } from '../src/lib/ai/generate.js';
import { AiError } from '../src/lib/ai/providers.js';
import { weatherCondition, weatherLook, weatherVars } from '../src/lib/weather/describe.js';
import { fetchWeatherVars, saveWeatherConfig, weatherConfig, weatherProviders, type WeatherProvider, type WeatherSnapshot } from '../src/lib/weather/index.js';
import { snapshotFromOpenMeteo } from '../src/lib/weather/openmeteo.js';

afterEach(() => vi.unstubAllGlobals());

const snap = (time: string, code = 0, over: Partial<WeatherSnapshot> = {}): WeatherSnapshot => ({
  code,
  temperature: 5,
  high: 7,
  low: 1,
  wind: 3,
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
        daily: { temperature_2m_max: [15.6], temperature_2m_min: [8], sunrise: ['2026-11-21T07:58'], sunset: ['2026-11-21T16:38'] },
      }),
    ).toEqual({ code: 3, temperature: 12.4, high: 15.6, low: 8, wind: 20.2, isDay: false, time: '2026-11-21T12:00', sunrise: '2026-11-21T07:58', sunset: '2026-11-21T16:38' });
  });
  it('copes with a missing daily part', () => {
    expect(snapshotFromOpenMeteo({ current: { temperature_2m: 1, weather_code: 0 } })).toMatchObject({ high: null, low: null, wind: null, sunrise: null, isDay: true });
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
