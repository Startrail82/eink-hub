import { schema, type DB } from '../db/index.js';
import type { Assignment } from '../db/schema.js';
import { getAssignments } from './display.js';
import { GAP_SLACK, MIN_GAP_HOURS, firstRun, isDue, nextRun, type Schedule } from './schedule.js';

const DAY = 24 * 3600_000;
/** How far ahead schedules are compared and listed. */
export const CHECK_DAYS = 31;
/**
 * Two changes of a Canvas closer than this get a warning: every change wakes the Canvas and costs
 * battery. The same limit as the battery warning of a single schedule (see `isFrequent`).
 */
const CLOSE_MS = MIN_GAP_HOURS * 3600_000 - GAP_SLACK;
const MAX_RUNS = 800;

/** The parts of a schedule that decide when it changes the picture. */
export type Timing = Pick<Assignment, 'schedule' | 'activeFrom' | 'activeTo'> & { nextChange?: number | null };

/** When a schedule is expected to change the picture between `from` and `until`. */
export function projection(t: Timing, from: Date, until: Date, limit = MAX_RUNS): Date[] {
  const w = { activeFrom: t.activeFrom, activeTo: t.activeTo };
  const out: Date[] = [];
  // The stored time when it is still ahead, otherwise the next matching time.
  let cursor: Date | null = t.nextChange != null && t.nextChange >= from.getTime() ? new Date(t.nextChange) : firstRun(t.schedule as Schedule, from, w);
  while (cursor && cursor <= until && out.length < limit) {
    out.push(cursor);
    cursor = nextRun(t.schedule as Schedule, cursor, w);
  }
  return out;
}

const minute = (d: Date) => Math.floor(d.getTime() / 60_000);

export interface ScheduleClash {
  at: number;
  other: Assignment;
}
export interface CloseChanges {
  /** This schedule's change… */
  at: number;
  /** …and the other schedule's change closest to it. */
  otherAt: number;
  minutes: number;
  other: Assignment;
}
export interface ScheduleCheck {
  /** Two schedules change at exactly the same minute: not allowed. */
  clash?: ScheduleClash;
  /** Another schedule changes less than MIN_GAP_HOURS from this one: allowed, but worth a warning. */
  close?: CloseChanges;
}

/**
 * Compares a schedule with the other schedules of the same Canvas over the coming month.
 * `id` is the schedule being edited, so it is not compared with itself. `nextChange` is the
 * change time it will have once saved: hourly schedules run relative to it, so leaving it out
 * would compare times it never runs at.
 */
export function checkSchedule(db: DB, frameId: number, candidate: Timing & { id?: number }, now = new Date()): ScheduleCheck {
  const until = new Date(now.getTime() + CHECK_DAYS * DAY);
  const mine = projection({ ...candidate, nextChange: candidate.nextChange ?? null }, now, until);
  let close: CloseChanges | undefined;
  for (const other of getAssignments(db, frameId)) {
    if (other.id === candidate.id || !other.enabled) continue;
    const theirs = projection(other, now, until);
    const taken = new Set(theirs.map(minute));
    const same = mine.find((d) => taken.has(minute(d)));
    if (same) return { clash: { at: same.getTime(), other } };
    const pair = closestPair(mine, theirs);
    if (pair && pair.ms < CLOSE_MS && (!close || pair.ms < close.minutes * 60_000))
      close = { at: pair.a.getTime(), otherAt: pair.b.getTime(), minutes: Math.round(pair.ms / 60_000), other };
  }
  return { close };
}

/** The closest pair of changes between two sorted lists. */
function closestPair(xs: Date[], ys: Date[]): { a: Date; b: Date; ms: number } | undefined {
  let best: { a: Date; b: Date; ms: number } | undefined;
  let j = 0;
  for (const a of xs) {
    while (j + 1 < ys.length && ys[j + 1] <= a) j++;
    for (const b of [ys[j], ys[j + 1]]) {
      if (!b) continue;
      const ms = Math.abs(b.getTime() - a.getTime());
      if (!best || ms < best.ms) best = { a, b, ms };
    }
  }
  return best;
}

export interface OverviewItem {
  at: number;
  assignmentId: number;
  collectionId: number;
  collection: string;
  /** A change that is already due and waits for the Canvas (listed at `now`). */
  pending?: boolean;
}
export interface OverviewDay {
  /** Local date, YYYY-MM-DD. */
  date: string;
  items: OverviewItem[];
}

/** The coming changes of a Canvas, per day, over all its enabled schedules. */
export function overview(db: DB, frameId: number, days = 7, now = new Date()): OverviewDay[] {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + days);
  const names = new Map(db.select({ id: schema.collections.id, name: schema.collections.name }).from(schema.collections).all().map((c) => [c.id, c.name]));
  const items: OverviewItem[] = [];
  for (const a of getAssignments(db, frameId)) {
    if (!a.enabled) continue;
    // Due already (no time yet, or past): it happens as soon as the Canvas responds or wakes.
    // (A time still ahead is listed by the projection below.)
    if (a.nextChange == null ? isDue(null, now, a.schedule, a) : a.nextChange < now.getTime()) items.push({ at: now.getTime(), assignmentId: a.id, collectionId: a.collectionId, collection: names.get(a.collectionId) ?? '', pending: true });
    for (const t of projection(a, now, end)) items.push({ at: t.getTime(), assignmentId: a.id, collectionId: a.collectionId, collection: names.get(a.collectionId) ?? '' });
  }
  items.sort((x, y) => x.at - y.at);
  const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const out: OverviewDay[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    out.push({ date: key(d), items: items.filter((it) => key(new Date(it.at)) === key(d)) });
  }
  return out;
}

