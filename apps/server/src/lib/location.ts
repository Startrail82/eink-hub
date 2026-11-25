import { getSetting, setSetting, type DB } from '../db/index.js';
import type { Frame } from '../db/schema.js';
import { nearestPlace } from './geo.js';
import { HttpError } from './context.js';

/**
 * Where the hub (or one Canvas) is: a place with coordinates, from the offline place list or
 * typed by hand. The weather and the "leave out the home country" caption option read it.
 */
export interface Place {
  name: string;
  /** First-level region ("Basque Country"), '' when unknown. */
  region: string;
  /** English name, as Immich names it, '' when unknown (open sea). */
  country: string;
  countryCode: string;
  latitude: number;
  longitude: number;
}

const KEY = 'location';

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/**
 * A place from a request, or null to clear it. Coordinates are required; a missing name or
 * country is filled from the nearest listed place (coordinates typed by hand or from the
 * browser), and a place far from any town is named by its coordinates.
 */
export function parsePlace(raw: unknown): Place | null {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object') throw new HttpError(400, 'invalid_location');
  const r = raw as Record<string, unknown>;
  const latitude = Number(r.latitude);
  const longitude = Number(r.longitude);
  if (r.latitude === '' || r.longitude === '' || !Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180)
    throw new HttpError(400, 'invalid_location');
  const round = (n: number) => Math.round(n * 1000) / 1000;
  const place: Place = {
    name: text(r.name, 120),
    region: text(r.region, 120),
    country: text(r.country, 80),
    countryCode: text(r.countryCode, 2).toUpperCase(),
    latitude: round(latitude),
    longitude: round(longitude),
  };
  if (!place.name || !place.country) {
    const near = nearestPlace(latitude, longitude);
    if (near) {
      place.name ||= near.name;
      place.region ||= near.region;
      place.country ||= near.country;
      place.countryCode ||= near.countryCode;
    }
    place.name ||= `${place.latitude}, ${place.longitude}`;
  }
  return place;
}

function stored(json: string | undefined): Place | null {
  if (!json) return null;
  try {
    return parsePlace(JSON.parse(json));
  } catch {
    return null;
  }
}

/** The hub's location, or null when none is set. */
export function hubLocation(db: DB): Place | null {
  return stored(getSetting(db, KEY));
}

/** Store the hub's location (null clears it). The home country follows it. */
export function setHubLocation(db: DB, place: Place | null) {
  setSetting(db, KEY, place ? JSON.stringify(place) : '');
  setSetting(db, 'homeCountry', place?.country ?? '');
}

/** A Canvas's own location when it has one, else the hub's. */
export function frameLocation(db: DB, frame: Pick<Frame, 'config'> | null | undefined): Place | null {
  return frame?.config?.location ?? hubLocation(db);
}

/**
 * The country photos taken "at home" are in, for leaving it out of captions: the Canvas's or the
 * hub's location, or the home country chosen before locations existed.
 */
export function homeCountry(db: DB, frame?: Pick<Frame, 'config'> | null): string | undefined {
  const place = frameLocation(db, frame);
  if (place) return place.country || undefined;
  return getSetting(db, 'homeCountry') || undefined;
}
