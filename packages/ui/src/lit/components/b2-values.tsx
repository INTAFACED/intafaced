/**
 * Volt's dense value parts for desks and tables: a number in a row (amount, price, percent, change), a coin's mark,
 * an order's status word, a small tag, a whole-panel state and the loading line. The look is
 * `components.css` (`lt-num`, `lt-coin`, `lt-status`, `lt-badge`, `lt-state`, `lt-table-scroll`), roles only.
 * Amounts and changes hide when the person hides balances (the same switch the older kit reads).
 */
import * as React from 'react';
import { clsx } from 'clsx';
import { useHideBalances } from '../../components/numbers.js';
import { coinArt } from '../../components/coins/coin-art.generated.js';

export const UNKNOWN = '—';
export const HIDDEN_MASK = '••••';
const LTR = { dir: 'ltr', 'data-ltr': '' } as const;

export type Direction = 'up' | 'down' | 'flat';

/** Direction of an already-formatted, signed change ("+1.2%", "−0.28%"); all-zero digits are flat. */
export function signDirection(text: string | null | undefined): Direction {
  if (!text) return 'flat';
  const digits = text.replace(/[^0-9]/g, '');
  if (digits === '' || /^0*$/.test(digits)) return 'flat';
  const first = text.trim().charAt(0);
  if (first === '+') return 'up';
  if (first === '−' || first === '-') return 'down';
  return 'flat';
}

const GLYPH: Record<Direction, string> = { up: '▲', down: '▼', flat: '' };

interface ValueProps extends Omit<React.ComponentProps<'span'>, 'children'> {
  /** Pre-formatted text, or null when unknown. */
  value: string | null | undefined;
  /** Mask when "hide balances" is on. Default true for amounts, false for prices. */
  sensitive?: boolean;
  /** Overrides the hide-balances switch (tests). */
  hidden?: boolean;
}

function useMasked(sensitive: boolean | undefined, hidden: boolean | undefined, fallback: boolean): boolean {
  const fromContext = useHideBalances();
  return (sensitive ?? fallback) && (hidden ?? fromContext);
}

function NumberText({
  value,
  masked,
  className,
  slot,
  ...props
}: Omit<ValueProps, 'sensitive' | 'hidden'> & { masked: boolean; slot: string }) {
  return (
    <span
      data-slot={slot}
      data-hidden={masked || undefined}
      data-unknown={(value == null && !masked) || undefined}
      aria-label={masked ? 'Hidden' : undefined}
      className={clsx('lt-num', className)}
      {...props}
      {...LTR}
    >
      {masked ? HIDDEN_MASK : (value ?? UNKNOWN)}
    </span>
  );
}

/** An asset quantity ("0.0420 BTC"). Hidden when balances are hidden. */
export function Amount({ value, sensitive, hidden, ...props }: ValueProps) {
  return <NumberText slot="amount" value={value} masked={useMasked(sensitive, hidden, true)} {...props} />;
}

/** A market price: always shown, even with balances hidden. */
export function Price({ value, sensitive, hidden, ...props }: ValueProps) {
  return <NumberText slot="price" value={value} masked={useMasked(sensitive, hidden, false)} {...props} />;
}

/** A signed percent, toned by its sign; the sign is always in the text. */
export function Pct({
  value,
  arrow = false,
  direction,
  className,
  ...props
}: Omit<ValueProps, 'sensitive' | 'hidden'> & { arrow?: boolean; direction?: Direction }) {
  const dir = value == null ? 'flat' : (direction ?? signDirection(value));
  return (
    <span data-slot="pct" data-direction={dir} className={clsx('lt-num lt-signed', className)} {...props} {...LTR}>
      {arrow && value != null && GLYPH[dir] ? <span aria-hidden="true">{GLYPH[dir]} </span> : null}
      {value ?? UNKNOWN}
    </span>
  );
}

/** A change line: arrow and signed text toned by sign, so colour is never the only cue. Hidden with balances. */
export function ChangeText({
  value,
  direction,
  suffix,
  sensitive,
  hidden,
  className,
  ...props
}: ValueProps & { direction?: Direction; suffix?: React.ReactNode }) {
  const masked = useMasked(sensitive, hidden, true);
  const dir = value == null ? 'flat' : (direction ?? signDirection(value));
  return (
    <span data-slot="change-text" data-direction={dir} className={clsx('lt-change-text', className)} {...props}>
      <span {...LTR} className="lt-num lt-signed" data-direction={masked ? 'flat' : dir}>
        {!masked && value != null && GLYPH[dir] ? <span aria-hidden="true">{GLYPH[dir]} </span> : null}
        {masked ? HIDDEN_MASK : (value ?? UNKNOWN)}
      </span>
      {suffix ? <span className="lt-quiet">{suffix}</span> : null}
    </span>
  );
}

