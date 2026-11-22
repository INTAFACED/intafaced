/**
 * Home's own figures and states, drawn only from the kit (`@intafaced/ui/lit`, its templates and their `lt-` classes). Each
 * keeps the data marks, roles and names of the old part it stands in for (`data-slot="money"`, `"hero-number"`,
 * `"state-block"` and the rest), so the journeys that read Home read it the same way. Figures arrive formatted, as
 * decimal strings: nothing here parses, rounds or formats money.
 */
import type { ReactNode } from 'react';
import { Button } from '@intafaced/ui/lit';
import { Skeleton } from '@intafaced/ui/lit/templates';

export const UNKNOWN = '—';
export const HIDDEN_MASK = '••••';
/** The accessible name of a masked figure, as the old kit's number parts gave it; journeys find a hidden total by it. */
const HIDDEN_NAME = 'Hidden'; // literal-text-ok: a fixed accessible name the app's tests read, not a sentence

export type Direction = 'up' | 'down' | 'flat';

/** The direction a signed, formatted change reads ("+$1.20", "−0.3%"); all zeros is flat. */
export function signDirection(text: string | null | undefined): Direction {
  if (!text) return 'flat';
  const digits = text.replace(/[^0-9]/g, '');
  if (digits === '' || /^0*$/.test(digits)) return 'flat';
  const first = text.trim().charAt(0);
  return first === '+' ? 'up' : first === '−' || first === '-' ? 'down' : 'flat';
}

const GLYPH: Record<Direction, string> = { up: '▲', down: '▼', flat: '' };
const dirOf = (d: Direction) => (d === 'flat' ? undefined : d);

function Figure({
  slot,
  value,
  masked,
  testId,
}: {
  slot: 'money' | 'amount';
  value: string | null | undefined;
  masked: boolean;
  testId?: string;
}) {
  return (
    <span
      data-slot={slot}
      data-testid={testId}
      data-hidden={masked || undefined}
      aria-label={masked ? HIDDEN_NAME : undefined}
      dir="ltr"
      data-ltr=""
    >
      {masked ? HIDDEN_MASK : (value ?? UNKNOWN)}
    </span>
  );
}

/** A balance in money ("$1,204.50"). Masked when balances are hidden. */
export const Money = ({ value, hidden, testId }: { value: string | null | undefined; hidden: boolean; testId?: string }) => (
  <Figure slot="money" value={value} masked={hidden} testId={testId} />
);

/** An asset quantity ("0.0420 BTC"). Masked when balances are hidden. */
export const Amount = ({ value, hidden, testId }: { value: string | null | undefined; hidden: boolean; testId?: string }) => (
  <Figure slot="amount" value={value} masked={hidden} testId={testId} />
);

/** A signed percent, up or down by its sign as well as its colour. A price move: never masked. */
export function Pct({ value, arrow = false }: { value: string | null | undefined; arrow?: boolean }) {
  const dir = value == null ? 'flat' : signDirection(value);
  return (
    <span data-slot="pct" data-direction={dir} data-dir={dirOf(dir)} dir="ltr" data-ltr="">
      {arrow && value != null && GLYPH[dir] ? <span aria-hidden="true">{GLYPH[dir]} </span> : null}
      {value ?? UNKNOWN}
    </span>
  );
}

/** Today's change line: the arrow and signed figure, then its words. A portfolio figure, so masked when balances are hidden. */
export function ChangeText({ value, hidden, suffix }: { value: string | null | undefined; hidden: boolean; suffix?: ReactNode }) {
  const dir = value == null ? 'flat' : signDirection(value);
  return (
    <span data-slot="change-text" data-direction={dir}>
      <span dir="ltr" data-ltr="" data-dir={hidden ? undefined : dirOf(dir)}>
        {!hidden && value != null && GLYPH[dir] ? <span aria-hidden="true">{GLYPH[dir]} </span> : null}
        {hidden ? HIDDEN_MASK : (value ?? UNKNOWN)}
      </span>
      {suffix ? <span className="lt-hint"> {suffix}</span> : null}
    </span>
  );
}

