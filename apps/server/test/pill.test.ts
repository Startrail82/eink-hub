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
const { DEFAULT_PILL, isDefaultPill, resolvePill } = await import('../src/imaging/pill.js');

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
});

describe('Canvas pill settings', () => {
  it('saves what differs from the defaults and clears it again', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/frames', payload: { kind: 'openframe', name: 'Pills', width: 1200, height: 1600 } });
    const id = created.json().id as number;
    const set = async (pill: unknown) => (await app.inject({ method: 'PATCH', url: `/api/frames/${id}`, payload: { config: { pill } } })).json().config.pill;
    expect(await set({ bg: '#112233', text: '#ffffff', opacity: 72 })).toEqual({ bg: '#112233', text: '#ffffff', opacity: 72 });
    expect(await set({ bg: 'nope', opacity: 999 })).toBeUndefined(); // nothing valid left, so back to the defaults
    expect(await set({ bg: '#112233', text: '#ffffff', opacity: 72 })).toBeDefined();
    expect(await set(null)).toBeUndefined();
  });
});
