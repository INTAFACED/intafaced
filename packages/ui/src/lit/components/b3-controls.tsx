/**
 * Controls a working room needs beyond the first sheets: a listbox select, a checkbox, tabs inside a room, a confirm
 * dialog, a decimal field for money and quantities, and a freshness chip. They read only `--lit-*` roles (styles in
 * `../templates/templates.css`) and hold no copy of their own beyond the freshness words, which a room may replace.
 */
import * as React from 'react';
import { asOfIso, formatAsOf, freshnessOf, type AsOf, type Freshness } from '../../components/freshness.js';
import { blurDecimalValue, displayDecimal, nextDecimalValue, pastedDecimalValue } from '../../components/input-logic.js';
import { useFreshnessClock } from '../../components/use-freshness-clock.js';
import type { MoneyStatus } from '../contracts.js';

export interface SelectOption {
  value: string;
  label: string;
}

/**
 * One choice from a list: a button that opens a listbox (a combobox), so it reads and works the same on every
 * platform. Arrow keys move, Enter or Space picks, Escape closes; a click outside closes it.
 */
export function Select({
  label,
  options,
  value,
  onChange,
  disabled,
  hideLabel = false,
}: {
  label: string;
  options: readonly SelectOption[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** The label is still the control's name, only not drawn (a filter row whose options say what it is). */
  hideLabel?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const chosen = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const [active, setActive] = React.useState(chosen);
  const root = React.useRef<HTMLDivElement>(null);
  const trigger = React.useRef<HTMLButtonElement>(null);
  const base = React.useId();
  const labelId = `${base}-label`;
  const listId = `${base}-list`;
  React.useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  const show = () => {
    setActive(chosen);
    setOpen(true);
  };
  const pick = (next: string) => {
    setOpen(false);
    trigger.current?.focus();
    if (next !== value) onChange(next);
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    const last = options.length - 1;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) return show();
      setActive((i) => (event.key === 'ArrowDown' ? Math.min(last, i + 1) : Math.max(0, i - 1)));
    } else if (event.key === 'Home' && open) {
      event.preventDefault();
      setActive(0);
    } else if (event.key === 'End' && open) {
      event.preventDefault();
      setActive(last);
    } else if ((event.key === 'Enter' || event.key === ' ') && open) {
      event.preventDefault();
      const option = options[active];
      if (option) pick(option.value);
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      setOpen(false);
    } else if (event.key === 'Tab') setOpen(false);
  };
  return (
    <div className="lt-select" ref={root}>
      <span id={labelId} className={hideLabel ? 'lt-sr' : 'lt-select-label'}>
        {label}
      </span>
      <button
        ref={trigger}
        type="button"
        role="combobox"
        className="lt-select-trigger"
        aria-labelledby={labelId}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKeyDown}
      >
        <span>{options[chosen]?.value === value ? options[chosen]?.label : ''}</span>
        <span className="lt-select-caret" aria-hidden="true" />
      </button>
      {open ? (
        <ul role="listbox" id={listId} aria-labelledby={labelId} className="lt-select-list">
          {options.map((o, i) => (
            <li
              key={o.value}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={o.value === value}
              data-active={i === active || undefined}
              onPointerDown={(event) => event.preventDefault()}
              onPointerEnter={() => setActive(i)}
              onClick={() => pick(o.value)}
            >
              {o.label}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** A box to tick, with its words beside it; the words are its name. */
export function Checkbox({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="lt-check">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.currentTarget.checked)} />
      <span>{label}</span>
    </label>
  );
}

export interface TabSetTab<T extends string> {
  value: T;
  label: string;
  panel: React.ReactNode;
}

/**
 * Sections of one room shown one at a time (a tab list and its panel). Only the open panel is drawn. The arrow keys
 * move between tabs. For moving between rooms use `Tabs`, which is links.
 */
export function TabSet<T extends string>({
  label,
  tabs,
  value,
  onChange,
}: {
  label: string;
  tabs: readonly TabSetTab<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  const base = React.useId();
  const list = React.useRef<HTMLDivElement>(null);
  const move = (event: React.KeyboardEvent, at: number) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const rtl = list.current ? getComputedStyle(list.current).direction === 'rtl' : false;
    const next = tabs[(at + (rtl ? -step : step) + tabs.length) % tabs.length];
    if (!next) return;
    onChange(next.value);
    list.current?.querySelector<HTMLElement>(`[data-tab="${next.value}"]`)?.focus();
  };
  const open = tabs.find((t) => t.value === value);
  return (
    <div className="lt-tabset">
      <div ref={list} role="tablist" aria-label={label} className="lt-tablist lt-scroll-row">
        {tabs.map((t, i) => (
          <button
            key={t.value}
            type="button"
            role="tab"
            id={`${base}-tab-${t.value}`}
            data-tab={t.value}
            aria-selected={t.value === value}
            aria-controls={`${base}-panel-${t.value}`}
            tabIndex={t.value === value ? 0 : -1}
            className="lt-tab"
            onClick={() => onChange(t.value)}
            onKeyDown={(event) => move(event, i)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {open ? (
        <div role="tabpanel" id={`${base}-panel-${open.value}`} aria-labelledby={`${base}-tab-${open.value}`} className="lt-tabpanel">
          {open.panel}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A modal question before something happens (place an order, accept a price), on the native <dialog>: focus stays
 * inside and Escape asks `onClose`, which may refuse while a request is in flight. `alert` makes it an alert dialog.
 * Its content is drawn only while open. The control marked `data-autofocus` takes focus when it opens.
 */
export function Dialog({
  open,
  title,
  description,
  onClose,
  alert = false,
  children,
}: {
  open: boolean;
  title: string;
  description?: React.ReactNode;
  onClose: () => void;
  alert?: boolean;
  children?: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDialogElement>(null);
  const titleId = React.useId();
  const descriptionId = React.useId();
  React.useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal?.();
      d.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    }
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="lt-sheet lt-dialog"
      role={alert ? 'alertdialog' : undefined}
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      {open ? (
        <div className="lt-stack">
          <h2 id={titleId} className="lt-sheet-title">
            {title}
          </h2>
          {description ? (
            <p id={descriptionId} className="lt-hint">
              {description}
            </p>
          ) : null}
          {children}
        </div>
      ) : null}
    </dialog>
  );
}

/**
 * A field for money and quantities. The value is a decimal string ("0.1"), never a number: a keystroke that would
 * make it invalid is refused, a paste is cleaned and cut to `precision`, and a trailing mark is dropped on leaving.
 */
export function DecimalField({
  label,
  hint,
  error,
  unit,
  value,
  onValueChange,
  precision,
  disabled,
  placeholder,
  id,
}: {
  label: string;
  hint?: string;
  error?: string;
  /** The unit after the value ("USDT"); not part of the field's name. */
  unit?: string;
  value: string;
  onValueChange: (value: string) => void;
  precision: number;
  disabled?: boolean;
  placeholder?: string;
  id?: string;
}) {
  const auto = React.useId();
  const inputId = id ?? auto;
  const input = React.useRef<HTMLInputElement>(null);
  const caret = React.useRef<number | null>(null);
  React.useLayoutEffect(() => {
    if (caret.current !== null && input.current) {
      const at = Math.max(0, Math.min(caret.current, input.current.value.length));
      input.current.setSelectionRange(at, at);
      caret.current = null;
    }
  });
  const describedBy = [hint ? `${inputId}-hint` : null, error ? `${inputId}-error` : null].filter(Boolean).join(' ') || undefined;
  const options = { precision, decimalSeparator: '.' as const };
  return (
    <div className="lit-field-control" data-unit={unit ? '' : undefined}>
      <label htmlFor={inputId}>{label}</label>
      <div className="lt-field-row">
        <input
          ref={input}
          id={inputId}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          dir="ltr"
          value={displayDecimal(value)}
          placeholder={placeholder}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          onChange={(event) => {
            const raw = event.currentTarget.value;
            const at = event.currentTarget.selectionStart ?? raw.length;
            const next = nextDecimalValue(value, raw, options);
            caret.current = Math.max(0, at - (raw.length - displayDecimal(next).length));
            if (next !== value) onValueChange(next);
          }}
          onPaste={(event) => {
            if (disabled) return;
            event.preventDefault();
            const next = pastedDecimalValue(value, event.clipboardData.getData('text'), options);
            caret.current = displayDecimal(next).length;
            if (next !== value) onValueChange(next);
          }}
          onBlur={() => {
            const cleaned = blurDecimalValue(value);
            if (cleaned !== value) onValueChange(cleaned);
          }}
        />
        {unit ? <span className="lt-field-unit">{unit}</span> : null}
      </div>
      {hint ? (
        <span id={`${inputId}-hint`} data-part="hint">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={`${inputId}-error`} data-part="error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

const FRESH_STATUS: Record<Freshness, MoneyStatus> = { live: 'done', stale: 'pending', unknown: 'unknown', refused: 'failed' };
const FRESH_WORDS: Record<Freshness, string> = { live: 'Live', stale: 'Stale', unknown: 'Unknown', refused: 'Refused' };

/**
 * How fresh a reading is, as a shape and a word (Live, Stale, Unknown, Refused), announced politely. Without `now` it
 * keeps its own clock and turns Stale by itself when the readings stop.
 */
export function FreshnessChip({
  asOf,
  now,
  staleAfterMs,
  refused,
  showAsOf = false,
  words,
}: {
  asOf: AsOf;
  now?: number;
  staleAfterMs?: number | null;
  refused?: boolean;
  /** Draw "<Word> · as of 14:03:07" when the reading has a time. */
  showAsOf?: boolean;
  words?: Partial<Record<Freshness, string>>;
}) {
  const clock = useFreshnessClock({ asOf, now, staleAfterMs, refused });
  const kind = freshnessOf({ asOf, now: clock, staleAfterMs, refused });
  const iso = showAsOf ? asOfIso(asOf) : null;
  const shown = iso ? formatAsOf(asOf, { now: clock }) : null;
  return (
    <span role="status" className="lt-chip" data-status={FRESH_STATUS[kind]} data-freshness={kind}>
      <span className="lt-chip-mark" aria-hidden="true" />
      <span>
        {words?.[kind] ?? FRESH_WORDS[kind]}
        {iso && shown ? (
          <>
            {' · as of '}
            <time dateTime={iso}>{shown}</time>
          </>
        ) : null}
      </span>
    </span>
  );
}
