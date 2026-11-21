import { useState } from 'react';
import { CalendarClock, Pause, Plus } from 'lucide-react';
import type { Assignment, Frame } from '../lib/api';
import { useI18n } from '../i18n';
import { useFrames } from '../lib/hooks';
import { AssignmentEditor } from '../components/AssignmentEditor';
import { PlanCard, isPending, nextChangeOf } from '../components/PlanCard';
import { WeekOverview } from '../components/WeekOverview';
import { Select } from '../components/Select';
import { Button, Empty, Modal, Segmented, SectionTitle, Spinner } from '../components/ui';

type Plan = { frame: Frame; a: Assignment };
type View = 'plans' | 'week';

export function Schedule() {
  const { t } = useI18n();
  const frames = useFrames();
  const [view, setView] = useState<View>('plans');
  // A schedule to change, or 'new' to create one (the Canvas is picked in the editor).
  const [editing, setEditing] = useState<Plan | 'new' | null>(null);
  const [weekFrameId, setWeekFrameId] = useState<number | ''>('');

  if (frames.isLoading) return <Spinner />;
  // Every schedule of every Canvas gets a card, soonest change first (paused ones last).
  const plans: Plan[] = (frames.data ?? []).flatMap((frame) => frame.assignments.map((a) => ({ frame, a })));
  const sortKey = ({ frame, a }: Plan) => (!a.enabled ? Infinity : isPending(frame, a) ? 0 : nextChangeOf(frame, a)!);
  plans.sort((x, y) => sortKey(x) - sortKey(y));
  const active = plans.filter((p) => p.a.enabled);
  const paused = plans.filter((p) => !p.a.enabled);
  const scheduledFrames = (frames.data ?? []).filter((f) => f.assignments.some((a) => a.enabled));
  const weekFrame = scheduledFrames.find((f) => f.id === weekFrameId) ?? scheduledFrames[0];

  const create = (
    <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
      {t('scheduleView.create')}
    </Button>
  );
  const card = (p: Plan) => <PlanCard key={p.a.id} frame={p.frame} assignment={p.a} onEdit={() => setEditing(p)} />;

  return (
    <>
      <SectionTitle title={t('nav.schedule')} subtitle={t('scheduleView.subtitle')} action={plans.length ? create : undefined} />
      {!frames.data?.length ? (
        <Empty icon={<CalendarClock className="size-6" />} title={t('scheduleView.empty')}>
          {t('scheduleView.empty_hint')}
        </Empty>
      ) : !plans.length ? (
        <Empty icon={<CalendarClock className="size-6" />} title={t('scheduleView.none')}>
          <p>{t('scheduleView.none_hint')}</p>
          <div className="mt-4">{create}</div>
        </Empty>
      ) : (
        <div className="space-y-4">
          <Segmented
            fill
            value={view}
            onChange={setView}
            options={[
              { value: 'plans', label: t('scheduleView.tab_plans') },
              { value: 'week', label: t('scheduleView.tab_week') },
            ]}
          />
          {view === 'plans' ? (
            <>
              {active.map(card)}
              {paused.length > 0 && (
                <>
                  <h2 className="flex items-center gap-1.5 pt-4 text-[13px] font-semibold text-muted">
                    <Pause className="size-3.5" /> {t('scheduleView.paused_group')}
                  </h2>
                  {paused.map(card)}
                </>
              )}
            </>
          ) : weekFrame ? (
            <>
              {scheduledFrames.length > 1 && (
                <Select
                  aria-label={t('nav.canvas')}
                  value={weekFrame.id}
                  onChange={setWeekFrameId}
                  options={scheduledFrames.map((f) => ({ value: f.id, label: f.name }))}
                />
              )}
              <WeekOverview frame={weekFrame} />
            </>
          ) : (
            <p className="text-sm text-muted">{t('week.none')}</p>
          )}
        </div>
      )}
      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? t('scheduleView.create') : editing ? `${t('nav.schedule')} · ${editing.frame.name}` : ''}
      >
        {editing === 'new' ? (
          <AssignmentEditor choices={frames.data ?? []} onSaved={() => setEditing(null)} />
        ) : (
          editing && <AssignmentEditor key={editing.a.id} frame={editing.frame} assignment={editing.a} onSaved={() => setEditing(null)} />
        )}
      </Modal>
    </>
  );
}
