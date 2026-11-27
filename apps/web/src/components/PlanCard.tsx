import { CalendarClock, ChevronRight, CloudDownload, Pause, Send } from 'lucide-react';
import type { Assignment, Frame } from '../lib/api';
import { dateTime, describeSchedule, relativeTime } from '../lib/format';
import { useI18n } from '../i18n';
import { useCollections } from '../lib/hooks';
import { FrameMockup } from './FrameMockup';
import { Card, Pill, cx } from './ui';

/** How the photo reaches the Canvas: the hub pushes it, or the Canvas pulls it when it wakes. */
export function ModePill({ mode }: { mode: Frame['mode'] }) {
  return mode === 'pull' ? (
    <Pill tone="ok">
      <CloudDownload className="size-3" /> Pull
    </Pill>
  ) : (
    <Pill tone="accent">
      <Send className="size-3" /> Push
    </Pill>
  );
}

/**
 * When this schedule changes the picture next. A pull Canvas with a single schedule changes
 * when it wakes; with several, each schedule has its own time.
 */
export const nextChangeOf = (f: Frame, a: Assignment) => (f.mode === 'pull' && f.assignments.length <= 1 ? f.nextWake : a.nextChange);

/** No time yet, or already past: the change is waiting for the Canvas. */
export const isPending = (f: Frame, a: Assignment) => {
  const n = nextChangeOf(f, a);
  return n === null || n < Date.now() - 60_000;
};

/**
 * One schedule of a Canvas as a list row. The picture runs down the left (only when `showFrame`);
 * beside it the name, playlist, timing and next change; chips pinned to the card's top-right corner. The whole
 * card opens the editor (a list row with a chevron), which is where it is paused or deleted. Same
 * hover as the Canvas cards. Paused: dashed border, greyed picture and faded text, while the
 * Paused chip stays at full strength.
 */
export function PlanCard({ frame: f, assignment: a, showFrame = true, onEdit }: { frame: Frame; assignment: Assignment; showFrame?: boolean; onEdit: () => void }) {
  const { t, tn } = useI18n();
  const collections = useCollections();
  const col = collections.data?.find((c) => c.id === a.collectionId);
  const nextChange = nextChangeOf(f, a);
  const pending = isPending(f, a);

  return (
    <Card
      className={cx(
        'group relative flex items-center gap-3 p-4 transition hover:bg-surface-2 sm:gap-5 sm:pr-5',
        !a.enabled && 'border-dashed border-line bg-surface/60 shadow-none',
      )}
    >
      <button
        type="button"
        className="absolute inset-0 cursor-pointer rounded-[inherit] transition active:bg-ink/5"
        aria-label={`${t('common.edit')} · ${showFrame ? f.name : (col?.name ?? '')}`}
        onClick={onEdit}
      />
      {showFrame && (
        <div className={cx('w-20 shrink-0 transition', !a.enabled && 'opacity-50 grayscale')}>
          <FrameMockup frame={f} className="transition group-hover:-translate-y-1" />
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col self-stretch justify-center">
        <h3
          className={cx(
            // One line on a phone (cut with an ellipsis); wider screens have room to wrap.
            'min-w-0 font-bold break-words max-sm:truncate',
            // Room for the corner chips, past the chevron column the text already stops at.
            showFrame && a.enabled && 'pr-10',
            !showFrame && !a.enabled && 'pr-14',
            showFrame && !a.enabled && 'pr-32',
            !a.enabled && 'opacity-55',
          )}
        >{showFrame ? f.name : (col?.name ?? '')}</h3>
        <div className={cx(!a.enabled && 'opacity-55')}>
          {col && showFrame && (
            <p className="mt-0.5 truncate text-sm text-ink-2">
              <span className="font-semibold">{col.name}</span> · {t(`collectionType.${col.type}`)} · {tn('common.photos', col.itemCount)}
            </p>
          )}
          {col && !showFrame && (
            <p className="mt-0.5 truncate text-sm text-ink-2">
              {t(`collectionType.${col.type}`)} · {tn('common.photos', col.itemCount)}
            </p>
          )}
          <p className="mt-0.5 text-xs text-muted">
            {describeSchedule(a.schedule, t, tn)}, {t(`order.${a.orderMode}_lc`)}
            {a.activeFrom && ` · ${t('scheduleView.window', { from: a.activeFrom, to: a.activeTo ?? '' })}`}
          </p>
        </div>
        {a.enabled && (
          <p className="mt-1 flex items-start gap-1.5 text-xs font-medium text-ink-2">
            <CalendarClock className="mt-px size-3.5 shrink-0" />
            <span className="first-letter:uppercase">
              {pending
                ? t(f.mode === 'pull' ? 'scheduleView.pending_pull' : 'scheduleView.pending_push')
                : t('scheduleView.next_change', { when: relativeTime(nextChange!), date: dateTime(nextChange!) })}
            </span>
          </p>
        )}
      </div>
      {/* Chips pinned to the card's top-right corner; only the title line leaves room for them. */}
      {(showFrame || !a.enabled) && (
        <div className="absolute top-4 right-4 flex gap-1.5 sm:right-5">
          {showFrame && <ModePill mode={f.mode} />}
          {!a.enabled && (
            <Pill tone="warn">
              <Pause className="size-3" /> {t('scheduleView.paused')}
            </Pill>
          )}
        </div>
      )}
      <ChevronRight className="size-5 shrink-0 text-muted transition group-hover:translate-x-0.5 group-hover:text-ink-2" aria-hidden />
    </Card>
  );
}
