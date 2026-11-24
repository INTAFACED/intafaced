/**
 * Owner: lane B2 (templates). Components the templates need first: EqualChoice, Stepper, Skeleton, KeyValue,
 * StatusChip, FreshnessChip, Tabs, SectionTabs, TabList, Disclosure, Checkbox, Dialog, Sheet, Select, DecimalInput. They read only `--lit-*` roles (styles in `../templates/templates.css`).
 */
import * as React from 'react';
import type { MoneyStatus } from '../contracts.js';
import { asOfIso, formatAsOf, freshnessOf, type AsOf, type Freshness } from '../../components/freshness.js';
import { useFreshnessClock } from '../../components/use-freshness-clock.js';
import { blurDecimalValue, nextDecimalValue, pastedDecimalValue, stepValueForKey } from '../../components/input-logic.js';
import { stepDecimal } from '../../components/amount-input-logic.js';
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

/** One link in a section's tab bar. `match` names more path prefixes the tab owns (a room's detail pages). */
export interface TabLink {
  label: string;
  href: string;
  match?: readonly string[];
}

const pathOf = (href: string) => (href.split(/[?#]/)[0] ?? href).replace(/(.)\/$/, '$1');

/**
 * The href of the tab `pathname` sits in: the tab whose path is the route, else the longest tab path (or `match`
 * prefix) the route sits under. A tab at a section's root (`/bank`, `/quant`: one segment) lights only on itself, so a
 * room the bar does not list lights no tab rather than the wrong one.
 */
export function currentTab(items: readonly TabLink[], pathname: string): string {
  const here = pathOf(pathname);
  const exact = items.find((t) => pathOf(t.href) === here);
  if (exact) return exact.href;
  let best = '';
  let found = '';
  for (const t of items) {
    const own = pathOf(t.href);
    const prefixes = [...(own.split('/').filter(Boolean).length > 1 ? [own] : []), ...(t.match ?? [])];
    for (const prefix of prefixes) {
      if ((here === prefix || here.startsWith(`${prefix}/`)) && prefix.length > best.length) {
        best = prefix;
        found = t.href;
      }
    }
  }
  return found;
}

const onRoute = (listener: () => void) => {
  window.addEventListener('popstate', listener);
  return () => window.removeEventListener('popstate', listener);
};
const routePath = () => (typeof location === 'undefined' ? '' : location.pathname);

/**
 * Scrolls a tab row (only the row, never the page) as far as brings its lit tab (`aria-current`, `aria-pressed` or
 * `aria-selected`) wholly into view, once per lit tab, so a row that scrolls never opens with its lit tab off-screen.
 */
const shown = new WeakMap<HTMLElement, string>();
function showLit(row: HTMLElement | null, lit: string) {
  if (!row || shown.get(row) === lit) return;
  shown.set(row, lit);
  reveal(row);
  // The row's face may arrive after the first layout and widen each tab: once the fonts are in, bring the lit tab into view again.
  if (typeof document !== 'undefined') void document.fonts?.ready.then(() => shown.get(row) === lit && reveal(row));
}
function reveal(row: HTMLElement) {
  const tab = row.querySelector<HTMLElement>('[aria-current="page"], [aria-pressed="true"], [aria-selected="true"]');
  if (!tab || row.scrollWidth <= row.clientWidth) return;
  const box = row.getBoundingClientRect();
  const at = tab.getBoundingClientRect();
  if (at.right > box.right) row.scrollLeft += at.right - box.right + 24;
  else if (at.left < box.left) row.scrollLeft -= box.left - at.left + 24;
}

/**
 * One row of tabs. With `href`s it is a section's tab bar: links, the open room marked `aria-current`; the lit tab is the
 * route's (`currentTab`) unless `current` names one. With `value`s and `onChange` it is in-page tabs: a `tablist` of
 * `tab`s, the shown one `aria-selected`, one Tab stop, and the arrow keys, Home and End move and show (the panel is a
 * `TabPanel` with the same `id`). Either row is one line at every width: a longer row scrolls sideways, fading at the
 * end that has more, with the lit tab scrolled into view.
 */
export type TabsProps =
  | { items: readonly TabLink[]; current?: string; label: string }
  | {
      /** In-page tabs: each item names the panel it shows. */
      items: readonly { label: string; value: string }[];
      value: string;
      onChange: (value: string) => void;
      /** The tab row's name; a row whose tabs name themselves (Order book, Last trades) may go without. */
      label?: string;
      /** Prefix for the tab and panel ids, shared with each `TabPanel`. */
      id: string;
      className?: string;
    };

export function Tabs(props: TabsProps) {
  const refs = React.useRef<(HTMLButtonElement | null)[]>([]);
  const path = React.useSyncExternalStore(onRoute, routePath, routePath);
  if (!('onChange' in props)) {
    const { items, current, label } = props;
    const lit = current ?? currentTab(items, path);
    return (
      <nav ref={(node) => showLit(node, lit)} className="lt-tabs" aria-label={label} data-region="section-tabs">
        {items.map((t) => (
          <a key={t.href} href={t.href} className="lt-tab" aria-current={t.href === lit ? 'page' : undefined}>
            {t.label}
          </a>
        ))}
      </nav>
    );
  }
  const { items, value, onChange, label, id, className } = props;
  const at = Math.max(
    0,
    items.findIndex((t) => t.value === value),
  );
  const move = (event: React.KeyboardEvent<HTMLElement>, index: number) => {
    const next = nextTabIndex(index, readingArrow(event.key, isRightToLeft(event.currentTarget)), items.length);
    if (next === null) return;
    const item = items[next];
    if (!item) return;
    event.preventDefault();
    onChange(item.value);
    refs.current[next]?.focus();
  };
  return (
    <div className={className ? `lt-tabs ${className}` : 'lt-tabs'} role="tablist" aria-label={label}>
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

/**
 * A key as the row reads it: on a right-to-left page the row reads from the right, so ArrowLeft goes to the next tab and
 * ArrowRight to the one before. Every other key is itself.
 */
export function readingArrow(key: string, rtl: boolean): string {
  if (!rtl) return key;
  return key === 'ArrowLeft' ? 'ArrowRight' : key === 'ArrowRight' ? 'ArrowLeft' : key;
}

/** Whether an element sits in a right-to-left run: the nearest `dir` on it or an ancestor says `rtl`. */
export function isRightToLeft(el: Pick<Element, 'closest'>): boolean {
  return el.closest('[dir]')?.getAttribute('dir')?.toLowerCase() === 'rtl';
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
export function TabPanel({
  id,
  value,
  current,
  className,
  testId,
  children,
}: {
  id: string;
  value: string;
  current: string;
  /** A layout class for the panel's own parts (`lt-stack`). */
  className?: string;
  testId?: string;
  children: React.ReactNode;
}) {
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
      className={className ? `lt-tab-panel ${className}` : 'lt-tab-panel'}
      data-testid={testId}
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
 * A room's own sections, one button each, the open one pressed: the same row as Tabs, for sections a room switches
 * itself (it navigates in `onChange`) rather than by link. One line that scrolls sideways when it overflows, as Tabs do. The
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
    <div ref={(node) => showLit(node, value)} className="lt-tabs" role="group" aria-label={label} onKeyDown={moveFocusByArrow}>
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
    <div ref={(node) => showLit(node, value)} className="lt-tabs" role="tablist" aria-label={label}>
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
 * dialog (focus stays inside, Escape closes, focus returns to what opened it), built on the native <dialog> element.
 * As an `alertdialog` it asks for an answer: it draws no Close button of its own (its own buttons answer it), Escape
 * asks `onClose` and the sheet stays open until `open` turns false. An element inside marked `data-autofocus` takes
 * the focus when it opens.
 * A `description` (what the answer does) is drawn under the title and describes the sheet; a `footer` holds its buttons,
 * at its end.
 */
export function Sheet({
  open,
  title,
  description,
  onClose,
  role = 'dialog',
  closeButton = role !== 'alertdialog',
  closeLabel,
  closeLang,
  titleLang,
  footer,
  testId,
  children,
}: {
  open: boolean;
  title: string;
  /**
   * The language of `title`, when the room's copy fell back to another one than the page's: the heading carries it and
   * names the sheet, so the name is read in the words' own language.
   */
  titleLang?: string;
  /** What the sheet asks or does, read out with its name (`aria-describedby`). */
  description?: React.ReactNode;
  onClose: () => void;
  role?: 'dialog' | 'alertdialog';
  /** The sheet's own Close button; off for a sheet whose own buttons answer it (a form with Not now). */
  closeButton?: boolean;
  /** The Close button's spoken name, when it says more than its word ("Close dialog"). */
  closeLabel?: string;
  /** The language of `closeLabel`, when the room's copy fell back to another one than the page's. */
  closeLang?: string;
  /** The sheet's buttons, at its end. */
  footer?: React.ReactNode;
  testId?: string;
  children: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDialogElement>(null);
  const descriptionId = React.useId();
  const titleId = React.useId();
  const alert = role === 'alertdialog';
  // Focus goes back to what opened the sheet when it closes or goes away, as a modal dialog's should.
  const opener = React.useRef<HTMLElement | null>(null);
  const giveBack = () => {
    const back = opener.current;
    opener.current = null;
    if (back?.isConnected) back.focus();
  };
  React.useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      d.showModal?.();
      d.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    }
    if (!open && d.open) {
      d.close();
      giveBack();
    }
  }, [open]);
  React.useEffect(() => giveBack, []);
  return (
    <dialog
      ref={ref}
      className="lt-sheet"
      data-testid={testId}
      role={alert ? 'alertdialog' : undefined}
      aria-modal={alert || undefined}
      aria-label={titleLang ? undefined : title}
      aria-labelledby={titleLang ? titleId : undefined}
      aria-describedby={description ? descriptionId : undefined}
      onClose={alert ? undefined : onClose}
      onCancel={(e) => {
        if (alert) e.preventDefault();
        onClose();
      }}
    >
      <header className="lt-sheet-head">
        <h2 className="lt-sheet-title" id={titleLang ? titleId : undefined} lang={titleLang}>
          {title}
        </h2>
        {closeButton ? (
          <button type="button" className="lt-button lt-button-secondary" aria-label={closeLabel} lang={closeLang} onClick={onClose}>
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
      {footer ? <footer className="lt-sheet-foot">{footer}</footer> : null}
    </dialog>
  );
}

export interface SelectOption {
  value: string;
  label: string;
  /** Listed but not choosable (`aria-disabled`): a choice the room shows and refuses, with its reason in the label. */
  disabled?: boolean;
  /** Help on hover. */
  title?: string;
  /** The option's own `data-*` marks, for a room's tests. */
  data?: Readonly<Record<`data-${string}`, string>>;
}

/**
 * One choice from a list, as a button that opens a list: a `combobox` with a `listbox` of `option`s. Focus stays on
 * the button; the arrow keys, Home and End move through the open list, Enter or Space picks, Escape and Tab close.
 * A value not among the options is shown as itself, so a choice in force is never hidden; an empty one shows `placeholder`.
 */
export function Select({
  label,
  labelledBy,
  describedBy,
  title,
  size = 'md',
  className,
  options,
  value,
  onChange,
  disabled,
  placeholder,
}: {
  /** Its name; or `labelledBy`, the id of the words on the page that name it. */
  label?: string;
  labelledBy?: string;
  describedBy?: string;
  title?: string;
  /** sm: a dense desk control. */
  size?: 'sm' | 'md';
  className?: string;
  options: readonly SelectOption[];
  value: string;
  /** Leave it out for a list that only shows a choice in force (every other option disabled). */
  onChange?: (value: string) => void;
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
    if (option?.disabled) return;
    setOpen(false);
    if (option && option.value !== value) onChange?.(option.value);
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
    <div className={className ? `lt-select ${className}` : 'lt-select'}>
      <button
        type="button"
        role="combobox"
        className="lt-select-button"
        data-size={size === 'sm' ? 'sm' : undefined}
        aria-label={labelledBy ? undefined : label}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        title={title}
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
        <ul
          className="lt-select-list"
          role="listbox"
          id={`${id}-list`}
          aria-label={labelledBy ? undefined : label}
          aria-labelledby={labelledBy}
        >
          {options.map((o, i) => (
            <li
              {...o.data}
              key={o.value}
              id={`${id}-${i}`}
              role="option"
              aria-selected={o.value === value}
              aria-disabled={o.disabled || undefined}
              title={o.title}
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
 * With a `tick` (a market's tick size) the arrow keys step by it (Shift, PageUp and PageDown: ten ticks) and the field
 * draws two steppers; `onMax` and `onBbo` add the Max and BBO keys after the unit. Stepping is bigint work, never a float.
 */
export function DecimalInput({
  label,
  hint,
  error,
  unit,
  steppers,
  stepLabels = { up: 'Increase', down: 'Decrease' },
  onMax,
  maxLabel = 'Max',
  onBbo,
  bboLabel = 'BBO',
  ...props
}: DecimalBoxProps & {
  /** Draws the field around the box, this its label. */
  label?: string;
  hint?: string;
  error?: string;
  /** The unit after the value ("USDT"). */
  unit?: string;
  /** The up and down steppers; drawn by default when there is a `tick` and the box can be changed. */
  steppers?: boolean;
  stepLabels?: { up: string; down: string };
  onMax?: () => void;
  maxLabel?: string;
  onBbo?: () => void;
  bboLabel?: string;
}) {
  const auto = React.useId();
  if (label === undefined) return <DecimalBox {...props} />;
  const id = props.id ?? auto;
  const describedBy =
    [props['aria-describedby'], hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') || undefined;
  const { tick, value, onValueChange, precision, min, max, disabled, readOnly } = props;
  const showSteppers = (steppers ?? true) && tick !== undefined && !readOnly;
  const step = (direction: 1 | -1) => {
    if (tick === undefined || disabled || readOnly) return;
    const next = stepDecimal(value, tick, direction, { precision, min: min ?? '0', max });
    if (next !== value) onValueChange(next);
  };
  return (
    <div className="lt-field" data-unit={unit ? '' : undefined}>
      <label htmlFor={id}>{label}</label>
      <div className="lt-field-row">
        <DecimalBox {...props} id={id} dir="ltr" aria-invalid={error ? true : props['aria-invalid']} aria-describedby={describedBy} />
        {unit ? <span className="lt-field-unit">{unit}</span> : null}
        {showSteppers ? (
          <span className="lt-field-steps">
            <button type="button" tabIndex={-1} aria-label={stepLabels.up} disabled={disabled} onClick={() => step(1)}>
              <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                <path d="M4 10l4-4 4 4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
            <button type="button" tabIndex={-1} aria-label={stepLabels.down} disabled={disabled} onClick={() => step(-1)}>
              <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          </span>
        ) : null}
        {onBbo ? (
          <button type="button" className="lt-field-key" disabled={disabled} onClick={onBbo}>
            {bboLabel}
          </button>
        ) : null}
        {onMax ? (
          <button type="button" className="lt-field-key" disabled={disabled} onClick={onMax}>
            {maxLabel}
          </button>
        ) : null}
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

type DecimalBoxProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'inputMode' | 'min' | 'max'> & {
  value: string;
  onValueChange: (value: string) => void;
  precision: number;
  /** The step for the arrow keys (a market's tick size), as a decimal string. */
  tick?: string;
  /** Where stepping stops (typing is never clamped); the lower bound is "0" unless given. */
  min?: string;
  max?: string;
};

function DecimalBox({ value, onValueChange, precision, tick, min, max, onBlur, onKeyDown, ...rest }: DecimalBoxProps) {
  const ref = React.useRef<HTMLInputElement>(null);
  const caret = React.useRef<number | null>(null);
  // After a cleaned keystroke the value changes and the box draws again: put the caret back where the person typed.
  React.useLayoutEffect(() => {
    const at = caret.current;
    caret.current = null;
    if (at !== null && ref.current && ref.current === document.activeElement) placeCaret(ref.current, at);
  });
  return (
    <input
      {...rest}
      ref={ref}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (tick === undefined || rest.readOnly || rest.disabled || e.defaultPrevented) return;
        const next = stepValueForKey(value, tick, e.key, e.shiftKey, { precision, min: min ?? '0', max });
        if (next === null) return;
        e.preventDefault();
        if (next !== value) onValueChange(next);
      }}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      spellCheck={false}
      value={value}
      onChange={(e) => {
        const box = e.currentTarget;
        const raw = box.value;
        const next = nextDecimalValue(value, raw, { precision });
        // What was refused or cleaned away sat before the caret: the caret keeps its place in what stays.
        const at = Math.max(0, (box.selectionStart ?? raw.length) - (raw.length - next.length));
        if (next !== value) {
          caret.current = at;
          onValueChange(next);
          return;
        }
        // A refused keystroke changes no value, so nothing draws again; React puts the old text back once this event
        // is done, which sends the caret to the end. Put it back after that.
        queueMicrotask(() => {
          if (box.isConnected && box.value === value) placeCaret(box, at);
        });
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

function placeCaret(box: HTMLInputElement, at: number) {
  const pos = Math.min(at, box.value.length);
  box.setSelectionRange(pos, pos);
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
  kind: fixed,
  labels,
  asOfLabel,
  timeZone,
}: {
  asOf: AsOf;
  staleAfterMs: number;
  refused?: boolean;
  showAsOf?: boolean;
  now?: number;
  /** Why it is unknown, refused or behind: in the title and read out (a title alone is not read reliably). */
  reason?: string;
  /** A fixed kind (a lifecycle state drawn in the chip's shapes); absent, it is read from `asOf`. */
  kind?: Freshness;
  /** The room's own words for each kind. */
  labels?: Partial<Record<Freshness, string>>;
  /** The room's own words for "as of". */
  asOfLabel?: string;
  /** IANA zone for the as-of time; the browser's own when not given. */
  timeZone?: string;
}) {
  const clock = useFreshnessClock({ asOf, now, staleAfterMs, refused, enabled: fixed == null });
  const kind = fixed ?? freshnessOf({ asOf, now: clock, staleAfterMs, refused });
  const iso = showAsOf ? asOfIso(asOf) : null;
  const shown = iso ? formatAsOf(asOf, { now: clock, timeZone }) : null;
  return (
    <span className="lt-chip" role="status" data-freshness={kind} title={reason}>
      <span className="lt-chip-mark" aria-hidden="true" />
      <span>
        <span data-part="word">{labels?.[kind] ?? FRESHNESS_WORDS[kind]}</span>
        {iso && shown ? (
          <span className="lt-chip-when">
            {asOfLabel === undefined ? ' · as of ' : ` · ${asOfLabel} `}
            <time dateTime={iso}>{shown}</time>
          </span>
        ) : null}
      </span>
      {reason ? <span className="lt-sr">{reason}</span> : null}
    </span>
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
