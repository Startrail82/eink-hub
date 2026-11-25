import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

/**
 * Offline place list: the nearest place with ≥ 1000 people for photos uploaded to the hub, and
 * place search for the hub's location. From the GeoNames list in apps/server/geo
 * (scripts/build-geo.mjs). No Immich and no internet needed, and coordinates never leave the
 * server. Immich photos keep Immich's answer.
 */

/** Farther than this from any listed place (open sea, wilderness): no place. */
export const MAX_PLACE_KM = 50;

const GEO_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'geo');

/** A place from the list, as the location settings store it. */
export interface GeoPlace {
  name: string;
  /** First-level region ("Basque Country"), '' when GeoNames has none. */
  region: string;
  /** English name, as Immich names it. */
  country: string;
  countryCode: string;
  latitude: number;
  longitude: number;
}

interface Places {
  names: string[];
  countryCodes: string[];
  admin1: string[];
  population: Uint32Array;
  lat: Float32Array;
  lon: Float32Array;
  /** 1°×1° cells → indexes of the places in them. */
  cells: Map<number, number[]>;
  countries: Map<string, string>;
  /** "CC.admin1" → region name. */
  regions: Map<string, string>;
}

let places: Places | null = null;

const cellKey = (lat: number, lon: number) => (Math.floor(lat) + 90) * 360 + (((Math.floor(lon) % 360) + 360) % 360);

function readTsv(file: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!fs.existsSync(file)) return map;
  // \r?\n: a CRLF checkout (Windows, autocrlf) must not leave "\r" on the last column.
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const [code, name] = line.split('\t');
    if (code && name) map.set(code, name);
  }
  return map;
}

function load(): Places {
  if (places) return places;
  const countries = readTsv(path.join(GEO_DIR, 'countries.tsv'));
  const regions = readTsv(path.join(GEO_DIR, 'admin1.tsv'));
  const lines = zlib.gunzipSync(fs.readFileSync(path.join(GEO_DIR, 'cities.tsv.gz'))).toString('utf8').split(/\r?\n/);
  const names: string[] = [];
  const countryCodes: string[] = [];
  const admin1: string[] = [];
  const population = new Uint32Array(lines.length);
  const lat = new Float32Array(lines.length);
  const lon = new Float32Array(lines.length);
  const cells = new Map<number, number[]>();
  for (const line of lines) {
    // Older lists have only the first four columns.
    const [name, la, lo, cc, pop, a1] = line.split('\t');
    if (!name || !cc) continue;
    const i = names.length;
    names.push(name);
    countryCodes.push(cc);
    admin1.push(a1 ?? '');
    population[i] = Number(pop) || 0;
    lat[i] = +la;
    lon[i] = +lo;
    const key = cellKey(+la, +lo);
    const cell = cells.get(key);
    if (cell) cell.push(i);
    else cells.set(key, [i]);
  }
  places = { names, countryCodes, admin1, population, lat, lon, cells, countries, regions };
  return places;
}

function placeAt(p: Places, i: number): GeoPlace {
  const cc = p.countryCodes[i];
  return {
    name: p.names[i],
    region: (p.admin1[i] && p.regions.get(`${cc}.${p.admin1[i]}`)) || '',
    country: p.countries.get(cc) ?? '',
    countryCode: cc,
    latitude: Math.round(p.lat[i] * 1000) / 1000,
    longitude: Math.round(p.lon[i] * 1000) / 1000,
  };
}

function km(lat1: number, lon1: number, lat2: number, lon2: number) {
  const rad = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Index of the listed place nearest to a position, or -1 when none is within MAX_PLACE_KM. */
function nearest(p: Places, latitude: number, longitude: number): number {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return -1;
  let best = -1;
  let bestKm = Infinity;
  // The cell around the point and its neighbours cover at least ~55 km in every direction
  // (less east–west near the poles, where there are hardly any places anyway).
  for (let dLat = -1; dLat <= 1; dLat++) {
    for (let dLon = -1; dLon <= 1; dLon++) {
      for (const i of p.cells.get(cellKey(latitude + dLat, longitude + dLon)) ?? []) {
        const d = km(latitude, longitude, p.lat[i], p.lon[i]);
        if (d < bestKm) {
          bestKm = d;
          best = i;
        }
      }
    }
  }
  return bestKm > MAX_PLACE_KM ? -1 : best;
}

/** City and country (English, as Immich names them) nearest to a GPS position, or null. */
export function reverseGeocode(latitude: number, longitude: number): { city: string; country: string } | null {
  const p = load();
  const i = nearest(p, latitude, longitude);
  return i < 0 ? null : { city: p.names[i], country: p.countries.get(p.countryCodes[i]) ?? '' };
}

/** The listed place nearest to a position, with its region and country, or null. */
export function nearestPlace(latitude: number, longitude: number): GeoPlace | null {
  const p = load();
  const i = nearest(p, latitude, longitude);
  return i < 0 ? null : placeAt(p, i);
}

/** Every country in the list (ISO code and English name, as Immich names it), sorted by name. */
export function allCountries(): { code: string; name: string }[] {
  return [...load().countries].map(([code, name]) => ({ code, name })).sort((a, b) => a.name.localeCompare(b.name));
}

/** Lower case, accents and punctuation dropped, words separated by one space. */
export function normalize(s: string): string {
  return ` ${s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()} `;
}

/**
 * Normalized names, built on the first search (startup and reverse geocoding don't need them).
 * A bilingual name ("Donostia / San Sebastián") gives one key per language.
 */
let searchKeys: string[][] | null = null;

/** 0: the whole name, 1: the start of the name, 2: the start of a word in it, -1: no match. */
function matchRank(keys: string[], q: string): number {
  let best = -1;
  for (const key of keys) {
    const rank = key === ` ${q} ` ? 0 : key.startsWith(` ${q}`) ? 1 : key.includes(` ${q}`) ? 2 : -1;
    if (rank >= 0 && (best < 0 || rank < best)) best = rank;
  }
  return best;
}

/**
 * Places whose name matches `query`, best first: the whole name, then the start of the name,
 * then the start of any word in it, and the most populated first within each. Either name of a
 * bilingual place counts as its name ("san seb" finds "Donostia / San Sebastián" first). Text
 * after a comma narrows by region or country ("paris, texas", "paris, fr").
 */
export function searchPlaces(query: string, limit = 20): GeoPlace[] {
  const [placePart, ...rest] = query.split(',');
  const q = normalize(placePart ?? '').trim();
  if (!q) return [];
  const filter = normalize(rest.join(' ')).trim();
  const p = load();
  searchKeys ??= p.names.map((n) => (n.includes('/') ? [normalize(n), ...n.split('/').map(normalize)] : [normalize(n)]));
  const hits: { i: number; rank: number }[] = [];
  for (let i = 0; i < searchKeys.length; i++) {
    const rank = matchRank(searchKeys[i], q);
    if (rank < 0) continue;
    if (filter) {
      const cc = p.countryCodes[i];
      const where = normalize(`${p.countries.get(cc) ?? ''} ${p.regions.get(`${cc}.${p.admin1[i]}`) ?? ''}`);
      if (!where.includes(` ${filter}`) && filter !== cc.toLowerCase()) continue;
    }
    hits.push({ i, rank });
  }
  hits.sort((a, b) => a.rank - b.rank || p.population[b.i] - p.population[a.i]);
  return hits.slice(0, limit).map((h) => placeAt(p, h.i));
}
