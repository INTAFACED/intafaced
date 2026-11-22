/**
 * Owner: lane B2 (templates). Components the templates need first: EqualChoice, Stepper, Skeleton, KeyValue,
 * StatusChip, FreshnessChip, Tabs, Sheet, Select, DecimalInput. They read only `--lit-*` roles (styles in `../templates/templates.css`).
 */
import * as React from 'react';
import type { MoneyStatus } from '../contracts.js';
import { asOfIso, formatAsOf, freshnessOf, type AsOf, type Freshness } from '../../components/freshness.js';
import { useFreshnessClock } from '../../components/use-freshness-clock.js';
import { blurDecimalValue, nextDecimalValue, pastedDecimalValue } from '../../components/input-logic.js';

/**
 * Two or more choices of the same size, style and level (COBS 4.12A.18R(2); Directive 2023/2673 Art 16e(1)(a)).
 * No choice is pre-focused or styled as the default, and the labels name outcomes, never "Yes" or "No".
 */
export function EqualChoice({ choices }: { choices: readonly { label: string; onSelect?: () => void; href?: string }[] }) {
  return (
    <div className="lt-equal" data-slot="equal-choice">
      {choices.map((c) =>
        c.href ? (
          <a key={c.label} className="lt-button lt-button-equal" href={c.href}>
            {c.label}
          </a>
        ) : (
          <button key={c.label} type="button" className="lt-button lt-button-equal" onClick={c.onSelect}>
            {c.label}
          </button>
        ),
      )}
    </div>
  );
}

/**
 * One choice of two or more that stays selected (Buy or Sell on a ticket): a radio group drawn as one switch. The
 * options keep equal size and style; only the selected one is marked, by a state the switch shows, not by colour.
 */
