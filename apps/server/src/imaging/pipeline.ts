import { DEFAULT_PILL, type PillStyle } from './pill.js';
import { skyIcon, type Sky } from './sky.js';
import sharp, { type OverlayOptions, type Sharp } from 'sharp';
import type { FitMode } from '../db/schema.js';
import type { ImageFormat } from '../device/drivers/types.js';
import { PALETTES, ditherToPalette, encodeBmp, indicesToRgb } from './dither.js';

export interface CropRect {
  /** Fractions (0..1) of the EXIF-oriented source image. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RenderOptions {
  /** Native panel size, portrait (e.g. 1200×1600). */
  width: number;
  height: number;
  /** Frame hung landscape: compose at height×width and rotate into the portrait buffer. */
  landscape: boolean;
  rotate: number;
  fit: FitMode;
  bg: string;
  crop?: CropRect | null;
  /** Text drawn in a label at the bottom-left, e.g. the photo's date. */
  caption?: string | null;
  /** Today's weather, drawn in a translucent label at the bottom-right. */
  weather?: WeatherBar | null;
  /** Colours and opacity of the date and weather labels. */
  pill?: PillStyle;
  quality?: number;
  /** Baseline JPEG unless the frame asks for something else. */
  format?: ImageFormat;
}

export const formatExt = (f: ImageFormat = { type: 'jpeg' }) => (f.type === 'jpeg' ? 'jpg' : f.type);
export const formatMime = (ext: string) => (ext === 'jpg' ? 'image/jpeg' : ext === 'png' ? 'image/png' : 'image/bmp');

export function targetSize(o: Pick<RenderOptions, 'width' | 'height' | 'landscape'>) {
  const w = Math.min(o.width, o.height);
  const h = Math.max(o.width, o.height);
  return o.landscape ? { w: h, h: w } : { w, h };
}

export function aspectKey(o: Pick<RenderOptions, 'width' | 'height' | 'landscape'>) {
  const { w, h } = targetSize(o);
  return `${w}x${h}`;
}

/**
 * Produce the JPEG the canvas expects: baseline (not progressive), 8-bit sRGB,
 * exactly the panel resolution, stored portrait.
 */
export async function renderForFrame(src: Buffer, o: RenderOptions): Promise<Buffer> {
  const { w: tw, h: th } = targetSize(o);
  const { data: oriented, info } = await sharp(src, { failOn: 'none' })
    .autoOrient()
    .toColourspace('srgb')
    .toBuffer({ resolveWithObject: true });

  let composed: Buffer;
  if (o.crop) {
    const left = clamp(Math.round(o.crop.x * info.width), 0, info.width - 1);
    const top = clamp(Math.round(o.crop.y * info.height), 0, info.height - 1);
    const width = clamp(Math.round(o.crop.w * info.width), 1, info.width - left);
    const height = clamp(Math.round(o.crop.h * info.height), 1, info.height - top);
    composed = await sharp(oriented)
      .extract({ left, top, width, height })
      .resize(tw, th, { fit: 'cover' })
      .toBuffer();
  } else if (o.fit === 'contain') {
    composed = await sharp(oriented).resize(tw, th, { fit: 'contain', background: o.bg }).toBuffer();
  } else if (o.fit === 'blur') {
    const backdrop = await sharp(oriented).resize(tw, th, { fit: 'cover' }).blur(45).modulate({ brightness: 0.92 }).toBuffer();
    const fg = await sharp(oriented).resize(tw, th, { fit: 'inside' }).toBuffer();
    composed = await sharp(backdrop).composite([{ input: fg, gravity: 'center' }]).toBuffer();
  } else {
    composed = await sharp(oriented).resize(tw, th, { fit: 'cover', position: sharp.strategy.attention }).toBuffer();
  }

  let captionBox: Box | null = null;
  if (o.caption) ({ img: composed, box: captionBox } = await addCaption(composed, o.caption, tw, th, o.pill ?? DEFAULT_PILL));
  if (o.weather) composed = await addWeatherBar(composed, o.weather, tw, th, captionBox, o.pill ?? DEFAULT_PILL);

  let out = sharp(composed);
  if (o.landscape && o.rotate) out = out.rotate(o.rotate);
  out = out.flatten({ background: o.bg }).toColourspace('srgb');
  if (!o.format || (o.format.type === 'jpeg' && !o.format.palette)) {
    return out.jpeg({ quality: o.quality ?? 92, progressive: false, mozjpeg: false, chromaSubsampling: '4:4:4' }).toBuffer();
  }
  return encode(out, o.format, o.quality);
}

