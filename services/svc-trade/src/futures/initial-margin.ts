/**
 * Initial margin for a futures open (trade.futures F2 helper), and THE LEVERAGE
 * CEILING.
 *
 * Pure arithmetic: notional / leverage, floored to integer scaled units via
 * ledger Amount bigints. Engine and risk still own whether the open is allowed.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THERE WAS NO CEILING AT ALL, AND THAT IS WHAT THIS FILE IS NOW ALSO FOR
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `grep -rn "MAX_LEVERAGE\|maxLeverage"` returned nothing on this repository.
 * `position-service.ts` took `leverage` off the request body, this function
 * checked that it was `> 0`, and the only ceiling anywhere in the path was an
 * accident of storage: `positions.leverage` is `numeric(8, 2)`, so the platform
 * would accept **999,999.99x** and answer a request for 1,000,000x with a
 * Postgres `22003` numeric overflow surfacing as a 500.
 *
 * That is indefensible on its own terms, before any exploit is involved. It is
 * also the multiplier on one: 100,000x turned ten USDT of margin into a million
 * of notional, and a mark moved 19% against a thin book paid 190,000 out of the
 * profit pot. The depth requirement in `mark-from-depth.ts` is the other half —
 * it makes the mark expensive to manufacture — and neither half is sufficient
 * alone. **This half is what makes the prize bounded and the margin real.**
 *
 * WHAT LEVERAGE ACTUALLY IS, HERE. Margin is `notional / leverage`, and margin
 * is the only money the trader has at risk in an isolated position
 * (`DIRECTION` §1). So leverage is precisely the ratio between what a mark may
 * be asked to pay out on and what its owner stands to lose for being wrong. An
 * unbounded ratio means an unbounded payout against a bounded stake, which is
 * not a leverage product — it is a free option on the house pot.
 *
 * REFUSED, NOT CLAMPED. A request for 500x is not quietly opened at the cap: the
 * caller asked for a position with a different liquidation price than the one
 * they would get, and silently substituting risk parameters is the same class of
 * mistake as silently substituting a price. `docs/adr/2026-08-05-futures-risk-
 * and-mark-law.md` is explicit for prices — *refuse the request, not
 * ignore-and-substitute, so the caller learns* — and a margin requirement is a
 * price the caller pays.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE NUMBER IS THE LISTING OWNER'S.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * An absent owner/listing cap is not permission to choose one. It disables
 * position opens and re-leverage while leaving the rest of svc-trade serving.
 */
import { div, formatAmount, mul, parseAmount, type Amount } from '@intafaced/ledger-client';

/** Preserve an explicitly named positive cap. Missing stays missing. */
export function resolveMaxLeverage(configured?: Amount | null): Amount | null {
  return configured != null && configured > 0n ? configured : null;
}

/** Parse the owner cap. Empty → null/refuse-closed; this function never supplies a magnitude. */
export function parseConfiguredMaxLeverage(raw: string): Amount | null {
  const s = raw.trim();
  if (s === '') return null;
  const n = parseAmount(s);
  if (n <= 0n) {
    throw new Error('TRADE_FUTURES_MAX_LEVERAGE must be a positive decimal or empty');
  }
  return n;
}

/** Leverage was zero, negative, or not a number this path can use. */
export const LEVERAGE_INVALID = 'trade.leverage_invalid';
/** Leverage was positive and above the cap. */
export const LEVERAGE_TOO_HIGH = 'trade.leverage_too_high';
/** No listing/owner source named the cap, so no money path may guess one. */
export const LEVERAGE_CAP_UNSET = 'trade.leverage_cap_unset';

export type LeverageRefusalCode = typeof LEVERAGE_INVALID | typeof LEVERAGE_TOO_HIGH;

export interface LeverageCheck {
  readonly ok: boolean;
  readonly reason?: string;
  /** Present exactly when `ok` is false. */
  readonly code?: LeverageRefusalCode;
}

/**
 * MAY A POSITION BE OPENED AT THIS LEVERAGE?
 *
 * Pure, and returns a refusal rather than throwing, so the caller can decide the
 * HTTP shape and — more importantly — can run it BEFORE it locks any margin or
 * writes any row. `position-service.ts` calls it before the ledger post, which
 * is what turns the `numeric(8, 2)` overflow from a 500 with a compensating
 * release into a 400 that never moved anything.
 */
export function checkLeverage(leverage: Amount, maximum: Amount): LeverageCheck {
  if (leverage <= 0n) {
    return { ok: false, code: LEVERAGE_INVALID, reason: `leverage must be greater than zero, got ${formatAmount(leverage)}` };
  }
  if (leverage > maximum) {
    return {
      ok: false,
      code: LEVERAGE_TOO_HIGH,
      reason: `leverage ${formatAmount(leverage)}x exceeds the maximum of ${formatAmount(maximum)}x on this deployment`,
    };
  }
  return { ok: true };
}

export function initialMargin(input: { size: Amount; entryPrice: Amount; leverage: Amount }): Amount {
  if (input.size <= 0n) throw new Error('size must be positive');
  if (input.entryPrice <= 0n) throw new Error('entryPrice must be positive');
  if (input.leverage <= 0n) throw new Error('leverage must be positive');
  // Margin the house requires rounds up, and rounds once on the true value: notional rounds up too, then the division
  // by leverage, so a trader is never asked for less than notional / leverage.
  const margin = div(mul(input.size, input.entryPrice, 'ceil'), input.leverage, 'ceil');
  if (margin <= 0n) throw new Error('initial margin rounds to zero — raise size/price or lower leverage');
  return margin;
}

/** Test helper: parse decimal strings into Amounts then compute. */
export function initialMarginFromDecimals(size: string, entryPrice: string, leverage: string): string {
  const m = initialMargin({
    size: parseAmount(size),
    entryPrice: parseAmount(entryPrice),
    leverage: parseAmount(leverage),
  });
  // format as integer string of scaled amount is internal; tests compare via parse
  return m.toString();
}

/** Leverage is set in hundredths: the order path refuses a finer step, and so does the calculator. */
export const LEVERAGE_STEP = 10n ** 16n;
