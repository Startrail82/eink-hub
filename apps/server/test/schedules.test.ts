import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { afterAll, describe, expect, it } from 'vitest';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b8hub-schedules-'));
process.env.DATA_DIR = dataDir;
process.env.AUTH_DISABLED = 'true';

const { ensureDirs, config } = await import('../src/config.js');
const { openDb, schema, migrations } = await import('../src/db/index.js');
const { buildApp } = await import('../src/app.js');
const { checkSchedule, overview, projection } = await import('../src/lib/plan.js');
const { saveLocalUpload } = await import('../src/lib/images.js');
const { dueAssignment, getAssignment, getAssignments, latestDue } = await import('../src/lib/display.js');

ensureDirs();
const db = openDb(config.dbPath);
const { app } = await buildApp(db, { logger: false });
afterAll(async () => {
  await app.close();
});

const cron = (expr: string) => ({ kind: 'cron' as const, expr });
const NOW = new Date(2026, 10, 21, 13, 0); // Sat 21 Nov 2026, 13:00 local time

async function newFrame(name: string) {
  const res = await app.inject({ method: 'POST', url: '/api/frames', payload: { kind: 'openframe', name, width: 1200, height: 1600 } });
  return res.json().id as number;
}
async function newCollection(name: string) {
  return (await app.inject({ method: 'POST', url: '/api/collections', payload: { name, type: 'manual' } })).json().id as number;
}
const post = (frameId: number, body: object) => app.inject({ method: 'POST', url: `/api/frames/${frameId}/assignments`, payload: body });

describe('migration', () => {
  it('lets a Canvas have several schedules and keeps the existing ones', () => {
    const file = path.join(dataDir, 'old.db');
    const old = new Database(file);
    // The database as it was before this migration (everything up to passkeys).
    for (const m of migrations.slice(0, 11)) old.exec(m);
    old.pragma('user_version = 11');
    old.prepare(`INSERT INTO frames (id, name, host, upstream_token, created_at) VALUES (1, 'A', 'h', 't1', 1), (2, 'B', 'h', 't2', 1)`).run();
    old.prepare(
      `INSERT INTO assignments (id, frame_id, collection_id, order_mode, schedule, next_change, fit, bg, show_date, enabled, last_change)
       VALUES (7, 1, 3, 'newest', '{"kind":"days","days":1,"at":"07:30"}', 123, 'blur', '#112233', 1, 0, 99)`,
    ).run();
    old.close();

    const migrated = openDb(file);
    const rows = migrated.select().from(schema.assignments).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 7, frameId: 1, collectionId: 3, orderMode: 'newest', nextChange: 123, fit: 'blur', bg: '#112233', showDate: true, enabled: false, lastChange: 99,
      schedule: { kind: 'days', days: 1, at: '07:30' },
    });
    // Two schedules for the same Canvas are now fine.
    migrated.insert(schema.assignments).values({ frameId: 1, collectionId: 4 }).run();
    expect(migrated.select().from(schema.assignments).all()).toHaveLength(2);
    migrated.$client.close();
  });
});

describe('what a schedule will do', () => {
  it('lists the coming changes of a cron schedule', () => {
    const runs = projection({ schedule: cron('0 20 * * *'), activeFrom: null, activeTo: null }, NOW, new Date(2026, 10, 24, 0, 0));
    expect(runs.map((d) => [d.getDate(), d.getHours()])).toEqual([[21, 20], [22, 20], [23, 20]]);
  });

  it('keeps hourly changes inside the active hours', () => {
    const runs = projection({ schedule: { kind: 'interval', hours: 1 }, activeFrom: '08:00', activeTo: '10:00' }, new Date(2026, 10, 21, 7, 0), new Date(2026, 10, 21, 12, 0));
    expect(runs.length).toBeGreaterThan(0);
    for (const d of runs) expect(d.getHours()).toBeGreaterThanOrEqual(8);
    for (const d of runs) expect(d.getHours() * 60 + d.getMinutes()).toBeLessThanOrEqual(10 * 60);
  });
});

