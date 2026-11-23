/**
 * Owner: lane B2 (templates). Components the templates need first: EqualChoice, Stepper, Skeleton, KeyValue,
 * StatusChip, Tabs, SectionTabs, TabList, Disclosure, Checkbox, Dialog, Sheet. They read only `--lit-*` roles (styles in `../templates/templates.css`).
 */
import * as React from 'react';
import type { MoneyStatus } from '../contracts.js';
import { moveFocusByArrow } from './arrow-focus.js';
import type { DataMarks } from './b2-table.js';

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
        <div key={r.label} data-total={r.total || undefined} data-unset={r.unset || undefined}>
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
export function Tabs({ items, current, label }: { items: readonly { label: string; href: string }[]; current: string; label: string }) {
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

/**
 * A room's own sections, one button each, the open one pressed: the same row as Tabs, for sections a room switches
 * itself (it navigates in `onChange`) rather than by link. Wraps onto a second line when it overflows, as Tabs do. The
 * arrow keys move focus between the sections (`arrow-focus.ts`).
 */
export function SectionTabs<T extends string>({
  items,
  value,
  onChange,
  label,
}: {
  items: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="lt-tabs" role="group" aria-label={label} onKeyDown={moveFocusByArrow}>
      {items.map((t) => (
        <button key={t.value} type="button" className="lt-tab" aria-pressed={t.value === value} onClick={() => onChange(t.value)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Tabs that switch a panel in place (Send, Receive and Request on one card): a WAI-ARIA tab list drawn like Tabs. The
 * chosen tab is selected and is the only one in the Tab order; arrow keys, Home and End move between the tabs and choose
 * the one they reach, and `onChange` is called with it (a room that keeps each tab at its own address navigates there).
 * `panelOf` names the id of the panel each tab shows, when the panel is drawn.
 */
export function TabList<T extends string>({
  items,
  value,
  onChange,
  label,
  panelOf,
}: {
  items: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  panelOf?: (value: T) => string | undefined;
}) {
  const refs = React.useRef(new Map<T, HTMLButtonElement>());
  const go = (index: number) => {
    const next = items[(index + items.length) % items.length];
    if (!next) return;
    refs.current.get(next.value)?.focus();
    onChange(next.value);
  };
  const keys = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    const rtl = event.currentTarget.closest('[dir="rtl"]') !== null;
    if (step !== undefined) go(index + (rtl && (event.key === 'ArrowRight' || event.key === 'ArrowLeft') ? -step : step));
    else if (event.key === 'Home') go(0);
    else if (event.key === 'End') go(items.length - 1);
    else return;
    event.preventDefault();
  };
  return (
    <div className="lt-tabs" role="tablist" aria-label={label}>
      {items.map((t, i) => (
        <button
          key={t.value}
          ref={(node) => {
            if (node) refs.current.set(t.value, node);
            else refs.current.delete(t.value);
          }}
          type="button"
          role="tab"
          className="lt-tab"
          aria-selected={t.value === value}
          aria-controls={panelOf?.(t.value)}
          tabIndex={t.value === value ? 0 : -1}
          onClick={() => t.value !== value && onChange(t.value)}
          onKeyDown={(event) => keys(event, i)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A room's own bar (an asset page's name, price and sections), given to the room as its `bar`: the frame draws it
 * first, and it stays right under the app's top bar (and under the legal band when that is on) while the page scrolls.
 * Its place is the top bar's real bottom edge as measured (`--a11y-obscured-top`, from `trackObscuringBars`), so a
 * banner above the top bar or a top bar of another height moves it too; before the first measure it is the
 * `--lit-topbar-h` token. Its children sit in a row, the first at the start and the last at the end. `marks` are the
 * bar's own (`data-testid`), where a room's tests find it.
 */
export function RoomBar({ marks, children }: { marks?: DataMarks; children: React.ReactNode }) {
  return (
    <div className="lt-room-bar" data-region="room-bar" {...marks}>
      {children}
    </div>
  );
}

export interface DisclosureItem {
  /** Names the section in `defaultOpen`; stable across renders. */
  value: string;
  title: React.ReactNode;
  body: React.ReactNode;
}

/**
 * Sections that fold: each one's heading is a button that opens and closes it, and its open body is a region named by
 * that heading. One is open at a time unless `multiple`; `defaultOpen` names the ones open at first. A closed body is
 * not drawn, so nothing folded away is read out or reached by Tab.
 */
export function Disclosure({
  items,
  defaultOpen = [],
  multiple = false,
}: {
  items: readonly DisclosureItem[];
  defaultOpen?: readonly string[];
  multiple?: boolean;
}) {
  const [open, setOpen] = React.useState<readonly string[]>(defaultOpen);
  const base = React.useId();
  const toggle = (value: string) =>
    setOpen((now) => (now.includes(value) ? now.filter((v) => v !== value) : multiple ? [...now, value] : [value]));
  return (
    <div className="lt-disclosure">
      {items.map((item, i) => {
        const isOpen = open.includes(item.value);
        const head = `${base}-${i}-head`;
        const body = `${base}-${i}-body`;
        return (
          <div key={item.value} className="lt-disclosure-item" data-open={isOpen || undefined}>
            <h3 className="lt-disclosure-head">
              <button type="button" id={head} aria-expanded={isOpen} aria-controls={body} onClick={() => toggle(item.value)}>
                {item.title}
              </button>
            </h3>
            {isOpen ? (
              <div id={body} role="region" aria-labelledby={head} className="lt-disclosure-body">
                {item.body}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** A tick with its words, one row: the box, then the label. Every other attribute goes to the native checkbox. */
export function Checkbox({ label, ...input }: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> & { label: React.ReactNode }) {
  return (
    <label className="lt-field">
      <input {...input} type="checkbox" />
      <span>{label}</span>
    </label>
  );
}

/**
 * A modal dialog in the middle of the screen: a review before a step that cannot be undone, or one short task. It is
 * open while it is drawn (the caller decides when it shows and owns its own submission), keeps focus inside, and closes
 * on Escape or its Close button by calling `onClose`. Built on the native <dialog> element, named by its title.
 * `alert` marks a confirmation that interrupts (send money, delete): it is announced as an alert dialog.
 */
export function Dialog({
  title,
  onClose,
  closeLabel,
  alert = false,
  children,
  'data-testid': testId,
}: {
  title: React.ReactNode;
  onClose: () => void;
  closeLabel: string;
  /** A confirmation before a step that cannot be undone: role `alertdialog`. */
  alert?: boolean;
  children: React.ReactNode;
  'data-testid'?: string;
}) {
  const ref = React.useRef<HTMLDialogElement>(null);
  const titleId = React.useId();
  React.useEffect(() => {
    const d = ref.current;
    if (!d || d.open) return;
    // A host without modal dialogs (an older engine, a test DOM) still shows it, in the flow.
    if (typeof d.showModal === 'function') d.showModal();
    else d.setAttribute('open', '');
  }, []);
  return (
    <dialog
      ref={ref}
      className="lt-dialog"
      role={alert ? 'alertdialog' : undefined}
      aria-modal={alert ? true : undefined}
      data-testid={testId}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="lt-sheet-head">
        <h2 id={titleId} className="lt-sheet-title">
          {title}
        </h2>
        <button type="button" className="lt-button lt-button-secondary" aria-label={closeLabel} onClick={onClose}>
          ×
        </button>
      </header>
      <div className="lt-sheet-body">{children}</div>
    </dialog>
  );
}

/**
 * A bottom sheet on a phone, a side sheet on a computer: one of the two layers allowed glass. It is a modal
 * dialog (focus stays inside, Escape closes), built on the native <dialog> element.
 */
export function Sheet({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDialogElement>(null);
  React.useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal?.();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="lt-sheet" aria-label={title} onClose={onClose} onCancel={onClose}>
      <header className="lt-sheet-head">
        <h2 className="lt-sheet-title">{title}</h2>
        <button type="button" className="lt-button lt-button-secondary" onClick={onClose}>
          Close
        </button>
      </header>
      <div className="lt-sheet-body">{children}</div>
    </dialog>
  );
}

/**
 * How much of a limit is used: a bar that fills to `value` of `max`, read out as a progress bar with its words (`text`,
 * for example "62% used"). At or past the limit it is marked full by a state, never by colour alone.
 */
export function Meter({ label, value, max = 100, text }: { label: string; value: number; max?: number; text: string }) {
  const shown = Math.max(0, Math.min(value, max));
  const share = max > 0 ? (shown / max) * 100 : 0;
  return (
    <div
      className="lt-meter"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.round(shown)}
      aria-valuetext={text}
      data-full={value >= max || undefined}
    >
      <span className="lt-meter-fill" style={{ inlineSize: `${share}%` }} />
      <span className="lt-sr">{text}</span>
    </div>
  );
}

/**
 * A sample of someone else's brand, as their own page will show it (a business's checkout colour): a named figure whose
 * `lt-brand-*` parts take `accent` and the text colour on it, `onAccent`. The colours are the person's own, never the
 * kit's roles, so this is the one part that takes a colour as a value; everything around it stays in the kit's look.
 */
export function BrandSample({
  label,
  accent,
  onAccent,
  children,
}: {
  label: string;
  /** A `#rrggbb` colour the person chose. */
  accent: string;
  /** The text colour that reads on `accent`. */
  onAccent: string;
  children: React.ReactNode;
}) {
  const colour = /^#[0-9a-fA-F]{6}$/;
  const brand: React.CSSProperties & { '--lt-brand'?: string; '--lt-on-brand'?: string } = {
    '--lt-brand': colour.test(accent) ? accent : undefined,
    '--lt-on-brand': colour.test(onAccent) ? onAccent : undefined,
  };
  return (
    <figure className="lt-brand" aria-label={label} style={brand}>
      {children}
    </figure>
  );
}
