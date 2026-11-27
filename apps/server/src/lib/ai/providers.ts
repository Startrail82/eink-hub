import crypto from 'node:crypto';
import type { AiConfig } from './settings.js';

export const OPENAI_DEFAULT_URL = 'https://api.openai.com/v1';
/** Google's OpenAI-compatible endpoint for the Gemini API. */
export const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';

export interface GenerateOpts {
  /** The frame's shape, used to pick a fitting size. */
  width: number;
  height: number;
  /** Give up after this long. */
  timeoutMs?: number;
}

export class AiError extends Error {}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

/** A settings field a provider needs; the Settings page draws it from this. */
export interface ProviderField {
  /** Which AiConfig value the field edits. */
  key: 'url' | 'apiKey' | 'username' | 'model' | 'size' | 'workflow';
  type: 'text' | 'password' | 'textarea';
  /** Translation key of the label, or `text` for a name that is the same in every language. */
  label?: string;
  text?: string;
  /** Translation key of the explanation. */
  hint?: string;
  placeholder?: string;
  /** Shown under "Advanced options", for settings most people leave alone. */
  advanced?: boolean;
}

/** What a connection test found. */
export interface TestResult {
  /** A short description of what answered, usually the host. */
  server: string;
  /** The image models the service offers, when it can list them. */
  models?: string[];
}

/**
 * An image generator. To add one, write an ImageProvider and list it in `imageProviders`; the
 * Settings page, the connection test and the generation all work from this description. See
 * "Adding an image provider" in the AI images guide.
 */
export interface ImageProvider {
  /** Stable identifier, saved in the settings. */
  id: string;
  /** Name shown in Settings: a translation key in `labelKey`, or `label` when the name is the same in every language. */
  label: string;
  labelKey?: string;
  fields: ProviderField[];
  /** Model used when none is filled in, and put in the field when the provider is chosen. */
  defaultModel?: string;
  /** Whether `test` lists the models, so Settings can offer them. */
  listsModels?: boolean;
  /** Whether enough is filled in to try a generation. */
  configured(cfg: AiConfig): boolean;
  /** Draw one picture and return its bytes. Throw an AiError with a readable message when it fails. */
  generate(cfg: AiConfig, prompt: string, opts: GenerateOpts, timeout: number): Promise<Buffer>;
  /** Check the address and key without generating anything; say what answered and, if it can, list the image models. */
  test(cfg: AiConfig): Promise<TestResult>;
}

/** Ask the configured provider for one image and return its bytes. */
export async function generateImage(cfg: AiConfig, prompt: string, opts: GenerateOpts): Promise<Buffer> {
  const provider = imageProviders.find((p) => p.id === cfg.provider);
  if (!provider) throw new AiError('No AI provider is configured');
  return provider.generate(cfg, prompt, opts, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
}

/** ComfyUI has no login of its own; behind a proxy that asks for one, sign in with HTTP Basic. */
function comfyHeaders(cfg: AiConfig): Record<string, string> {
  return cfg.username ? { authorization: `Basic ${Buffer.from(`${cfg.username}:${cfg.apiKey}`).toString('base64')}` } : {};
}

async function http(url: string, init: RequestInit, timeout: number): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
  } catch (err) {
    const e = err as Error;
    throw new AiError(e.name === 'TimeoutError' ? `${new URL(url).host} did not answer in time` : `${new URL(url).host}: ${(e.cause as Error | undefined)?.message ?? e.message}`);
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 300);
    throw new AiError(`${new URL(url).host} answered ${res.status}${body ? `: ${body}` : ''}`);
  }
  return res;
}

// --- OpenAI-compatible (/v1/images/generations) -------------------------------------------

/** One of the sizes the OpenAI image models accept, closest to the frame's shape. */
export function openaiSize(width: number, height: number): string {
  const ratio = width / height;
  if (ratio > 1.15) return '1536x1024';
  if (ratio < 0.87) return '1024x1536';
  return '1024x1024';
}

/** Some services reject `size`: "none" in the settings leaves it out. */
function openaiSizeField(cfg: AiConfig, opts: GenerateOpts): { size?: string } {
  if (cfg.size.toLowerCase() === 'none') return {};
  return { size: cfg.size || openaiSize(opts.width, opts.height) };
}

const bearer = (cfg: AiConfig): Record<string, string> => (cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {});

