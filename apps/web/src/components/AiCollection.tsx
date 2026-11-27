import { useEffect, useRef, useState } from 'react';
import { api, type AiCollectionConfig, type AiSource, type Collection } from '../lib/api';
import { useAction, useFrames } from '../lib/hooks';
import { DEFAULT_PANEL, panelKey, panelOptions } from '../lib/panels';
import { useI18n, type MsgKey } from '../i18n';
import { Button, Field, Modal, Segmented, inputClass } from './ui';
import { Select } from './Select';
import { useAiSettings } from './AiSettings';

const DEFAULT_KEEP = 20;

/** Placeholders each source fills in (see the server's lib/ai/sources). */
const WEATHER_TAGS = ['condition', 'temperature', 'high', 'low', 'wind', 'daypart', 'sunrise', 'sunset'];
const TAGS: Record<AiSource, string[]> = {
  prompt: ['pick', ...WEATHER_TAGS, 'date', 'time', 'season'],
  rss: ['pick', 'title', 'description', ...WEATHER_TAGS, 'date', 'time', 'season'],
};

/** What each placeholder becomes, shown next to it. */
const TAG_HINT: Record<string, MsgKey> = {
  pick: 'ai.pick_hint',
  date: 'ai.tag_date',
  time: 'ai.tag_time',
  season: 'ai.tag_season',
  title: 'ai.tag_title',
  description: 'ai.tag_description',
  condition: 'ai.tag_condition',
  temperature: 'ai.tag_temperature',
  high: 'ai.tag_high',
  low: 'ai.tag_low',
  wind: 'ai.tag_wind',
  daypart: 'ai.tag_daypart',
  sunrise: 'ai.tag_sunrise',
  sunset: 'ai.tag_sunset',
};

/** The placeholders with what each one becomes; click one to add it to the prompt. */
function TagChips({ tags, onPick }: { tags: string[]; onPick: (tag: string) => void }) {
  const { t } = useI18n();
  return (
    <ul className="mt-2 space-y-1.5">
      {tags.map((tag) => (
        <li key={tag} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          <button
            type="button"
            title={t('ai.tag_insert')}
            className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2.5 py-1 font-mono text-xs text-ink-2 transition hover:bg-accent/10 hover:text-accent"
            onClick={() => onPick(tag === 'pick' ? '{pick: one | two | three}' : `{${tag}}`)}
          >
            {tag === 'pick' ? '{pick: … | …}' : `{${tag}}`}
          </button>
          {t(TAG_HINT[tag])}
        </li>
      ))}
    </ul>
  );
}

function configOf(c?: Collection): AiCollectionConfig {
  const raw = (c?.config ?? {}) as Partial<AiCollectionConfig>;
  return {
    source: raw.source ?? 'prompt',
    prompt: raw.prompt ?? '',
    weatherOffset: Math.min(47, Math.max(0, Math.floor(Number(raw.weatherOffset) || 0))),
    negative: raw.negative ?? '',
    feedUrl: raw.feedUrl ?? '',
    keep: raw.keep ?? DEFAULT_KEEP,
    panel: raw.panel ?? null,
    orientation: raw.orientation === 'landscape' ? 'landscape' : 'portrait',
  };
}

