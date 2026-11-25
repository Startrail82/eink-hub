import { useState } from 'react';
import { History, Trash2 } from 'lucide-react';
import { api, type FitMode, type Assignment, type Frame, type LocationMode, type OrderMode, type SavedAssignment, type Schedule } from '../lib/api';
import { useAction, useCollections } from '../lib/hooks';
import { SchedulePicker } from './SchedulePicker';
import { useI18n, type MsgKey } from '../i18n';
import { BgPicker } from './BgPicker';
import { Button, Chips, Field, Segmented, Toggle, cx, inputClass, useConfirm } from './ui';
import { Select } from './Select';
import { TimeField } from './TimeField';

/**
 * The label drawn on the photo: date and/or place (from Immich) as two chips, none = no label.
 * With the place on, "leave out the home country" shows under it.
 */
export function CaptionOptions({
  showDate,
  onShowDate,
  location,
  onLocation,
  hideHome,
  onHideHome,
  memories,
}: {
  showDate: boolean;
  onShowDate: (v: boolean) => void;
  location: LocationMode;
  onLocation: (m: LocationMode) => void;
  hideHome: boolean;
  onHideHome: (v: boolean) => void;
  /** "On this day": the date reads "5 years ago today". */
  memories?: boolean;
}) {
  const { t } = useI18n();
  const place = location !== 'off';
  return (
    <Field label={t('assign.caption')} group>
      <p className="mb-2 text-xs text-muted">{t(memories ? 'assign.caption_hint_memories' : 'assign.caption_hint')}</p>
      <Chips
        options={[
          { value: 'date', label: t('assign.caption_date'), on: showDate, onChange: onShowDate },
          { value: 'place', label: t('assign.caption_place'), on: place, onChange: (v) => onLocation(v ? 'city_country' : 'off') },
        ]}
      />
      {place && (
        <div className="mt-3">
          <Toggle nested label={t('assign.hide_home_country')} hint={t('assign.hide_home_country_hint')} checked={hideHome} onChange={onHideHome} />
        </div>
      )}
    </Field>
  );
}

const DEFAULT_SCHEDULE: Schedule = { kind: 'days', days: 1, at: '07:00' };

/**
 * Edits one schedule of a Canvas: pass `assignment` to change it, or only `frame` to add one.
 * To add one from the Schedule page, pass `choices` instead of `frame`: the Canvas is picked first.
 */
