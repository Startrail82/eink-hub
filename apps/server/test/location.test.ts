import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ImmichAsset } from '../src/immich/client.js';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'b8hub-location-'));
process.env.AUTH_DISABLED = 'true';

const { ensureDirs, config } = await import('../src/config.js');
const { openDb, schema, setSetting } = await import('../src/db/index.js');
const { buildApp } = await import('../src/app.js');
const { DETAILS_RETRY_MS, saveLocalUpload, locationText, photoCaption, upsertImmichAssets, withCaptionDetails } = await import('../src/lib/images.js');
const { readExif, renderForFrame } = await import('../src/imaging/pipeline.js');
const { allCountries, reverseGeocode } = await import('../src/lib/geo.js');
const sharp = (await import('sharp')).default;

const db = (ensureDirs(), openDb(config.dbPath));
const at = (y: number, m: number, d: number) => ({ takenAt: Date.UTC(y, m - 1, d, 12) });
const rowOf = (assetId: string) => db.select().from(schema.images).all().find((i) => i.immichAssetId === assetId)!;

describe('locationText', () => {
  const rome = { city: 'Rome', country: 'Italy' };
  const home = { city: 'Boechout', country: 'Belgium' };

  it('is empty unless a location mode is on', () => {
    expect(locationText(rome, 'off')).toBeNull();
    expect(locationText(rome, undefined)).toBeNull();
    expect(locationText(rome, 'whatever' as never)).toBeNull();
  });
  it('shows the city, or the city and country', () => {
    expect(locationText(rome, 'city')).toBe('Rome');
    expect(locationText(rome, 'city_country')).toBe('Rome, Italy');
  });
  it('leaves out the home country only when asked to, ignoring case and accents', () => {
    expect(locationText(home, 'city_country')).toBe('Boechout, Belgium');
    expect(locationText(home, 'city_country', { hideHomeCountry: true, homeCountry: 'belgium' })).toBe('Boechout');
    expect(locationText({ city: 'Zürich', country: 'Österreich' }, 'city_country', { hideHomeCountry: true, homeCountry: 'osterreich' })).toBe('Zürich');
    expect(locationText(home, 'city_country', { hideHomeCountry: true })).toBe('Boechout, Belgium');
    expect(locationText(rome, 'city_country', { hideHomeCountry: true, homeCountry: 'Belgium' })).toBe('Rome, Italy');
  });
  it('falls back to the country when Immich knows no city, unless it is the hidden home country', () => {
    expect(locationText({ city: '', country: 'Norway' }, 'city')).toBe('Norway');
    expect(locationText({ city: null, country: 'Belgium' }, 'city', { hideHomeCountry: true, homeCountry: 'Belgium' })).toBeNull();
  });
  it('is empty when there is no location at all', () => {
    expect(locationText({ city: null, country: null }, 'city_country')).toBeNull();
    expect(locationText({ city: '', country: '' }, 'city')).toBeNull();
  });
});

describe('photoCaption', () => {
  const img = { ...at(2019, 10, 6), city: 'Rome', country: 'Italy' };

  it('keeps the date-only caption unchanged', () => {
    expect(photoCaption(img, { lang: 'en', showDate: true })).toBe('6 October 2019');
    expect(photoCaption(img, { lang: 'en', showDate: false })).toBeNull();
  });
  it('joins date and location', () => {
    expect(photoCaption(img, { lang: 'en', showDate: true, location: 'city_country' })).toBe('6 October 2019 · Rome, Italy');
  });
  it('shows the location alone when the date is off', () => {
    expect(photoCaption(img, { lang: 'en', location: 'city' })).toBe('Rome');
  });
  it('adds the location to the "on this day" caption', () => {
    const now = new Date();
    const memory = { takenAt: Date.UTC(now.getFullYear() - 3, 0, 1, 12), city: 'Rome', country: 'Italy' };
    expect(photoCaption(memory, { lang: 'en', showDate: true, memories: true, location: 'city' })).toMatch(/3 years ago · Rome$/);
  });
  it('skips the date part when the photo has no date', () => {
    expect(photoCaption({ takenAt: null, city: 'Rome', country: 'Italy' }, { lang: 'en', showDate: true, location: 'city' })).toBe('Rome');
  });
});

