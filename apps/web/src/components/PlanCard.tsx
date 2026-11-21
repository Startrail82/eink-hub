import { CalendarClock, ChevronRight, CloudDownload, Pause, Play, Send, Trash2 } from 'lucide-react';
import { api, type Assignment, type Frame } from '../lib/api';
import { dateTime, describeSchedule, relativeTime } from '../lib/format';
import { useI18n } from '../i18n';
import { useAction, useCollections } from '../lib/hooks';
import { FrameMockup } from './FrameMockup';
import { Button, Card, Pill, cx, useConfirm } from './ui';

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
 * name, playlist, timing, next change and chips stack beside it. The whole card opens the editor
 * (a list row with a chevron); Pause and Delete sit above that button: labelled on the right on
 * wide screens, icons below on a phone. Same hover as the Canvas cards. Paused: dashed border,
 * greyed picture and faded text, while the Paused chip and the buttons stay at full strength.
 */
export function PlanCard({ frame: f, assignment: a, showFrame = true, onEdit }: { frame: Frame; assignment: Assignment; showFrame?: boolean; onEdit: () => void }) {
  const { t, tn } = useI18n();
  const collections = useCollections();
  const confirm = useConfirm();
  const setEnabled = useAction((enabled: boolean) => api.patch(`/api/assignments/${a.id}`, { enabled }), { success: t('assign.saved') });
  const remove = useAction(() => api.del(`/api/assignments/${a.id}`), { success: t('assign.removed') });
  const col = collections.data?.find((c) => c.id === a.collectionId);
  const nextChange = nextChangeOf(f, a);
  const pending = isPending(f, a);

  const pause = (label: boolean) => (
    <Button
      size="sm"
      className={label ? undefined : 'size-8! px-0!'}
      icon={a.enabled ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
      aria-label={t(a.enabled ? 'scheduleView.pause' : 'scheduleView.resume')}
      disabled={setEnabled.isPending}
      onClick={() => setEnabled.mutate(!a.enabled)}
    >
      {label && t(a.enabled ? 'scheduleView.pause' : 'scheduleView.resume')}
    </Button>
  );
  const del = (label: boolean) => (
    <Button
      size="sm"
      variant="danger"
      className={label ? undefined : 'size-8! px-0!'}
      icon={<Trash2 className="size-3.5" />}
      aria-label={t('common.delete')}
      disabled={remove.isPending}
      onClick={async () => (await confirm({ title: t('assign.remove'), message: t('assign.confirm_remove', { name: f.name }) })) && remove.mutate(undefined)}
    >
      {label && t('common.delete')}
    </Button>
  );

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
        <div className={cx(!a.enabled && 'opacity-55')}>
          <h3 className="truncate font-bold">{showFrame ? f.name : (col?.name ?? '')}</h3>
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
        {/* Chips wrap in their own space and the phone buttons stay bottom-right; only when not
            even one chip fits beside them do the buttons drop to their own line (still right). */}
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <div className="flex min-w-min grow basis-0 flex-wrap items-center gap-1.5">
            {showFrame && <ModePill mode={f.mode} />}
            {!a.enabled && (
              <Pill tone="warn">
                <Pause className="size-3" /> {t('scheduleView.paused')}
              </Pill>
            )}
          </div>
          <div className="relative z-10 ml-auto flex shrink-0 items-center gap-1.5 sm:hidden">
            {pause(false)}
            {del(false)}
          </div>
        </div>
      </div>
      <div className="relative z-10 flex items-center gap-2 max-sm:hidden">
        {pause(true)}
        {del(true)}
      </div>
      <ChevronRight className="size-5 shrink-0 text-muted transition group-hover:translate-x-0.5 group-hover:text-ink-2" aria-hidden />
    </Card>
  );
}