describe('several schedules on one Canvas', () => {
  it('rejects a second schedule that changes at exactly the same minute', async () => {
    const frame = await newFrame('Clash');
    const a = await newCollection('Photos');
    const b = await newCollection('AI');
    expect((await post(frame, { collectionId: a, schedule: cron('0 20 * * *') })).statusCode).toBe(200);
    const res = await post(frame, { collectionId: b, schedule: cron('0 20 * * *') });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('Photos');
    expect(getAssignments(db, frame)).toHaveLength(1);
  });

  it('allows changes a few minutes apart and warns when they are less than 12 hours apart', async () => {
    const frame = await newFrame('Close');
    const a = await newCollection('Photos 2');
    const b = await newCollection('AI 2');
    await post(frame, { collectionId: a, schedule: cron('0 20 * * *') });
    const apart = await post(frame, { collectionId: b, schedule: cron('5 20 * * *') });
    expect(apart.statusCode).toBe(200);
    expect(apart.json().warnings).toEqual([expect.objectContaining({ kind: 'close', minutes: 5 })]);
    // 7 hours before 20:00 is still too close…
    const morning = await post(frame, { collectionId: b, schedule: cron('0 13 * * *') });
    expect(morning.json().warnings).toEqual([expect.objectContaining({ kind: 'close', minutes: 7 * 60 })]);
    expect(getAssignments(db, frame)).toHaveLength(3);
    // …while exactly 12 hours from the only other schedule is fine.
    const other = await newFrame('Twelve');
    await post(other, { collectionId: a, schedule: cron('0 7 * * *') });
    expect((await post(other, { collectionId: b, schedule: cron('0 19 * * *') })).json().warnings).toEqual([]);
  });

  it('can change a schedule without clashing with itself, and clears a clash when paused', async () => {
    const frame = await newFrame('Edit');
    const a = await newCollection('Photos 3');
    const b = await newCollection('AI 3');
    const first = (await post(frame, { collectionId: a, schedule: cron('0 7 * * *') })).json().assignment;
    const edit = await app.inject({ method: 'PUT', url: `/api/assignments/${first.id}`, payload: { collectionId: a, schedule: cron('0 7 * * *'), fit: 'blur' } });
    expect(edit.statusCode).toBe(200);
    expect(edit.json().assignment.fit).toBe('blur');
    // A paused schedule does not take part in the comparison.
    await app.inject({ method: 'PATCH', url: `/api/assignments/${first.id}`, payload: { enabled: false } });
    expect((await post(frame, { collectionId: b, schedule: cron('0 7 * * *') })).statusCode).toBe(200);
    // ...but it cannot be resumed on top of the other one.
    const resume = await app.inject({ method: 'PATCH', url: `/api/assignments/${first.id}`, payload: { enabled: true } });
    expect(resume.statusCode).toBe(409);
  });

  it('does not change the picture the moment a second schedule is added', async () => {
    const frame = await newFrame('Later');
    const a = await newCollection('Photos 4');
    const b = await newCollection('AI 4');
    const first = (await post(frame, { collectionId: a, schedule: cron('0 7 * * *') })).json().assignment;
    const second = (await post(frame, { collectionId: b, schedule: cron('0 19 * * *') })).json().assignment;
    expect(first.nextChange).toBeNull(); // the first one changes right away, as before
    expect(second.nextChange).toBeGreaterThan(Date.now());
  });

  it('serves the schedule that is due and reports the one that changes next', async () => {
    const frame = await newFrame('Due');
    const a = await newCollection('Photos 5');
    const b = await newCollection('AI 5');
    const one = (await post(frame, { collectionId: a, schedule: cron('0 7 * * *') })).json().assignment;
    const two = (await post(frame, { collectionId: b, schedule: cron('0 19 * * *') })).json().assignment;
    const set = (id: number, nextChange: number) => db.update(schema.assignments).set({ nextChange }).where(eqId(id)).run();
    const now = new Date();
    set(one.id, now.getTime() + 3600_000);
    set(two.id, now.getTime() - 1000);
    expect(dueAssignment(db, frame, now)?.id).toBe(two.id);
    expect(getAssignment(db, frame)?.id).toBe(two.id); // earliest change
    // Both overdue (the frame slept through 07:00): the one due most recently wins.
    set(one.id, now.getTime() - 5 * 3600_000);
    expect(dueAssignment(db, frame, now)?.id).toBe(two.id);
    set(one.id, now.getTime() - 500);
    set(two.id, now.getTime() - 5 * 3600_000);
    expect(latestDue(getAssignments(db, frame), now)?.id).toBe(one.id);
    set(one.id, now.getTime() + 3600_000);
    set(two.id, now.getTime() + 7200_000);
    expect(dueAssignment(db, frame, now)).toBeUndefined();
    expect(getAssignment(db, frame)?.id).toBe(one.id);

    const frames = (await app.inject({ url: '/api/frames' })).json() as { id: number; assignment: { id: number }; assignments: { id: number }[] }[];
    const f = frames.find((x) => x.id === frame)!;
    expect(f.assignment.id).toBe(one.id);
    expect(f.assignments.map((x) => x.id)).toEqual([one.id, two.id]);
  });

  it('shows the coming changes per day', async () => {
    const frame = await newFrame('Overview');
    const a = await newCollection('Photos 6');
    const b = await newCollection('AI 6');
    await post(frame, { collectionId: a, schedule: cron('0 7 * * *') });
    await post(frame, { collectionId: b, schedule: cron('30 19 * * *') });
    const days = (await app.inject({ url: `/api/frames/${frame}/overview?days=3` })).json() as { date: string; items: { at: number; collection: string }[] }[];
    expect(days).toHaveLength(3);
    const all = days.flatMap((d) => d.items);
    expect(all.length).toBeGreaterThanOrEqual(4);
    expect(new Set(all.map((i) => i.collection))).toEqual(new Set(['Photos 6', 'AI 6']));
    expect([...all].sort((x, y) => x.at - y.at)).toEqual(all);
  });

  it('works out the overview and comparison from fixed times', async () => {
    const frame = await newFrame('Fixed');
    const a = await newCollection('Photos 7');
    await post(frame, { collectionId: a, schedule: cron('0 20 * * *') });
    const days = overview(db, frame, 2, NOW);
    expect(days.map((d) => d.date)).toEqual(['2026-11-21', '2026-11-22']);
    // The first schedule changes right away (listed as pending), then at 20:00.
    expect(days[0].items.filter((i) => !i.pending)).toHaveLength(1);
    const check = checkSchedule(db, frame, { schedule: cron('15 20 * * *'), activeFrom: null, activeTo: null }, NOW);
    expect(check.clash).toBeUndefined();
    expect(check.close?.minutes).toBe(15);
    // Exactly 12 hours apart: no warning.
    expect(checkSchedule(db, frame, { schedule: cron('0 8 * * *'), activeFrom: null, activeTo: null }, NOW).close).toBeUndefined();
  });
});