async function openaiImage(base: string, cfg: AiConfig, prompt: string, opts: GenerateOpts, timeout: number): Promise<Buffer> {
  const res = await http(
    `${base}/images/generations`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearer(cfg) },
      body: JSON.stringify({ model: cfg.model, prompt, n: 1, ...openaiSizeField(cfg, opts) }),
    },
    timeout,
  );
  const json = (await res.json().catch(() => null)) as { data?: { b64_json?: string; url?: string }[] } | null;
  const item = json?.data?.[0];
  if (item?.b64_json) return Buffer.from(item.b64_json, 'base64');
  if (item?.url) return Buffer.from(await (await http(item.url, {}, timeout)).arrayBuffer());
  throw new AiError('The image service answered without an image');
}

// --- ComfyUI (POST /prompt, poll /history, GET /view) -------------------------------------

/**
 * Fill in a workflow (API format): "{{prompt}}" inside any text, and a value that is exactly
 * "{{seed}}", "{{width}}" or "{{height}}" becomes a number.
 */
export function fillWorkflow(workflow: string, prompt: string, opts: GenerateOpts, seed = crypto.randomInt(0, 2 ** 32)): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(workflow);
  } catch {
    throw new AiError('The ComfyUI workflow is not valid JSON');
  }
  const numbers: Record<string, number> = { '{{seed}}': seed, '{{width}}': opts.width, '{{height}}': opts.height };
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return v in numbers ? numbers[v] : v.replaceAll('{{prompt}}', prompt);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(parsed);
}

interface ComfyHistory {
  [promptId: string]: {
    status?: { status_str?: string; completed?: boolean };
    outputs?: Record<string, { images?: { filename: string; subfolder?: string; type?: string }[] }>;
  };
}

