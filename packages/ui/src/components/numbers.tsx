'use client';

import * as React from 'react';
import { cn } from './cn.js';

/**
 * Number display (UI-SPEC 2.6, 4.1). Strings in, strings out: these components
 * never parse, round or format money. The app's `format.ts` helpers (fmtUsd,
 * fmtPrice, fmtAmount, fmtPct) produce the text; these only draw it with
 * tabular figures, the right colour and the hide-balances rule.
 *
 * `null` (unknown) always draws "—", never 0.
 *
 * Every figure is drawn left to right and isolated (`LTR`), so on an
 * Arabic or Hebrew page "+$206.29 (+1.68%)" keeps its sign in front and its
 * brackets in place instead of reading "(1.68%+) $206.29+".
 */

/** Left to right and isolated, after any props so a caller cannot undo it; `data-ltr` is the kit's marker for such values. */
export const LTR = { dir: 'ltr', 'data-ltr': '' } as const;

export const UNKNOWN = '—';
export const HIDDEN_MASK = '••••';

const HideBalancesContext = React.createContext(false);

/** Wrap the app (or one screen) once; Money, Amount and ChangeText read it. */
export function HideBalancesProvider({ hidden, children }: { hidden: boolean; children: React.ReactNode }) {
  return <HideBalancesContext.Provider value={hidden}>{children}</HideBalancesContext.Provider>;
}

export function useHideBalances(): boolean {
  return React.useContext(HideBalancesContext);
}

export type Direction = 'up' | 'down' | 'flat';

/**
 * Direction of an already-formatted, signed change string ("+$134.46 (+4.02%)",
 * "−0.28%"). Reads the leading sign; a string whose digits are all zero is flat.
 */
export function signDirection(text: string | null | undefined): Direction {
  if (!text) return 'flat';
  const digits = text.replace(/[^0-9]/g, '');
  if (digits === '' || /^0*$/.test(digits)) return 'flat';
  const first = text.trim().charAt(0);
  if (first === '+') return 'up';
  if (first === '−' || first === '-') return 'down';
  return 'flat';
}

const directionClass: Record<Direction, string> = {
  up: 'text-up-text',
  down: 'text-down-text',
  flat: 'text-fg-2',
};

const GLYPH: Record<Direction, string> = { up: '▲', down: '▼', flat: '' };

interface ValueProps extends Omit<React.ComponentProps<'span'>, 'children'> {
  /** Pre-formatted text, or null when unknown. */
  value: string | null | undefined;
}

interface SensitiveProps {
  /** Mask when "hide balances" is on. Default true for balances, false for prices. */
  sensitive?: boolean;
  /** Overrides the HideBalancesProvider (tests, stories). */
  hidden?: boolean;
}

function useMasked({ sensitive, hidden }: SensitiveProps, fallbackSensitive: boolean): boolean {
  const fromContext = useHideBalances();
  return (sensitive ?? fallbackSensitive) && (hidden ?? fromContext);
}

function NumberText({ value, masked, className, slot, ...props }: ValueProps & { masked: boolean; slot: string }) {
  const unknown = value == null;
  return (
    <span
      data-slot={slot}
      data-hidden={masked || undefined}
      aria-label={masked ? 'Hidden' : undefined}
      className={cn('if-num whitespace-nowrap tabular-nums', unknown && !masked && 'text-fg-2', className)}
      {...props}
      {...LTR}
    >
      {masked ? HIDDEN_MASK : (value ?? UNKNOWN)}
    </span>
  );
}

/** A USD value (or other balance-derived money). Masked when balances are hidden. */
export function Money({ value, sensitive, hidden, ...props }: ValueProps & SensitiveProps) {
  return <NumberText slot="money" value={value} masked={useMasked({ sensitive, hidden }, true)} {...props} />;
}

/** An asset quantity ("0.0420 BTC"). Masked when balances are hidden. */
export function Amount({ value, sensitive, hidden, ...props }: ValueProps & SensitiveProps) {
  return <NumberText slot="amount" value={value} masked={useMasked({ sensitive, hidden }, true)} {...props} />;
}

/** A market price. Prices are always shown, even with balances hidden. */
export function Price({ value, sensitive, hidden, ...props }: ValueProps & SensitiveProps) {
  return <NumberText slot="price" value={value} masked={useMasked({ sensitive, hidden }, false)} {...props} />;
}

export interface PctProps extends ValueProps {
  /** Draw the ▲/▼ glyph before the text. */
  arrow?: boolean;
  /** Force the direction (default: read from the sign of `value`). */
  direction?: Direction;
}

/** A signed percent ("+1.24%", "−0.28%"), coloured by sign. The sign is always in the text. */
export function Pct({ value, arrow = false, direction, className, ...props }: PctProps) {
  const dir = value == null ? 'flat' : (direction ?? signDirection(value));
  return (
    <span
      data-slot="pct"
      data-direction={dir}
      className={cn('if-num inline-flex items-center gap-1 whitespace-nowrap tabular-nums', directionClass[dir], className)}
      {...props}
      {...LTR}
    >
      {arrow && value != null && GLYPH[dir] ? (
        <span aria-hidden="true" className="text-[0.7em] leading-none">
          {GLYPH[dir]}
        </span>
      ) : null}
      {value ?? UNKNOWN}
    </span>
  );
}

export interface ChangeTextProps extends Omit<React.ComponentProps<'span'>, 'children'>, SensitiveProps {
  /** Pre-formatted "+$134.46 (+4.02%)". */
  value: string | null | undefined;
  direction?: Direction;
  /** Muted trailing words such as "Today" or "since 14:00". */
  suffix?: React.ReactNode;
}

/**
 * Change line: ▲/▼ glyph + signed text, coloured by sign. The sign is always
 * in the text and the glyph is a second cue, so colour is never the only signal.
 * It is a portfolio figure, so it is masked when balances are hidden.
 */
export function ChangeText({ value, direction, suffix, sensitive, hidden, className, ...props }: ChangeTextProps) {
  const masked = useMasked({ sensitive, hidden }, true);
  const dir = value == null ? 'flat' : (direction ?? signDirection(value));
  return (
    <span data-slot="change-text" data-direction={dir} className={cn('inline-flex items-baseline gap-1.5', className)} {...props}>
      <span
        {...LTR}
        className={cn('if-num inline-flex items-center gap-1 whitespace-nowrap tabular-nums', masked ? 'text-fg-2' : directionClass[dir])}
      >
        {!masked && value != null && GLYPH[dir] ? (
          <span aria-hidden="true" className="text-[0.7em] leading-none">
            {GLYPH[dir]}
          </span>
        ) : null}
        {masked ? HIDDEN_MASK : (value ?? UNKNOWN)}
      </span>
      {suffix ? <span className="text-fg-2">{suffix}</span> : null}
    </span>
  );
}
