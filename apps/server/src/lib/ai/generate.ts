import { and, eq } from 'drizzle-orm';
import { getSetting, schema, setSetting, type DB } from '../../db/index.js';
import type { Collection, Frame } from '../../db/schema.js';
import { addItems, refreshCount } from '../collections.js';
import type { Ctx } from '../context.js';
import { deleteImage, saveLocalUpload } from '../images.js';
import { AiError, generateImage } from './providers.js';
import { aiConfig, aiConfigured } from './settings.js';
import { commonVars, fetchFeed, fillTemplate, nextFeedItem, type PromptVars } from './sources.js';

export const aiSources = ['prompt', 'rss'] as const;
export type AiSource = (typeof aiSources)[number];

/** Per-collection settings, kept in the collection's config. */
export interface AiCollectionConfig {
  source: AiSource;
  /** Prompt text; {title}, {description}, {date}, {time}, {season} are filled in. Empty = a default. */
  prompt: string;
  /** ComfyUI only: what the picture should not look like; fills "{{negative}}" in the workflow. */
  negative: string;
  feedUrl: string;
  /** How many generated pictures to keep; 0 = keep them all. */
  keep: number;
  /** Panel resolution to generate for, "shortxlong" (e.g. "1200x1600"). Null = follow the first frame showing the collection. */
  panel: string | null;
  orientation: 'portrait' | 'landscape';
}

export const DEFAULT_KEEP = 20;

export const DEFAULT_PROMPTS: Record<Exclude<AiSource, 'prompt'>, string> = {
  rss: 'A witty, friendly editorial cartoon about this news headline: "{title}". {description} Clean line art with a few flat colours, no text or lettering.',
};

export function collectionConfig(c: Collection): AiCollectionConfig {
  const raw = c.config as Partial<AiCollectionConfig>;
  const keep = Number(raw.keep);
  return {
    source: (aiSources as readonly string[]).includes(raw.source ?? '') ? (raw.source as AiSource) : 'prompt',
    prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
    negative: typeof raw.negative === 'string' ? raw.negative.trim() : '',
    feedUrl: typeof raw.feedUrl === 'string' ? raw.feedUrl.trim() : '',
    keep: Number.isInteger(keep) && keep >= 0 ? keep : DEFAULT_KEEP,
    panel: typeof raw.panel === 'string' && /^\d{2,5}x\d{2,5}$/.test(raw.panel) ? raw.panel : null,
    orientation: raw.orientation === 'landscape' ? 'landscape' : 'portrait',
  };
}

/** The panel and orientation to generate for: the collection's own choice, else the first frame showing it. */
export function sizeFor(cfg: AiCollectionConfig, frame: Pick<Frame, 'width' | 'height' | 'orientation'> | undefined) {
  if (!cfg.panel) return targetSize(frame);
  const [short, long] = cfg.panel.split('x').map(Number);
  return targetSize({ width: short, height: long, orientation: cfg.orientation });
}

