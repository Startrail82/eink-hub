import { useEffect, useState } from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api, type AiProvider, type AiSettings as AiSettingsData } from '../lib/api';
import { useAction } from '../lib/hooks';
import { useI18n } from '../i18n';
import { Button, Card, Field, inputClass } from './ui';
import { Select } from './Select';

export const useAiSettings = () => useQuery({ queryKey: ['settings', 'ai'], queryFn: () => api.get<AiSettingsData>('/api/settings/ai') });

/** The hub-wide connection to the service that draws the pictures of AI collections. */
export function AiSettings() {
  const { t } = useI18n();
  const ai = useAiSettings();
  const [provider, setProvider] = useState<AiProvider>('');
  const [values, setValues] = useState({ url: '', username: '', model: '', size: '', workflow: '' });
  const [key, setKey] = useState('');
  const [test, setTest] = useState<{ ok: boolean; server?: string; error?: string } | null>(null);

  useEffect(() => {
    if (!ai.data) return;
    setProvider(ai.data.provider);
    setValues({ url: ai.data.url, username: ai.data.username, model: ai.data.model, size: ai.data.size, workflow: ai.data.workflow });
  }, [ai.data]);

  const providers = ai.data?.providers ?? [];
  const current = providers.find((p) => p.id === provider);
  const form = () => ({ provider, ...values, ...(key ? { apiKey: key } : {}) });
  const save = useAction(() => api.put('/api/settings/ai', form()), {
    success: t('ai.saved'),
    invalidate: [['settings', 'ai']],
  });
  const runTest = useAction(() => api.post<{ ok: boolean; server?: string; error?: string }>('/api/settings/ai/test', form()), { invalidate: [] });

  return (
    <Card className="p-6">
      <h2 className="text-lg font-bold">{t('ai.title')}</h2>
      <p className="mt-1 text-sm text-muted">{t('ai.hint')}</p>
      <div className="mt-5 space-y-4">
        <Field label={t('ai.provider')} group>
          <Select
            aria-label={t('ai.provider')}
            value={provider}
            onChange={(v) => {
              setProvider(v);
              setTest(null);
            }}
            options={[{ value: '', label: t('ai.provider_none') }, ...providers.map((p) => ({ value: p.id, label: p.label }))]}
          />
        </Field>
        {current && current.presets.length > 1 && (
          <Field label={t('ai.preset')} group>
            <Select
              aria-label={t('ai.preset')}
              value=""
              onChange={(id) => {
                const preset = current.presets.find((x) => x.id === id);
                if (!preset) return;
                setValues((v) => ({ ...v, url: preset.url, model: preset.model, size: preset.size }));
              }}
              options={[{ value: '', label: t('ai.preset_choose') }, ...current.presets.map((x) => ({ value: x.id, label: x.label }))]}
            />
          </Field>
        )}
        {current?.fields.map((f) => {
          const label = f.label ? t(f.label as never) : (f.text ?? f.key);
          const hint = f.key === 'apiKey' && ai.data?.apiKeySet ? t('settings.immich_key_set') : f.hint ? t(f.hint as never) : undefined;
          return (
            <Field key={f.key} label={label} hint={hint}>
              {f.type === 'textarea' ? (
                <textarea
                  className={`${inputClass} h-56 resize-y py-3 font-mono text-xs`}
                  spellCheck={false}
                  placeholder={f.placeholder}
                  value={values[f.key as keyof typeof values]}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key as keyof typeof values]: e.target.value }))}
                />
              ) : f.key === 'apiKey' ? (
                <input className={inputClass} type="password" autoComplete="new-password" placeholder={ai.data?.apiKeySet ? '••••••••' : ''} value={key} onChange={(e) => setKey(e.target.value)} />
              ) : (
                <input className={inputClass} autoComplete="off" placeholder={f.placeholder} value={values[f.key as keyof typeof values]} onChange={(e) => setValues((v) => ({ ...v, [f.key as keyof typeof values]: e.target.value }))} />
              )}
            </Field>
          );
        })}
        {test && (
          <p className={`flex items-center gap-2 text-sm font-medium ${test.ok ? 'text-leaf' : 'text-red-600'}`}>
            {test.ok ? <CheckCircle2 className="size-4 shrink-0" /> : <XCircle className="size-4 shrink-0" />}
            <span className="min-w-0 [overflow-wrap:anywhere]">{test.ok ? t('ai.connected', { server: test.server ?? '' }) : test.error}</span>
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            {t('common.save')}
          </Button>
          {provider !== '' && (
            <Button loading={runTest.isPending} onClick={() => runTest.mutate(undefined, { onSuccess: setTest })}>
              {t('ai.test')}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
