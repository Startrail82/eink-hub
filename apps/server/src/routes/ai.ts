import type { FastifyInstance } from 'fastify';
import { setSetting } from '../db/index.js';
import type { Ctx } from '../lib/context.js';
import { AiError, testConnection } from '../lib/ai/providers.js';
import { aiConfig, aiConfigured, aiProviders, saveAiConfig, type AiConfig } from '../lib/ai/settings.js';

/** Hub-wide connection to the AI image generator. The key is never sent back, only whether one is set. */
export function aiRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  app.get('/api/settings/ai', async () => {
    const { apiKey, ...c } = aiConfig(db);
    return { ...c, apiKeySet: !!apiKey, configured: aiConfigured(aiConfig(db)) };
  });

  app.put<{ Body: Partial<AiConfig> }>('/api/settings/ai', async (req) => {
    const b = req.body ?? {};
    if (b.provider !== undefined && b.provider !== '' && !(aiProviders as readonly string[]).includes(b.provider)) return { ok: false };
    saveAiConfig(db, b);
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
    const cfg: AiConfig = { ...saved, ...b, apiKey: b.apiKey || saved.apiKey };
    try {
      return { ok: true, server: await testConnection(cfg) };
    } catch (err) {
      return { ok: false, error: err instanceof AiError ? err.message : (err as Error).message };
    }
  });
}