/** "$12,481.29" as a person reads it: the figure is one image whose name is the whole value. */
function spoken(value: string, decimals: number, prefix: string): string {
  const format = new Intl.NumberFormat('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return `${prefix}${format.format(value as Intl.StringNumericLiteral)}`;
}

/**
 * The total, Home's one big figure. `value` is a decimal string already rounded to `decimals` (`null` draws "—"); Intl
 * formats the string exactly, never through a float.
 */
export function HeroFigure({
  value,
  decimals,
  prefix,
  unit,
  hidden,
}: {
  value: string | null;
  decimals: number;
  prefix: string;
  unit?: string;
  hidden: boolean;
}) {
  return (
    <span data-slot="hero-number" data-hidden={hidden || undefined} className="lt-figure lt-figure-hero" dir="ltr" data-ltr="">
      {hidden ? (
        <span aria-label={HIDDEN_NAME}>
          {prefix}
          {HIDDEN_MASK}
        </span>
      ) : value == null ? (
        <span>{UNKNOWN}</span>
      ) : (
        <span role="img" aria-label={spoken(value, decimals, prefix)}>
          {spoken(value, decimals, prefix)}
        </span>
      )}
      {unit ? <span className="lt-hint"> {unit}</span> : null}
    </span>
  );
}

export interface StateAction {
  label: string;
  onClick?: () => void;
  href?: string;
}

function ActionKey({ action, primary }: { action: StateAction; primary: boolean }) {
  const look = primary ? 'lt-button lt-button-primary' : 'lt-button lt-button-secondary';
  return action.href ? (
    <a className={look} href={action.href}>
      {action.label}
    </a>
  ) : (
    <Button tone={primary ? 'primary' : 'secondary'} onClick={action.onClick}>
      {action.label}
    </Button>
  );
}

export type StateBlockProps =
  | { kind: 'empty'; title: ReactNode; body?: ReactNode; action?: StateAction }
  | { kind: 'error'; title: string; onRetry: () => void; retryLabel: string }
  | { kind: 'refused'; title: string; body: ReactNode; code?: string; action?: StateAction };

/** A part of Home that has nothing to show, could not load, or was refused: said in words in its own place. */
export function StateBlock(props: StateBlockProps) {
  if (props.kind === 'empty')
    return (
      <div data-slot="state-block" data-kind="empty" className="lt-empty">
        <p className="lt-empty-title">{props.title}</p>
        {props.body ? <p className="lt-empty-body">{props.body}</p> : null}
        {props.action ? <ActionKey action={props.action} primary /> : null}
      </div>
    );
  if (props.kind === 'error')
    return (
      <div data-slot="state-block" data-kind="error" role="alert" className="lt-refusal" data-refusal="unreachable">
        <p className="lt-refusal-title">{props.title}</p>
        <Button tone="secondary" onClick={props.onRetry}>
          {props.retryLabel}
        </Button>
      </div>
    );
  return (
    <div data-slot="state-block" data-kind="refused" className="lt-refusal" data-refusal="refused">
      <p className="lt-refusal-title">{props.title}</p>
      <p className="lt-refusal-body">{props.body}</p>
      {props.action ? <ActionKey action={props.action} primary={false} /> : null}
      {props.code ? <p className="lt-ref">{props.code}</p> : null}
    </div>
  );
}

const CHIP = { filled: 'done', working: 'unknown', pending: 'pending', failed: 'failed' } as const;

/** A status in words with a shape mark, never colour alone (`data-slot="status-tag"`, its status kept as before). */
export function StatusTag({ status, label, testId, test }: { status: keyof typeof CHIP; label: string; testId?: string; test?: boolean }) {
  return (
    <span className="lt-chip" data-slot="status-tag" data-testid={testId} data-status={test ? 'test' : CHIP[status]} data-tag={status}>
      <span className="lt-chip-mark" aria-hidden="true" />
      {label}
    </span>
  );
}

/** A placeholder in the final shape of what it stands for. */
export const Ghost = Skeleton;