/**
 * Final encoding for frames that want PNG/BMP and/or hub-side dithering. Takes any sharp
 * pipeline already at the panel's size.
 */
async function encode(img: Sharp, f: ImageFormat, quality = 92): Promise<Buffer> {
  const { data: pixels, info } = await img.removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let data: Buffer = pixels;
  const palette = f.palette ? PALETTES[f.palette] : null;
  if (palette) data = indicesToRgb(ditherToPalette(data, info.width, info.height, palette), palette);
  const raw = () => sharp(data, { raw: { width: info.width, height: info.height, channels: 3 } });
  if (f.type === 'bmp') return encodeBmp(data, info.width, info.height, f.palette === 'bw');
  if (f.type === 'png') {
    // Exact palette colours survive quantisation when there are at most that many.
    return palette ? raw().png({ palette: true, colours: palette.length, dither: 0, compressionLevel: 9 }).toBuffer() : raw().png().toBuffer();
  }
  return raw().jpeg({ quality, progressive: false, mozjpeg: false, chromaSubsampling: '4:4:4' }).toBuffer();
}

/** Re-encode an already rendered JPEG (e.g. the welcome picture) for a frame's format. */
export async function convertRender(jpeg: Buffer, f: ImageFormat): Promise<Buffer> {
  if (f.type === 'jpeg' && !f.palette) return jpeg;
  return encode(sharp(jpeg).toColourspace('srgb'), f);
}

const escapeMarkup = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Solid white rounded label with dark text, bottom-left. Solid colours dither cleanly on
 * colour e-ink; translucent gradients would turn into noise.
 */
interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

async function addCaption(img: Buffer, caption: string, w: number, h: number, style: PillStyle): Promise<{ img: Buffer; box: Box }> {
  const size = Math.max(14, Math.round(Math.min(w, h) * 0.032));
  const label = await sharp({
    text: { text: `<span foreground="${style.text}">${escapeMarkup(caption)}</span>`, font: `Inter,Arial,DejaVu Sans,Sans Semi-Bold ${size}`, dpi: 72, rgba: true },
  })
    .png()
    .toBuffer({ resolveWithObject: true });
  const padX = Math.round(size * 0.75);
  const padY = Math.round(size * 0.45);
  const margin = Math.round(Math.min(w, h) * 0.04);
  const pillW = Math.min(w - 2 * margin, label.info.width + 2 * padX);
  const pillH = label.info.height + 2 * padY;
  const pill = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pillW}" height="${pillH}"><rect width="${pillW}" height="${pillH}" rx="${pillH / 2}" fill="${style.bg}" fill-opacity="${style.opacity / 100}"/></svg>`,
  );
  const top = h - margin - pillH;
  const out = await sharp(img)
    .composite([
      { input: pill, left: margin, top },
      { input: label.data, left: margin + padX, top: top + padY },
    ])
    .toBuffer();
  return { img: out, box: { left: margin, top, width: pillW, height: pillH } };
}

const textLabel = (text: string, size: number, ink: string) =>
  sharp({ text: { text: `<span foreground="${ink}">${escapeMarkup(text)}</span>`, font: `Inter,Arial,DejaVu Sans,Sans Semi-Bold ${size}`, dpi: 72, rgba: true } })
    .png()
    .toBuffer({ resolveWithObject: true });

/** What the weather bar shows: the numbers, and optionally the sky with its word in the hub's language. */
export interface WeatherBar {
  min: number;
  max: number;
  rain: number | null;
  sky?: Sky | null;
  label?: string | null;
}

/**
 * Today's weather in a label at the bottom-right, like the caption but translucent so the picture
 * shows through: low, high and chance of rain on the first line, the sky (icon and word) below it.
 * The drop and the icon are drawn, not font symbols: most fonts lack them. When the caption is in
 * the way, the label goes above it.
 */
