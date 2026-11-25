import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Search } from 'lucide-react';
import { cx, inputClass, openLayers } from './ui';

export interface SelectOption<T> {
  value: T;
  label: ReactNode;
  /** Plain text for type-ahead when the label isn't a string. */
  text?: string;
  disabled?: boolean;
}

const MENU_MAX = 320;
const GAP = 6;

/**
 * Our own dropdown (Material You menu) instead of the native <select>: a field like the other
 * inputs that opens a list anchored to it, below or above depending on the room left.
 * Keyboard: arrows, Home/End, Enter/Space, Escape and type-ahead, as a listbox.
 * `search` adds a filter box at the top of the menu, for long lists (countries…).
 */
export function Select<T extends string | number>({
  value,
  onChange,
  options,
  placeholder,
  disabled,
  className,
  search,
  'aria-label': ariaLabel,
}: {
  value: T | '' | null | undefined;
  onChange: (v: T) => void;
  options: SelectOption<T>[];
  /** Shown (muted) while nothing is chosen. */
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  /** A filter box at the top of the menu: its placeholder, and what shows when nothing matches. */
  search?: { placeholder: string; empty: string };
  'aria-label'?: string;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [pos, setPos] = useState<CSSProperties>({});
  const typed = useRef({ text: '', at: 0 });
  const searchBox = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');

  const selectedIndex = options.findIndex((o) => o.value === value);
  const selected = options[selectedIndex];
  const textOf = (o: SelectOption<T>) => o.text ?? (typeof o.label === 'string' ? o.label : String(o.value));
  // Accents and case don't matter: "osterreich" finds "Österreich".
  const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const matches = (o: SelectOption<T>, text: string) => !text || fold(textOf(o)).includes(text);
  const q = fold(query.trim());
  // Indexes into `options` of the ones shown, in order.
  const shown = options.map((_, i) => i).filter((i) => matches(options[i], q));

  const place = useCallback(() => {
    const r = trigger.current?.getBoundingClientRect();
    if (!r) return;
    const below = window.innerHeight - r.bottom - GAP - 8;
    const above = r.top - GAP - 8;
    const wanted = Math.min(MENU_MAX, options.length * 44 + 16 + (search ? 56 : 0));
    const up = below < wanted && above > below;
    setPos({
      left: Math.max(8, Math.min(r.left, window.innerWidth - Math.max(r.width, 180) - 8)),
      minWidth: r.width,
      maxWidth: Math.max(r.width, window.innerWidth - 16),
      maxHeight: Math.min(MENU_MAX, up ? above : below),
      ...(up ? { bottom: window.innerHeight - r.top + GAP } : { top: r.bottom + GAP }),
    });
  }, [options.length, search]);

  const show = () => {
    if (disabled) return;
    place();
    setQuery('');
    setActive(selectedIndex >= 0 ? selectedIndex : options.findIndex((o) => !o.disabled));
    setOpen(true);
  };
  const close = (refocus = true) => {
    setOpen(false);
    setQuery('');
    if (refocus) trigger.current?.focus();
  };
  const pick = (i: number) => {
    const o = options[i];
    if (!o || o.disabled) return;
    if (o.value !== value) onChange(o.value);
    close();
  };

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const layer = Symbol();
    openLayers.push(layer);
    const outside = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !trigger.current?.contains(t)) close(false);
    };
    const reposition = () => place();
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', reposition);
    // Scrolling the page (or the sheet the field is in) moves the field: the menu follows it.
    window.addEventListener('scroll', reposition, true);
    return () => {
      openLayers.splice(openLayers.indexOf(layer), 1);
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, place]);

  useEffect(() => {
    if (open && active >= 0) menu.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  useEffect(() => {
    if (open && search) searchBox.current?.focus({ preventScroll: true });
  }, [open, search]);

  // Moves through the options that are shown; from -1 / options.length: the first / last one.
  const step = (from: number, dir: 1 | -1) => {
    const pos = shown.indexOf(from);
    const start = pos >= 0 ? pos : dir === 1 ? -1 : shown.length;
    for (let k = start + dir; k >= 0 && k < shown.length; k += dir) if (!options[shown[k]].disabled) return shown[k];
    return from;
  };
  const filter = (text: string) => {
    setQuery(text);
    const f = fold(text.trim());
    setActive(options.findIndex((o) => !o.disabled && matches(o, f)));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        show();
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActive((a) => step(a, 1));
        return;
      case 'ArrowUp':
        e.preventDefault();
        setActive((a) => step(a, -1));
        return;
      case 'Home':
        if (search) return; // moves the caret in the filter box
        e.preventDefault();
        setActive(step(-1, 1));
        return;
      case 'End':
        if (search) return;
        e.preventDefault();
        setActive(step(options.length, -1));
        return;
      case 'Enter':
        e.preventDefault();
        if (shown.includes(active)) pick(active);
        return;
      case ' ':
        if (search) return; // a space in the filter ("United States")
        e.preventDefault();
        pick(active);
        return;
      case 'Escape':
        // Closing the menu takes it off the layer stack straight away (React flushes effects for key
        // events), so a sheet listening on window would see the same Escape: keep it from getting there.
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      case 'Tab':
        close(false);
        return;
    }
    if (!search && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const now = Date.now();
      typed.current = { text: (now - typed.current.at < 700 ? typed.current.text : '') + e.key.toLowerCase(), at: now };
      const i = options.findIndex((o) => !o.disabled && textOf(o).toLowerCase().startsWith(typed.current.text));
      if (i >= 0) setActive(i);
    }
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        aria-activedescendant={open && active >= 0 ? `${id}-${active}` : undefined}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => (open ? close() : show())}
        onKeyDown={onKeyDown}
        className={cx(
          inputClass,
          'flex items-center justify-between gap-2 text-left disabled:cursor-not-allowed disabled:opacity-50',
          open && 'border-ink/40 bg-surface',
          className,
        )}
      >
        <span className={cx('min-w-0 truncate', !selected && 'text-muted')}>{selected ? selected.label : (placeholder ?? '')}</span>
        <ChevronDown className={cx('size-4 shrink-0 text-muted transition', open && 'rotate-180')} />
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            style={pos}
            className="menu-in fixed z-[70] flex flex-col overflow-hidden rounded-2xl border border-line/70 bg-surface shadow-lift"
            // Clicks inside must not reach whatever is under the menu (e.g. a card-wide button).
            onClick={(e) => e.stopPropagation()}
          >
            {search && (
              <div className="relative shrink-0 border-b border-line/70 p-2">
                <Search className="pointer-events-none absolute top-1/2 left-5 size-4 -translate-y-1/2 text-muted" />
                <input
                  ref={searchBox}
                  type="text"
                  role="combobox"
                  aria-expanded
                  aria-label={search.placeholder}
                  aria-controls={`${id}-menu`}
                  aria-activedescendant={shown.includes(active) ? `${id}-${active}` : undefined}
                  placeholder={search.placeholder}
                  value={query}
                  onChange={(e) => filter(e.target.value)}
                  onKeyDown={onKeyDown}
                  className="h-10 w-full rounded-xl bg-surface-2 pr-3 pl-9 text-sm outline-none placeholder:text-muted"
                />
              </div>
            )}
            <ul id={`${id}-menu`} role="listbox" aria-label={ariaLabel} className="min-h-0 overflow-y-auto py-2">
              {search && !shown.length && <li className="px-5 py-3 text-sm text-muted">{search.empty}</li>}
              {shown.map((i) => {
                const o = options[i];
                return (
              <li
                key={String(o.value)}
                id={`${id}-${i}`}
                data-i={i}
                role="option"
                aria-selected={i === selectedIndex}
                aria-disabled={o.disabled || undefined}
                onPointerEnter={() => !o.disabled && setActive(i)}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => pick(i)}
                className={cx(
                  'mx-2 flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-xl px-3 text-sm transition-colors',
                  o.disabled && 'cursor-default opacity-40',
                  i === selectedIndex ? 'bg-accent-soft font-semibold text-accent' : i === active && 'bg-surface-2',
                  i === selectedIndex && i === active && 'ring-1 ring-accent/30',
                )}
              >
                <span className="min-w-0 truncate">{o.label}</span>
                {i === selectedIndex && <Check className="size-4 shrink-0" />}
              </li>
                );
              })}
            </ul>
          </div>,
          document.body,
        )}
    </>
  );
}
