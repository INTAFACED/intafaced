/**
 * Pure collateral-credit arithmetic.
 *
 * This file does not import position-service.ts. PositionService.open calls
 * these helpers after it has already computed margin, so a retry of an
 * admitted open is not priced a second time and there is no import cycle.
 *
 * The cut is ceil: a fractional haircut never invents credit. Blank, negative,
 * and a bps above 10000 are config errors, not a haircut of 0 or 10.
 */
import type { Amount } from '@intafaced/ledger-client';
import { mulBps } from '@intafaced/ledger-client/money';
import { parseOwnerIntegerEnv } from '../owner-int-env.js';

export const HAIRCUT_UNSET = 'trade.haircut_unset' as const;
export const HAIRCUT_CREDIT_SHORT = 'trade.haircut_credit_short' as const;
/** The account's collateral could not be read: a service failure, retried, never the owner's answer. */
export const COLLATERAL_UNREADABLE = 'trade.collateral_unreadable' as const;

export function readOwnerHaircutBps(env: NodeJS.ProcessEnv = process.env): unknown {
  return env.TRADE_COLLATERAL_HAIRCUT_BPS;
}

/** Owner integer bps in 0..10000. Blank, non-integer, negative, or above 10000 refuses. */
export function requireOwnerHaircutBps(raw: unknown): number {
  const n = parseOwnerIntegerEnv(typeof raw === 'number' || typeof raw === 'string' ? raw : String(raw));
  if (n == null || n < 0 || n > 10_000) {
    throw Object.assign(new Error('TRADE_COLLATERAL_HAIRCUT_BPS is unset — refuse rather than invent a haircut'), {
      code: HAIRCUT_UNSET,
    });
  }
  return n;
}

/**
 * How much of the posted cash counts toward initial margin.
 * 1000 bps on 100 credits 90. The cut is ceil so a fractional haircut never
 * invents credit. The initial-margin lock is a different number: this function
 * does not return it.
 */
export function collateralCredit(postedCash: Amount, haircutBps: number): Amount {
  if (postedCash <= 0n) return 0n as Amount;
  if (!Number.isInteger(haircutBps) || haircutBps <= 0) return postedCash;
  if (haircutBps >= 10_000) return 0n as Amount;
  const cut = mulBps(postedCash, haircutBps, 'ceil');
  const credit = postedCash - cut;
  return (credit < 0n ? 0n : credit) as Amount;
}

export type OpenCreditDecision =
  | { readonly ok: true; readonly credit: Amount; readonly lockAmount: Amount }
  | { readonly ok: false; readonly code: typeof HAIRCUT_CREDIT_SHORT; readonly reason: string; readonly lockAmount: 0n };

/**
 * Credit below the required initial margin refuses. The lock, when the open
 * proceeds, stays the full initial margin — the haircut does not shrink it.
 *
 * `postedCash` is free balance plus margin already locked. `initialMargin` is
 * the sum of initial margin already required plus the new requirement.
 */
export function decideOpenCredit(input: {
  readonly postedCash: Amount;
  readonly initialMargin: Amount;
  readonly haircutBps: number;
}): OpenCreditDecision {
  const credit = collateralCredit(input.postedCash, input.haircutBps);
  if (credit < input.initialMargin) {
    return {
      ok: false,
      code: HAIRCUT_CREDIT_SHORT,
      reason:
        'posted collateral credit is below the initial margin — the haircut does not shrink the lock, so the open is refused and nothing is locked',
      lockAmount: 0n,
    };
  }
  return { ok: true, credit, lockAmount: input.initialMargin };
}
