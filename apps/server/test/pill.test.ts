import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, describe, expect, it } from 'vitest';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b8hub-pill-'));
process.env.DATA_DIR = dataDir;
process.env.AUTH_DISABLED = 'true';

const { ensureDirs, config } = await import('../src/config.js');
const { openDb } = await import('../src/db/index.js');
const { buildApp } = await import('../src/app.js');
const { renderForFrame } = await import('../src/imaging/pipeline.js');
const { DEFAULT_PILL, autoPill, isDefaultPill, luminance, resolvePill } = await import('../src/imaging/pill.js');

ensureDirs();
const db = openDb(config.dbPath);
const { app } = await buildApp(db, { logger: false });
afterAll(async () => {
  await app.close();
});

describe('pill style', () => {
  it('is white and solid unless told otherwise', () => {
    expect(resolvePill()).toEqual(DEFAULT_PILL);
    expect(resolvePill(null)).toEqual(DEFAULT_PILL);
    expect(isDefaultPill(resolvePill({}))).toBe(true);
  });

  it('keeps valid colours and clamps the opacity, falling back to the default for the rest', () => {
    expect(resolvePill({ bg: '#102030', text: '#FFFFFF', opacity: 72 })).toEqual({ bg: '#102030', text: '#ffffff', opacity: 72 });
    expect(resolvePill({ bg: 'red', text: '#12', opacity: 500 })).toEqual({ ...DEFAULT_PILL, opacity: 100 });
    expect(resolvePill({ opacity: 3 }).opacity).toBe(10);
    expect(resolvePill({ opacity: Number.NaN }).opacity).toBe(100);
    // Not a number at all: the default, not the 10% floor.
    expect(resolvePill({ opacity: null as unknown as number }).opacity).toBe(100);
    expect(resolvePill({ opacity: '' as unknown as number }).opacity).toBe(100);
  });

  it('draws the labels in the chosen colours', async () => {
    const src = await sharp({ create: { width: 600, height: 800, channels: 3, background: '#336699' } }).png().toBuffer();
    const base = { width: 600, height: 800, landscape: false, rotate: 0, fit: 'cover' as const, bg: '#ffffff', format: { type: 'png' as const }, caption: '23 november 2026' };
    const px = async (buf: Buffer, x: number, y: number) => {
      const r = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
      const i = (y * r.info.width + x) * r.info.channels;
      return [...r.data.subarray(i, i + 3)];
    };
    // Inside the date pill at its vertical middle, left of the text and clear of the rounded
    // corner's anti-aliasing: margin 24, the pill is about 42px tall at this size.
    const y = 800 - 24 - 21;
    expect(await px(await renderForFrame(src, base), 30, y)).toEqual([255, 255, 255]);
    expect(await px(await renderForFrame(src, { ...base, pill: { bg: '#000000', text: '#ffffff', opacity: 100 } }), 30, y)).toEqual([0, 0, 0]);
    const half = await px(await renderForFrame(src, { ...base, pill: { bg: '#000000', text: '#ffffff', opacity: 50 } }), 30, y);
    expect(half[2]).toBeGreaterThan(40); // the blue of the picture shows through
    expect(half[2]).toBeLessThan(100);
  });

  it('picks automatic colours against the picture under the label', async () => {
    const lum = (c: number[]) => luminance(c as [number, number, number]);
    // Dark blue sky: a light bluish chip with dark text.
    const overDark = autoPill([20, 40, 90], false);
    expect(lum(hexRgb(overDark.bg))).toBeGreaterThan(0.7);
    expect(lum(hexRgb(overDark.text))).toBeLessThan(0.05);
    const [r, , b] = hexRgb(overDark.bg);
    expect(b).toBeGreaterThan(r); // keeps the blue
    // Bright sand: a dark chip with light text.
    const overLight = autoPill([235, 215, 170], false);
    expect(lum(hexRgb(overLight.bg))).toBeLessThan(0.05);
    expect(lum(hexRgb(overLight.text))).toBeGreaterThan(0.8);
    // Grey stays neutral.
    const grey = autoPill([200, 200, 200], false);
    const [gr, gg, gb] = hexRgb(grey.bg);
    expect(gr).toBe(gg);
    expect(gg).toBe(gb);
    // Palette panels: plain white or black only.
    expect(autoPill([20, 40, 90], true)).toEqual({ bg: '#ffffff', text: '#1d1c1a' });
    expect(autoPill([235, 215, 170], true)).toEqual({ bg: '#1d1c1a', text: '#ffffff' });
    // Saved as "auto", a stale text colour is dropped so it can't change the render hash.
    expect(resolvePill({ bg: 'auto', text: '#ff0000', opacity: 80 })).toEqual({ bg: 'auto', text: DEFAULT_PILL.text, opacity: 80 });
  });

  it('draws an automatic label light on a dark picture and dark on a light one', async () => {
    const render = async (colour: string, palette = false) => {
      const src = await sharp({ create: { width: 600, height: 800, channels: 3, background: colour } }).png().toBuffer();
      const out = await renderForFrame(src, {
        width: 600,
        height: 800,
        landscape: false,
        rotate: 0,
        fit: 'cover',
        bg: '#ffffff',
        caption: '23 november 2026',
        pill: { bg: 'auto', text: DEFAULT_PILL.text, opacity: 100 },
        format: palette ? { type: 'png', palette: 'spectra6' } : { type: 'png' },
      });
      const r = await sharp(out).raw().toBuffer({ resolveWithObject: true });
      const i = ((800 - 24 - 21) * r.info.width + 30) * r.info.channels;
      return [...r.data.subarray(i, i + 3)];
    };
    expect(luminance((await render('#10203a')) as [number, number, number])).toBeGreaterThan(0.7);
    expect(luminance((await render('#f0e6c8')) as [number, number, number])).toBeLessThan(0.05);
    // Dithered to a palette: pure white, no grain from a tint.
    expect(await render('#10203a', true)).toEqual([255, 255, 255]);
  });
});

const hexRgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

describe('Canvas pill settings', () => {
  it('saves what differs from the defaults and clears it again', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/frames', payload: { kind: 'openframe', name: 'Pills', width: 1200, height: 1600 } });
    const id = created.json().id as number;
    const set = async (pill: unknown) => (await app.inject({ method: 'PATCH', url: `/api/frames/${id}`, payload: { config: { pill } } })).json().config.pill;
    expect(await set({ bg: '#112233', text: '#ffffff', opacity: 72 })).toEqual({ bg: '#112233', text: '#ffffff', opacity: 72 });
    expect(await set({ bg: 'nope', opacity: 999 })).toBeUndefined(); // nothing valid left, so back to the defaults
    expect(await set({ bg: '#112233', text: '#ffffff', opacity: 72 })).toBeDefined();
    expect(await set(null)).toBeUndefined();
    expect(await set({ bg: 'auto', opacity: 90 })).toEqual({ bg: 'auto', text: DEFAULT_PILL.text, opacity: 90 });
  });
});
