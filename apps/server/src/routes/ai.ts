import type { FastifyInstance } from 'fastify';
import { setSetting } from '../db/index.js';
import { HttpError, type Ctx } from '../lib/context.js';
import { aiProviderIds, AiError, imageProviders, testConnection } from '../lib/ai/providers.js';
import { aiConfig, aiConfigured, clearAiConfig, saveAiConfig, type AiConfig } from '../lib/ai/settings.js';

/** Hub-wide connection to the AI image generator. The key is never sent back, only whether one is set. */
export function aiRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  app.get('/api/settings/ai', async () => {
    const { apiKey, ...c } = aiConfig(db);
    // The providers say which fields Settings has to show for each.
    const providers = imageProviders.map(({ id, label, labelKey, fields, defaultModel, listsModels }) => ({ id, label, labelKey, fields, defaultModel, listsModels: !!listsModels }));
    return { ...c, apiKeySet: !!apiKey, configured: aiConfigured(aiConfig(db)), providers };
  });

  app.put<{ Body: Partial<AiConfig> }>('/api/settings/ai', async (req) => {
    const b = req.body ?? {};
    if (b.provider !== undefined && b.provider !== '' && !aiProviderIds().includes(b.provider)) throw new HttpError(400, 'ai_provider_unknown', { provider: String(b.provider) });
    saveAiConfig(db, b);
    return { ok: true };
  });

  /** Remove the whole configuration (the "Remove configuration" button). */
  app.delete('/api/settings/ai', async () => {
    clearAiConfig(db);
    return { ok: true };
  });

  /** Forget the key, e.g. when switching to a server that needs none. */
  app.delete('/api/settings/ai/key', async () => {
    setSetting(db, 'ai.apiKey', '');
    return { ok: true };
  });

  app.post<{ Body: Partial<AiConfig> }>('/api/settings/ai/test', async (req) => {
    const saved = aiConfig(db);
    const b = req.body ?? {};
    // The saved key is only used for the address and service it was saved for, so testing
    // another address can never send it to a new host.
    const sameHost = (b.url === undefined || b.url.trim().replace(/\/+$/, '') === saved.url) && (b.provider === undefined || b.provider === saved.provider);
    const cfg: AiConfig = { ...saved, ...b, apiKey: b.apiKey || (sameHost ? saved.apiKey : '') };
    try {
      return { ok: true, ...(await testConnection(cfg)) };
    } catch (err) {
      return { ok: false, error: err instanceof AiError ? err.message : (err as Error).message };
    }
  });

  /** The image models of the saved service, for the model field (empty when it can't list them). */
  app.get('/api/settings/ai/models', async () => {
    const cfg = aiConfig(db);
    if (!imageProviders.find((p) => p.id === cfg.provider)?.listsModels || !aiConfigured(cfg)) return { models: [] };
    try {
      return { models: (await testConnection(cfg)).models ?? [] };
    } catch {
      return { models: [] };
    }
  });
}