describe('a pull Canvas with several schedules', () => {
  it('serves the schedule that is due and wakes up at the earliest change of all of them', async () => {
    const photo = async (colour: string) => (await saveLocalUpload(db, await sharp({ create: { width: 800, height: 480, channels: 3, background: colour } }).jpeg().toBuffer(), `${colour}.jpg`)).id;
    const [red, blue] = [await photo('#cc0000'), await photo('#0000cc')];
    const created = (await app.inject({ method: 'POST', url: '/api/frames', payload: { kind: 'openframe', name: 'Pull', width: 800, height: 480 } })).json();
    const poll = () => app.inject({ url: '/of/v1/display', headers: { authorization: `Bearer ${created.upstreamToken}`, host: 'hub.local:8080' } }).then((r) => r.json());
    expect((await poll()).action).toBe('show'); // the welcome picture
    const col = async (name: string, imageId: number) => (await app.inject({ method: 'POST', url: '/api/collections', payload: { name, type: 'manual', imageIds: [imageId] } })).json().id as number;
    const morning = (await post(created.id, { collectionId: await col('Morning', red), schedule: cron('0 7 * * *') })).json().assignment;
    const evening = (await post(created.id, { collectionId: await col('Evening', blue), schedule: cron('0 19 * * *') })).json().assignment;
    const now = Date.now();
    db.update(schema.assignments).set({ nextChange: now + 3 * 3600_000 }).where(eqId(morning.id)).run();
    db.update(schema.assignments).set({ nextChange: now - 1000 }).where(eqId(evening.id)).run();

    const body = await poll();
    expect(body.action).toBe('show'); // the evening schedule was due
    const after = getAssignments(db, created.id);
    const [m, e] = [after.find((x) => x.id === morning.id)!, after.find((x) => x.id === evening.id)!];
    expect(e.nextChange).toBeGreaterThan(now); // moved on
    expect(e.lastChange).not.toBeNull();
    expect(m.lastChange).toBeNull(); // the morning one did not run
    expect(m.nextChange).toBe(now + 3 * 3600_000);
    const woken = db.select().from(schema.frames).where(eq(schema.frames.id, created.id)).get()!;
    expect(woken.nextWake).toBe(Math.min(m.nextChange!, e.nextChange!));
    // Nothing is due any more: no new picture.
    expect((await poll()).action).toBe('none');
  });

  it('moves on an older schedule that was also due, so its stale picture does not follow', async () => {
    const photo = async (colour: string) => (await saveLocalUpload(db, await sharp({ create: { width: 800, height: 480, channels: 3, background: colour } }).jpeg().toBuffer(), `${colour}.jpg`)).id;
    const [green, grey] = [await photo('#00aa00'), await photo('#777777')];
    const created = (await app.inject({ method: 'POST', url: '/api/frames', payload: { kind: 'openframe', name: 'Pull 2', width: 800, height: 480 } })).json();
    const poll = () => app.inject({ url: '/of/v1/display', headers: { authorization: `Bearer ${created.upstreamToken}`, host: 'hub.local:8080' } }).then((r) => r.json());
    await poll(); // the welcome picture
    const col = async (name: string, imageId: number) => (await app.inject({ method: 'POST', url: '/api/collections', payload: { name, type: 'manual', imageIds: [imageId] } })).json().id as number;
    const morning = (await post(created.id, { collectionId: await col('Morning 2', green), schedule: cron('0 7 * * *') })).json().assignment;
    const noon = (await post(created.id, { collectionId: await col('Noon 2', grey), schedule: cron('0 12 * * *') })).json().assignment;
    const now = Date.now();
    // The Canvas slept through both changes.
    db.update(schema.assignments).set({ nextChange: now - 5 * 3600_000 }).where(eqId(morning.id)).run();
    db.update(schema.assignments).set({ nextChange: now - 1000 }).where(eqId(noon.id)).run();

    expect((await poll()).action).toBe('show');
    const after = getAssignments(db, created.id);
    const [m, n] = [after.find((x) => x.id === morning.id)!, after.find((x) => x.id === noon.id)!];
    expect(n.lastChange).not.toBeNull();
    expect(m.lastChange).toBeNull(); // skipped…
    expect(m.nextChange).toBeGreaterThan(now); // …and moved on
    expect((await poll()).action).toBe('none');
  });
});

