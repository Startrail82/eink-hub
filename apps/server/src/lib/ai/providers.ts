import crypto from 'node:crypto';
import { OPENAI_DEFAULT_URL, type AiConfig } from './settings.js';

export interface GenerateOpts {
  /** The frame's shape, used to pick a fitting size. */
  width: number;
  height: number;
  /** Give up after this long. */
  timeoutMs?: number;
}

export class AiError extends Error {}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

/** Ask the configured provider for one image and return its bytes. */
export async function generateImage(cfg: AiConfig, prompt: string, opts: GenerateOpts): Promise<Buffer> {
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (cfg.provider === 'openai') return openaiImage(cfg, prompt, opts, timeout);
  if (cfg.provider === 'comfyui') return comfyImage(cfg, prompt, opts, timeout);
  throw new AiError('No AI provider is configured');
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

async function openaiImage(cfg: AiConfig, prompt: string, opts: GenerateOpts, timeout: number): Promise<Buffer> {
  const base = (cfg.url || OPENAI_DEFAULT_URL).replace(/\/+$/, '');
  const res = await http(
    `${base}/images/generations`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
      body: JSON.stringify({ model: cfg.model, prompt, n: 1, size: cfg.size || openaiSize(opts.width, opts.height) }),
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
  const workflow = fillWorkflow(cfg.workflow, prompt, opts);
  const queued = await http(`${base}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: workflow, client_id: crypto.randomUUID() }) }, left());
  const promptId = ((await queued.json().catch(() => null)) as { prompt_id?: string } | null)?.prompt_id;
  if (!promptId) throw new AiError('ComfyUI did not accept the workflow');

  for (;;) {
    if (Date.now() - started > timeout) throw new AiError('ComfyUI took too long');
    await new Promise((r) => setTimeout(r, 1000));
    const history = (await (await http(`${base}/history/${promptId}`, {}, left())).json().catch(() => ({}))) as ComfyHistory;
    const entry = history[promptId];
    if (!entry) continue;
    if (entry.status?.status_str === 'error') throw new AiError('ComfyUI reported an error while running the workflow');
    const image = Object.values(entry.outputs ?? {}).flatMap((o) => o.images ?? [])[0];
    if (!image) {
      if (entry.status?.completed) throw new AiError('The ComfyUI workflow finished without producing an image');
      continue;
    }
    const q = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder ?? '', type: image.type ?? 'output' });
    return Buffer.from(await (await http(`${base}/view?${q}`, {}, left())).arrayBuffer());
  }
}

// --- Connection test (costs nothing: no image is generated) -------------------------------

/** Check the address and key. Returns a short description of what answered. */
export async function testConnection(cfg: AiConfig): Promise<string> {
  if (cfg.provider === 'openai') {
    const base = (cfg.url || OPENAI_DEFAULT_URL).replace(/\/+$/, '');
    await http(`${base}/models`, { headers: cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {} }, 15_000);
    return new URL(base).host;
  }
  if (cfg.provider === 'comfyui') {
    if (!cfg.url) throw new AiError('The ComfyUI address is empty');
    await http(`${cfg.url.replace(/\/+$/, '')}/system_stats`, {}, 15_000);
    if (cfg.workflow) fillWorkflow(cfg.workflow, 'test', { width: 512, height: 512 });
    return new URL(cfg.url).host;
  }
  throw new AiError('No AI provider is configured');
}
