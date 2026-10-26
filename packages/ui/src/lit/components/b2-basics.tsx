/**
 * Owner: lane B2 (templates). Components the templates need first: EqualChoice, Stepper, Skeleton, KeyValue,
 * StatusChip, Tabs, Sheet. They read only `--lit-*` roles (styles in `../templates/templates.css`).
 */
import * as React from 'react';
import type { MoneyStatus } from '../contracts.js';

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
