/** How the date label on a picture looks. Kept per Canvas, in its config. */
export interface PillStyle {
  /** Background colour, "#rrggbb", or "auto" to pick it from the picture under the label. */
  bg: string;
  /** Text and icon colour, "#rrggbb". Ignored when the background is "auto". */
  text: string;
  /** How opaque the background is, 10 to 100 percent. */
  opacity: number;
}

/** White and solid: a see-through label dithers noisily on a colour e-ink panel, so it is opt-in. */
export const DEFAULT_PILL: PillStyle = { bg: '#ffffff', text: '#1d1c1a', opacity: 100 };

/** The background value that asks for a colour picked from the picture. */
export const AUTO = 'auto';

const HEX = /^#[0-9a-f]{6}$/i;

/** What was saved, completed with the defaults; anything invalid falls back to the default. */
export function resolvePill(saved?: Partial<PillStyle> | null): PillStyle {
  // Only a real number counts: Number(null) and Number('') are 0, which would clamp to 10%.
  const opacity = typeof saved?.opacity === 'number' ? Math.round(saved.opacity) : Number.NaN;
  const auto = saved?.bg === AUTO;
  return {
    bg: auto ? AUTO : typeof saved?.bg === 'string' && HEX.test(saved.bg) ? saved.bg.toLowerCase() : DEFAULT_PILL.bg,
    // In auto the text colour is derived, so a stale saved one must not change the render hash.
    text: !auto && typeof saved?.text === 'string' && HEX.test(saved.text) ? saved.text.toLowerCase() : DEFAULT_PILL.text,
    opacity: Number.isFinite(opacity) ? Math.min(100, Math.max(10, opacity)) : DEFAULT_PILL.opacity,
  };
}

export const isDefaultPill = (p: PillStyle) => p.bg === DEFAULT_PILL.bg && p.text === DEFAULT_PILL.text && p.opacity === DEFAULT_PILL.opacity;

type Rgb = [number, number, number];

/** WCAG relative luminance of an sRGB colour, 0 (black) to 1 (white). */
export function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Hue of an sRGB colour in degrees, and its saturation (HSL), 0 to 1. */
function hueSat([r, g, b]: Rgb): { h: number; s: number } {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  if (d === 0) return { h: 0, s: 0 };
  const l = (max + min) / 2;
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === rn ? ((gn - bn) / d) % 6 : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
  return { h: (h * 60 + 360) % 360, s };
}

function hslHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return '#' + [r, g, b].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('');
}

/**
 * Label colours for the picture under it (its mean colour): over a dark area a light chip
 * with dark text, over a light one a dark chip with light text. Tinted with the picture's hue
 * so it belongs to the photo; `plain` (panels the hub dithers to a palette, where a tint turns
 * into grain) keeps to white and near-black.
 */
export function autoPill(mean: Rgb, plain: boolean): { bg: string; text: string } {
  // 0.18 is where white and black contrast equally with the area (WCAG): a light chip stands
  // out more below it, a dark one above.
  const light = luminance(mean) < 0.18;
  if (plain) return light ? { bg: '#ffffff', text: '#1d1c1a' } : { bg: '#1d1c1a', text: '#ffffff' };
  const { h, s } = hueSat(mean);
  // A grey area gets a neutral chip; a colourful one a soft tint of its hue.
  const tint = Math.min(0.35, s * 0.5);
  return light ? { bg: hslHex(h, tint, 0.93), text: hslHex(h, tint, 0.14) } : { bg: hslHex(h, tint, 0.17), text: hslHex(h, tint, 0.96) };
}
