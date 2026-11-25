/** How the date label on a picture looks. Kept per Canvas, in its config. */
export interface PillStyle {
  /** Background colour, "#rrggbb". */
  bg: string;
  /** Text and icon colour, "#rrggbb". */
  text: string;
  /** How opaque the background is, 10 to 100 percent. */
  opacity: number;
}

/** White and solid: a see-through label dithers noisily on a colour e-ink panel, so it is opt-in. */
export const DEFAULT_PILL: PillStyle = { bg: '#ffffff', text: '#1d1c1a', opacity: 100 };

const HEX = /^#[0-9a-f]{6}$/i;

/** What was saved, completed with the defaults; anything invalid falls back to the default. */
export function resolvePill(saved?: Partial<PillStyle> | null): PillStyle {
  // Only a real number counts: Number(null) and Number('') are 0, which would clamp to 10%.
  const opacity = typeof saved?.opacity === 'number' ? Math.round(saved.opacity) : Number.NaN;
  return {
    bg: typeof saved?.bg === 'string' && HEX.test(saved.bg) ? saved.bg.toLowerCase() : DEFAULT_PILL.bg,
    text: typeof saved?.text === 'string' && HEX.test(saved.text) ? saved.text.toLowerCase() : DEFAULT_PILL.text,
    opacity: Number.isFinite(opacity) ? Math.min(100, Math.max(10, opacity)) : DEFAULT_PILL.opacity,
  };
}

export const isDefaultPill = (p: PillStyle) => p.bg === DEFAULT_PILL.bg && p.text === DEFAULT_PILL.text && p.opacity === DEFAULT_PILL.opacity;
