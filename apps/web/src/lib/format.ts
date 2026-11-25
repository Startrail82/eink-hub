import type { Schedule } from './api';
import type { TFunction, TnFunction } from '../i18n';

/** Active BCP 47 locale; set by the I18nProvider whenever the language changes. */
let locale = 'en-GB';
export function setFormatLocale(l: string) {
  locale = l;
}

/**
 * Some browsers (e.g. Chromium/Electron builds with reduced ICU) have no Basque data and
 * silently fall back to another language, so Basque gets a small built-in formatter.
 */
const basqueFallback = () =>
  locale.startsWith('eu') && !Intl.DateTimeFormat.supportedLocalesOf(['eu']).length;
const EU_WEEKDAYS = ['igandea', 'astelehena', 'asteartea', 'asteazkena', 'osteguna', 'ostirala', 'larunbata'];
const EU_UNITS = { second: 'segundo', minute: 'minutu', hour: 'ordu', day: 'egun' } as const;
const pad = (n: number) => String(n).padStart(2, '0');

function relative(value: number, unit: keyof typeof EU_UNITS): string {
  if (basqueFallback()) {
    if (value === 0) return 'orain';
    return value < 0 ? `duela ${-value} ${EU_UNITS[unit]}` : `${value} ${EU_UNITS[unit]} barru`;
  }
  return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(value, unit);
}

export function relativeTime(ms: number | null | undefined): string {
  if (!ms) return '—';
  const diff = (ms - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return relative(Math.round(diff), 'second');
  if (abs < 3600) return relative(Math.round(diff / 60), 'minute');
  if (abs < 86400) return relative(Math.round(diff / 3600), 'hour');
  return relative(Math.round(diff / 86400), 'day');
}

export function dateTime(ms: number | null | undefined): string {
  if (!ms) return '—';
  const d = new Date(ms);
  // Basque numeric style: 2026/10/12 08:00
  if (basqueFallback()) return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Weekday name, 0 = Sunday, in the active locale. */
export function weekdayName(d: number): string {
  if (basqueFallback()) return EU_WEEKDAYS[d];
  // 2026-06-07 is a Sunday.
  return new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(new Date(2026, 5, 7 + d));
}

/** Human-readable schedule, e.g. "Every 2 weeks, on Monday at 08:00". */
export function describeSchedule(s: Schedule, t: TFunction, tn: TnFunction): string {
  switch (s.kind) {
    case 'interval':
      return s.hours === 1 ? t('schedule.every_hour') : tn('schedule.every_hours', s.hours);
    case 'days':
      return s.days === 1 ? t('schedule.desc_daily', { at: s.at }) : tn('schedule.desc_days', s.days, { at: s.at });
    case 'weeks':
      return t(s.weeks === 1 ? 'schedule.desc_weekly' : 'schedule.desc_biweekly', { day: weekdayName(s.weekday), at: s.at });
    case 'monthly':
      return t('schedule.desc_monthly', { day: s.day, at: s.at });
    case 'cron':
      return t('schedule.desc_cron', { expr: s.expr });
  }
}

/** Storage size with a unit that keeps it short: 850 MB, 31.4 GB. */
export function formatBytes(bytes: number): string {
  const gb = bytes >= 1e9;
  const n = new Intl.NumberFormat(locale, { maximumFractionDigits: gb ? 1 : 0 }).format(bytes / (gb ? 1e9 : 1e6));
  return `${n} ${gb ? 'GB' : 'MB'}`;
}

/** Share of the whole, in the active locale's style (99 %, 99%). */
export function formatPercent(part: number, whole: number): string {
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(part / whole);
}

/** A gap in minutes, e.g. "20 min" or "5 h 20 min" (in the active locale where the browser can). */
export function duration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const DF = (Intl as unknown as { DurationFormat?: new (l: string, o: object) => { format(d: object): string } }).DurationFormat;
  if (DF && !basqueFallback()) return new DF(locale, { style: 'short' }).format(h ? (m ? { hours: h, minutes: m } : { hours: h }) : { minutes: m });
  return h ? (m ? `${h} h ${m} min` : `${h} h`) : `${m} min`;
}

/** Clock time in the active locale, e.g. "20:00". */
export function clock(ms: number): string {
  const d = new Date(ms);
  if (basqueFallback()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}

/** "YYYY-MM-DD" (a local day) as a long weekday and date, e.g. "Saturday 21 November". */
export function dayTitle(date: string): { weekday: string; rest: string } {
  const [y, m, d] = date.split('-').map(Number);
  const day = new Date(y, m - 1, d);
  if (basqueFallback()) return { weekday: EU_WEEKDAYS[day.getDay()], rest: `${y}/${pad(m)}/${pad(d)}` };
  return {
    weekday: new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(day),
    rest: new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long' }).format(day),
  };
}
