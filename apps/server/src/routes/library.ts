import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { requestLang, tr, type Lang } from '../i18n.js';
import { schema } from '../db/index.js';
import { collectionTypes, fitModes, locationModes, orderModes, type Assignment, type CollectionType, type DisplayOptions } from '../db/schema.js';
import { addItems, getCollection, refreshCount, syncCollection } from '../lib/collections.js';
import { HttpError, type Ctx } from '../lib/context.js';
import { getAssignment, getAssignmentById, getAssignments, getFrame } from '../lib/display.js';
import { checkSchedule, overview } from '../lib/plan.js';
import { DEFAULT_SCHEDULE, MEMORIES_SCHEDULE, firstRun, isFrequent, parseSchedule, upcoming } from '../lib/schedule.js';
import { deleteImage, frameAspect, getCrop, getImage, imageThumbnail, loadSource, readRender, renderFor, saveLocalUpload, setCrop } from '../lib/images.js';
import { formatMime, thumbnail } from '../imaging/pipeline.js';
import { renderTarget } from '../device/drivers/index.js';

export function libraryRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  // --- Images -----------------------------------------------------------------------------
  app.get<{ Querystring: { collectionId?: string; source?: 'local' | 'immich'; offset?: string; limit?: string } }>(
    '/api/images',
    async (req) => {
      const limit = Math.min(Number(req.query.limit ?? 120), 500);
      const offset = Number(req.query.offset ?? 0);
      const filters = [];
      if (req.query.source) filters.push(eq(schema.images.source, req.query.source));
      if (req.query.collectionId) {
        filters.push(
          inArray(
            schema.images.id,
            db
              .select({ id: schema.collectionItems.imageId })
              .from(schema.collectionItems)
              .where(eq(schema.collectionItems.collectionId, +req.query.collectionId)),
          ),
        );
      }
      const where = filters.length ? and(...filters) : undefined;
      const items = db.select().from(schema.images).where(where).orderBy(desc(schema.images.createdAt), desc(schema.images.id)).limit(limit).offset(offset).all();
      const total = db.select({ n: sql<number>`count(*)` }).from(schema.images).where(where).get()?.n ?? 0;
      return { items, total };
    },
  );

  app.post('/api/images', async (req) => {
    const created = [];
    for await (const part of req.files({ limits: { fileSize: 80 * 1024 * 1024 } })) {
      created.push(await saveLocalUpload(db, await part.toBuffer(), part.filename));
    }
    const collectionId = Number((req.query as Record<string, string>).collectionId);
    if (collectionId) addItems(db, collectionId, created.map((i) => i.id));
    return created;
  });

  app.delete<{ Params: { id: string } }>('/api/images/:id', async (req) => {
    const img = getImage(db, +req.params.id);
    const ids = db.select({ c: schema.collectionItems.collectionId }).from(schema.collectionItems).where(eq(schema.collectionItems.imageId, img.id)).all();
    await deleteImage(db, img);
    for (const { c } of ids) refreshCount(db, c);
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/api/images/:id/thumb', async (req, reply) => {
    const buf = await imageThumbnail(ctx, getImage(db, +req.params.id));
    return reply.header('content-type', 'image/jpeg').header('cache-control', 'private, max-age=604800').send(buf);
  });

  /** Large preview (≤1600px) used by the crop editor. */
  app.get<{ Params: { id: string } }>('/api/images/:id/preview', async (req, reply) => {
    const buf = await thumbnail(await loadSource(ctx, getImage(db, +req.params.id)), 1600);
    return reply.header('content-type', 'image/jpeg').header('cache-control', 'private, max-age=86400').send(buf);
  });

  app.get<{ Params: { id: string }; Querystring: { frameId: string } }>('/api/images/:id/crop', async (req) => {
    const frame = getFrame(db, +req.query.frameId);
    return { aspect: frameAspect(frame), crop: getCrop(db, +req.params.id, frameAspect(frame)) };
  });
  app.put<{ Params: { id: string }; Body: { frameId: number; crop: { x: number; y: number; w: number; h: number } | null } }>(
    '/api/images/:id/crop',
    async (req) => {
      const frame = getFrame(db, req.body.frameId);
      setCrop(db, getImage(db, +req.params.id).id, frameAspect(frame), req.body.crop);
      return { ok: true };
    },
  );

  /** Exactly what the frame would receive. */
  app.post<{ Body: { imageId: number; frameId: number } & DisplayOptions }>('/api/render/preview', async (req, reply) => {
    const { imageId, frameId, ...opts } = req.body;
    const frame = getFrame(db, frameId);
    const r = await renderFor(ctx, getImage(db, imageId), frame, opts);
    // Landscape renders for portrait-buffer panels are stored rotated; rotate back so the UI shows it as hung.
    if (frame.orientation === 'landscape' && renderTarget(frame).rotateBuffer) {
      return reply.header('content-type', 'image/jpeg').send(await sharp(r.buf).rotate(360 - frame.rotate).jpeg().toBuffer());
    }
    return reply.header('content-type', formatMime(r.ext)).send(r.buf);
  });
  app.get<{ Params: { hash: string } }>('/api/renders/:hash', async (req, reply) => {
    if (!/^[a-f0-9]{40}$/.test(req.params.hash)) throw new HttpError(400, 'bad_hash');
    const r = await readRender(req.params.hash);
    if (!r) throw new HttpError(404, 'render_not_found');
    return reply.header('content-type', formatMime(r.ext)).header('cache-control', 'private, max-age=604800').send(r.buf);
  });

  // --- Collections ------------------------------------------------------------------------
  app.get('/api/collections', async () => {
    const cols = db.select().from(schema.collections).orderBy(schema.collections.name).all();
    const covers = db
      .select({ collectionId: schema.collectionItems.collectionId, imageId: sql<number>`MIN(${schema.collectionItems.imageId})` })
      .from(schema.collectionItems)
      .groupBy(schema.collectionItems.collectionId)
      .all();
    const coverOf = new Map(covers.map((c) => [c.collectionId, c.imageId]));
    return cols.map((c) => ({ ...c, coverImageId: coverOf.get(c.id) ?? null }));
  });

  app.post<{ Body: { name: string; type: CollectionType; config?: Record<string, unknown>; imageIds?: number[] } }>(
    '/api/collections',
    async (req) => {
      const { name, type, config = {}, imageIds = [] } = req.body ?? ({} as never);
      if (!name?.trim()) throw new HttpError(400, 'name_missing');
      if (!collectionTypes.includes(type)) throw new HttpError(400, 'collection_type_invalid');
      const col = db.insert(schema.collections).values({ name: name.trim(), type, config, createdAt: Date.now() }).returning().get();
      if (imageIds.length) addItems(db, col.id, imageIds);
      return type === 'manual' ? getCollection(db, col.id) : syncCollection(ctx, col);
    },
  );

  app.patch<{ Params: { id: string }; Body: { name?: string; config?: Record<string, unknown> } }>('/api/collections/:id', async (req) => {
    const col = getCollection(db, +req.params.id);
    db.update(schema.collections)
      .set({ ...(req.body.name ? { name: req.body.name } : {}), ...(req.body.config ? { config: req.body.config } : {}) })
      .where(eq(schema.collections.id, col.id))
      .run();
    const updated = getCollection(db, col.id);
    return req.body.config && updated.type !== 'manual' ? syncCollection(ctx, updated) : updated;
  });

  app.delete<{ Params: { id: string } }>('/api/collections/:id', async (req) => {
    const id = +req.params.id;
    db.delete(schema.assignments).where(eq(schema.assignments.collectionId, id)).run();
    db.delete(schema.collectionItems).where(eq(schema.collectionItems.collectionId, id)).run();
    db.delete(schema.collections).where(eq(schema.collections.id, id)).run();
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/collections/:id/sync', async (req) => syncCollection(ctx, getCollection(db, +req.params.id)));

  app.post<{ Params: { id: string }; Body: { imageIds: number[] } }>('/api/collections/:id/items', async (req) => {
    const col = getCollection(db, +req.params.id);
    if (col.type !== 'manual') throw new HttpError(400, 'manual_only');
    addItems(db, col.id, req.body.imageIds ?? []);
    return getCollection(db, col.id);
  });
  app.delete<{ Params: { id: string }; Body: { imageIds: number[] } }>('/api/collections/:id/items', async (req) => {
    const col = getCollection(db, +req.params.id);
    db.delete(schema.collectionItems)
      .where(and(eq(schema.collectionItems.collectionId, col.id), inArray(schema.collectionItems.imageId, req.body.imageIds ?? [])))
      .run();
    refreshCount(db, col.id);
    return getCollection(db, col.id);
  });

  // --- Assignments (collection → frame rotation) -----------------------------------------
  app.get('/api/assignments', async () => db.select().from(schema.assignments).all());

  interface AssignmentBody {
    collectionId: number;
    orderMode?: (typeof orderModes)[number];
    schedule?: unknown;
    activeFrom?: string | null;
    activeTo?: string | null;
    fit?: (typeof fitModes)[number];
    bg?: string;
    showDate?: boolean;
    showLocation?: (typeof locationModes)[number];
    hideHomeCountry?: boolean;
    enabled?: boolean;
  }

  /** Create (no `prev`) or change one schedule of a Canvas. Two schedules may not change at the same minute. */
  function saveAssignment(frameId: number, prev: Assignment | undefined, b: AssignmentBody, lang: Lang) {
    const collection = getCollection(db, b.collectionId);
    // "On this day" is a daily feed: one random memory per day, changing at midnight.
    const isMemories = collection.type === 'immich_memories';
    const schedule = isMemories ? MEMORIES_SCHEDULE : b.schedule === undefined ? DEFAULT_SCHEDULE : parseSchedule(b.schedule);
    const hhmm = (v?: string | null) => (v && /^\d{2}:\d{2}$/.test(v) ? v : null);
    // Active hours only make sense for hourly schedules; longer ones already pick a time.
    const hourly = schedule.kind === 'interval';
    const window = { activeFrom: hourly ? hhmm(b.activeFrom) : null, activeTo: hourly ? hhmm(b.activeTo) : null };
    const enabled = b.enabled ?? prev?.enabled ?? true;

    const check = enabled ? checkSchedule(db, frameId, { id: prev?.id, schedule, ...window }) : {};
    if (check.clash) {
      const name = db.select({ name: schema.collections.name }).from(schema.collections).where(eq(schema.collections.id, check.clash.other.collectionId)).get()?.name ?? '';
      throw new HttpError(409, 'schedule_conflict', { name, time: new Date(check.clash.at).toLocaleString(lang, { dateStyle: 'short', timeStyle: 'short' }) });
    }

    const others = getAssignments(db, frameId).filter((x) => x.id !== prev?.id);
    // New rotation or new collection: change right away. New timing: start counting from now.
    // Anything else (fit, order…): keep the pending change time. A schedule added next to
    // others starts counting from now too, so it does not replace the picture the moment it is saved.
    const nextChange = !prev
      ? others.length
        ? (firstRun(schedule, new Date(), window)?.getTime() ?? null)
        : null
      : prev.collectionId !== b.collectionId
        ? null
        : JSON.stringify(prev.schedule) !== JSON.stringify(schedule) || prev.activeFrom !== window.activeFrom || prev.activeTo !== window.activeTo
          ? (firstRun(schedule, new Date(), window)?.getTime() ?? null)
          : prev.nextChange;
    const values = {
      collectionId: b.collectionId,
      orderMode: isMemories ? ('random' as const) : orderModes.includes(b.orderMode!) ? b.orderMode! : ('random' as const),
      schedule,
      nextChange,
      ...window,
      fit: fitModes.includes(b.fit!) ? b.fit! : ('cover' as const),
      bg: /^#[0-9a-f]{6}$/i.test(b.bg ?? '') ? b.bg! : '#ffffff',
      showDate: b.showDate ?? isMemories,
      // Clients that predate the location options leave them out: keep what was set.
      showLocation: locationModes.includes(b.showLocation!) ? b.showLocation! : (prev?.showLocation ?? 'off'),
      hideHomeCountry: typeof b.hideHomeCountry === 'boolean' ? b.hideHomeCountry : (prev?.hideHomeCountry ?? false),
      enabled,
    };
    const assignment = prev
      ? db.update(schema.assignments).set(values).where(eq(schema.assignments.id, prev.id)).returning().get()
      : db.insert(schema.assignments).values({ frameId, ...values }).returning().get();
    const close = check.close && {
      minutes: check.close.minutes,
      at: check.close.at,
      otherAt: check.close.otherAt,
      otherAssignmentId: check.close.other.id,
      otherCollectionId: check.close.other.collectionId,
    };
    return { assignment, warnings: close ? [{ kind: 'close' as const, ...close }] : [] };
  }

  // The schedule that changes next, for clients that only know one schedule per Canvas.
  app.put<{ Params: { frameId: string }; Body: AssignmentBody }>('/api/frames/:frameId/assignment', async (req) => {
    const frameId = getFrame(db, +req.params.frameId).id;
    return saveAssignment(frameId, getAssignment(db, frameId), req.body, requestLang(req, db)).assignment;
  });

  // Several schedules per Canvas.
  app.get<{ Params: { frameId: string } }>('/api/frames/:frameId/assignments', async (req) => getAssignments(db, getFrame(db, +req.params.frameId).id));
  app.post<{ Params: { frameId: string }; Body: AssignmentBody }>('/api/frames/:frameId/assignments', async (req) => {
    const frameId = getFrame(db, +req.params.frameId).id;
    return saveAssignment(frameId, undefined, req.body, requestLang(req, db));
  });
  app.put<{ Params: { id: string }; Body: AssignmentBody }>('/api/assignments/:id', async (req) => {
    const prev = getAssignmentById(db, +req.params.id);
    return saveAssignment(prev.frameId, prev, req.body, requestLang(req, db));
  });
  app.patch<{ Params: { id: string }; Body: { enabled?: boolean } }>('/api/assignments/:id', async (req) => {
    const prev = getAssignmentById(db, +req.params.id);
    const enabled = req.body?.enabled === true;
    if (enabled && !prev.enabled) {
      const check = checkSchedule(db, prev.frameId, { id: prev.id, schedule: prev.schedule, activeFrom: prev.activeFrom, activeTo: prev.activeTo });
      if (check.clash) {
        const name = db.select({ name: schema.collections.name }).from(schema.collections).where(eq(schema.collections.id, check.clash.other.collectionId)).get()?.name ?? '';
        throw new HttpError(409, 'schedule_conflict', { name, time: new Date(check.clash.at).toLocaleString(requestLang(req, db), { dateStyle: 'short', timeStyle: 'short' }) });
      }
    }
    return setEnabled(prev, enabled);
  });
  app.delete<{ Params: { id: string } }>('/api/assignments/:id', async (req) => {
    db.delete(schema.assignments).where(eq(schema.assignments.id, getAssignmentById(db, +req.params.id).id)).run();
    return { ok: true };
  });

  /** The coming changes of a Canvas, per day. */
  app.get<{ Params: { frameId: string }; Querystring: { days?: string } }>('/api/frames/:frameId/overview', async (req) => {
    const days = Math.min(31, Math.max(1, Math.floor(Number(req.query.days)) || 7));
    return overview(db, getFrame(db, +req.params.frameId).id, days);
  });

  /** Pause or resume one schedule. A change that fell due while paused starts counting again from now. */
  function setEnabled(prev: Assignment, enabled: boolean) {
    const window = { activeFrom: prev.activeFrom, activeTo: prev.activeTo };
    const stale = enabled && !prev.enabled && prev.nextChange !== null && prev.nextChange <= Date.now();
    return db
      .update(schema.assignments)
      .set({ enabled, ...(stale ? { nextChange: firstRun(prev.schedule, new Date(), window)?.getTime() ?? null } : {}) })
      .where(eq(schema.assignments.id, prev.id))
      .returning()
      .get();
  }

  // Pause / resume the schedule that changes next (one-schedule clients).
  app.patch<{ Params: { frameId: string }; Body: { enabled?: boolean } }>('/api/frames/:frameId/assignment', async (req) => {
    const prev = getAssignment(db, getFrame(db, +req.params.frameId).id);
    return prev ? setEnabled(prev, req.body?.enabled === true) : null;
  });

  /** Validates a schedule and returns its next runs, so the UI shows exactly what will happen. */
  app.post<{ Body: { schedule: unknown; activeFrom?: string | null; activeTo?: string | null } }>('/api/schedule/preview', async (req) => {
    try {
      const schedule = parseSchedule(req.body?.schedule);
      const window = schedule.kind === 'interval' ? { activeFrom: req.body.activeFrom, activeTo: req.body.activeTo } : {};
      return {
        ok: true,
        next: upcoming(schedule, new Date(), 3, window).map((d) => d.getTime()),
        frequent: isFrequent(schedule),
      };
    } catch (err) {
      if (err instanceof HttpError) return { ok: false, error: tr(requestLang(req, db), err.key, err.vars) };
      throw err;
    }
  });

  app.delete<{ Params: { frameId: string } }>('/api/frames/:frameId/assignment', async (req) => {
    db.delete(schema.assignments).where(eq(schema.assignments.frameId, +req.params.frameId)).run();
    return { ok: true };
  });
}