describe('storing the location from Immich', () => {
  it('stores city and country, and "" when Immich knows none', () => {
    upsertImmichAssets(db, [
      { id: 'rome', type: 'IMAGE', exifInfo: { city: 'Rome', country: 'Italy' } },
      { id: 'sea', type: 'IMAGE', exifInfo: { city: null, country: null } },
    ]);
    expect([rowOf('rome').city, rowOf('rome').country]).toEqual(['Rome', 'Italy']);
    expect([rowOf('sea').city, rowOf('sea').country]).toEqual(['', '']);
  });
  it('leaves the location unknown (NULL) when the payload says nothing about it', () => {
    upsertImmichAssets(db, [
      { id: 'bare', type: 'IMAGE' },
      { id: 'sizes-only', type: 'IMAGE', exifInfo: { exifImageWidth: 100, exifImageHeight: 50 } },
    ]);
    expect([rowOf('bare').city, rowOf('bare').country]).toEqual([null, null]);
    expect([rowOf('sizes-only').city, rowOf('sizes-only').country]).toEqual([null, null]);
  });
  it('leaves the location unknown while Immich has GPS but no place yet', () => {
    upsertImmichAssets(db, [{ id: 'gps-pending', type: 'IMAGE', exifInfo: { city: null, country: null, latitude: 51.1, longitude: 4.5 } }]);
    expect([rowOf('gps-pending').city, rowOf('gps-pending').country]).toEqual([null, null]);
  });
  it('does not wipe a known location when an asset is re-imported by bare id', () => {
    upsertImmichAssets(db, [{ id: 'rome', type: 'IMAGE' }]);
    expect([rowOf('rome').city, rowOf('rome').country]).toEqual(['Rome', 'Italy']);
  });
});

