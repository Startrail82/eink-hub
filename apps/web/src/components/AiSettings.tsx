import { useEffect, useState } from 'react';
import { CheckCircle2, ChevronDown, XCircle } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api, type AiProvider, type AiProviderField, type AiSettings as AiSettingsData, type AiTestResult } from '../lib/api';
import { useAction } from '../lib/hooks';
import { useI18n } from '../i18n';
import { Button, Card, Field, inputClass, useConfirm } from './ui';
import { Select } from './Select';

export const useAiSettings = () => useQuery({ queryKey: ['settings', 'ai'], queryFn: () => api.get<AiSettingsData>('/api/settings/ai') });

type Values = { url: string; username: string; model: string; size: string; workflow: string };

/** "Another model…" in the model list: switches to typing the name. */
const OTHER = '__other__';

/** The hub-wide connection to the service that draws the pictures of AI collections. */
export function AiSettings() {
  const { t } = useI18n();
  const ai = useAiSettings();
  const [provider, setProvider] = useState<AiProvider>('');
  const [values, setValues] = useState<Values>({ url: '', username: '', model: '', size: '', workflow: '' });
  const [key, setKey] = useState('');
  const [test, setTest] = useState<AiTestResult | null>(null);
  /** Image models found by the last connection test (or for the saved service), null before any. */
  const [models, setModels] = useState<string[] | null>(null);
  const [typing, setTyping] = useState(false);

  const providers = ai.data?.providers ?? [];
  const current = providers.find((p) => p.id === provider);
  const saved = !!ai.data && provider === ai.data.provider;
  /** A hosted service (Gemini, OpenAI): no address to fill in, and its models come from the connection test. */
  const hosted = !!current?.listsModels && !current.fields.some((x) => x.key === 'url');

  // The saved service's models, so the list is there without testing again.
  const savedModels = useQuery({
    queryKey: ['settings', 'ai', 'models'],
    queryFn: () => api.get<{ models: string[] }>('/api/settings/ai/models'),
    enabled: !!ai.data?.configured && !!providers.find((p) => p.id === ai.data?.provider)?.listsModels,
  });

  useEffect(() => {
    if (!ai.data) return;
    setProvider(ai.data.provider);
    setValues({ url: ai.data.url, username: ai.data.username, model: ai.data.model, size: ai.data.size, workflow: ai.data.workflow });
    setKey('');
  }, [ai.data]);

  useEffect(() => {
    if (saved && savedModels.data?.models.length) setModels(savedModels.data.models);
  }, [saved, savedModels.data]);

  const set = (k: keyof Values, v: string) => setValues((x) => ({ ...x, [k]: v }));
  const form = () => ({ provider, ...values, ...(key ? { apiKey: key } : {}) });
  const save = useAction(() => api.put('/api/settings/ai', form()), {
    success: t('ai.saved'),
    // ['settings'] too: it says whether AI collections can be made.
    invalidate: [['settings']],
  });
  const runTest = useAction(() => api.post<AiTestResult>('/api/settings/ai/test', form()), { invalidate: [] });
  const confirm = useConfirm();
  const remove = useAction(() => api.del('/api/settings/ai'), {
    success: t('ai.removed'),
    invalidate: [['settings']],
  });

  const choose = (id: string) => {
    setProvider(id);
    setTest(null);
    setModels(null);
    setTyping(false);
    setKey('');
    // Back to the saved service: its saved model. Another one: empty, filled from the list (hosted)
    // or typed in.
    set('model', ai.data && id === ai.data.provider ? ai.data.model : '');
  };

  const label = (f: AiProviderField) => (f.label ? t(f.label as never) : (f.text ?? f.key));
  const hintOf = (f: AiProviderField) => {
    if (f.key === 'apiKey' && saved && ai.data?.apiKeySet) return t('settings.immich_key_set');
    if (f.key === 'model' && current?.listsModels) {
      // A hosted service lists only image models; another service lists them all.
      if (models?.length && !typing) return t(hosted ? 'ai.model_hint_listed' : 'ai.model_hint_all');
      return t(hosted ? 'ai.model_hint_list' : 'ai.model_hint');
    }
    return f.hint ? t(f.hint as never) : undefined;
  };

  const input = (f: AiProviderField) => {
    if (f.type === 'textarea')
      return (
        <textarea
          className={`${inputClass} h-56 resize-y py-3 font-mono text-xs`}
          spellCheck={false}
          placeholder={f.placeholder}
          value={values[f.key as keyof Values]}
          onChange={(e) => set(f.key as keyof Values, e.target.value)}
        />
      );
    if (f.key === 'apiKey')
      return (
        <input
          className={inputClass}
          type="password"
          autoComplete="new-password"
          placeholder={saved && ai.data?.apiKeySet ? '••••••••' : ''}
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
      );
    // The models the service offers, once known; "Another model…" to type one it doesn't list.
    if (f.key === 'model' && models?.length && !typing) {
      const options = [...new Set([...(values.model ? [values.model] : []), ...models])];
      return (
        <Select
          aria-label={label(f)}
          value={values.model}
          onChange={(v) => (v === OTHER ? setTyping(true) : set('model', String(v)))}
          options={[...options.map((m) => ({ value: m, label: m })), { value: OTHER, label: t('ai.model_other') }]}
        />
      );
    }
    // A hosted service's model is picked from its list: nothing to type until the connection test brings it.
    const locked = f.key === 'model' && hosted && !typing;
    return (
      <input
        className={`${inputClass} disabled:cursor-not-allowed disabled:opacity-50`}
        autoComplete="off"
        disabled={locked}
        placeholder={locked ? '' : f.placeholder}
        value={locked ? '' : values[f.key as keyof Values]}
        onChange={(e) => set(f.key as keyof Values, e.target.value)}
      />
    );
  };

  const field = (f: AiProviderField) => (
    <Field key={f.key} label={label(f)} hint={hintOf(f)} hintFirst group={f.key === 'model' && !!models?.length && !typing}>
      {input(f)}
    </Field>
  );

  const basic = current?.fields.filter((f) => !f.advanced) ?? [];
  const advanced = current?.fields.filter((f) => f.advanced) ?? [];

  return (
    <Card className="p-6">
      <h2 className="text-lg font-bold">{t('ai.title')}</h2>
      <p className="mt-1 text-sm text-muted">{t('ai.hint')}</p>
      <div className="mt-5 space-y-4">
        <Field label={t('ai.provider')} group>
          <Select
            aria-label={t('ai.provider')}
            value={provider}
            onChange={(v) => choose(String(v))}
            // "Not set up" only until a service is saved; after that, "Remove configuration" clears it.
            options={[
              ...(ai.data?.provider ? [] : [{ value: '', label: t('ai.provider_none') }]),
              ...providers.map((p) => ({ value: p.id, label: p.labelKey ? t(p.labelKey as never) : p.label })),
            ]}
          />
        </Field>
        {basic.map(field)}
        {advanced.length > 0 && (
          <details className="group rounded-2xl border border-line px-4 py-3">
            <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-semibold">
              {t('ai.advanced')}
              <ChevronDown className="size-4 text-muted transition group-open:rotate-180" />
            </summary>
            <div className="mt-4 space-y-4">{advanced.map(field)}</div>
          </details>
        )}
        {test && (
          <p className={`flex items-center gap-2 text-sm font-medium ${test.ok ? 'text-leaf' : 'text-red-600'}`}>
            {test.ok ? <CheckCircle2 className="size-4 shrink-0" /> : <XCircle className="size-4 shrink-0" />}
            <span className="min-w-0 [overflow-wrap:anywhere]">
              {test.ok
                ? test.models
                  ? t('ai.connected_models', { server: test.server ?? '', count: String(test.models.length) })
                  : t('ai.connected', { server: test.server ?? '' })
                : test.error}
            </span>
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            {t('common.save')}
          </Button>
          {provider !== '' && (
            <Button
              loading={runTest.isPending}
              onClick={() =>
                runTest.mutate(undefined, {
                  onSuccess: (r) => {
                    setTest(r);
                    if (r.ok && r.models) {
                      setModels(r.models);
                      // Nothing chosen yet: the default model if this account has it, else the first one offered.
                      const def = current?.defaultModel;
                      if (!values.model && r.models.length && !typing) set('model', def && r.models.includes(def) ? def : r.models[0]);
                    }
                  },
                })
              }
            >
              {t('ai.test')}
            </Button>
          )}
          {!!ai.data?.provider && (
            <Button
              variant="danger"
              className="sm:ml-auto"
              loading={remove.isPending}
              onClick={async () =>
                (await confirm({ title: t('settings.immich_remove'), message: t('ai.confirm_remove') })) &&
                remove.mutate(undefined, {
                  onSuccess: () => {
                    setKey('');
                    setTest(null);
                    setModels(null);
                    setTyping(false);
                  },
                })
              }
            >
              {t('settings.immich_remove')}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