/** A coin's mark, or its first letter in a circle when we hold no art for it. */
export function CoinIcon({
  asset,
  size = 'md',
  className,
  ...props
}: Omit<React.ComponentProps<'span'>, 'children'> & { asset: string; size?: 'sm' | 'md' | 'lg' }) {
  const key = asset.toUpperCase();
  const svg = coinArt[key];
  if (svg)
    return (
      <span data-slot="coin-icon" data-asset={key} data-size={size} className={clsx('lt-coin', className)} {...props}>
        {/* The art is this package's own generated constant (coin-art.test.ts): no script, handler or reference. */}
        <span aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />
      </span>
    );
  return (
    <span
      data-slot="coin-icon"
      data-asset={key}
      data-size={size}
      data-fallback="lettered"
      aria-hidden="true"
      className={clsx('lt-coin', className)}
      {...props}
    >
      {key.charAt(0)}
    </span>
  );
}

export type StatusKind = 'filled' | 'working' | 'pending' | 'cancelled' | 'failed';
const STATUS_WORD: Record<StatusKind, string> = {
  filled: 'Filled',
  working: 'Working',
  pending: 'Pending',
  cancelled: 'Cancelled',
  failed: 'Failed',
};

/** An order's status word in a hairline box; the room passes its own copy. */
export function StatusTag({
  status,
  label,
  className,
  ...props
}: Omit<React.ComponentProps<'span'>, 'children'> & { status: StatusKind; label?: string }) {
  return (
    <span data-slot="status-tag" data-status={status} className={clsx('lt-status', className)} {...props}>
      {label ?? STATUS_WORD[status]}
    </span>
  );
}

export type BadgeTone = 'neutral' | 'accent' | 'warn' | 'error' | 'up' | 'down';

/** A small tinted tag with words (colour alone is never the cue). */
export function Badge({ tone = 'neutral', className, ...props }: React.ComponentProps<'span'> & { tone?: BadgeTone }) {
  return <span data-slot="badge" data-tone={tone} className={clsx('lt-badge', className)} {...props} />;
}

export interface StateAction {
  label: string;
  onClick?: () => void;
  /** Renders a link instead of a button. */
  href?: string;
}

export type StateBlockProps = { className?: string; testId?: string } & (
  | { kind: 'loading'; rows?: number; label?: string }
  | { kind: 'empty'; title: React.ReactNode; body?: React.ReactNode; action?: StateAction }
  | { kind: 'error'; thing?: string; title?: string; onRetry: () => void; retryLabel?: string }
  | { kind: 'refused'; title: string; body: React.ReactNode; code?: string; action?: StateAction }
);

function StateButton({ action, tone }: { action: StateAction; tone: 'primary' | 'secondary' }) {
  if (action.href)
    return (
      <a className="lit-button" data-tone={tone} data-size="md" role="link" href={action.href}>
        {action.label}
      </a>
    );
  return (
    <button type="button" className="lit-button" data-tone={tone} data-size="md" onClick={action.onClick}>
      {action.label}
    </button>
  );
}

/** A panel's own state, inside the panel: loading rows, empty, a failed read with its retry, or a typed refusal. */
export function StateBlock(props: StateBlockProps) {
  if (props.kind === 'loading')
    return (
      <div
        data-slot="state-block"
        data-testid={props.testId}
        data-kind="loading"
        role="status"
        aria-busy="true"
        aria-label={props.label}
        className={clsx('lt-state', props.className)}
      >
        {Array.from({ length: props.rows ?? 3 }, (_, i) => (
          <span key={i} className="lt-bone" aria-hidden="true" />
        ))}
      </div>
    );
  if (props.kind === 'empty')
    return (
      <div data-slot="state-block" data-testid={props.testId} data-kind="empty" className={clsx('lt-state', props.className)}>
        <h3 className="lt-state-title">{props.title}</h3>
        {props.body ? <p className="lt-state-body">{props.body}</p> : null}
        {props.action ? <StateButton action={props.action} tone="primary" /> : null}
      </div>
    );
  if (props.kind === 'error')
    return (
      <div data-slot="state-block" data-testid={props.testId} data-kind="error" role="alert" className={clsx('lt-state', props.className)}>
        <p className="lt-state-title">{props.title ?? `Couldn't load ${props.thing ?? 'this'}.`}</p>
        <StateButton action={{ label: props.retryLabel ?? 'Try again', onClick: props.onRetry }} tone="secondary" />
      </div>
    );
  return (
    <div data-slot="state-block" data-testid={props.testId} data-kind="refused" className={clsx('lt-state', props.className)}>
      <p className="lt-state-title">{props.title}</p>
      <p className="lt-state-body">{props.body}</p>
      {props.action ? <StateButton action={props.action} tone="secondary" /> : null}
      {props.code ? <p className="lt-ref">{props.code}</p> : null}
    </div>
  );
}

/** Data on its way: one status line, the words the room passes. */
export function Loading({ label }: { label: React.ReactNode }) {
  return (
    <div className="lt-loading" role="status">
      <span className="lt-loading-dot" aria-hidden="true" />
      {label}…
    </div>
  );
}

/** A placeholder bar while one value loads; `block` for a panel, `row` for a line, `word` for a figure. */
export function Bone({ size = 'row' }: { size?: 'word' | 'row' | 'block' | 'panel' }) {
  return <span className="lt-bone" data-size={size} aria-hidden="true" />;
}
