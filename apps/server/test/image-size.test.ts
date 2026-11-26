import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ImmichAsset } from '../src/immich/client.js';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'b8hub-size-'));
process.env.AUTH_DISABLED = 'true';

const { ensureDirs, config } = await import('../src/config.js');
const { openDb, schema, setSetting } = await import('../src/db/index.js');
const { buildApp } = await import('../src/app.js');
const { DETAILS_RETRY_MS, fillImmichSizes, renderFor, upsertImmichAssets } = await import('../src/lib/images.js');

const db = (ensureDirs(), openDb(config.dbPath));
const rowOf = (assetId: string) => db.select().from(schema.images).all().find((i) => i.immichAssetId === assetId)!;
const sizeOf = (assetId: string) => [rowOf(assetId).width, rowOf(assetId).height];

/** Immich's answer per asset: stored 4000×3000, EXIF says "rotate 90°" → shown 3000×4000. */
const ASSETS: Record<string, ImmichAsset> = {
  rotated: { id: 'rotated', type: 'IMAGE', exifInfo: { exifImageWidth: 4000, exifImageHeight: 3000, orientation: '6' } },
  wide: { id: 'wide', type: 'IMAGE', exifInfo: { exifImageWidth: 6000, exifImageHeight: 4000 } },
  // Immich has not read this one's EXIF yet: only the original tells its size.
  unknown: { id: 'unknown', type: 'IMAGE', exifInfo: null },
};
const hits: string[] = [];
let original: Buffer;

const immich = Fastify();
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let ctx: Awaited<ReturnType<typeof buildApp>>['ctx'];

beforeAll(async () => {
  // A 300×200 JPEG with EXIF orientation 6: displayed upright, 200×300.
  original = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#4080c0' } })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();
  immich.get<{ Params: { id: string } }>('/api/assets/:id', async (req, reply) => {
    hits.push(req.params.id);
    return ASSETS[req.params.id] ?? reply.code(404).send({ message: 'not found' });
  });
  immich.get('/api/assets/:id/original', async (_req, reply) => reply.type('image/jpeg').send(original));
  setSetting(db, 'immich.url', await immich.listen({ port: 0, host: '127.0.0.1' }));
  setSetting(db, 'immich.apiKey', 'test');
  ({ app, ctx } = await buildApp(db, { logger: false }));
});
afterAll(async () => {
  await app.close();
  await immich.close();
});

describe('sizes of photos imported by bare id', () => {
  it('asks Immich for the size, EXIF rotation applied', async () => {
    upsertImmichAssets(db, [{ id: 'rotated', type: 'IMAGE' }, { id: 'wide', type: 'IMAGE' }]);
    expect(sizeOf('rotated')).toEqual([null, null]);
    expect(await fillImmichSizes(ctx)).toBe(2);
    expect(sizeOf('rotated')).toEqual([3000, 4000]);
    expect(sizeOf('wide')).toEqual([6000, 4000]);
  });

  it('fills them right after an import from the Immich page', async () => {
    ASSETS['imported'] = { id: 'imported', type: 'IMAGE', exifInfo: { exifImageWidth: 3000, exifImageHeight: 4000 } };
    const res = await app.inject({ method: 'POST', url: '/api/immich/import', payload: { assetIds: ['imported'] } });
    expect(res.statusCode).toBe(200);
    await expect.poll(() => sizeOf('imported')).toEqual([3000, 4000]);
  });

  it('does not ask again for images that already have a size, and waits before retrying unknown ones', async () => {
    upsertImmichAssets(db, [{ id: 'unknown', type: 'IMAGE' }]);
    hits.length = 0;
    const t0 = Date.now();
    expect(await fillImmichSizes(ctx, { now: t0 })).toBe(0);
    expect(hits).toEqual(['unknown']);
    await fillImmichSizes(ctx, { now: t0 + 1000 });
    expect(hits).toEqual(['unknown']);
    await fillImmichSizes(ctx, { now: t0 + DETAILS_RETRY_MS + 1 });
    expect(hits).toEqual(['unknown', 'unknown']);
  });

  it('reads the size from the original on its first render when Immich does not know it', async () => {
    expect(sizeOf('unknown')).toEqual([null, null]);
    const frame = db
      .insert(schema.frames)
      .values({ name: 'F', host: '127.0.0.1:1', upstreamToken: 'size-token', mode: 'pull', createdAt: Date.now() })
      .returning()
      .get();
    await renderFor(ctx, rowOf('unknown'), frame);
    expect(sizeOf('unknown')).toEqual([200, 300]);
  });
});
