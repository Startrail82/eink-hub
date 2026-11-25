import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

/**
 * Offline reverse geocoding for photos uploaded to the hub: the nearest place with ≥ 1000
 * people, from the GeoNames list in apps/server/geo (scripts/build-geo.mjs). No Immich and no
 * internet needed, and coordinates never leave the server. Immich photos keep Immich's answer.
 */

/** Farther than this from any listed place (open sea, wilderness): no place. */
export const MAX_PLACE_KM = 50;

const GEO_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'geo');

interface Places {
  names: string[];
  countryCodes: string[];
  lat: Float32Array;
  lon: Float32Array;
  /** 1°×1° cells → indexes of the places in them. */
  cells: Map<number, number[]>;
  countries: Map<string, string>;
}

let places: Places | null = null;

const cellKey = (lat: number, lon: number) => (Math.floor(lat) + 90) * 360 + (((Math.floor(lon) % 360) + 360) % 360);

function load(): Places {
  if (places) return places;
  const countries = new Map<string, string>();
  for (const line of fs.readFileSync(path.join(GEO_DIR, 'countries.tsv'), 'utf8').split('\n')) {
    const [code, name] = line.split('\t');
    if (code && name) countries.set(code, name);
  }
  const lines = zlib.gunzipSync(fs.readFileSync(path.join(GEO_DIR, 'cities.tsv.gz'))).toString('utf8').split('\n');
  const names: string[] = [];
  const countryCodes: string[] = [];
  const lat = new Float32Array(lines.length);
  const lon = new Float32Array(lines.length);
  const cells = new Map<number, number[]>();
  for (const line of lines) {
    const [name, la, lo, cc] = line.split('\t');
    if (!name || !cc) continue;
    const i = names.length;
    names.push(name);
    countryCodes.push(cc);
    lat[i] = +la;
    lon[i] = +lo;
    const key = cellKey(+la, +lo);
    const cell = cells.get(key);
    if (cell) cell.push(i);
    else cells.set(key, [i]);
  }
  places = { names, countryCodes, lat, lon, cells, countries };
  return places;
}

function km(lat1: number, lon1: number, lat2: number, lon2: number) {
  const rad = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** City and country (English, as Immich names them) nearest to a GPS position, or null. */
export function reverseGeocode(latitude: number, longitude: number): { city: string; country: string } | null {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  const p = load();
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
  if (best < 0 || bestKm > MAX_PLACE_KM) return null;
  return { city: p.names[best], country: p.countries.get(p.countryCodes[best]) ?? '' };
}

/** Every country in the list (ISO code and English name, as Immich names it), sorted by name. */
export function allCountries(): { code: string; name: string }[] {
  return [...load().countries].map(([code, name]) => ({ code, name })).sort((a, b) => a.name.localeCompare(b.name));
}