describe('the schedule preview while editing', () => {
  it('compares with the other schedules of the Canvas: same minute is an error, less than 12 hours a warning', async () => {
    const frame = await newFrame('Preview');
    const a = await newCollection('Photos P');
    const b = await newCollection('AI P');
    const first = (await post(frame, { collectionId: a, schedule: cron('0 7 * * *') })).json().assignment;
    const preview = (body: object) => app.inject({ method: 'POST', url: '/api/schedule/preview', payload: body }).then((r) => r.json());

    const clash = await preview({ schedule: { kind: 'days', days: 1, at: '07:00' }, frameId: frame, collectionId: b, enabled: true });
    expect(clash.ok).toBe(false);
    expect(clash.error).toContain('Photos P');

    const close = await preview({ schedule: { kind: 'days', days: 1, at: '07:15' }, frameId: frame, collectionId: b, enabled: true });
    expect(close).toMatchObject({ ok: true, close: { minutes: 15, collection: 'Photos P' } });

    // Editing the schedule itself: no comparison with itself. Paused: no comparison at all.
    expect((await preview({ schedule: cron('0 7 * * *'), frameId: frame, assignmentId: first.id, collectionId: a, enabled: true })).close).toBeUndefined();
    expect((await preview({ schedule: cron('0 7 * * *'), frameId: frame, collectionId: b, enabled: false })).ok).toBe(true);
    // Without a Canvas it only validates, as before.
    expect((await preview({ schedule: cron('0 7 * * *') })).ok).toBe(true);
  });
});

