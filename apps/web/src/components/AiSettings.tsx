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
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [username, setUsername] = useState('');
  const [model, setModel] = useState('');
  const [size, setSize] = useState('');
  const [workflow, setWorkflow] = useState('');
  const [test, setTest] = useState<{ ok: boolean; server?: string; error?: string } | null>(null);

  useEffect(() => {
    if (!ai.data) return;
    setProvider(ai.data.provider);
    setUrl(ai.data.url);
    setUsername(ai.data.username);
    setModel(ai.data.model);
    setSize(ai.data.size);
    setWorkflow(ai.data.workflow);
  }, [ai.data]);

  const form = () => ({ provider, url, model, size, workflow, username, ...(key ? { apiKey: key } : {}) });
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
              setProvider(v as AiProvider);
              setTest(null);
            }}
            options={[
              { value: '', label: t('ai.provider_none') },
              { value: 'openai', label: 'OpenAI' },
              { value: 'comfyui', label: 'ComfyUI' },
            ]}
          />
        </Field>
        {provider !== '' && (
          <Field label={t('ai.url')} hint={provider === 'openai' ? t('ai.url_hint_openai') : t('ai.url_hint_comfyui')}>
            <input className={inputClass} placeholder={provider === 'openai' ? 'https://api.openai.com/v1' : 'http://192.168.1.30:8188'} value={url} onChange={(e) => setUrl(e.target.value)} />
          </Field>
        )}
        {provider === 'openai' && (
          <>
            <Field label="API key" hint={ai.data?.apiKeySet ? t('settings.immich_key_set') : undefined}>
              <input className={inputClass} type="password" placeholder={ai.data?.apiKeySet ? '••••••••' : ''} value={key} onChange={(e) => setKey(e.target.value)} />
            </Field>
            <Field label={t('ai.model')} hint={t('ai.model_hint')}>
              <input className={inputClass} placeholder="gpt-image-1" value={model} onChange={(e) => setModel(e.target.value)} />
            </Field>
            <Field label={t('ai.size')} hint={t('ai.size_hint')}>
              <input className={inputClass} placeholder="1024x1536" value={size} onChange={(e) => setSize(e.target.value)} />
            </Field>
          </>
        )}
        {provider === 'comfyui' && (
          <Field label={t('login.username')} hint={t('ai.auth_hint')} group>
            <div className="grid grid-cols-2 gap-3">
              <input className={inputClass} autoComplete="off" aria-label={t('login.username')} placeholder={t('login.username')} value={username} onChange={(e) => setUsername(e.target.value)} />
              <input
                className={inputClass}
                type="password"
                autoComplete="new-password"
                aria-label={t('login.password')}
                placeholder={ai.data?.apiKeySet ? '••••••••' : t('login.password')}
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
            </div>
          </Field>
        )}
        {provider === 'comfyui' && (
          <Field label={t('ai.workflow')} hint={t('ai.workflow_hint')}>
            <textarea
              className={`${inputClass} h-56 resize-y py-3 font-mono text-xs`}
              spellCheck={false}
              placeholder='{"6": {"class_type": "CLIPTextEncode", "inputs": {"text": "{{prompt}}"}}}'
              value={workflow}
              onChange={(e) => setWorkflow(e.target.value)}
            />
          </Field>
        )}
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
