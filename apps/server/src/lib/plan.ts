import { schema, type DB } from '../db/index.js';
import type { Assignment } from '../db/schema.js';
import { getAssignments } from './display.js';
import { firstRun, nextRun, type Schedule } from './schedule.js';

const DAY = 24 * 3600_000;
/** How far ahead schedules are compared and listed. */
export const CHECK_DAYS = 31;
/** Two changes closer than this get a warning (an e-ink refresh takes a while and costs battery). */
export const CLOSE_MINUTES = 30;
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
  at: number;
  otherAt: number;
  minutes: number;
  other: Assignment;
}
export interface ScheduleCheck {
  /** Two schedules change at exactly the same minute: not allowed. */
  clash?: ScheduleClash;
  /** Two changes less than CLOSE_MINUTES apart: allowed, but worth a warning. */
  close?: CloseChanges;
}

/**
 * Compares a schedule with the other schedules of the same Canvas over the coming month.
 * `id` is the schedule being edited, so it is not compared with itself.
 */
export function checkSchedule(db: DB, frameId: number, candidate: Timing & { id?: number }, now = new Date()): ScheduleCheck {
  const until = new Date(now.getTime() + CHECK_DAYS * DAY);
  const mine = projection({ ...candidate, nextChange: null }, now, until);
  const result: ScheduleCheck = {};
  for (const other of getAssignments(db, frameId)) {
    if (other.id === candidate.id || !other.enabled) continue;
    const theirs = projection(other, now, until);
    const taken = new Set(theirs.map(minute));
    const same = mine.find((d) => taken.has(minute(d)));
    if (same) return { clash: { at: same.getTime(), other } };
    if (result.close) continue;
    // Both lists are sorted: walk them together for the closest pair.
    let j = 0;
    for (const d of mine) {
      while (j + 1 < theirs.length && theirs[j + 1] <= d) j++;
      for (const t of [theirs[j], theirs[j + 1]]) {
        if (!t) continue;
        const minutes = Math.abs(t.getTime() - d.getTime()) / 60_000;
        if (minutes < CLOSE_MINUTES) {
          result.close = { at: d.getTime(), otherAt: t.getTime(), minutes: Math.round(minutes), other };
          break;
        }
      }
      if (result.close) break;
    }
  }
  return result;
}

export interface OverviewItem {
  at: number;
  assignmentId: number;
  collectionId: number;
  collection: string;
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

