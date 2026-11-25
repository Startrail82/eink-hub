import { getSetting, setSetting, type DB } from '../../db/index.js';
import { AiError } from '../ai/providers.js';
import type { PromptVars } from '../ai/sources.js';
import { weatherVars } from './describe.js';
import { openMeteo } from './openmeteo.js';
import { cleanOffset } from './provider.js';
import type { WeatherProvider, WeatherSnapshot } from './provider.js';

export { cleanOffset, MAX_OFFSET_HOURS } from './provider.js';
export type { WeatherProvider, WeatherRequest, WeatherSnapshot } from './provider.js';

/** Every weather source the hub knows. To add one, write a WeatherProvider and list it here. */
export const weatherProviders: WeatherProvider[] = [openMeteo];

export const DEFAULT_WEATHER_PROVIDER = openMeteo.id;

/** The hub-wide choice of weather source (Settings > Weather). */
export interface WeatherConfig {
  provider: string;
  apiKey: string;
}

export function weatherConfig(db: DB): WeatherConfig {
  const saved = getSetting(db, 'weather.provider') ?? '';
  return {
    provider: weatherProviders.some((p) => p.id === saved) ? saved : DEFAULT_WEATHER_PROVIDER,
    apiKey: getSetting(db, 'weather.apiKey') ?? '',
  };
}

export function saveWeatherConfig(db: DB, c: Partial<WeatherConfig>) {
  // A key belongs to one provider: choosing another one forgets it rather than sending it to a stranger.
  if (c.provider !== undefined && weatherProviders.some((p) => p.id === c.provider)) {
    if (c.provider !== weatherConfig(db).provider) setSetting(db, 'weather.apiKey', '');
    setSetting(db, 'weather.provider', c.provider);
  }
  if (c.apiKey !== undefined) setSetting(db, 'weather.apiKey', c.apiKey.trim());
}

/** The chosen provider's snapshot at a place, now or `hours` ahead. */
export async function fetchSnapshot(latitude: number, longitude: number, cfg: WeatherConfig, hours = 0): Promise<WeatherSnapshot> {
  const provider = weatherProviders.find((p) => p.id === cfg.provider) ?? openMeteo;
  if (provider.key === 'required' && !cfg.apiKey) throw new AiError(`${provider.name} needs an API key (Settings > Weather)`);
  return provider.fetch({ latitude, longitude, apiKey: cfg.apiKey, hours: cleanOffset(hours) });
}

/** The chosen provider's snapshot at a place, as prompt variables. */
export async function fetchWeatherVars(latitude: number, longitude: number, cfg: WeatherConfig, hours = 0): Promise<PromptVars> {
  return weatherVars(await fetchSnapshot(latitude, longitude, cfg, hours));
}