export function AssignmentEditor({ frame: fixed, assignment, choices, onSaved }: { frame?: Frame; assignment?: Assignment; choices?: Frame[]; onSaved?: () => void }) {
  const { t } = useI18n();
  const confirm = useConfirm();
  const collections = useCollections();
  const [frameId, setFrameId] = useState<number | ''>('');
  const frame = fixed ?? choices?.find((f) => f.id === frameId);
  const a = assignment;
  const [collectionId, setCollectionId] = useState<number | ''>(a?.collectionId ?? '');
  const [orderMode, setOrderMode] = useState<OrderMode>(a?.orderMode ?? 'random');
  const [schedule, setSchedule] = useState<Schedule>(a?.schedule ?? DEFAULT_SCHEDULE);
  const [scheduleOk, setScheduleOk] = useState(true);
  const [windowOn, setWindowOn] = useState(!!a?.activeFrom);
  const [from, setFrom] = useState(a?.activeFrom ?? '08:00');
  const [to, setTo] = useState(a?.activeTo ?? '23:00');
  const [fit, setFit] = useState<FitMode>(a?.fit ?? 'cover');
  const [bg, setBg] = useState(a?.bg ?? '#ffffff');
  const [showDate, setShowDate] = useState(a?.showDate ?? false);
  const [showLocation, setShowLocation] = useState<LocationMode>(a?.showLocation ?? 'off');
  const [hideHome, setHideHome] = useState(a?.hideHomeCountry ?? false);
  const [enabled, setEnabled] = useState(a?.enabled ?? true);

  const collection = collections.data?.find((c) => c.id === collectionId);
  // "On this day" has a fixed timing: one random memory per day, changing at 00:00.
  const isMemories = collection?.type === 'immich_memories';
  const hourly = !isMemories && schedule.kind === 'interval';
  // A new schedule starts empty: everything else waits until a Canvas and a collection are picked.
  const ready = !!frame && !!collectionId;

  const pickCollection = (id: number) => {
    setCollectionId(id);
    if (collections.data?.find((c) => c.id === id)?.type === 'immich_memories') setShowDate(true);
  };

  const save = useAction(
    () => {
      const body = {
        collectionId,
        orderMode,
        schedule,
        activeFrom: hourly && windowOn ? from : null,
        activeTo: hourly && windowOn ? to : null,
        fit,
        bg,
        showDate,
        showLocation,
        hideHomeCountry: hideHome,
        enabled,
      };
      return a
        ? api.put<SavedAssignment>(`/api/assignments/${a.id}`, body)
        : api.post<SavedAssignment>(`/api/frames/${frame!.id}/assignments`, body);
    },
    { success: t('assign.saved'), invalidate: [['frames']] },
  );
  const remove = useAction(() => api.del(`/api/assignments/${a!.id}`), { success: t('assign.removed') });

  if (collections.data && collections.data.length === 0)
    return <p className="text-sm text-muted">{t('assign.no_collections')}</p>;

  return (
    <div className="@container min-w-0 space-y-5">
      {/* Two columns when the editor itself has room (page vs. popup vs. phone), one otherwise. */}
      <div className="grid gap-5 @xl:grid-cols-2 @xl:gap-x-8">
        <div className="min-w-0 space-y-5">
          {choices && (
            <Field label={t('nav.canvas')} group>
              <Select
                aria-label={t('nav.canvas')}
                value={frameId}
                onChange={setFrameId}
                placeholder={t('send.pick_canvas')}
                options={choices.map((f) => ({ value: f.id, label: f.name }))}
              />
            </Field>
          )}
          <Field label={t('assign.collection')} group>
            <Select
              aria-label={t('assign.collection')}
              disabled={!frame}
              value={collectionId}
              onChange={pickCollection}
              placeholder={t('assign.pick_collection')}
              // "On this day" changes daily, so a photo count would be misleading.
              options={(collections.data ?? []).map((c) => ({ value: c.id, label: c.type === 'immich_memories' ? c.name : `${c.name} (${c.itemCount})` }))}
            />
          </Field>

          {isMemories ? (
            <div className="flex gap-3 rounded-2xl bg-surface-2 p-4 text-sm text-ink-2">
              <History className="mt-0.5 size-5 shrink-0 text-accent" />
              <p>{t('assign.memories_info')}</p>
            </div>
          ) : (
            <SchedulePicker
              value={schedule}
              onChange={setSchedule}
              activeFrom={hourly && windowOn ? from : null}
              activeTo={hourly && windowOn ? to : null}
              onValidity={setScheduleOk}
              disabled={!ready}
              compare={frame && collectionId !== '' ? { frameId: frame.id, assignmentId: a?.id, collectionId, enabled } : undefined}
            />
          )}
        </div>

        <fieldset disabled={!ready} className={cx('min-w-0 space-y-5', !ready && 'opacity-50')}>
          {!isMemories && (
            <Field label={t('assign.order')} hint={t(`order.${orderMode}_hint`)} group>
              <Segmented
                fill
                value={orderMode}
                onChange={setOrderMode}
                options={[
                  { value: 'random', label: t('order.random') },
                  { value: 'sequential', label: t('order.sequential') },
                  { value: 'newest', label: t('order.newest') },
                ]}
              />
            </Field>
          )}

          <Field label={t('assign.fit')} group>
            <p className="mb-2 text-xs text-muted">{t('assign.fit_hint')}</p>
            <Segmented
              fill
              value={fit}
              onChange={setFit}
              options={[
                { value: 'cover', label: t('fit.auto') },
                { value: 'contain', label: t('fit.contain') },
                { value: 'blur', label: t('fit.blur') },
              ]}
            />
            <p className="mt-2 text-sm text-muted">{t(`send.${fit === 'cover' ? 'auto' : fit}_hint` as MsgKey)}</p>
            {fit === 'contain' && (
              <div className="mt-3">
                <BgPicker value={bg} onChange={setBg} />
              </div>
            )}
          </Field>

          <CaptionOptions
            showDate={showDate}
            onShowDate={setShowDate}
            location={showLocation}
            onLocation={setShowLocation}
            hideHome={hideHome}
            onHideHome={setHideHome}
            memories={isMemories}
          />

          <div className="space-y-4 rounded-2xl bg-surface-2 p-4">
            {hourly && (
              <div>
                <Toggle label={t('assign.window')} hint={t('assign.window_hint')} checked={windowOn} onChange={setWindowOn} />
                {windowOn && (
                  <div className="mt-3 flex items-center gap-3">
                    <TimeField aria-label={t('assign.window')} value={from} onChange={setFrom} />
                    <span className="text-muted">→</span>
                    <TimeField aria-label={t('assign.window')} value={to} onChange={setTo} />
                  </div>
                )}
              </div>
            )}
            <Toggle label={t('assign.enabled')} hint={t('assign.enabled_hint')} checked={enabled} onChange={setEnabled} />
          </div>
        </fieldset>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          loading={save.isPending}
          disabled={!ready || (!isMemories && !scheduleOk)}
          onClick={() => save.mutate(undefined, { onSuccess: () => onSaved?.() })}
        >
          {t('common.save')}
        </Button>
        {a && (
          <Button
            variant="danger"
            icon={<Trash2 className="size-4" />}
            loading={remove.isPending}
            onClick={async () =>
              (await confirm({ title: t('assign.remove'), message: t('assign.confirm_remove', { name: frame!.name }) })) &&
              remove.mutate(undefined, { onSuccess: onSaved })
            }
          >
            {t('assign.remove')}
          </Button>
        )}
      </div>
    </div>
  );
}