export function Segmented({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { value: string; label: string }[];
  value: string;
  onChange?: (value: string) => void;
}) {
  return (
    <div className="lt-segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className="lt-segment"
          onClick={() => onChange?.(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** The steps of a flow; on a phone only the current step's name shows, the others as bars. */
export function Stepper({ labels, current }: { labels: readonly string[]; current: number }) {
  return (
    <ol className="lt-stepper" aria-label={`Step ${current + 1} of ${labels.length}`}>
      {labels.map((l, i) => (
        <li key={l} data-step={i < current ? 'done' : i === current ? 'current' : 'todo'} aria-current={i === current ? 'step' : undefined}>
          {l}
        </li>
      ))}
    </ol>
  );
}

export type SkeletonShape = 'figure' | 'rows' | 'chart' | 'grid' | 'text' | 'form' | 'keys';

/**
 * A placeholder in the content's final shape, so nothing jumps when data arrives and nothing flashes "no
 * records". `busy` pulses (while loading); without it, it is the still ghost a gated room shows behind its gate.
 */
export function Skeleton({ shape, busy = true, count: given }: { shape: SkeletonShape; busy?: boolean; count?: number }) {
  const count = given ?? { rows: 5, text: 6, grid: 3, form: 3, keys: 4, figure: 1, chart: 1 }[shape];
  return (
    <div className="lt-ghost" data-ghost={shape} data-busy={busy || undefined} aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className="lt-ghost-item" />
      ))}
    </div>
  );
}

export interface KeyValueRow {
  label: string;
  value: React.ReactNode;
  note?: string;
  /** The row the others add up to. */
  total?: boolean;
  /** The value is not set: drawn as a caution, never as zero. */
  unset?: boolean;
  /** Addresses, IBANs and references stay left-to-right in a right-to-left page. */
  ltr?: boolean;
}

/** Label and value rows: review, receipt, details. */
export function KeyValue({ rows, label }: { rows: readonly KeyValueRow[]; label?: string }) {
  return (
    <dl className="lt-kv" aria-label={label}>
      {rows.map((r) => (
        <div key={r.label} data-slot="key-value-row" data-total={r.total || undefined} data-unset={r.unset || undefined}>
          <dt>{r.label}</dt>
          <dd>
            <bdi className={r.ltr ? 'lt-mono' : undefined} dir={r.ltr ? 'ltr' : undefined} data-ltr={r.ltr ? '' : undefined}>
              {r.value}
            </bdi>
            {r.note ? <span className="lt-kv-note">{r.note}</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

const STATUS_WORDS: Record<MoneyStatus, string> = {
  pending: 'Pending',
  failed: 'Failed',
  done: 'Done',
  unknown: 'Checking',
};

/**
 * Money status in words with a shape mark, never colour alone. `label` overrides the word. `returned` marks a
 * failed movement whose money is back in the balance: neutral, never the failure red.
 */
export function StatusChip({ status, label, returned = false }: { status: MoneyStatus; label?: string; returned?: boolean }) {
  return (
    <span className="lt-chip" data-status={status} data-returned={returned || undefined}>
      <span className="lt-chip-mark" aria-hidden="true" />
      {label ?? STATUS_WORDS[status]}
    </span>
  );
}

/** A door's room row: links, with the open room marked for assistive tech as well as by look. */
export type TabsProps =
  | { items: readonly { label: string; href: string }[]; current: string; label: string }
  | {
      /** In-page tabs: each item names the panel it shows. */
      items: readonly { label: string; value: string }[];
      value: string;
      onChange: (value: string) => void;
      label: string;
      /** Prefix for the tab and panel ids, shared with each `TabPanel`. */
      id: string;
    };

/**
 * One row of tabs. With `href`s it is a door's room row: links, the open room marked `aria-current`. With `value`s and
 * `onChange` it is in-page tabs: a `tablist` of `tab`s, the shown one `aria-selected`, one Tab stop, and the arrow keys,
 * Home and End move and show (the panel is a `TabPanel` with the same `id`).
 */
export function Tabs(props: TabsProps) {
  const refs = React.useRef<(HTMLButtonElement | null)[]>([]);
  if (!('onChange' in props)) {
    const { items, current, label } = props;
    return (
      <nav className="lt-tabs" aria-label={label}>
        {items.map((t) => (
          <a key={t.href} href={t.href} className="lt-tab" aria-current={t.href === current ? 'page' : undefined}>
            {t.label}
          </a>
        ))}
      </nav>
    );
  }
  const { items, value, onChange, label, id } = props;
  const at = Math.max(
    0,
    items.findIndex((t) => t.value === value),
  );
  const move = (event: React.KeyboardEvent, index: number) => {
    const next = nextTabIndex(index, event.key, items.length);
    if (next === null) return;
    const item = items[next];
    if (!item) return;
    event.preventDefault();
    onChange(item.value);
    refs.current[next]?.focus();
  };
  return (
    <div className="lt-tabs" role="tablist" aria-label={label}>
      {items.map((t, i) => (
        <button
          key={t.value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="tab"
          id={`${id}-tab-${t.value}`}
          aria-controls={`${id}-panel-${t.value}`}
          aria-selected={i === at}
          tabIndex={i === at ? 0 : -1}
          className="lt-tab"
          onClick={() => onChange(t.value)}
          onKeyDown={(e) => move(e, i)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** The tab an arrow, Home or End key moves to from `index` (wrapping), or null for any other key. */
export function nextTabIndex(index: number, key: string, count: number): number | null {
  if (count === 0) return null;
  if (key === 'ArrowRight' || key === 'ArrowDown') return (index + 1) % count;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (index - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

/** What a keyboard can reach inside a panel. */
const PANEL_CONTROL = 'a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';

/**
 * Whether a tab's panel is itself a Tab stop: only while it holds nothing a keyboard can reach, so Tab from the tab
 * still lands in it. A panel with controls leaves the stop to its first control, never to the whole (often tall) panel,
 * whose focus ring would run under the phone's dock.
 */
export function panelIsTabStop(panel: Pick<ParentNode, 'querySelector'>): boolean {
  return panel.querySelector(PANEL_CONTROL) === null;
}

/** The panel an in-page tab shows. Only the shown panel is rendered, so a hidden one reads nothing. */
export function TabPanel({ id, value, current, children }: { id: string; value: string; current: string; children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [stop, setStop] = React.useState(true);
  const shown = value === current;
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setStop(panelIsTabStop(el));
    read();
    const watch = new MutationObserver(read);
    watch.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ['tabindex', 'href'] });
    return () => watch.disconnect();
  }, [shown]);
  if (!shown) return null;
  return (
    <div
      ref={ref}
      className="lt-tab-panel"
      role="tabpanel"
      id={`${id}-panel-${value}`}
      aria-labelledby={`${id}-tab-${value}`}
      tabIndex={stop ? 0 : undefined}
    >
      {children}
    </div>
  );
}

/**
 * A bottom sheet on a phone, a side sheet on a computer: one of the two layers allowed glass. It is a modal
 * dialog (focus stays inside, Escape closes), built on the native <dialog> element. As an `alertdialog` it asks for
 * an answer: it draws no Close button of its own (its own buttons answer it), Escape asks `onClose` and the sheet
 * stays open until `open` turns false. An element inside marked `data-autofocus` takes the focus when it opens.
 * A `description` (what the answer does) is drawn under the title and describes the sheet.
 */
export function Sheet({
  open,
  title,
  description,
  onClose,
  role = 'dialog',
  closeButton = role !== 'alertdialog',
  children,
}: {
  open: boolean;
  title: string;
  /** What the sheet asks or does, read out with its name (`aria-describedby`). */
  description?: React.ReactNode;
  onClose: () => void;
  role?: 'dialog' | 'alertdialog';
  /** The sheet's own Close button; off for a sheet whose own buttons answer it (a form with Not now). */
  closeButton?: boolean;
  children: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDialogElement>(null);
  const descriptionId = React.useId();
  const alert = role === 'alertdialog';
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
      className="lt-sheet"
      role={alert ? 'alertdialog' : undefined}
      aria-modal={alert || undefined}
      aria-label={title}
      aria-describedby={description ? descriptionId : undefined}
      onClose={alert ? undefined : onClose}
      onCancel={(e) => {
        if (alert) e.preventDefault();
        onClose();
      }}
    >
      <header className="lt-sheet-head">
        <h2 className="lt-sheet-title">{title}</h2>
        {closeButton ? (
          <button type="button" className="lt-button lt-button-secondary" onClick={onClose}>
            Close
          </button>
        ) : null}
      </header>
      <div className="lt-sheet-body">
        {description ? (
          <p id={descriptionId} className="lt-description">
            {description}
          </p>
        ) : null}
        {children}
      </div>
    </dialog>
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

/**
 * One choice from a list, as a button that opens a list: a `combobox` with a `listbox` of `option`s. Focus stays on
 * the button; the arrow keys, Home and End move through the open list, Enter or Space picks, Escape and Tab close.
 * A value not among the options is shown as itself, so a choice in force is never hidden; an empty one shows `placeholder`.
 */
export function Select({
  label,
  options,
  value,
  onChange,
  disabled,
  placeholder,
}: {
  label: string;
  options: readonly SelectOption[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Shown while nothing is chosen (an empty value). */
  placeholder?: string;
}) {
  const id = React.useId();
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState(0);
  const selected = options.findIndex((o) => o.value === value);
  const shown = options[selected]?.label ?? (value === '' && placeholder ? placeholder : value);
  const show = () => {
    setActive(Math.max(0, selected));
    setOpen(true);
  };
  const pick = (index: number) => {
    const option = options[index];
    setOpen(false);
    if (option && option.value !== value) onChange(option.value);
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    const step = selectKey(event.key, open);
    if (step === null) return;
    if (step !== 'close') event.preventDefault();
    if (step === 'open') show();
    else if (step === 'close') setOpen(false);
    else if (step === 'pick') pick(active);
    else setActive((i) => nextOptionIndex(i, step, options.length));
  };
  return (
    <div className="lt-select">
      <button
        type="button"
        role="combobox"
        className="lt-select-button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-activedescendant={open && options.length > 0 ? `${id}-${active}` : undefined}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKeyDown}
        onBlur={() => setOpen(false)}
      >
        <span>{shown}</span>
        <span className="lt-select-mark" aria-hidden="true" />
      </button>
      {open ? (
        <ul className="lt-select-list" role="listbox" id={`${id}-list`} aria-label={label}>
          {options.map((o, i) => (
            <li
              key={o.value}
              id={`${id}-${i}`}
              role="option"
              aria-selected={o.value === value}
              data-active={i === active || undefined}
              // Keep the focus on the button, so the list closes on blur only when focus really leaves.
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(i)}
            >
              {o.label}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

type SelectStep = 'open' | 'close' | 'pick' | 'next' | 'previous' | 'first' | 'last';

/** What a key does to a Select, closed or open; null for a key it leaves alone. */
export function selectKey(key: string, open: boolean): SelectStep | null {
  if (!open) return key === 'ArrowDown' || key === 'ArrowUp' || key === 'Enter' || key === ' ' ? 'open' : null;
  if (key === 'Escape' || key === 'Tab') return 'close';
  if (key === 'Enter' || key === ' ') return 'pick';
  if (key === 'ArrowDown') return 'next';
  if (key === 'ArrowUp') return 'previous';
  if (key === 'Home') return 'first';
  if (key === 'End') return 'last';
  return null;
}

/** The option a move lands on, held at the ends of the list. */
export function nextOptionIndex(index: number, step: 'next' | 'previous' | 'first' | 'last', count: number): number {
  if (count === 0) return 0;
  if (step === 'first') return 0;
  if (step === 'last') return count - 1;
  return Math.min(count - 1, Math.max(0, index + (step === 'next' ? 1 : -1)));
}

/**
 * A text box for an amount or a quantity: the value is a decimal string ("0.1", never a number). A keystroke that
 * would make it invalid or longer than `precision` decimals is refused, a paste is cleaned and cut down to it, and an
 * unfinished "." is dropped on blur. Put it in an `lt-field` with its label, or give it a `label` and it draws its own
 * field: the label names the box, the `unit` sits after it (not part of its name), the hint and the error describe it.
 */
export function DecimalInput({
  label,
  hint,
  error,
  unit,
  ...props
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'inputMode'> & {
  value: string;
  onValueChange: (value: string) => void;
  precision: number;
  /** Draws the field around the box, this its label. */
  label?: string;
  hint?: string;
  error?: string;
  /** The unit after the value ("USDT"). */
  unit?: string;
}) {
  const auto = React.useId();
  if (label === undefined) return <DecimalBox {...props} />;
  const id = props.id ?? auto;
  const describedBy =
    [props['aria-describedby'], hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className="lt-field" data-unit={unit ? '' : undefined}>
      <label htmlFor={id}>{label}</label>
      <div className="lt-field-row">
        <DecimalBox {...props} id={id} dir="ltr" aria-invalid={error ? true : props['aria-invalid']} aria-describedby={describedBy} />
        {unit ? <span className="lt-field-unit">{unit}</span> : null}
      </div>
      {hint ? <small id={`${id}-hint`}>{hint}</small> : null}
      {error ? (
        <small id={`${id}-error`} role="alert">
          {error}
        </small>
      ) : null}
    </div>
  );
}

function DecimalBox({
  value,
  onValueChange,
  precision,
  onBlur,
  ...rest
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'inputMode'> & {
  value: string;
  onValueChange: (value: string) => void;
  precision: number;
}) {
  return (
    <input
      {...rest}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      spellCheck={false}
      value={value}
      onChange={(e) => {
        const next = nextDecimalValue(value, e.currentTarget.value, { precision });
        if (next !== value) onValueChange(next);
      }}
      onPaste={(e) => {
        if (rest.readOnly || rest.disabled) return;
        e.preventDefault();
        const next = pastedDecimalValue(value, e.clipboardData.getData('text'), { precision });
        if (next !== value) onValueChange(next);
      }}
      onBlur={(e) => {
        const cleaned = blurDecimalValue(value);
        if (cleaned !== value) onValueChange(cleaned);
        onBlur?.(e);
      }}
    />
  );
}

/** A checkbox with its words, as one row: the box, then the label (`lt-field`). */
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
    <label className="lt-field">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.currentTarget.checked)} />
      <span>{label}</span>
    </label>
  );
}

/** The TEST label an illustrative figure or sample list carries (AGENTS.md: an illustrative figure says TEST). */
export function TestTag() {
  return <span className="lt-test">TEST</span>;
}

const FRESHNESS_WORDS: Record<Freshness, string> = { live: 'Live', stale: 'Stale', unknown: 'Unknown', refused: 'Refused' };

/**
 * How fresh a polled read is, as a shape and a word (Live, Stale, Unknown, Refused), never colour alone, with its
 * "as of" time when `showAsOf`. It keeps its own clock, so Live turns Stale by itself; pass `now` only for screenshots.
 */
export function FreshnessChip({
  asOf,
  staleAfterMs,
  refused = false,
  showAsOf = false,
  now,
  reason,
}: {
  asOf: AsOf;
  staleAfterMs: number;
  refused?: boolean;
  showAsOf?: boolean;
  now?: number;
  /** Why it is unknown, refused or behind: in the title and read out (a title alone is not read reliably). */
  reason?: string;
}) {
  const clock = useFreshnessClock({ asOf, now, staleAfterMs, refused });
  const kind = freshnessOf({ asOf, now: clock, staleAfterMs, refused });
  const iso = showAsOf ? asOfIso(asOf) : null;
  const shown = iso ? formatAsOf(asOf, { now: clock }) : null;
  return (
    <span className="lt-chip" role="status" data-freshness={kind} title={reason}>
      <span className="lt-chip-mark" aria-hidden="true" />
      <span>
        <span data-part="word">{FRESHNESS_WORDS[kind]}</span>
        {iso && shown ? (
          <span className="lt-chip-when">
            {' · as of '}
            <time dateTime={iso}>{shown}</time>
          </span>
        ) : null}
      </span>
      {reason ? <span className="lt-sr">{reason}</span> : null}
    </span>
  );
}
