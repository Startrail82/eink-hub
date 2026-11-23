import type { Lang } from '../i18n.js';

/** The weather as the bar shows it: one icon and one short word. */
export type Sky = 'clear' | 'partly' | 'cloudy' | 'fog' | 'drizzle' | 'rain' | 'snow' | 'thunder';

/** WMO weather code (Open-Meteo) to the kind the bar draws. */
export function skyOf(code: number | null | undefined): Sky | null {
  if (typeof code !== 'number') return null;
  if (code === 0 || code === 1) return 'clear';
  if (code === 2) return 'partly';
  if (code === 3) return 'cloudy';
  if (code === 45 || code === 48) return 'fog';
  if (code >= 51 && code <= 57) return 'drizzle';
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if (code >= 95) return 'thunder';
  return null;
}

const LABELS: Record<Lang, Record<Sky, string>> = {
  nl: { clear: 'Zonnig', partly: 'Half bewolkt', cloudy: 'Bewolkt', fog: 'Mist', drizzle: 'Motregen', rain: 'Regen', snow: 'Sneeuw', thunder: 'Onweer' },
  en: { clear: 'Sunny', partly: 'Partly cloudy', cloudy: 'Cloudy', fog: 'Fog', drizzle: 'Drizzle', rain: 'Rain', snow: 'Snow', thunder: 'Thunderstorm' },
  es: { clear: 'Soleado', partly: 'Parcialmente nublado', cloudy: 'Nublado', fog: 'Niebla', drizzle: 'Llovizna', rain: 'Lluvia', snow: 'Nieve', thunder: 'Tormenta' },
  eu: { clear: 'Eguzkitsu', partly: 'Hodei-tarteak', cloudy: 'Hodeitsu', fog: 'Lainoa', drizzle: 'Zirimiri', rain: 'Euria', snow: 'Elurra', thunder: 'Ekaitza' },
  ca: { clear: 'Assolellat', partly: 'Parcialment ennuvolat', cloudy: 'Ennuvolat', fog: 'Boira', drizzle: 'Plugim', rain: 'Pluja', snow: 'Neu', thunder: 'Tempesta' },
  gl: { clear: 'Soleado', partly: 'Parcialmente nubrado', cloudy: 'Nubrado', fog: 'Néboa', drizzle: 'Chuvisco', rain: 'Chuvia', snow: 'Neve', thunder: 'Treboada' },
  fr: { clear: 'Ensoleillé', partly: 'Partiellement nuageux', cloudy: 'Nuageux', fog: 'Brouillard', drizzle: 'Bruine', rain: 'Pluie', snow: 'Neige', thunder: 'Orage' },
  de: { clear: 'Sonnig', partly: 'Teils bewölkt', cloudy: 'Bewölkt', fog: 'Nebel', drizzle: 'Nieselregen', rain: 'Regen', snow: 'Schnee', thunder: 'Gewitter' },
  it: { clear: 'Soleggiato', partly: 'Parzialmente nuvoloso', cloudy: 'Nuvoloso', fog: 'Nebbia', drizzle: 'Pioviggine', rain: 'Pioggia', snow: 'Neve', thunder: 'Temporale' },
  pt: { clear: 'Ensolarado', partly: 'Parcialmente nublado', cloudy: 'Nublado', fog: 'Nevoeiro', drizzle: 'Chuvisco', rain: 'Chuva', snow: 'Neve', thunder: 'Trovoada' },
  pl: { clear: 'Słonecznie', partly: 'Częściowe zachmurzenie', cloudy: 'Pochmurno', fog: 'Mgła', drizzle: 'Mżawka', rain: 'Deszcz', snow: 'Śnieg', thunder: 'Burza' },
  cs: { clear: 'Slunečno', partly: 'Polojasno', cloudy: 'Zataženo', fog: 'Mlha', drizzle: 'Mrholení', rain: 'Déšť', snow: 'Sníh', thunder: 'Bouřka' },
  ru: { clear: 'Солнечно', partly: 'Переменная облачность', cloudy: 'Облачно', fog: 'Туман', drizzle: 'Морось', rain: 'Дождь', snow: 'Снег', thunder: 'Гроза' },
  ja: { clear: '晴れ', partly: '晴れ時々曇り', cloudy: '曇り', fog: '霧', drizzle: '霧雨', rain: '雨', snow: '雪', thunder: '雷雨' },
  ko: { clear: '맑음', partly: '구름 조금', cloudy: '흐림', fog: '안개', drizzle: '이슬비', rain: '비', snow: '눈', thunder: '뇌우' },
  zh: { clear: '晴', partly: '多云', cloudy: '阴', fog: '雾', drizzle: '毛毛雨', rain: '雨', snow: '雪', thunder: '雷雨' },
  'zh-TW': { clear: '晴', partly: '多雲', cloudy: '陰', fog: '霧', drizzle: '毛毛雨', rain: '雨', snow: '雪', thunder: '雷雨' },
};

export const skyLabel = (sky: Sky, lang: Lang): string => LABELS[lang]?.[sky] ?? LABELS.en[sky];

const INK = '#1d1c1a';
const CLOUD = 'M7 19a4 4 0 0 1-.5-7.97A6 6 0 0 1 18 9.5 4.5 4.5 0 0 1 17.5 19Z';
const SUN = (cx: number, cy: number, r: number) => {
  const rays = Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI) / 4;
    const c = Math.cos(a);
    const s = Math.sin(a);
    return `<line x1="${cx + c * (r + 1.6)}" y1="${cy + s * (r + 1.6)}" x2="${cx + c * (r + 3.4)}" y2="${cy + s * (r + 3.4)}"/>`;
  }).join('');
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${INK}" stroke="none"/>${rays}`;
};

/** A small flat icon on a 24x24 grid, drawn in the same ink as the text. */
export function skyIcon(sky: Sky, px: number): Buffer {
  const cloud = (dy = 0) => `<path d="${CLOUD}" fill="${INK}" stroke="none" transform="translate(0 ${dy})"/>`;
  const drops = (n: number, dy = 0) => Array.from({ length: n }, (_, i) => `<line x1="${8 + i * 4}" y1="${21 + dy}" x2="${7 + i * 4}" y2="${24 + dy}"/>`).join('');
  const body: Record<Sky, string> = {
    clear: SUN(12, 12, 4.6),
    partly: `${SUN(8.5, 8.5, 3.4)}<path d="${CLOUD}" fill="#ffffff" stroke="#ffffff" stroke-width="2.4" transform="translate(2 1)"/><path d="${CLOUD}" fill="${INK}" stroke="none" transform="translate(2 1)"/>`,
    cloudy: cloud(),
    fog: `${cloud(-3)}<line x1="4" y1="19" x2="20" y2="19"/><line x1="7" y1="22" x2="21" y2="22"/>`,
    drizzle: `${cloud(-4)}${drops(2, -1)}`,
    rain: `${cloud(-4)}${drops(3, -1)}`,
    snow: `${cloud(-4)}${[8, 12, 16].map((x) => `<circle cx="${x}" cy="21.5" r="1.1" fill="${INK}" stroke="none"/>`).join('')}`,
    thunder: `${cloud(-4)}<path d="M12.5 15l-3 5h3l-1 4 4-6h-3l1-3Z" fill="${INK}" stroke="none"/>`,
  };
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 24 26"><g stroke="${INK}" stroke-width="1.7" stroke-linecap="round" fill="none">${body[sky]}</g></svg>`,
  );
}
