import { useQuery } from '@tanstack/react-query';
import { Moon } from 'lucide-react';
import { api, type Frame, type OverviewDay } from '../lib/api';
import { clock, dayTitle } from '../lib/format';
import { useI18n } from '../i18n';
import { Card, Spinner, cx } from './ui';

/** A calm set of dots to tell collections apart; the same collection always gets the same one. */
const DOTS = ['bg-accent', 'bg-leaf', 'bg-warn', 'bg-ink-2', 'bg-accent/50', 'bg-leaf/50'];
const dot = (collectionId: number) => DOTS[collectionId % DOTS.length];

const localKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * The coming week of one Canvas, a day per card: when the picture changes and to which
 * collection. Built for a phone first (one column); wider screens get two.
 */
export function WeekOverview({ frame }: { frame: Frame }) {
  const { t } = useI18n();
  const overview = useQuery({
    queryKey: ['frames', frame.id, 'overview', frame.assignments.map((a) => `${a.id}:${a.enabled}:${a.collectionId}:${JSON.stringify(a.schedule)}`).join('|')],
    queryFn: () => api.get<OverviewDay[]>(`/api/frames/${frame.id}/overview?days=7`),
    refetchInterval: 60_000,
  });
  if (overview.isLoading) return <Spinner />;
  const days = overview.data ?? [];
  if (!days.some((d) => d.items.length)) return <p className="text-sm text-muted">{t('week.none')}</p>;
  const today = localKey(new Date());
  const tomorrow = localKey(new Date(Date.now() + 86_400_000));

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {days.map((day) => {
        const title = dayTitle(day.date);
        const label = day.date === today ? t('week.today') : day.date === tomorrow ? t('week.tomorrow') : title.weekday;
        return (
          <Card key={day.date} className={cx('p-4', day.date === today && 'ring-1 ring-accent/40')}>
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="font-bold first-letter:uppercase">{label}</h3>
              <span className="text-xs text-muted first-letter:uppercase">{day.date === today || day.date === tomorrow ? `${title.weekday} ${title.rest}` : title.rest}</span>
            </div>
            {day.items.length ? (
              <ol className="mt-3 space-y-2">
                {day.items.map((i) => (
                  <li key={`${i.assignmentId}-${i.at}`} className="flex items-center gap-3 rounded-xl bg-surface-2 px-3 py-2">
                    <span className="w-12 shrink-0 text-sm font-bold tabular-nums">{clock(i.at)}</span>
                    <span className={cx('size-2.5 shrink-0 rounded-full', dot(i.collectionId))} aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink-2">{i.collection}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="mt-3 flex items-center gap-2 text-sm text-muted">
                <Moon className="size-4" /> {t('week.empty_day')}
              </p>
            )}
          </Card>
        );
      })}
    </div>
  );
}
