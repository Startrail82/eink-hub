import { useEffect, useMemo, useState } from 'react';
import { LocateFixed, MapPin, Search } from 'lucide-react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api, type Place } from '../lib/api';
import { languages, useI18n } from '../i18n';
import { Button, Field, Spinner, cx, fieldWidth, inputClass, useToast } from './ui';

/** Country names in the UI language ("España"), falling back to the English name the hub stores. */
export function useCountryName() {
  const { lang } = useI18n();
  return useMemo(() => {
    const locale = languages.find((l) => l.code === lang)?.locale ?? lang;
    let names: Intl.DisplayNames | null = null;
    try {
      names = new Intl.DisplayNames([locale, 'en'], { type: 'region' });
    } catch {
      // No region names in this browser: English only.
    }
    return (p: Pick<Place, 'country' | 'countryCode'>) => (p.countryCode && names?.of(p.countryCode)) || p.country;
  }, [lang]);
}

/** "Basque Country, España": what tells places with the same name apart. */
export function useWhere() {
  const country = useCountryName();
  return (p: Place) => [p.region, country(p)].filter((s, i, all) => s && all.indexOf(s) === i).join(', ');
}

const coords = (p: Pick<Place, 'latitude' | 'longitude'>) => `${p.latitude.toFixed(3)}, ${p.longitude.toFixed(3)}`;

/** Debounced copy of a value, so the place search doesn't run on every key press. */
function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

/**
 * Pick a place: search the hub's offline place list, type coordinates, or ask the browser.
 * The search runs on the hub; nothing goes to an outside service.
 */
export function LocationPicker({ value, onChange, saving }: { value: Place | null; onChange: (p: Place | null) => void; saving?: boolean }) {
  const { t } = useI18n();
  const toast = useToast();
  const where = useWhere();
  const [query, setQuery] = useState('');
  const [manual, setManual] = useState(false);
  const [lat, setLat] = useState('');
  const [lon, setLon] = useState('');
  const [locating, setLocating] = useState(false);
  const q = useDebounced(query.trim(), 250);
  const results = useQuery({
    queryKey: ['places', q],
    queryFn: () => api.get<Place[]>(`/api/places?q=${encodeURIComponent(q)}`),
    enabled: q.length >= 2,
    placeholderData: keepPreviousData,
    staleTime: Infinity,
  });
  // Geolocation only works on https (or localhost).
  const canLocate = typeof window !== 'undefined' && window.isSecureContext && 'geolocation' in navigator;

  const pick = (p: Place) => {
    onChange(p);
    setQuery('');
    setManual(false);
  };
  /** Coordinates from the form or the browser: named after the nearest listed place, if any. */
  const fromCoords = async (latitude: number, longitude: number) => {
    try {
      const near = await api.get<Place | null>(`/api/places/reverse?lat=${latitude}&lon=${longitude}`);
      // Keep the exact position; the hub fills in a name when no place is near.
      pick({ name: near?.name ?? '', region: near?.region ?? '', country: near?.country ?? '', countryCode: near?.countryCode ?? '', latitude, longitude });
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const locate = () => {
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        await fromCoords(Math.round(pos.coords.latitude * 1000) / 1000, Math.round(pos.coords.longitude * 1000) / 1000);
        setLocating(false);
      },
      () => {
        toast(t('location.locate_failed'), 'error');
        setLocating(false);
      },
      { timeout: 15_000, maximumAge: 600_000 },
    );
  };

  return (
    <div className="space-y-4">
      {value && (
        <div className={cx('flex items-start gap-3 rounded-2xl bg-surface-2 p-4', fieldWidth)}>
          <MapPin className="mt-0.5 size-5 shrink-0 text-muted" />
          <div className="min-w-0 flex-1">
            <div className="font-semibold [overflow-wrap:anywhere]">{value.name}</div>
            <div className="text-xs text-muted">
              {[where(value), coords(value)].filter(Boolean).join(' · ')}
            </div>
          </div>
          <Button size="sm" variant="secondary" loading={saving} onClick={() => onChange(null)}>
            {t('location.remove')}
          </Button>
        </div>
      )}

      <div className={cx('relative', fieldWidth)}>
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
        <input
          className={`${inputClass} pl-9`}
          type="search"
          aria-label={t('location.search')}
          placeholder={t('location.search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {q.length >= 2 && query.trim() && (
          <div className="mt-2 max-h-72 overflow-y-auto rounded-2xl border border-line bg-surface p-1 shadow-sm" role="listbox" aria-label={t('location.search')}>
            {results.isLoading ? (
              <div className="p-3">
                <Spinner />
              </div>
            ) : results.data?.length ? (
              results.data.map((p) => (
                <button
                  key={`${p.name}|${p.latitude}|${p.longitude}`}
                  type="button"
                  role="option"
                  aria-selected={false}
                  className="block w-full rounded-xl px-3 py-2 text-left hover:bg-surface-2 focus:bg-surface-2 focus:outline-none"
                  onClick={() => pick(p)}
                >
                  <span className="block text-sm font-semibold">{p.name}</span>
                  <span className="block text-xs text-muted">{where(p)}</span>
                </button>
              ))
            ) : (
              <p className="p-3 text-sm text-muted">{t('location.no_match')}</p>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        {canLocate && (
          <Button size="sm" variant="secondary" icon={<LocateFixed className="size-4" />} loading={locating} onClick={locate}>
            {t('location.use_mine')}
          </Button>
        )}
        <Button size="sm" variant="secondary" onClick={() => setManual((m) => !m)}>
          {t('location.coordinates')}
        </Button>
      </div>

      {manual && (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void fromCoords(Number(lat.replace(',', '.')), Number(lon.replace(',', '.')));
          }}
        >
          <Field label={t('location.latitude')}>
            <input className={`${inputClass} w-36`} inputMode="decimal" placeholder="43.313" value={lat} onChange={(e) => setLat(e.target.value)} required />
          </Field>
          <Field label={t('location.longitude')}>
            <input className={`${inputClass} w-36`} inputMode="decimal" placeholder="-1.975" value={lon} onChange={(e) => setLon(e.target.value)} required />
          </Field>
          <Button type="submit" variant="primary" size="sm">
            {t('location.use_coordinates')}
          </Button>
        </form>
      )}
    </div>
  );
}
