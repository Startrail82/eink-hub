import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { and, eq, inArray } from 'drizzle-orm';
import { config } from '../config.js';
import { basqueDate, hubLang, locales, yearsAgoText, type Lang } from '../i18n.js';
import { getSetting, schema, type DB } from '../db/index.js';
import type { DisplayOptions, Frame, Image, LocationMode } from '../db/schema.js';
import { assetSize, type ImmichAsset } from '../immich/client.js';
import { aspectKey, formatExt, probeImage, renderForFrame, thumbnail, type CropRect } from '../imaging/pipeline.js';
import { renderTarget } from '../device/drivers/index.js';
import { fetchDayForecast } from './ai/sources.js';
import { isDefaultPill, resolvePill } from '../imaging/pill.js';
import { skyLabel } from '../imaging/sky.js';
import { HttpError, immichFor, type Ctx } from './context.js';
import { reverseGeocode } from './geo.js';

const RENDER_VERSION = 1;

async function exists(p: string) {
  return fs.access(p).then(
    () => true,
    () => false,
  );
}

export function getImage(db: DB, id: number): Image {
  const img = db.select().from(schema.images).where(eq(schema.images.id, id)).get();
  if (!img) throw new HttpError(404, 'image_not_found', { id });
  return img;
}

export async function saveLocalUpload(db: DB, buf: Buffer, originalName: string): Promise<Image> {
  let meta;
  try {
    meta = await probeImage(buf);
  } catch {
    throw new HttpError(415, 'unsupported_image', { name: originalName });
  }
  const hash = crypto.createHash('sha1').update(buf).digest('hex');
  const ext = path.extname(originalName).toLowerCase() || '.jpg';
  const rel = path.join('local', `${hash}${ext}`);
  const abs = path.join(config.originalsDir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  if (!(await exists(abs))) await fs.writeFile(abs, buf);
  return db
    .insert(schema.images)
    .values({
      source: 'local',
      filePath: rel,
      originalName,
      width: meta.width,
      height: meta.height,
      takenAt: meta.takenAt ?? Date.now(),
      // From the photo's GPS, with the offline place list; '' = no GPS or nowhere near a place.
      ...placeOf(meta.gps),
      createdAt: Date.now(),
    })
    .returning()
    .get();
}

/** City and country for a GPS position ('' when there is none or no place near it). */
function placeOf(gps?: { latitude: number; longitude: number }): { city: string; country: string } {
  return (gps && reverseGeocode(gps.latitude, gps.longitude)) || { city: '', country: '' };
}

/**
 * The location an Immich payload settles, or null when it says nothing yet: no city/country
 * fields at all, or GPS data that Immich has not reverse-geocoded (yet). Only a photo without
 * GPS is known to have no location ('').
 */
export function locationFromExif(exif: ImmichAsset['exifInfo']): { city: string; country: string } | null {
  if (!exif || (exif.city === undefined && exif.country === undefined)) return null;
  const city = exif.city ?? '';
  const country = exif.country ?? '';
  if (!city && !country && exif.latitude != null && exif.longitude != null) return null;
  return { city, country };
}

/** Upsert Immich assets as image rows; returns ids in input order. */
export function upsertImmichAssets(db: DB, assets: ImmichAsset[]): number[] {
  const photos = assets.filter((a) => a.type === 'IMAGE');
  if (!photos.length) return [];
  return db.transaction((tx) => {
    for (const a of photos) {
      const size = assetSize(a);
      const taken = Date.parse(a.localDateTime ?? a.fileCreatedAt ?? '');
      // Only overwrite what this payload actually knows: imports by bare id must not wipe metadata.
      const values = {
        ...(a.originalFileName ? { originalName: a.originalFileName } : {}),
        ...(size ? { width: size.width, height: size.height } : {}),
        ...(Number.isFinite(taken) ? { takenAt: taken } : {}),
        ...(a.isFavorite !== undefined ? { favorite: a.isFavorite } : {}),
        // Only when the payload settles the location; '' marks "looked up, none".
        ...(locationFromExif(a.exifInfo) ?? {}),
      };
      const insert = tx.insert(schema.images).values({ source: 'immich', immichAssetId: a.id, createdAt: Date.now(), ...values });
      if (Object.keys(values).length) insert.onConflictDoUpdate({ target: schema.images.immichAssetId, set: values }).run();
      else insert.onConflictDoNothing().run();
    }
    const rows = tx
      .select({ id: schema.images.id, assetId: schema.images.immichAssetId })
      .from(schema.images)
      .where(inArray(schema.images.immichAssetId, photos.map((a) => a.id)))
      .all();
    const byAsset = new Map(rows.map((r) => [r.assetId, r.id]));
    return photos.map((a) => byAsset.get(a.id)!);
  });
}

async function decodable(buf: Buffer) {
  try {
    await sharp(buf, { failOn: 'none' }).resize(8, 8).toBuffer();
    return true;
  } catch {
    return false;
  }
}

/**
 * Full-resolution source bytes. Immich originals are cached on disk; formats sharp can't
 * decode (some HEIC/RAW) fall back to Immich's full-size then preview JPEG.
 */
export async function loadSource(ctx: Ctx, img: Image): Promise<Buffer> {
  if (img.source === 'local') {
    if (!img.filePath) throw new HttpError(404, 'original_missing');
    return fs.readFile(path.join(config.originalsDir, img.filePath));
  }
  const cached = path.join(config.originalsDir, 'immich', img.immichAssetId!);
  if (await exists(cached)) return fs.readFile(cached);

  const immich = immichFor(ctx.db);
  const attempts = [
    () => immich.original(img.immichAssetId!),
    () => immich.thumbnail(img.immichAssetId!, 'fullsize'),
    () => immich.thumbnail(img.immichAssetId!, 'preview'),
  ];
  for (const attempt of attempts) {
    try {
      const buf = Buffer.from(await (await attempt()).arrayBuffer());
      if (await decodable(buf)) {
        await fs.writeFile(cached, buf);
        return buf;
      }
    } catch (err) {
      ctx.log.debug({ err, asset: img.immichAssetId }, 'immich source attempt failed');
    }
  }
  throw new HttpError(502, 'immich_fetch_failed', { id: img.immichAssetId! });
}

export async function imageThumbnail(ctx: Ctx, img: Image): Promise<Buffer> {
  const file = path.join(config.cacheDir, `thumb_${img.id}.jpg`);
  if (await exists(file)) return fs.readFile(file);
  let buf: Buffer;
  if (img.source === 'immich') {
    const res = await immichFor(ctx.db).thumbnail(img.immichAssetId!, 'preview');
    buf = await thumbnail(Buffer.from(await res.arrayBuffer()));
  } else {
    buf = await thumbnail(await loadSource(ctx, img));
  }
  await fs.writeFile(file, buf);
  return buf;
}

export function frameAspect(frame: Frame) {
  return aspectKey({ width: frame.width, height: frame.height, landscape: frame.orientation === 'landscape' });
}

export function getCrop(db: DB, imageId: number, aspect: string): CropRect | null {
  const row = db
    .select()
    .from(schema.imageCrops)
    .where(and(eq(schema.imageCrops.imageId, imageId), eq(schema.imageCrops.aspect, aspect)))
    .get();
  return row ? { x: row.x, y: row.y, w: row.w, h: row.h } : null;
}

export function setCrop(db: DB, imageId: number, aspect: string, crop: CropRect | null) {
  db.delete(schema.imageCrops)
    .where(and(eq(schema.imageCrops.imageId, imageId), eq(schema.imageCrops.aspect, aspect)))
    .run();
  if (crop) db.insert(schema.imageCrops).values({ imageId, aspect, ...crop }).run();
}

/** Date the photo was taken, e.g. "6 de octubre de 2019". Stored as wall-clock time in UTC. */
export function photoDate(img: Pick<Image, 'takenAt'>, lang: Lang = 'en'): string | null {
  if (!img.takenAt) return null;
  if (lang === 'eu') return basqueDate(new Date(img.takenAt));
  return new Intl.DateTimeFormat(locales[lang], { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(img.takenAt);
}

/** "Un día como hoy hace 7 años" — the Google Photos-style caption for "On this day" memories. */
export function yearsAgoCaption(img: Pick<Image, 'takenAt'>, lang: Lang = 'en', now = new Date()): string | null {
  if (!img.takenAt) return null;
  const years = now.getFullYear() - new Date(img.takenAt).getUTCFullYear();
  if (years < 1) return photoDate(img, lang);
  return yearsAgoText(lang, years);
}

/**
 * "Boechout", "Rome, Italy" … from the city/country Immich stored. The country is left out for
 * `city` mode (unless there is no city) and for the home country when `hideHomeCountry` is set.
 */
export function locationText(
  img: Pick<Image, 'city' | 'country'>,
  mode: LocationMode | undefined,
  opts: { hideHomeCountry?: boolean; homeCountry?: string } = {},
): string | null {
  if (mode !== 'city' && mode !== 'city_country') return null;
  const city = img.city?.trim();
  const country = img.country?.trim();
  const home = opts.homeCountry?.trim();
  const isHome = !!(opts.hideHomeCountry && home && country && country.localeCompare(home, undefined, { sensitivity: 'base' }) === 0);
  const parts: string[] = [];
  if (city) parts.push(city);
  if (country && !isHome && (mode === 'city_country' || !city)) parts.push(country);
  return parts.length ? parts.join(', ') : null;
}

/** The text drawn on the photo: date (or "X years ago today") and/or location, joined by " · ". */
export function photoCaption(
  img: Pick<Image, 'takenAt' | 'city' | 'country'>,
  o: { lang: Lang; showDate?: boolean; memories?: boolean; location?: LocationMode; hideHomeCountry?: boolean; homeCountry?: string },
): string | null {
  const parts: string[] = [];
  if (o.showDate) {
    const date = o.memories ? yearsAgoCaption(img, o.lang) : photoDate(img, o.lang);
    if (date) parts.push(date);
  }
  const place = locationText(img, o.location, o);
  if (place) parts.push(place);
  return parts.length ? parts.join(' · ') : null;
}

/** How long to wait before asking Immich again after a failed or unsettled lookup. */
export const DETAILS_RETRY_MS = 30 * 60_000;
const detailsRetryAt = new Map<string, number>();

/**
 * Fill in what the caption needs and the row doesn't have yet. Uploads from before places were
 * read get theirs from the original's GPS. Immich photos picked by id (sent from the Immich
 * page, manual collections) carry no date or location: ask Immich for the asset and store it.
 * A failed lookup, or a place Immich has not geocoded yet, is retried at most every
 * DETAILS_RETRY_MS, so renders (cache hits included) don't wait on Immich every time.
 */
export async function withCaptionDetails(
  ctx: Ctx,
  img: Image,
  need: { date?: boolean; location?: boolean } = { location: true },
  now = Date.now(),
): Promise<Image> {
  if (img.source === 'local') return withLocalPlace(ctx, img, need);
  if (img.source !== 'immich' || !img.immichAssetId) return img;
  const missing = (i: Image) => (need.date && i.takenAt === null) || (need.location && i.city === null && i.country === null);
  if (!missing(img) || (detailsRetryAt.get(img.immichAssetId) ?? 0) > now) return img;
  try {
    upsertImmichAssets(ctx.db, [await immichFor(ctx.db).asset(img.immichAssetId)]);
    const fresh = ctx.db.select().from(schema.images).where(eq(schema.images.id, img.id)).get() ?? img;
    if (missing(fresh)) detailsRetryAt.set(img.immichAssetId, now + DETAILS_RETRY_MS);
    else detailsRetryAt.delete(img.immichAssetId);
    return fresh;
  } catch (err) {
    detailsRetryAt.set(img.immichAssetId, now + DETAILS_RETRY_MS);
    ctx.log.debug({ err, asset: img.immichAssetId }, 'immich details lookup failed');
    return img;
  }
}

/** Uploads from before places were read: name the place from the original's GPS once. */
async function withLocalPlace(ctx: Ctx, img: Image, need: { location?: boolean }): Promise<Image> {
  if (!need.location || img.city !== null || img.country !== null || !img.filePath) return img;
  try {
    const { gps } = await probeImage(await fs.readFile(path.join(config.originalsDir, img.filePath)));
    const place = placeOf(gps);
    ctx.db.update(schema.images).set(place).where(eq(schema.images.id, img.id)).run();
    return { ...img, ...place };
  } catch (err) {
    ctx.log.debug({ err, image: img.id }, 'reading the place of an upload failed');
    return img;
  }
}

export interface Rendered {
  hash: string;
  /** Path inside cacheDir. */
  file: string;
  /** Filename sent to / pulled by the device (`_P` / `_L` suffix required). */
  deviceName: string;
  buf: Buffer;
  /** File extension: jpg, png or bmp. */
  ext: string;
}

export async function renderFor(ctx: Ctx, img: Image, frame: Frame, opts: DisplayOptions = {}): Promise<Rendered> {
  const needLocation = !!opts.showLocation && opts.showLocation !== 'off';
  if (opts.showDate || needLocation) img = await withCaptionDetails(ctx, img, { date: opts.showDate, location: needLocation });
  const landscape = frame.orientation === 'landscape';
  const forecast = opts.weatherBar ? await fetchDayForecast(opts.weatherBar.latitude, opts.weatherBar.longitude, Date.now(), opts.weatherBar.offset).catch((err) => (ctx.log.warn({ err }, 'weather bar: no forecast, picture shown without it'), null)) : null;
  // The word is in the hub's language, so it is part of the render's identity.
  const weather = forecast ? { ...forecast, label: forecast.sky ? skyLabel(forecast.sky, hubLang(ctx.db)) : null } : null;
  const pill = resolvePill(frame.config?.pill);
  const crop = opts.crop !== undefined ? opts.crop : getCrop(ctx.db, img.id, frameAspect(frame));
  const target = renderTarget(frame);
  const ext = formatExt(target.format);
  const params = {
    v: RENDER_VERSION,
    img: img.id,
    width: frame.width,
    height: frame.height,
    landscape,
    rotate: target.rotateBuffer ? frame.rotate : 0,
    fit: crop ? 'cover' : (opts.fit ?? 'cover'),
    bg: opts.bg ?? '#ffffff',
    crop,
    caption: photoCaption(img, {
      lang: hubLang(ctx.db),
      showDate: opts.showDate,
      memories: opts.memories,
      location: opts.showLocation,
      hideHomeCountry: opts.hideHomeCountry,
      homeCountry: getSetting(ctx.db, 'homeCountry'),
    }),
    // Only when present, so existing renders keep their hash.
    ...(weather ? { weather } : {}),
    ...(isDefaultPill(pill) ? {} : { pill }),
    // Only when not the default, so existing JPEG renders keep their hash.
    ...(ext === 'jpg' && !target.format.palette ? {} : { format: target.format }),
  } as const;
  const hash = crypto.createHash('sha1').update(JSON.stringify(params)).digest('hex');
  const file = path.join(config.cacheDir, `${hash}.${ext}`);
  const deviceName = `h${img.id}_${hash.slice(0, 10)}_${landscape ? 'L' : 'P'}.${ext}`;
  if (await exists(file)) return { hash, file, deviceName, ext, buf: await fs.readFile(file) };

  const buf = await renderForFrame(await loadSource(ctx, img), {
    width: params.width,
    height: params.height,
    landscape,
    rotate: params.rotate,
    fit: params.fit,
    bg: params.bg,
    crop: params.crop,
    caption: params.caption,
    weather,
    pill,
    format: target.format,
  });
  await fs.writeFile(file, buf);
  return { hash, file, deviceName, ext, buf };
}

/** A cached render by hash, whatever format it was made in. */
export async function readRender(hash: string): Promise<{ buf: Buffer; ext: string } | null> {
  for (const ext of ['jpg', 'png', 'bmp']) {
    try {
      return { buf: await fs.readFile(path.join(config.cacheDir, `${hash}.${ext}`)), ext };
    } catch {
      // try the next format
    }
  }
  return null;
}

export async function deleteImage(db: DB, img: Image) {
  db.transaction((tx) => {
    tx.delete(schema.collectionItems).where(eq(schema.collectionItems.imageId, img.id)).run();
    tx.delete(schema.imageCrops).where(eq(schema.imageCrops.imageId, img.id)).run();
    tx.delete(schema.images).where(eq(schema.images.id, img.id)).run();
  });
  if (img.source === 'local' && img.filePath) {
    const stillUsed = db.select().from(schema.images).where(eq(schema.images.filePath, img.filePath)).get();
    if (!stillUsed) await fs.rm(path.join(config.originalsDir, img.filePath), { force: true });
  }
  await fs.rm(path.join(config.cacheDir, `thumb_${img.id}.jpg`), { force: true });
}