async function comfyImage(cfg: AiConfig, prompt: string, opts: GenerateOpts, timeout: number): Promise<Buffer> {
  const base = cfg.url.replace(/\/+$/, '');
  const started = Date.now();
  const left = () => Math.max(1000, timeout - (Date.now() - started));
  const auth = comfyHeaders(cfg);
  const workflow = fillWorkflow(cfg.workflow, prompt, opts);
  const queued = await http(`${base}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ prompt: workflow, client_id: crypto.randomUUID() }) }, left());
  const promptId = ((await queued.json().catch(() => null)) as { prompt_id?: string } | null)?.prompt_id;
  if (!promptId) throw new AiError('ComfyUI did not accept the workflow');

  for (;;) {
    if (Date.now() - started > timeout) throw new AiError('ComfyUI took too long');
    await new Promise((r) => setTimeout(r, 1000));
    const history = (await (await http(`${base}/history/${promptId}`, { headers: auth }, left())).json().catch(() => ({}))) as ComfyHistory;
    const entry = history[promptId];
    if (!entry) continue;
    if (entry.status?.status_str === 'error') throw new AiError('ComfyUI reported an error while running the workflow');
    const image = Object.values(entry.outputs ?? {}).flatMap((o) => o.images ?? [])[0];
    if (!image) {
      if (entry.status?.completed) throw new AiError('The ComfyUI workflow finished without producing an image');
      continue;
    }
    const q = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder ?? '', type: image.type ?? 'output' });
    return Buffer.from(await (await http(`${base}/view?${q}`, { headers: auth }, left())).arrayBuffer());
  }
}

// --- The providers --------------------------------------------------------------------------

/**
 * GET {base}/models: checks the address and key, and lists the models whose id passes `isImage`
 * (Gemini may prefix ids with "models/").
 */
async function listModels(base: string, cfg: AiConfig, isImage: (id: string) => boolean): Promise<TestResult> {
  const res = await http(`${base}/models`, { headers: bearer(cfg) }, 15_000);
  const json = (await res.json().catch(() => null)) as { data?: { id?: unknown }[] } | null;
  const ids = (json?.data ?? []).map((m) => String(m.id ?? '').replace(/^models\//, '')).filter(Boolean);
  return { server: new URL(base).host, models: [...new Set(ids.filter(isImage))].sort() };
}

/** A service that speaks the OpenAI images API. `base` is null when the address is a setting. */
function openaiLike(p: {
  id: string;
  label: string;
  labelKey?: string;
  base: string | null;
  keyHint?: string;
  defaultModel?: string;
  isImage: (id: string) => boolean;
}): ImageProvider {
  const base = (cfg: AiConfig) => (p.base ?? cfg.url).replace(/\/+$/, '');
  const fields: ProviderField[] = [
    ...(p.base ? [] : [{ key: 'url', type: 'text', label: 'ai.url', hint: 'ai.url_hint_openai', placeholder: 'http://192.168.1.30:8080/v1' } satisfies ProviderField]),
    { key: 'apiKey', type: 'password', text: 'API key', hint: p.keyHint },
    { key: 'model', type: 'text', label: 'ai.model', hint: 'ai.model_hint', placeholder: p.defaultModel },
    { key: 'size', type: 'text', label: 'ai.size', hint: 'ai.size_hint', placeholder: '1024x1536', advanced: true },
  ];
  return {
    id: p.id,
    label: p.label,
    labelKey: p.labelKey,
    defaultModel: p.defaultModel,
    listsModels: true,
    fields,
    // A hosted service needs a key; a self-hosted one needs its address and a model.
    configured: (cfg) => (p.base ? !!cfg.apiKey : !!cfg.url && !!cfg.model),
    generate: (cfg, prompt, opts, timeout) => openaiImage(base(cfg), { ...cfg, model: cfg.model || p.defaultModel || '' }, prompt, opts, timeout),
    async test(cfg) {
      if (!base(cfg)) throw new AiError('The address is empty');
      return listModels(base(cfg), cfg, p.isImage);
    },
  };
}

/** Google's Gemini API, through its OpenAI-compatible endpoint. */
const gemini = openaiLike({
  id: 'gemini',
  label: 'Google Gemini',
  base: GEMINI_URL,
  keyHint: 'ai.key_hint_gemini',
  defaultModel: 'gemini-2.5-flash-image',
  isImage: (id) => /^gemini-.*image|^imagen|nano-banana/i.test(id),
});

const openai = openaiLike({
  id: 'openai',
  label: 'OpenAI',
  base: OPENAI_DEFAULT_URL,
  keyHint: 'ai.key_hint_openai',
  defaultModel: 'gpt-image-1',
  isImage: (id) => /^(gpt-image|dall-e)/i.test(id),
});

/** Anything else that implements POST /v1/images/generations (LocalAI, xAI, a proxy...). */
const openaiCompatible = openaiLike({
  id: 'openai_compatible',
  label: 'OpenAI-compatible',
  labelKey: 'ai.provider_compatible',
  base: null,
  isImage: () => true,
});

const comfyui: ImageProvider = {
  id: 'comfyui',
  label: 'ComfyUI',
  labelKey: 'ai.provider_comfyui',
  fields: [
    { key: 'url', type: 'text', label: 'ai.url', hint: 'ai.url_hint_comfyui', placeholder: 'http://192.168.1.30:8188' },
    { key: 'username', type: 'text', label: 'login.username', hint: 'ai.auth_hint' },
    { key: 'apiKey', type: 'password', label: 'login.password' },
    { key: 'workflow', type: 'textarea', label: 'ai.workflow', hint: 'ai.workflow_hint', placeholder: '{"6": {"class_type": "CLIPTextEncode", "inputs": {"text": "{{prompt}}"}}}' },
  ],
  configured: (cfg) => !!cfg.url && cfg.workflow.includes('{{prompt}}'),
  generate: comfyImage,
  async test(cfg) {
    if (!cfg.url) throw new AiError('The ComfyUI address is empty');
    await http(`${cfg.url.replace(/\/+$/, '')}/system_stats`, { headers: comfyHeaders(cfg) }, 15_000);
    if (cfg.workflow) fillWorkflow(cfg.workflow, 'test', { width: 512, height: 512 });
    return { server: new URL(cfg.url).host };
  },
};

/** Every image generator the hub knows. */
export const imageProviders: ImageProvider[] = [gemini, openai, comfyui, openaiCompatible];

export const aiProviderIds = (): string[] => imageProviders.map((p) => p.id);

/** Check the address and key: what answered and, when the service lists them, its image models. */
export async function testConnection(cfg: AiConfig): Promise<TestResult> {
  const provider = imageProviders.find((p) => p.id === cfg.provider);
  if (!provider) throw new AiError('No AI provider is configured');
  return provider.test(cfg);
}