async function addWeatherBar(img: Buffer, wx: WeatherBar, w: number, h: number, caption: Box | null, style: PillStyle): Promise<Buffer> {
  const size = Math.max(14, Math.round(Math.min(w, h) * 0.032));
  const temps = await textLabel(`\u2193 ${wx.min}\u00b0   \u2191 ${wx.max}\u00b0`, size, style.text);
  const rain = wx.rain === null ? null : await textLabel(`${wx.rain}%`, size, style.text);
  const word = wx.sky && wx.label ? await textLabel(wx.label, size, style.text) : null;
  const padX = Math.round(size * 0.75);
  const padY = Math.round(size * 0.45);
  const margin = Math.round(Math.min(w, h) * 0.04);
  const dropH = Math.round(size * 0.95);
  const dropW = Math.round(dropH * 0.72);
  const iconPx = Math.round(size * 1.35);
  const gap = Math.round(size * 0.9);
  const gapSmall = Math.round(size * 0.3);
  const lineGap = Math.round(size * 0.25);
  const row1 = temps.info.width + (rain ? gap + dropW + gapSmall + rain.info.width : 0);
  const row1H = Math.max(temps.info.height, rain?.info.height ?? 0);
  const row2 = word ? iconPx + gapSmall + word.info.width : 0;
  const row2H = word ? Math.max(iconPx, word.info.height) : 0;
  const pillW = Math.min(w - 2 * margin, Math.max(row1, row2) + 2 * padX);
  const pillH = row1H + (word ? lineGap + row2H : 0) + 2 * padY;
  const left = w - margin - pillW;
  const gapAbove = Math.round(margin / 2);
  const clash = caption && caption.left + caption.width + gapAbove > left;
  const top = clash ? caption.top - gapAbove - pillH : h - margin - pillH;
  const rx = Math.min(pillH / 2, Math.round(size * 1.1));
  const pill = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pillW}" height="${pillH}"><rect width="${pillW}" height="${pillH}" rx="${rx}" fill="${style.bg}" fill-opacity="${style.opacity / 100}"/></svg>`,
  );
  const x0 = left + padX;
  const y1 = top + padY;
  const layers: OverlayOptions[] = [
    { input: pill, left, top },
    { input: temps.data, left: x0, top: y1 + Math.round((row1H - temps.info.height) / 2) },
  ];
  if (rain) {
    const dropLeft = x0 + temps.info.width + gap;
    const drop = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${dropW}" height="${dropH}" viewBox="0 0 10 14"><path d="M5 0C5 0 0 6 0 9a5 5 0 0 0 10 0C10 6 5 0 5 0Z" fill="${style.text}"/></svg>`,
    );
    layers.push({ input: drop, left: dropLeft, top: y1 + Math.round((row1H - dropH) / 2) });
    layers.push({ input: rain.data, left: dropLeft + dropW + gapSmall, top: y1 + Math.round((row1H - rain.info.height) / 2) });
  }
  if (word && wx.sky) {
    const y2 = y1 + row1H + lineGap;
    layers.push({ input: skyIcon(wx.sky, iconPx, style.text, style.bg), left: x0, top: y2 + Math.round((row2H - iconPx) / 2) });
    layers.push({ input: word.data, left: x0 + iconPx + gapSmall, top: y2 + Math.round((row2H - word.info.height) / 2) });
  }
  return sharp(img).composite(layers).toBuffer();
}

/** Small JPEG thumbnail for the web UI. */
export function thumbnail(src: Buffer, size = 480) {
  return sharp(src, { failOn: 'none' }).autoOrient().resize(size, size, { fit: 'inside' }).jpeg({ quality: 80 }).toBuffer();
}

export async function probeImage(src: Buffer) {
  const m = await sharp(src, { failOn: 'none' }).autoOrient().metadata();
  const taken = m.exif ? exifDate(m.exif) : undefined;
  return { width: m.autoOrient?.width ?? m.width, height: m.autoOrient?.height ?? m.height, takenAt: taken };
}

/** Pull DateTimeOriginal out of the raw EXIF block without a full EXIF parser. */
function exifDate(exif: Buffer): number | undefined {
  const m = exif.toString('latin1').match(/(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (!m) return undefined;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return Number.isFinite(t) ? t : undefined;
}

/** True if the JPEG uses a baseline (SOF0/SOF1) frame rather than progressive (SOF2). */
export function isBaselineJpeg(buf: Buffer): boolean {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return false;
  let i = 2;
  while (i + 4 < buf.length) {
    if (buf[i] !== 0xff) return false;
    const marker = buf[i + 1];
    if (marker === 0xc0 || marker === 0xc1) return true;
    if (marker === 0xc2) return false;
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return false;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}
