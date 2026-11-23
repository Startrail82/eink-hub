import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, describe, expect, it } from 'vitest';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b8hub-orient-'));
process.env.DATA_DIR = dataDir;
process.env.AUTH_DISABLED = 'true';

const { ensureDirs, config } = await import('../src/config.js');
const { openDb, schema } = await import('../src/db/index.js');
const { buildApp } = await import('../src/app.js');
const { saveLocalUpload } = await import('../src/lib/images.js');
const { chooseNextImage, getAssignments, getFrame } = await import('../src/lib/display.js');
const { matchOrientation } = await import('../src/lib/selection.js');

ensureDirs();
const db = openDb(config.dbPath);
const { app } = await buildApp(db, { logger: false });
afterAll(async () => {
  await app.close();
});

const cand = (id: number, width: number | null, height: number | null) => ({ id, position: id, takenAt: null, width, height });

describe('matching the way a Canvas hangs', () => {
  it('keeps upright pictures for portrait and wide ones for landscape, squares for both', () => {
    const all = [cand(1, 800, 1200), cand(2, 1200, 800), cand(3, 1000, 1000), cand(4, null, null)];
    expect(matchOrientation(all, 'portrait').map((c) => c.id)).toEqual([1, 3, 4]);
    expect(matchOrientation(all, 'landscape').map((c) => c.id)).toEqual([2, 3, 4]);
  });

  it('keeps everything when nothing fits, so the Canvas never stalls', () => {
    const wide = [cand(1, 1200, 800), cand(2, 1600, 900)];
    expect(matchOrientation(wide, 'portrait')).toEqual(wide);
  });

  it('only changes what a schedule picks when it is switched on', async () => {
    const frameId = (await app.inject({ method: 'POST', url: '/api/frames', payload: { kind: 'openframe', name: 'Staand', width: 1200, height: 1600 } })).json().id as number;
    const collectionId = (await app.inject({ method: 'POST', url: '/api/collections', payload: { name: 'Mix', type: 'manual' } })).json().id as number;
    const photo = async (w: number, h: number, name: string) => (await saveLocalUpload(db, await sharp({ create: { width: w, height: h, channels: 3, background: '#808080' } }).jpeg().toBuffer(), `${name}.jpg`)).id;
    const upright = await photo(480, 800, 'upright');
    const wide = await photo(800, 480, 'wide');
    for (const [i, id] of [upright, wide].entries()) db.insert(schema.collectionItems).values({ collectionId, imageId: id, position: i }).run();

    const save = async (matchOrientation: boolean) => {
      const res = await app.inject({ method: 'POST', url: `/api/frames/${frameId}/assignments`, payload: { collectionId, matchOrientation } });
      return res.json().assignment as { id: number; matchOrientation: boolean };
    };
    const picks = (id: number) => {
      const a = getAssignments(db, frameId).find((x) => x.id === id)!;
      return new Set(Array.from({ length: 60 }, () => chooseNextImage(db, getFrame(db, frameId), a)));
    };

    const off = await save(false);
    expect(off.matchOrientation).toBe(false);
    expect(picks(off.id)).toEqual(new Set([upright, wide]));
    db.delete(schema.assignments).run();

    const on = await save(true);
    expect(on.matchOrientation).toBe(true);
    expect(picks(on.id)).toEqual(new Set([upright]));

    // Hang the Canvas the other way and the other picture is the one that fits.
    await app.inject({ method: 'PATCH', url: `/api/frames/${frameId}`, payload: { orientation: 'landscape' } });
    expect(picks(on.id)).toEqual(new Set([wide]));
  });
});
