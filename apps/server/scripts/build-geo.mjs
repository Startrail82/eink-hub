#!/usr/bin/env node
/**
 * Builds the offline place list used to name where uploaded photos were taken and to pick the
 * hub's location (lib/geo.ts):
 *
 *   geo/cities.tsv.gz  name, latitude, longitude, country code, population, admin1 code
 *                      (places with ≥ 1000 people)
 *   geo/countries.tsv  country code, English name
 *   geo/admin1.tsv     "country.admin1" code, English name of the region ("ES.59", "Basque Country")
 *
 * From GeoNames (https://www.geonames.org, CC BY 4.0), the same data Immich geocodes with:
 *
 *   curl -LO https://download.geonames.org/export/dump/cities1000.zip
 *   curl -LO https://download.geonames.org/export/dump/countryInfo.txt
 *   curl -LO https://download.geonames.org/export/dump/admin1CodesASCII.txt
 *   node apps/server/scripts/build-geo.mjs cities1000.zip countryInfo.txt admin1CodesASCII.txt
 *
 * Needs `unzip` on the PATH (or pass the extracted cities1000.txt instead of the .zip).
 * Re-run now and then to pick up GeoNames fixes; the output is committed.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const [cities, countryInfo, admin1Codes] = process.argv.slice(2);
if (!cities || !countryInfo || !admin1Codes) {
  console.error('usage: build-geo.mjs cities1000.zip countryInfo.txt admin1CodesASCII.txt');
  process.exit(1);
}
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'geo');
fs.mkdirSync(out, { recursive: true });

// geoname columns: 1 name, 4 latitude, 5 longitude, 8 country code, 10 admin1 code, 14 population.
const raw = cities.endsWith('.zip')
  ? execFileSync('unzip', ['-p', cities, 'cities1000.txt'], { maxBuffer: 1 << 30 }).toString('utf8')
  : fs.readFileSync(cities, 'utf8');
const rows = [];
for (const line of raw.split('\n')) {
  const c = line.split('\t');
  if (c.length < 15 || !c[1] || !c[8]) continue;
  const clean = (s) => (s ?? '').replace(/[\t\r\n]/g, ' ').trim();
  // 3 decimals ≈ 100 m: plenty to find the nearest place, and a third of the size.
  rows.push(`${clean(c[1])}\t${(+c[4]).toFixed(3)}\t${(+c[5]).toFixed(3)}\t${c[8]}\t${+c[14] || 0}\t${clean(c[10])}`);
}
fs.writeFileSync(path.join(out, 'cities.tsv.gz'), zlib.gzipSync(rows.join('\n') + '\n', { level: 9 }));

// countryInfo columns: 0 ISO code, 4 name. Comment lines start with '#'.
const countries = fs
  .readFileSync(countryInfo, 'utf8')
  .split('\n')
  .filter((l) => l && !l.startsWith('#'))
  .map((l) => l.split('\t'))
  .filter((c) => c[0] && c[4])
  .map((c) => `${c[0]}\t${c[4].trim()}`);
fs.writeFileSync(path.join(out, 'countries.tsv'), countries.join('\n') + '\n');

// admin1CodesASCII columns: 0 "CC.code", 1 name.
const admin1 = fs
  .readFileSync(admin1Codes, 'utf8')
  .split('\n')
  .map((l) => l.split('\t'))
  .filter((c) => c[0] && c[1])
  .map((c) => `${c[0]}\t${c[1].trim()}`);
fs.writeFileSync(path.join(out, 'admin1.tsv'), admin1.join('\n') + '\n');

console.log(`${rows.length} places, ${countries.length} countries, ${admin1.length} regions → ${out}`);
