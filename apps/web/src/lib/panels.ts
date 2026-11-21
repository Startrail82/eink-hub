import type { Frame } from './api';

/** Known E Ink panels, by resolution ("short x long") with their diagonal in inches. Mirrors the server's device/sizes. */
export const KNOWN_PANELS: Record<string, number> = {
  '480x800': 7.3,
  '1200x1600': 13.3,
  '2160x3060': 28.5,
  '1440x2560': 31.5,
};

export const DEFAULT_PANEL = '1200x1600';

/** A frame's panel as "shortxlong", independent of how it hangs. */
export const panelKey = (f: Pick<Frame, 'width' | 'height'>) => `${Math.min(f.width, f.height)}x${Math.max(f.width, f.height)}`;

/** "13.3″ (1200 × 1600)", or just the resolution for a screen we do not know. */
export function panelLabel(key: string, diagonal?: number | null) {
  const d = diagonal ?? KNOWN_PANELS[key];
  const res = key.replace('x', ' × ');
  return d ? `${d}″ (${res})` : res;
}

/** Known panels plus any other resolution among the frames, smallest first. */
export function panelOptions(frames: Pick<Frame, 'width' | 'height' | 'diagonal'>[] = []) {
  const all = new Map<string, number | null>(Object.entries(KNOWN_PANELS));
  for (const f of frames) {
    const k = panelKey(f);
    if (!all.has(k) || (all.get(k) == null && f.diagonal)) all.set(k, all.get(k) ?? f.diagonal ?? null);
  }
  return [...all.entries()]
    .sort((a, b) => Number(a[0].split('x')[0]) - Number(b[0].split('x')[0]))
    .map(([value, d]) => ({ value, label: panelLabel(value, d) }));
}