describe('looking up a missing location', () => {
  const immich = Fastify();
  const hits: string[] = [];
  const ctx = { db, log: { debug() {} } } as unknown as Parameters<typeof withCaptionDetails>[0];

  beforeAll(async () => {
    immich.get<{ Params: { id: string } }>('/api/assets/:id', async (req, reply) => {
      hits.push(req.params.id);
      if (req.params.id === 'broken') return reply.code(500).send({ message: 'boom' });
      const exifInfo =
        req.params.id === 'lookup-none'
          ? { city: null, country: null }
          : req.params.id === 'lookup-pending'
            ? { city: null, country: null, latitude: 51.1, longitude: 4.5 }
            : { city: 'Ghent', country: 'Belgium' };
      const asset: ImmichAsset = { id: req.params.id, type: 'IMAGE', exifInfo, ...(req.params.id === 'dated' ? { localDateTime: '2019-10-06T12:00:00.000Z' } : {}) };
      return asset;
    });
    immich.get<{ Querystring: { type: string } }>('/api/search/suggestions', async (req) =>
      req.query.type === 'country' ? ['Italy', null, 'Belgium', '', 'Italy'] : [],
    );
    setSetting(db, 'immich.url', await immich.listen({ port: 0, host: '127.0.0.1' }));
    setSetting(db, 'immich.apiKey', 'test');
  });
  afterAll(() => immich.close());

  it('asks Immich once and remembers the answer', async () => {
    upsertImmichAssets(db, [{ id: 'lookup-1', type: 'IMAGE' }]);
    const first = await withCaptionDetails(ctx, rowOf('lookup-1'));
    expect([first.city, first.country]).toEqual(['Ghent', 'Belgium']);
    expect([rowOf('lookup-1').city, rowOf('lookup-1').country]).toEqual(['Ghent', 'Belgium']);
    await withCaptionDetails(ctx, rowOf('lookup-1'));
    expect(hits.filter((h) => h === 'lookup-1')).toHaveLength(1);
  });
  it('remembers "no location" too', async () => {
    upsertImmichAssets(db, [{ id: 'lookup-none', type: 'IMAGE' }]);
    await withCaptionDetails(ctx, rowOf('lookup-none'));
    await withCaptionDetails(ctx, rowOf('lookup-none'));
    expect([rowOf('lookup-none').city, rowOf('lookup-none').country]).toEqual(['', '']);
    expect(hits.filter((h) => h === 'lookup-none')).toHaveLength(1);
  });
  it('lists every country for the home country picker, with or without photos from it', async () => {
    const { app } = await buildApp(db, { logger: false });
    const list: string[] = (await app.inject({ url: '/api/countries' })).json();
    // Every country, including ones with no photos yet, without duplicates.
    expect(list.length).toBeGreaterThan(200);
    expect(list).toEqual(expect.arrayContaining(['Belgium', 'Italy', 'Spain', 'Namibia']));
    expect(list.filter((c) => c === 'Italy')).toHaveLength(1);
    await app.close();
  });
  it('fills in the date of a photo imported by bare id when the caption needs it', async () => {
    upsertImmichAssets(db, [{ id: 'dated', type: 'IMAGE' }]);
    expect(rowOf('dated').takenAt).toBeNull();
    const img = await withCaptionDetails(ctx, rowOf('dated'), { date: true });
    expect(img.takenAt).toBe(Date.parse('2019-10-06T12:00:00.000Z'));
    expect(rowOf('dated').takenAt).toBe(img.takenAt);
  });
  it('does not ask for local uploads', async () => {
    const local = db.insert(schema.images).values({ source: 'local', createdAt: Date.now() }).returning().get();
    expect(await withCaptionDetails(ctx, local)).toBe(local);
  });
  it('keeps going when Immich is unreachable, and retries later, not on every render', async () => {
    upsertImmichAssets(db, [{ id: 'broken', type: 'IMAGE' }]);
    const t0 = Date.now();
    const img = await withCaptionDetails(ctx, rowOf('broken'), {location:true}, t0);
    expect([img.city, img.country]).toEqual([null, null]);
    expect([rowOf('broken').city, rowOf('broken').country]).toEqual([null, null]);
    await withCaptionDetails(ctx, rowOf('broken'), {location:true}, t0 + 1000);
    expect(hits.filter((h) => h === 'broken')).toHaveLength(1);
    await withCaptionDetails(ctx, rowOf('broken'), {location:true}, t0 + DETAILS_RETRY_MS + 1);
    expect(hits.filter((h) => h === 'broken')).toHaveLength(2);
  });
  it('does not remember "no location" while Immich has not geocoded the GPS yet', async () => {
    upsertImmichAssets(db, [{ id: 'lookup-pending', type: 'IMAGE' }]);
    const t0 = Date.now();
    await withCaptionDetails(ctx, rowOf('lookup-pending'), {location:true}, t0);
    expect([rowOf('lookup-pending').city, rowOf('lookup-pending').country]).toEqual([null, null]);
    await withCaptionDetails(ctx, rowOf('lookup-pending'), {location:true}, t0 + DETAILS_RETRY_MS + 1);
    expect(hits.filter((h) => h === 'lookup-pending')).toHaveLength(2);
  });
});

/** A JPEG edited in 2025, taken on 6 October 2019 in Loano (Italy), or without GPS. */
const photo = (gps = true) =>
  sharp({ create: { width: 40, height: 30, channels: 3, background: '#888888' } })
    .withExif({
      IFD0: { DateTime: '2025:03:01 10:00:00' },
      IFD2: { DateTimeOriginal: '2019:10:06 12:00:00' },
      ...(gps ? { IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '44/1 7/1 4080/100', GPSLongitudeRef: 'E', GPSLongitude: '8/1 15/1 2520/100' } } : {}),
    })
    .jpeg()
    .toBuffer();