describe('clients that know one schedule per Canvas', () => {
  it('always work on the oldest schedule, and only remove that one', async () => {
    const frame = await newFrame('Legacy');
    const a = await newCollection('Photos L');
    const b = await newCollection('AI L');
    const first = (await post(frame, { collectionId: a, schedule: cron('0 7 * * *') })).json().assignment;
    const second = (await post(frame, { collectionId: b, schedule: cron('0 19 * * *') })).json().assignment;
    // The second one changes next, but the old endpoints keep to the first.
    db.update(schema.assignments).set({ nextChange: Date.now() + 3600_000 }).where(eqId(second.id)).run();
    db.update(schema.assignments).set({ nextChange: Date.now() + 7200_000 }).where(eqId(first.id)).run();
    const paused = (await app.inject({ method: 'PATCH', url: `/api/frames/${frame}/assignment`, payload: { enabled: false } })).json();
    expect(paused.id).toBe(first.id);
    const resumed = (await app.inject({ method: 'PATCH', url: `/api/frames/${frame}/assignment`, payload: { enabled: true } })).json();
    expect(resumed).toMatchObject({ id: first.id, enabled: true });
    const put = (await app.inject({ method: 'PUT', url: `/api/frames/${frame}/assignment`, payload: { collectionId: a, schedule: cron('0 7 * * *'), fit: 'blur' } })).json();
    expect(put).toMatchObject({ id: first.id, fit: 'blur' });
    expect(getAssignments(db, frame).find((x) => x.id === second.id)?.fit).toBe('cover');

    await app.inject({ method: 'DELETE', url: `/api/frames/${frame}/assignment` });
    expect(getAssignments(db, frame).map((x) => x.id)).toEqual([second.id]);
  });
});

describe('hourly schedules', () => {
  it('are compared at the times they really run, so editing one does not clash by accident', async () => {
    const frame = await newFrame('Hourly');
    const a = await newCollection('Photos H');
    const b = await newCollection('AI H');
    const first = (await post(frame, { collectionId: a, schedule: cron('0 7 * * *') })).json().assignment;
    // Two hourly schedules, 10 minutes apart.
    const hourly = { kind: 'interval' as const, hours: 1 as const };
    db.update(schema.assignments).set({ schedule: hourly, nextChange: Date.now() + 3600_000 }).where(eqId(first.id)).run();
    const second = db.insert(schema.assignments).values({ frameId: frame, collectionId: b, schedule: hourly, nextChange: Date.now() + 50 * 60_000 }).returning().get();
    // Only the fit changes: it keeps running at :50, which is no clash with the other one.
    const edit = await app.inject({ method: 'PUT', url: `/api/assignments/${second.id}`, payload: { collectionId: b, schedule: hourly, fit: 'blur' } });
    expect(edit.statusCode).toBe(200);
    expect(edit.json().warnings).toEqual([expect.objectContaining({ kind: 'close', minutes: 10 })]);
  });
});

describe('the week overview', () => {
  it('lists a change that is waiting for the Canvas', async () => {
    const frame = await newFrame('Waiting');
    const a = await newCollection('Photos W');
    await post(frame, { collectionId: a, schedule: cron('0 7 * * *') }); // the first one changes right away
    const days = overview(db, frame, 2);
    expect(days[0].items[0]).toMatchObject({ pending: true, collection: 'Photos W' });
    expect(days.flatMap((d) => d.items).filter((i) => i.pending)).toHaveLength(1);
  });
});

import { eq } from 'drizzle-orm';
function eqId(id: number) {
  return eq(schema.assignments.id, id);
}
