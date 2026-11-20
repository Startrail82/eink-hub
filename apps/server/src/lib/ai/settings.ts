import { getSetting, setSetting, type DB } from '../../db/index.js';

export const aiProviders = ['openai', 'comfyui'] as const;
export type AiProviderKind = (typeof aiProviders)[number];

/** The hub-wide connection to the image generator (Settings > AI images). */
export interface AiConfig {
  provider: AiProviderKind | '';
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

export const OPENAI_DEFAULT_URL = 'https://api.openai.com/v1';

export function aiConfig(db: DB): AiConfig {
  const provider = getSetting(db, 'ai.provider');
  return {
    provider: (aiProviders as readonly string[]).includes(provider ?? '') ? (provider as AiProviderKind) : '',
    url: getSetting(db, 'ai.url') ?? '',
    apiKey: getSetting(db, 'ai.apiKey') ?? '',
    username: getSetting(db, 'ai.username') ?? '',
    model: getSetting(db, 'ai.model') ?? '',
    size: getSetting(db, 'ai.size') ?? '',
    workflow: getSetting(db, 'ai.workflow') ?? '',
  };
}

export function saveAiConfig(db: DB, c: Partial<AiConfig>) {
  if (c.provider !== undefined) setSetting(db, 'ai.provider', (aiProviders as readonly string[]).includes(c.provider) ? c.provider : '');
  if (c.url !== undefined) setSetting(db, 'ai.url', c.url.trim().replace(/\/+$/, ''));
  if (c.apiKey) setSetting(db, 'ai.apiKey', c.apiKey.trim());
  if (c.username !== undefined) setSetting(db, 'ai.username', c.username.trim());
  if (c.model !== undefined) setSetting(db, 'ai.model', c.model.trim());
  if (c.size !== undefined) setSetting(db, 'ai.size', c.size.trim());
  if (c.workflow !== undefined) setSetting(db, 'ai.workflow', c.workflow.trim());
}

/** Whether enough is filled in to try a generation. */
export function aiConfigured(c: AiConfig): boolean {
  if (c.provider === 'openai') return !!c.model;
  if (c.provider === 'comfyui') return !!c.url && c.workflow.includes('{{prompt}}');
  return false;
}
