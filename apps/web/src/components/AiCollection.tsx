import { useEffect, useState } from 'react';
import { api, type AiCollectionConfig, type AiSource, type Collection } from '../lib/api';
import { useAction, useFrames } from '../lib/hooks';
import { DEFAULT_PANEL, panelKey, panelOptions } from '../lib/panels';
import { useI18n, type MsgKey } from '../i18n';
import { Button, Field, Modal, Segmented, inputClass } from './ui';
import { Select } from './Select';
import { useAiSettings } from './AiSettings';

const DEFAULT_KEEP = 20;

function configOf(c?: Collection): AiCollectionConfig {
  const raw = (c?.config ?? {}) as Partial<AiCollectionConfig>;
  return {
    source: raw.source ?? 'prompt',
    prompt: raw.prompt ?? '',
    feedUrl: raw.feedUrl ?? '',
    latitude: raw.latitude ?? null,
    longitude: raw.longitude ?? null,
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
  const [lat, setLat] = useState('');
  const [lon, setLon] = useState('');
  const [keep, setKeep] = useState(String(DEFAULT_KEEP));

  useEffect(() => {
    if (!open) return;
    const c = configOf(collection);
    // Nothing chosen yet (new, or made before this setting existed): start from the first frame showing it, else any frame.
    if (!c.panel) {
      const first = frames.data?.find((f) => f.assignment?.collectionId === collection?.id) ?? (collection ? undefined : frames.data?.[0]);
      c.panel = first ? panelKey(first) : DEFAULT_PANEL;
      if (first) c.orientation = first.orientation;
    }
    setName(collection?.name ?? '');
    setCfg(c);
    setLat(c.latitude === null ? '' : String(c.latitude));
    setLon(c.longitude === null ? '' : String(c.longitude));
    setKeep(String(c.keep));
  }, [open, collection, frames.data]);

  const set = <K extends keyof AiCollectionConfig>(k: K, v: AiCollectionConfig[K]) => setCfg((c) => ({ ...c, [k]: v }));
  const num = (s: string) => (s.trim() === '' || !Number.isFinite(Number(s)) ? null : Number(s));
  const config = (): AiCollectionConfig => ({ ...cfg, latitude: num(lat), longitude: num(lon), keep: Math.max(0, Math.floor(Number(keep) || 0)) });

  const save = useAction(
    () =>
      collection
        ? api.patch<Collection>(`/api/collections/${collection.id}`, { name: name.trim(), config: config() })
        : api.post<Collection>('/api/collections', { name: name.trim(), type: 'ai', config: config() }),
    { success: t(collection ? 'ai.saved' : 'library.created'), invalidate: [['collections']] },
  );

  const complete =
    !!name.trim() &&
    (cfg.source === 'prompt' ? !!cfg.prompt.trim() : cfg.source === 'rss' ? /^https?:\/\//i.test(cfg.feedUrl.trim()) : num(lat) !== null && num(lon) !== null);
  const hint: Record<AiSource, MsgKey> = { prompt: 'ai.prompt_hint_prompt', rss: 'ai.prompt_hint_rss', weather: 'ai.prompt_hint_weather' };

  return (
    <Modal open={open} onClose={onClose} title={collection ? t('ai.collection_edit') : t('library.new_ai')}>
      <div className="space-y-4">
        {ai.data && !ai.data.configured && <p className="rounded-2xl bg-surface-2 px-4 py-3 text-sm text-muted">{t('ai.setup_needed')}</p>}
        <Field label={t('common.name')}>
          <input className={inputClass} autoFocus={!collection} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('library.name_placeholder')} />
        </Field>
        <Field label={t('ai.source')} group>
          <Select
            aria-label={t('ai.source')}
            value={cfg.source}
            onChange={(v) => set('source', v as AiSource)}
            options={[
              { value: 'prompt', label: t('ai.source_prompt') },
              { value: 'rss', label: t('ai.source_rss') },
              { value: 'weather', label: t('ai.source_weather') },
            ]}
          />
        </Field>
        {cfg.source === 'rss' && (
          <Field label={t('ai.feed_url')}>
            <input className={inputClass} placeholder="https://example.org/feed.xml" value={cfg.feedUrl} onChange={(e) => set('feedUrl', e.target.value)} />
          </Field>
        )}
        {cfg.source === 'weather' && (
          <Field label={t('ai.latitude')} hint={t('ai.location_hint')} group>
            <div className="grid grid-cols-2 gap-3">
              <input className={inputClass} inputMode="decimal" aria-label={t('ai.latitude')} placeholder={t('ai.latitude')} value={lat} onChange={(e) => setLat(e.target.value)} />
              <input className={inputClass} inputMode="decimal" aria-label={t('ai.longitude')} placeholder={t('ai.longitude')} value={lon} onChange={(e) => setLon(e.target.value)} />
            </div>
          </Field>
        )}
        <Field label={t('ai.prompt')} hint={t(hint[cfg.source])}>
          <textarea className={`${inputClass} h-28 resize-y py-3`} value={cfg.prompt} onChange={(e) => set('prompt', e.target.value)} />
        </Field>
        <Field label={t('ai.panel')} hint={t('ai.panel_hint')} group>
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
        <Field label={t('ai.keep')} hint={t('ai.keep_hint')}>
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
