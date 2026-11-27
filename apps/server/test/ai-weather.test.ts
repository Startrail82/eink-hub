import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'b8hub-aiweather-'));

const { usesWeather, weatherCondition, weatherLook, weatherVars } = await import('../src/lib/ai/weather.js');
const { buildPrompt, collectionConfig } = await import('../src/lib/ai/generate.js');
type Snapshot = import('../src/lib/weather/index.js').WeatherSnapshot;

const snap = (time: string, code = 0, over: Partial<Snapshot> = {}): Snapshot => ({
  code, temperature: 5, high: 7, low: 1, wind: 3, rain: 20, dayCode: code, isDay: true,
  time: `2026-11-21T${time}`, sunrise: '2026-11-21T07:58', sunset: '2026-11-21T16:38', ...over,
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
      expect(at('07:40').daypart).toMatch(/^sunrise/);
      expect(at('12:20').daypart).toBe('day time');
      expect(at('16:20').daypart).toMatch(/^sunset/);
      expect(at('21:00').daypart).toMatch(/^night time/);
    });
    it('does not depend on the weather', () => {
      expect(at('12:20', 95).daypart).toBe('day time');
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

describe('weather placeholders in any prompt', () => {
  const cfg = (over: object) => collectionConfig({ config: { source: 'prompt', ...over } } as never);

  it('recognises the placeholders that need the weather', () => {
    expect(usesWeather('rain: {condition}')).toBe(true);
    expect(usesWeather('{season} in {title}')).toBe(false);
    expect(usesWeather('no tags')).toBe(false);
  });

  it('keeps the hours ahead within 0 to 47', () => {
    expect([undefined, 'x', -3, 4, 99].map((h) => cfg({ prompt: 'x', weatherOffset: h }).weatherOffset)).toEqual([0, 0, 0, 4, 47]);
  });

  it('only asks for the weather when the prompt uses it', async () => {
    let asked = 0;
    const weather = async () => (asked++, weatherVars(snap('12:20', 63)));
    expect((await buildPrompt(cfg({ prompt: 'A cat in {season}' }), [], weather)).prompt).toMatch(/^A cat in /);
    expect(asked).toBe(0);
    const { prompt } = await buildPrompt(cfg({ prompt: 'A cat in {condition}, {temperature} degrees, {daypart}' }), [], weather);
    expect(prompt).toBe('A cat in steady rain, rain streaks falling, wet glistening ground with puddle reflections, 5 degrees, day time');
    expect(asked).toBe(1);
  });

  it('fails readably when the weather is not available', async () => {
    await expect(buildPrompt(cfg({ prompt: '{condition}' }), [], async () => { throw new Error('no location'); })).rejects.toThrow('no location');
  });
});
