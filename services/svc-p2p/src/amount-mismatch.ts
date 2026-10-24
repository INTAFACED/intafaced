/**
 * P-trade-orders-20 / J-p2p-02 #3: the seller checks their own bank and finds the buyer paid less, more, or only part.
 *
 * The band is the owner's (`P2P_MISMATCH_TOLERANCE_BPS`, basis points of the order's fiat amount). Within it the report
 * is logged and the order goes on. Outside it nothing changes: the order stays paid and waiting on the seller, who is
 * never forced to release, and the dispute path is the way forward. Blank means no automatic classification: every
 * report goes to a person, through a dispute. The platform never moves fiat.
 */
import type { Amount } from '@intafaced/ledger-client';
import { PricingError, quantiseFiat } from './pricing.js';

export const MISMATCH_KINDS = ['under', 'over', 'partial'] as const;
export type MismatchKind = (typeof MISMATCH_KINDS)[number];

export const MISMATCH_CLASSIFICATIONS = ['within_tolerance', 'outside_tolerance', 'reported'] as const;
export type MismatchClassification = (typeof MISMATCH_CLASSIFICATIONS)[number];

export interface MismatchReport {
  readonly tradeId: string;
  readonly kind: MismatchKind;
  readonly amountReceived: Amount;
  /** The order's fiat amount when it was reported. */
  readonly expected: Amount;
  readonly classification: MismatchClassification;
  /** The owner's band the report was classified by, or null when it was blank. */
  readonly toleranceBps: number | null;
  readonly reportedAt: Date;
}

/** Blank, negative or past 100 % is unset: never a guessed band. Zero is a real band: only the exact amount is within it. */
export function parseToleranceBps(raw: number | null | undefined): number | null {
  if (raw === null || raw === undefined || !Number.isSafeInteger(raw) || raw < 0 || raw > 10_000) return null;
  return raw;
}

/**
 * The received amount must be a payable amount in the order's currency and must say what the kind says: less than the
 * order for `under` and `partial`, more for `over`. Anything else refuses `p2p.invalid_amount`.
 */
export function assertMismatchAmount(kind: MismatchKind, received: Amount, expected: Amount, fiatCurrency: string): void {
  if (received <= 0n) throw new PricingError('The amount received must be positive', 'p2p.invalid_amount');
  if (quantiseFiat(received, fiatCurrency, 'floor') !== received) {
    throw new PricingError(`A ${fiatCurrency} amount has no finer unit than the currency's own`, 'p2p.invalid_amount');
  }
  if (kind === 'over' ? received <= expected : received >= expected) {
    throw new PricingError(
      kind === 'over' ? 'An overpayment is more than the order amount' : 'An underpayment or part payment is less than the order amount',
      'p2p.invalid_amount',
    );
  }
}

/** Within the band when the difference is at most `toleranceBps` of the order amount, compared exactly in scaled units. */
export function classifyMismatch(received: Amount, expected: Amount, toleranceBps: number | null): MismatchClassification {
  if (toleranceBps === null) return 'reported';
  const diff = received > expected ? received - expected : expected - received;
  return diff * 10_000n <= expected * BigInt(toleranceBps) ? 'within_tolerance' : 'outside_tolerance';
}
