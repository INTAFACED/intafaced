/**
 * Liquidation fee (D-margin-07, ENGINE LQ-1).
 *
 * The fee on a liquidation rung is the smaller of (owner fee fraction x notional closed) and (collateral left
 * after the loss). It is credited to the insurance fund through the rung's own saga, under the business key
 * `<rungId>:fee`.
 *
 * Blank owner fraction: no fee is charged and the rung records `fee_unset`. A fee is revenue, not a safety
 * control, so a blank fraction never stops a liquidation and is never defaulted to a number.
 *
 * LEDGER OWNER JOB J-3: no `futuresLiquidationFee` recipe exists and svc-trade holds no grant for one. Until it
 * does, a planned fee is computed and recorded but NOT charged: `chargeState` is `ledger_job_pending` and no
 * ledger call is made. Nothing here edits packages/ledger-client or the svc-ledger allowlist.
 *
 * All amounts are scaled bigint (ledger-client SCALE); decimal strings only at the edge.
 */
import { formatAmount, parseAmount, SCALE, type Amount } from '@intafaced/ledger-client';

export const LIQUIDATION_FEE_UNSET = 'fee_unset' as const;
export const LIQUIDATION_FEE_FRACTION_INVALID = 'trade.liquidation_fee_fraction_invalid' as const;
export const LIQUIDATION_FEE_LEDGER_JOB_PENDING = 'ledger_job_pending' as const;

/** Our own terms, in plain words, for the statement and the desk. */
export const LIQUIDATION_FEE_EXPLANATION =
  'Liquidation fee: when a position is liquidated, a fee set by the platform owner is taken from the collateral left after the loss and paid into the insurance fund. It is never more than the collateral left.';

export type FeeFractionResult =
  | { readonly ok: true; readonly fraction: Amount | null }
  | { readonly ok: false; readonly code: typeof LIQUIDATION_FEE_FRACTION_INVALID; readonly message: string };

/**
 * Parse the owner fee fraction (`TRADE_FUTURES_LIQUIDATION_FEE_FRACTION`, a decimal string in [0, 1]).
 * Blank is `null` (fee unset). A malformed or out-of-range value refuses with a typed code; it is never clamped.
 */
export function parseLiquidationFeeFraction(raw: string | undefined | null): FeeFractionResult {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return { ok: true, fraction: null };
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    return { ok: false, code: LIQUIDATION_FEE_FRACTION_INVALID, message: 'liquidation fee fraction must be a decimal in [0, 1]' };
  }
  let fraction: Amount;
  try {
    fraction = parseAmount(trimmed);
  } catch {
    return { ok: false, code: LIQUIDATION_FEE_FRACTION_INVALID, message: 'liquidation fee fraction has too many decimals' };
  }
  if (fraction > SCALE) {
    return { ok: false, code: LIQUIDATION_FEE_FRACTION_INVALID, message: 'liquidation fee fraction is above 1' };
  }
  return { ok: true, fraction };
}

export interface PlanLiquidationFeeInput {
  readonly rungId: string;
  /** Owner fraction (scaled), or null when unset. */
  readonly fraction: Amount | null;
  /** Notional closed by this rung (scaled, >= 0). */
  readonly notionalClosed: Amount;
  /** Collateral left after the rung's loss (scaled). Negative or zero means nothing is left. */
  readonly leftoverCollateral: Amount;
}

export type LiquidationFeePlan =
  | { readonly state: typeof LIQUIDATION_FEE_UNSET; readonly fee: 0n; readonly key: null }
  | {
      readonly state: 'planned';
      readonly fee: Amount;
      readonly capped: boolean;
      readonly key: string;
      readonly chargeState: typeof LIQUIDATION_FEE_LEDGER_JOB_PENDING;
    };

/** Fee idempotency key: a business key bound to the rung, so a replay reuses it. */
export function liquidationFeeKey(rungId: string): string {
  if (rungId.trim() === '') throw new Error('liquidation fee key needs a rung id');
  return `${rungId}:fee`;
}

export function planLiquidationFee(input: PlanLiquidationFeeInput): LiquidationFeePlan {
  if (input.notionalClosed < 0n) throw new Error('notional closed cannot be negative');
  if (input.fraction === null) return { state: LIQUIDATION_FEE_UNSET, fee: 0n, key: null };
  const byFraction = (input.fraction * input.notionalClosed) / SCALE;
  const leftover = input.leftoverCollateral > 0n ? input.leftoverCollateral : 0n;
  const capped = byFraction > leftover;
  return {
    state: 'planned',
    fee: capped ? leftover : byFraction,
    capped,
    key: liquidationFeeKey(input.rungId),
    chargeState: LIQUIDATION_FEE_LEDGER_JOB_PENDING,
  };
}

/** Wire form for the desk and the customer statement: decimal strings, the reason, and the explanation. */
export function presentLiquidationFeePlan(plan: LiquidationFeePlan): {
  fee: string;
  feeState: string;
  charged: false;
  chargeReason: string;
  explanation: string;
} {
  return {
    fee: formatAmount(plan.fee),
    feeState: plan.state,
    charged: false,
    chargeReason: plan.state === LIQUIDATION_FEE_UNSET ? LIQUIDATION_FEE_UNSET : plan.chargeState,
    explanation: LIQUIDATION_FEE_EXPLANATION,
  };
}

export const LIQUIDATION_FEE_FRACTION_ENV = 'TRADE_FUTURES_LIQUIDATION_FEE_FRACTION' as const;

/**
 * Boot loader for the owner fee fraction. Unset or blank is `null` (fee unset: nothing is charged and the
 * rung records `fee_unset`). A malformed value fails boot with the typed code: a mistyped owner number is
 * never read as "no fee" and never clamped.
 */
export function loadLiquidationFeeFraction(env: Readonly<Record<string, string | undefined>>): Amount | null {
  const parsed = parseLiquidationFeeFraction(env[LIQUIDATION_FEE_FRACTION_ENV]);
  if (!parsed.ok) throw new Error(`${parsed.code}: ${LIQUIDATION_FEE_FRACTION_ENV} ${parsed.message}`);
  return parsed.fraction;
}