/** Create an AI collection, or change the settings of an existing one. */
export function AiCollectionDialog({ open, onClose, collection, onCreated }: { open: boolean; onClose: () => void; collection?: Collection; onCreated?: (c: Collection) => void }) {
  const { t } = useI18n();
  const ai = useAiSettings();
  const frames = useFrames();
  const [name, setName] = useState('');
  const [cfg, setCfg] = useState<AiCollectionConfig>(configOf());
  const [keep, setKeep] = useState(String(DEFAULT_KEEP));

  useEffect(() => {
    if (!open) return;
    const c = configOf(collection);
    // Nothing chosen yet (new, or made before this setting existed): start from the first Canvas showing it, else any Canvas.
    if (!c.panel) {
      const first = frames.data?.find((f) => f.assignment?.collectionId === collection?.id) ?? (collection ? undefined : frames.data?.[0]);
      c.panel = first ? panelKey(first) : DEFAULT_PANEL;
      if (first) c.orientation = first.orientation;
    }
    setName(collection?.name ?? '');
    setCfg(c);
    caret.current = null;
    setKeep(String(c.keep));
  }, [open, collection, frames.data]);

  const promptRef = useRef<HTMLTextAreaElement>(null);
  /** Where the cursor was in the prompt; clicking a tag takes the focus away. Null: at the end. */
  const caret = useRef<{ start: number; end: number } | null>(null);
  /** Put a placeholder where the cursor is (or at the end), with a space around it when needed. */
  const insertTag = (tag: string) => {
    const at = caret.current;
    setCfg((c) => {
      const text = c.prompt;
      const start = Math.min(at?.start ?? text.length, text.length);
      const end = Math.min(at?.end ?? start, text.length);
      const before = text.slice(0, start);
      const after = text.slice(end);
      const piece = `${before && !/\s$/.test(before) ? ' ' : ''}${tag}${after && !/^\s/.test(after) ? ' ' : ''}`;
      const pos = before.length + piece.length;
      caret.current = { start: pos, end: pos };
      return { ...c, prompt: before + piece + after };
    });
    requestAnimationFrame(() => {
      const el = promptRef.current;
      const pos = caret.current?.start;
      if (!el || pos === undefined) return;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };
  const set = <K extends keyof AiCollectionConfig>(k: K, v: AiCollectionConfig[K]) => setCfg((c) => ({ ...c, [k]: v }));
  const config = (): AiCollectionConfig => ({ ...cfg, keep: Math.max(0, Math.floor(Number(keep) || 0)) });

  const save = useAction(
    () =>
      collection
        ? api.patch<Collection>(`/api/collections/${collection.id}`, { name: name.trim(), config: config() })
        : api.post<Collection>('/api/collections', { name: name.trim(), type: 'ai', config: config() }),
    { success: t(collection ? 'ai.saved' : 'library.created'), invalidate: [['collections']] },
  );

  const complete =
    !!name.trim() &&
    (cfg.source === 'prompt' ? !!cfg.prompt.trim() : /^https?:\/\//i.test(cfg.feedUrl.trim()));
  const hint: Record<AiSource, MsgKey> = { prompt: 'ai.prompt_hint_prompt', rss: 'ai.prompt_hint_rss' };

  return (
    <Modal open={open} onClose={onClose} title={collection ? t('ai.collection_edit') : t('library.new_ai')}>
      <div className="space-y-4">
        {ai.data && !ai.data.configured && <p className="rounded-2xl bg-surface-2 px-4 py-3 text-sm text-muted">{t('ai.setup_needed')}</p>}
        <Field label={t('common.name')}>
          <input className={inputClass} autoFocus={!collection} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('library.name_placeholder')} />
        </Field>
        <Field label={t('ai.source')} group>
          <Segmented
            fill
            value={cfg.source}
            onChange={(v) => set('source', v)}
            options={[
              { value: 'prompt', label: t('ai.source_prompt') },
              { value: 'rss', label: t('ai.source_rss') },
            ]}
          />
        </Field>
        {cfg.source === 'rss' && (
          <Field label={t('ai.feed_url')} hint={t('ai.feed_hint')} hintFirst>
            <input className={inputClass} placeholder="https://example.org/feed.xml" value={cfg.feedUrl} onChange={(e) => set('feedUrl', e.target.value)} />
          </Field>
        )}
        <Field label={t('ai.weather_offset')} hint={t('ai.weather_offset_hint')}>
          <input
            className={inputClass}
            type="number"
            inputMode="numeric"
            min={0}
            max={47}
            step={1}
            value={cfg.weatherOffset}
            onChange={(e) => set('weatherOffset', Math.min(47, Math.max(0, Math.floor(Number(e.target.value) || 0))))}
          />
        </Field>
        <Field label={t('ai.prompt')} hint={t(hint[cfg.source])} hintFirst group>
          <textarea
            ref={promptRef}
            aria-label={t('ai.prompt')}
            className={`${inputClass} h-28 resize-y py-3`}
            value={cfg.prompt}
            onChange={(e) => set('prompt', e.target.value)}
            // Remember where the cursor is, since clicking a tag takes the focus away.
            onSelect={(e) => (caret.current = { start: e.currentTarget.selectionStart, end: e.currentTarget.selectionEnd })}
          />
          <TagChips tags={TAGS[cfg.source]} onPick={insertTag} />
        </Field>
        {ai.data?.provider === 'comfyui' && (
          <Field label={t('ai.negative')} hint={t('ai.negative_hint')}>
            <textarea className={`${inputClass} h-20 resize-y py-3`} value={cfg.negative} onChange={(e) => set('negative', e.target.value)} />
          </Field>
        )}
        <Field label={t('ai.panel')} hint={t('ai.panel_hint')} hintFirst group>
          <div className="space-y-3">
            <Select aria-label={t('ai.panel')} value={cfg.panel ?? DEFAULT_PANEL} onChange={(v) => set('panel', String(v))} options={panelOptions(frames.data)} />
            <Segmented
              fill
              value={cfg.orientation}
              onChange={(v) => set('orientation', v)}
              options={[
                { value: 'portrait', label: t('canvasSettings.portrait') },
                { value: 'landscape', label: t('canvasSettings.landscape') },
              ]}
            />
          </div>
        </Field>
        <Field label={t('ai.keep')} hint={t('ai.keep_hint')} hintFirst>
          <input className={inputClass} type="number" min={0} step={1} value={keep} onChange={(e) => setKeep(e.target.value)} />
        </Field>
      </div>
      <Button
        variant="primary"
        className="mt-5 w-full"
        disabled={!complete}
        loading={save.isPending}
        onClick={() =>
          save.mutate(undefined, {
            onSuccess: (c) => {
              if (!collection) onCreated?.(c);
              onClose();
            },
          })
        }
      >
        {collection ? t('common.save') : t('common.create')}
      </Button>
    </Modal>
  );
}
