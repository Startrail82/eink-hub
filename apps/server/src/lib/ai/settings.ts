import { getSetting, setSetting, type DB } from '../../db/index.js';
import { aiProviderIds, imageProviders } from './providers.js';

/** The hub-wide connection to the image generator (Settings > AI images). */
export interface AiConfig {
  /** The id of one of the providers in providers.ts, or empty when none is chosen. */
  provider: string;
  /** OpenAI-compatible: base URL up to and including /v1. ComfyUI: server address. */
  url: string;
  apiKey: string;
  /** ComfyUI behind a login (e.g. Authentik): the user name; the "API key" is then its password. */
  username: string;
  /** OpenAI-compatible only. */
  model: string;
  /** OpenAI-compatible only: "1024x1024" etc. Empty = pick one that fits the frame. */
  size: string;
  /** ComfyUI only: the workflow in API format, with {{prompt}} where the text goes. */
  workflow: string;
}

export function aiConfig(db: DB): AiConfig {
  const provider = getSetting(db, 'ai.provider');
  return {
    provider: aiProviderIds().includes(provider ?? '') ? (provider as string) : '',
    url: getSetting(db, 'ai.url') ?? '',
    apiKey: getSetting(db, 'ai.apiKey') ?? '',
    username: getSetting(db, 'ai.username') ?? '',
    model: getSetting(db, 'ai.model') ?? '',
    size: getSetting(db, 'ai.size') ?? '',
    workflow: getSetting(db, 'ai.workflow') ?? '',
  };
}

export function saveAiConfig(db: DB, c: Partial<AiConfig>) {
  // A key belongs to one service: choosing another one forgets it rather than sending it to a stranger.
  // Same for the address: a key saved for one host is not sent to another unless a new one is typed.
  const cur = aiConfig(db);
  const newUrl = c.url === undefined ? undefined : c.url.trim().replace(/\/+$/, '');
  if ((c.provider !== undefined && c.provider !== cur.provider) || (newUrl !== undefined && newUrl !== cur.url)) {
    setSetting(db, 'ai.apiKey', '');
  }
  if (c.provider !== undefined) setSetting(db, 'ai.provider', aiProviderIds().includes(c.provider) ? c.provider : '');
  if (c.url !== undefined) setSetting(db, 'ai.url', c.url.trim().replace(/\/+$/, ''));
  if (c.apiKey) setSetting(db, 'ai.apiKey', c.apiKey.trim());
  if (c.username !== undefined) setSetting(db, 'ai.username', c.username.trim());
  if (c.model !== undefined) setSetting(db, 'ai.model', c.model.trim());
  if (c.size !== undefined) setSetting(db, 'ai.size', c.size.trim());
  if (c.workflow !== undefined) setSetting(db, 'ai.workflow', c.workflow.trim());
}

/** Whether enough is filled in to try a generation. */
export function aiConfigured(c: AiConfig): boolean {
  return imageProviders.find((p) => p.id === c.provider)?.configured(c) ?? false;
}
