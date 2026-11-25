#!/usr/bin/env node
/**
 * Builds the offline place list used to name where uploaded photos were taken (lib/geo.ts):
 *
 *   geo/cities.tsv.gz  name, latitude, longitude, country code  (places with ≥ 1000 people)
 *   geo/countries.tsv  country code, English name
 *
 * From GeoNames (https://www.geonames.org, CC BY 4.0), the same data Immich geocodes with:
 *
 *   curl -LO https://download.geonames.org/export/dump/cities1000.zip
 *   curl -LO https://download.geonames.org/export/dump/countryInfo.txt
 *   node apps/server/scripts/build-geo.mjs cities1000.zip countryInfo.txt
 *
 * Needs `unzip` on the PATH. Re-run now and then to pick up GeoNames fixes; the output is committed.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const [zip, countryInfo] = process.argv.slice(2);
if (!zip || !countryInfo) {
  console.error('usage: build-geo.mjs cities1000.zip countryInfo.txt');
  process.exit(1);
}
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'geo');
fs.mkdirSync(out, { recursive: true });

// geoname columns: 1 name, 4 latitude, 5 longitude, 8 country code.
const raw = execFileSync('unzip', ['-p', zip, 'cities1000.txt'], { maxBuffer: 1 << 30 }).toString('utf8');
const rows = [];
for (const line of raw.split('\n')) {
  const c = line.split('\t');
  if (c.length < 9 || !c[1] || !c[8]) continue;
  // 3 decimals ≈ 100 m: plenty to find the nearest place, and a third of the size.
  rows.push(`${c[1].replace(/[\t\n]/g, ' ')}\t${(+c[4]).toFixed(3)}\t${(+c[5]).toFixed(3)}\t${c[8]}`);
}
fs.writeFileSync(path.join(out, 'cities.tsv.gz'), zlib.gzipSync(rows.join('\n') + '\n', { level: 9 }));

// countryInfo columns: 0 ISO code, 4 name. Comment lines start with '#'.
const countries = fs
  .readFileSync(countryInfo, 'utf8')
  .split('\n')
  .filter((l) => l && !l.startsWith('#'))
  .map((l) => l.split('\t'))
  .filter((c) => c[0] && c[4])
  .map((c) => `${c[0]}\t${c[4]}`);
fs.writeFileSync(path.join(out, 'countries.tsv'), countries.join('\n') + '\n');

console.log(`${rows.length} places, ${countries.length} countries → ${out}`);