describe('offline places for uploads', () => {
  it('names the nearest place and its country', () => {
    expect(reverseGeocode(44.128, 8.257)).toEqual({ city: 'Loano', country: 'Italy' });
    expect(reverseGeocode(51.16, 4.49)).toEqual({ city: 'Boechout', country: 'Belgium' });
    expect(reverseGeocode(-22.57, 17.08)?.country).toBe('Namibia');
  });
  it('has no place far from everything, or for nonsense', () => {
    expect(reverseGeocode(35, -40)).toBeNull();
    expect(reverseGeocode(NaN, 3)).toBeNull();
    expect(reverseGeocode(95, 3)).toBeNull();
  });
  it('lists every country for the picker without Immich', () => {
    const all = allCountries();
    expect(all.length).toBeGreaterThan(200);
    expect(all).toEqual(expect.arrayContaining(['Spain', 'Italy', 'Czechia', 'United States']));
  });
  it('reads the original capture date, not the last edit, and the GPS', async () => {
    const meta = await sharp(await photo()).metadata();
    const exif = readExif(meta.exif!);
    expect(exif.takenAt).toBe(Date.UTC(2019, 9, 6, 12));
    expect(exif.gps?.latitude).toBeCloseTo(44.128, 3);
    expect(exif.gps?.longitude).toBeCloseTo(8.257, 3);
    expect(readExif(Buffer.from('not exif'))).toEqual({});
  });
  it('stores the place of an upload, and "" when it has no GPS', async () => {
    const withGps = await saveLocalUpload(db, await photo(), 'loano.jpg');
    expect([withGps.city, withGps.country, withGps.takenAt]).toEqual(['Loano', 'Italy', Date.UTC(2019, 9, 6, 12)]);
    const without = await saveLocalUpload(db, await photo(false), 'plain.jpg');
    expect([without.city, without.country]).toEqual(['', '']);
  });
  it('names the place of an older upload the first time the caption needs it', async () => {
    const up = await saveLocalUpload(db, await photo(), 'older.jpg');
    db.update(schema.images).set({ city: null, country: null }).where(eq(schema.images.id, up.id)).run();
    const ctx = { db, log: { debug() {} } } as unknown as Parameters<typeof withCaptionDetails>[0];
    const img = await withCaptionDetails(ctx, db.select().from(schema.images).where(eq(schema.images.id, up.id)).get()!, { location: true });
    expect([img.city, img.country]).toEqual(['Loano', 'Italy']);
  });
});

describe('long captions', () => {
  it('fit inside a narrow frame', async () => {
    const src = await sharp({ create: { width: 600, height: 1000, channels: 3, background: '#808080' } }).jpeg().toBuffer();
    const caption = '6 October 2019 · Llanfairpwllgwyngyllgogerychwyrndrobwllllantysiliogogogoch, United Kingdom of Great Britain';
    const out = await renderForFrame(src, { width: 480, height: 800, landscape: false, rotate: 0, fit: 'cover', bg: '#ffffff', caption });
    expect((await sharp(out).metadata()).width).toBe(480);
  });
});

describe('settings and assignment options', () => {
  let app: Awaited<ReturnType<typeof buildApp>>['app'];
  beforeAll(async () => {
    app = (await buildApp(db, { logger: false })).app;
  });
  afterAll(() => app.close());

  it('stores the home country', async () => {
    expect((await app.inject({ url: '/api/settings' })).json().homeCountry).toBe('');
    await app.inject({ method: 'PUT', url: '/api/settings', payload: { homeCountry: '  Belgium ' } });
    expect((await app.inject({ url: '/api/settings' })).json().homeCountry).toBe('Belgium');
  });

  it('saves the location options on an assignment, and keeps them for older clients', async () => {
    const frame = db.insert(schema.frames).values({ name: 'Test', host: '127.0.0.1:1', upstreamToken: 'location-test', mode: 'push', createdAt: Date.now() }).returning().get();
    const col = (await app.inject({ method: 'POST', url: '/api/collections', payload: { name: 'Manual', type: 'manual' } })).json();
    const put = async (payload: object) =>
      (await app.inject({ method: 'PUT', url: `/api/frames/${frame.id}/assignment`, payload: { collectionId: col.id, ...payload } })).json();

    expect(await put({})).toMatchObject({ showLocation: 'off', hideHomeCountry: false });
    expect(await put({ showLocation: 'city_country', hideHomeCountry: true })).toMatchObject({ showLocation: 'city_country', hideHomeCountry: true });
    expect(await put({ fit: 'contain' })).toMatchObject({ showLocation: 'city_country', hideHomeCountry: true });
    expect(await put({ showLocation: 'nonsense' })).toMatchObject({ showLocation: 'city_country' });
    expect(await put({ hideHomeCountry: 'false' })).toMatchObject({ hideHomeCountry: true });
  });
});