/** What a generation needs from the collection's own settings; throws a readable error when incomplete. */
export function validateCollectionConfig(cfg: AiCollectionConfig) {
  if (cfg.source === 'prompt' && !cfg.prompt.trim()) throw new AiError('A prompt is required');
  if (cfg.source === 'rss' && !/^https?:\/\//i.test(cfg.feedUrl)) throw new AiError('A feed address (http or https) is required');
}

// --- Per-collection state that must survive edits of the config ---------------------------

interface AiState {
  /** Feed items already illustrated (newest last), capped. */
  seen: string[];
  lastGenerated: number | null;
}

const stateKey = (id: number) => `ai.state.${id}`;

export function aiState(db: DB, id: number): AiState {
  try {
    const s = JSON.parse(getSetting(db, stateKey(id)) ?? '{}') as Partial<AiState>;
    return { seen: Array.isArray(s.seen) ? s.seen.map(String) : [], lastGenerated: typeof s.lastGenerated === 'number' ? s.lastGenerated : null };
  } catch {
    return { seen: [], lastGenerated: null };
  }
}

function saveState(db: DB, id: number, s: AiState) {
  setSetting(db, stateKey(id), JSON.stringify({ ...s, seen: s.seen.slice(-200) }));
}

export function forgetState(db: DB, id: number) {
  db.delete(schema.settings).where(eq(schema.settings.key, stateKey(id))).run();
}

// --- Prompt ---------------------------------------------------------------------------------

/** The prompt for the next picture, plus the feed item it is about (to remember it afterwards). */
export async function buildPrompt(cfg: AiCollectionConfig, seen: string[]): Promise<{ prompt: string; itemId?: string }> {
  const vars: PromptVars = commonVars();
  if (cfg.source === 'prompt') return { prompt: fillTemplate(cfg.prompt, vars) };
  const template = cfg.prompt.trim() || DEFAULT_PROMPTS[cfg.source];
  const items = await fetchFeed(cfg.feedUrl);
  // Everything illustrated already? Start over with the newest rather than showing nothing new.
  const item = nextFeedItem(items, seen) ?? items[0];
  return { prompt: fillTemplate(template, { ...vars, title: item.title, description: item.description }), itemId: item.id };
}

// --- Generation -----------------------------------------------------------------------------

/** Longest side to generate: about 1 megapixel at a 3:4 shape, which is what SDXL-class models are trained on. */
const MAX_SIDE = 1216;

/** The size to ask for: the frame's shape, longest side capped, multiples of 8 (what diffusion models like). */
export function targetSize(frame: Pick<Frame, 'width' | 'height' | 'orientation'> | undefined, cap = MAX_SIDE): { width: number; height: number } {
  const w = frame?.width ?? 1200;
  const h = frame?.height ?? 1600;
  const [long, short] = [Math.max(w, h), Math.min(w, h)];
  const scale = Math.min(1, cap / long);
  const round = (n: number) => Math.max(64, Math.round((n * scale) / 8) * 8);
  return frame?.orientation === 'landscape' ? { width: round(long), height: round(short) } : { width: round(short), height: round(long) };
}

const running = new Set<number>();

export function isGenerating(collectionId: number) {
  return running.has(collectionId);
}

function setStatus(db: DB, id: number, error: string | null) {
  db.update(schema.collections)
    .set(error === null ? { lastSync: Date.now(), syncError: null } : { syncError: error })
    .where(eq(schema.collections.id, id))
    .run();
}

/** The frames showing this collection, used to size the picture. */
function framesOf(db: DB, collectionId: number): Frame[] {
  return db
    .select({ frame: schema.frames })
    .from(schema.assignments)
    .innerJoin(schema.frames, eq(schema.frames.id, schema.assignments.frameId))
    .where(eq(schema.assignments.collectionId, collectionId))
    .all()
    .map((r) => r.frame);
}

/**
 * Make one new picture for an AI collection. Never throws: a failure is stored on the
 * collection (shown in the UI) so the next attempt can simply try again.
 */
export async function generateFor(ctx: Ctx, collectionId: number): Promise<boolean> {
  if (running.has(collectionId)) return false;
  running.add(collectionId);
  try {
    const c = ctx.db.select().from(schema.collections).where(eq(schema.collections.id, collectionId)).get();
    if (!c || c.type !== 'ai') return false;
    const provider = aiConfig(ctx.db);
    if (!aiConfigured(provider)) throw new AiError('No AI image service is set up yet (Settings > AI images)');
    const cfg = collectionConfig(c);
    validateCollectionConfig(cfg);
    const state = aiState(ctx.db, c.id);
    const { prompt, itemId } = await buildPrompt(cfg, state.seen);
    const buf = await generateImage(provider, prompt, { ...sizeFor(cfg, framesOf(ctx.db, c.id)[0]), negative: cfg.negative });
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    const img = await saveLocalUpload(ctx.db, buf, `ai-${c.id}-${stamp}.png`);
    addItems(ctx.db, c.id, [img.id]);
    saveState(ctx.db, c.id, { seen: itemId ? [...state.seen, itemId] : state.seen, lastGenerated: Date.now() });
    setStatus(ctx.db, c.id, null);
    ctx.log.info({ collection: c.id, image: img.id, prompt }, 'AI picture generated');
    await prune(ctx.db, c.id, cfg.keep);
    return true;
  } catch (err) {
    const message = err instanceof AiError ? err.message : (err as Error).message;
    ctx.log.warn({ err, collection: collectionId }, 'AI generation failed');
    setStatus(ctx.db, collectionId, message);
    return false;
  } finally {
    running.delete(collectionId);
  }
}

/**
 * Drop the oldest pictures beyond `keep` from the collection, never one that is on a frame (or queued
 * for it). A picture that is also in another collection stays there.
 */
export async function prune(db: DB, collectionId: number, keep: number) {
  if (keep <= 0) return;
  const members = db
    .select({ img: schema.images })
    .from(schema.collectionItems)
    .innerJoin(schema.images, eq(schema.images.id, schema.collectionItems.imageId))
    .where(eq(schema.collectionItems.collectionId, collectionId))
    .all()
    .map((r) => r.img)
    .sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
  const onScreen = new Set(
    db
      .select({ a: schema.frames.currentImageId, b: schema.frames.pendingImageId })
      .from(schema.frames)
      .all()
      .flatMap((f) => [f.a, f.b])
      .filter((n): n is number => n != null),
  );
  for (const img of members.slice(keep)) {
    if (onScreen.has(img.id)) continue;
    // Only leave this collection; the picture itself goes when no other collection holds it
    // (someone may have added a favourite to a manual collection).
    db.delete(schema.collectionItems).where(and(eq(schema.collectionItems.collectionId, collectionId), eq(schema.collectionItems.imageId, img.id))).run();
    const elsewhere = db.select().from(schema.collectionItems).where(eq(schema.collectionItems.imageId, img.id)).get();
    if (!elsewhere) await deleteImage(db, img);
  }
  refreshCount(db, collectionId);
}

// --- Ahead of the frame ---------------------------------------------------------------------

/** Start generating this long before a frame is due to change; a pull frame wakes right on time. */
export const LEAD_MS = 10 * 60_000;
/** After a failure, wait this long before trying again. */
export const RETRY_MS = 5 * 60_000;

/**
 * Whether a new picture should be made now: a frame using the collection changes within the lead
 * time and no picture has been made since the lead window opened.
 */
export function generationDue(
  nextChanges: (number | null)[],
  lastGenerated: number | null,
  lastFailed: number | null,
  now: number,
): boolean {
  const upcoming = nextChanges.filter((n): n is number => n != null && n - LEAD_MS <= now);
  if (!upcoming.length) return false;
  if (lastFailed !== null && now - lastFailed < RETRY_MS) return false;
  const opened = Math.min(...upcoming) - LEAD_MS;
  return lastGenerated === null || lastGenerated < opened;
}

const failedAt = new Map<number, number>();

/** Called every minute by the scheduler: make the picture for each AI collection that needs one. */
export async function pregenerate(ctx: Ctx, now = Date.now()) {
  const cols = ctx.db.select().from(schema.collections).where(eq(schema.collections.type, 'ai')).all();
  for (const c of cols) {
    const nexts = ctx.db
      .select({ n: schema.assignments.nextChange })
      .from(schema.assignments)
      .where(and(eq(schema.assignments.collectionId, c.id), eq(schema.assignments.enabled, true)))
      .all()
      .map((r) => r.n);
    if (!generationDue(nexts, aiState(ctx.db, c.id).lastGenerated, failedAt.get(c.id) ?? null, now)) continue;
    if (await generateFor(ctx, c.id)) failedAt.delete(c.id);
    else failedAt.set(c.id, now);
  }
}
