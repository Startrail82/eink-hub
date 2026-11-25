import { useQueries } from '@tanstack/react-query';
import { Frame as FrameIcon, Moon } from 'lucide-react';
import { api, type Frame, type OverviewDay } from '../lib/api';
import { clock, dayTitle } from '../lib/format';
import { useI18n } from '../i18n';
import { Card, Spinner, cx } from './ui';

/** A calm set of dots to tell collections apart; the same collection always gets the same one. */
const DOTS = ['bg-accent', 'bg-leaf', 'bg-warn', 'bg-ink-2', 'bg-accent/50', 'bg-leaf/50'];
const dot = (collectionId: number) => DOTS[collectionId % DOTS.length];

const localKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const DAYS = 7;

/**
 * The coming week of one or more Canvases, a day per card: when the picture changes and to which
 * collection. With `showFrame` (the Schedule page, every Canvas at once) each change also names its Canvas.
 * Built for a phone first (one column); wider screens get two. `compact` (inside a Canvas, where it
 * sits under the schedules) uses smaller cards and rows, two days side by side from small screens on.
 */
export function WeekOverview({ frames, showFrame = false, compact = false }: { frames: Frame[]; showFrame?: boolean; compact?: boolean }) {
  const { t } = useI18n();
  const overviews = useQueries({
    queries: frames.map((frame) => ({
      queryKey: ['frames', frame.id, 'overview', frame.assignments.map((a) => `${a.id}:${a.enabled}:${a.collectionId}:${JSON.stringify(a.schedule)}`).join('|')],
      queryFn: () => api.get<OverviewDay[]>(`/api/frames/${frame.id}/overview?days=${DAYS}`),
      refetchInterval: 60_000,
    })),
  });
  if (overviews.some((o) => o.isLoading)) return <Spinner />;
  // The hub groups by its own timezone; regroup by this browser's days, which is what the
  // clock times below and "Today" are shown in.
  const items = overviews
    .flatMap((o, n) => (o.data ?? []).flatMap((d) => d.items.map((it) => ({ ...it, frameId: frames[n].id, frameName: frames[n].name }))))
    .sort((x, y) => x.at - y.at || x.frameName.localeCompare(y.frameName));
  if (!items.length) return <p className="text-sm text-muted">{t('week.none')}</p>;
  const dayAt = (i: number) => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + i);
    return localKey(d);
  };
  const days = Array.from({ length: DAYS }, (_, i) => {
    const date = dayAt(i);
    return { date, items: items.filter((it) => localKey(new Date(it.at)) === date) };
  });
  const today = dayAt(0);
  const tomorrow = dayAt(1);

  return (
    // grid-cols-1 (minmax(0, 1fr)): without it a long collection name widens the column past the screen.
    <div className={cx('grid grid-cols-1', compact ? 'gap-2 sm:grid-cols-2' : 'gap-3 lg:grid-cols-2')}>
      {days.map((day) => {
        const title = dayTitle(day.date);
        const label = day.date === today ? t('week.today') : day.date === tomorrow ? t('week.tomorrow') : title.weekday;
        return (
          <Card key={day.date} className={cx(compact ? 'rounded-2xl p-3' : 'p-4', day.date === today && 'ring-1 ring-accent/40')}>
            <div className="flex items-baseline justify-between gap-3">
              <h3 className={cx('font-bold first-letter:uppercase', compact && 'text-sm')}>{label}</h3>
              <span className="text-xs text-muted first-letter:uppercase">{day.date === today || day.date === tomorrow ? `${title.weekday} ${title.rest}` : title.rest}</span>
            </div>
            {day.items.length ? (
              <ol className={compact ? 'mt-2 space-y-1' : 'mt-3 space-y-2'}>
                {day.items.map((i) => (
                  <li key={`${i.assignmentId}-${i.at}`} className={cx('flex items-center rounded-xl bg-surface-2', compact ? 'gap-2 px-2.5 py-1' : 'gap-3 px-3 py-2')}>
                    <span className={cx('shrink-0 font-bold tabular-nums', compact ? 'min-w-10 text-xs' : 'min-w-12 text-sm', i.pending && 'text-warn')}>{i.pending ? t('detail.pending') : clock(i.at)}</span>
                    <span className={cx('shrink-0 rounded-full', compact ? 'size-2' : 'size-2.5', dot(i.collectionId))} aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className={cx('block truncate font-medium text-ink-2', compact ? 'text-xs' : 'text-sm')}>{i.collection}</span>
                      {showFrame && (
                        <span className="flex min-w-0 items-center gap-1 text-xs text-muted">
                          <FrameIcon className="size-3 shrink-0" aria-hidden />
                          <span className="truncate">{i.frameName}</span>
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className={cx('flex items-center gap-2 text-muted', compact ? 'mt-2 text-xs' : 'mt-3 text-sm')}>
                <Moon className={compact ? 'size-3.5' : 'size-4'} /> {t('week.empty_day')}
              </p>
            )}
          </Card>
        );
      })}
    </div>
  );
}
