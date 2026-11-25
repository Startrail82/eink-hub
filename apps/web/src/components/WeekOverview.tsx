import { useQueries } from '@tanstack/react-query';
import { Frame as FrameIcon, Images, Moon } from 'lucide-react';
import { api, thumbUrl, type Frame, type OverviewDay } from '../lib/api';
import { useCollections } from '../lib/hooks';
import { clock, dayTitle } from '../lib/format';
import { useI18n } from '../i18n';
import { Card, Spinner, cx } from './ui';

/**
 * The collection's cover as a small thumbnail, to tell collections apart at a glance (colours
 * would read as good/bad). Without a cover, a neutral placeholder.
 */
function Cover({ imageId, compact }: { imageId: number | null | undefined; compact: boolean }) {
  const size = compact ? 'size-4 rounded' : 'size-5 rounded-md';
  return imageId ? (
    <img src={thumbUrl(imageId)} alt="" loading="lazy" className={cx(size, 'object-cover')} />
  ) : (
    <span className={cx(size, 'flex items-center justify-center bg-line text-muted')} aria-hidden>
      <Images className="size-3" />
    </span>
  );
}

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
  const collections = useCollections();
  const covers = new Map(collections.data?.map((c) => [c.id, c.coverImageId]));
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
              // One grid per day, each row a subgrid: times, covers, names and Canvases line up in
              // columns even when a row says "Pending" instead of a time.
              <ol className={cx('grid grid-cols-[auto_auto_minmax(0,1fr)_auto]', compact ? 'mt-2 gap-x-2 gap-y-1' : 'mt-3 gap-x-3 gap-y-2')}>
                {day.items.map((i) => (
                  <li key={`${i.assignmentId}-${i.at}`} className={cx('col-span-full grid grid-cols-subgrid items-center rounded-xl bg-surface-2', compact ? 'px-2.5 py-1' : 'px-3 py-2')}>
                    <span className={cx('font-bold tabular-nums', compact ? 'text-xs' : 'text-sm', i.pending && 'text-warn')}>{i.pending ? t('detail.pending') : clock(i.at)}</span>
                    <Cover imageId={covers.get(i.collectionId)} compact={compact} />
                    <span className={cx('truncate font-medium text-ink-2', compact ? 'text-xs' : 'text-sm')}>{i.collection}</span>
                    {showFrame ? (
                      <span className="flex max-w-24 min-w-0 items-center justify-end sm:max-w-40 gap-1 text-xs text-muted">
                        <FrameIcon className="size-3 shrink-0" aria-hidden />
                        <span className="truncate">{i.frameName}</span>
                      </span>
                    ) : (
                      <span />
                    )}
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
