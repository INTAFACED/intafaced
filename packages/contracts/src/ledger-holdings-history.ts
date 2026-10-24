/**
 * LEDGER HOLDINGS HISTORY — what one owner holds now, and how it moved since a point in time (J-portfolio-05 #6-#7).
 *
 * A read over the custodial ledger, served to svc-bank so it can replay a customer's holdings backwards to any past
 * moment (value over time) and name the flows between two moments (the change-in-value bridge), without a second
 * book. One answer, read in one snapshot, so the holdings and the movements agree:
 *
 * - `holdings`: every account of the owner (available and every lock: hold, escrow, stake, collateral), summed per
 *   asset, as of `asOf`. An asset the owner holds none of is absent, never a zero row.
 * - `movements`: the signed net of every entry on those accounts posted at or after `from`, per asset, per ledger
 *   reason, per time bucket. A move between two of the owner's own accounts in one bucket (an order hold, a hold
 *   released, a withdrawal put on hold) nets to zero and is left out; what is left crossed the owner's edge. `fee` is
 *   the trading fee taken from the owner's receiving line of a fill in that row (`0` when none).
 *
 * So holdings at any bucket boundary T after `from` are `holdings` minus the net of every row whose bucket starts at
 * or after T. Browser-safe: zod only.
 */

import { z } from 'zod';

/** The window or bucket as asked cannot be answered (from in the future, or not an ISO time). */
export const LEDGER_HOLDINGS_HISTORY_WINDOW_INVALID = 'ledger.holdings_history_window_invalid' as const;
/** More rows than one answer carries: ask for a later `from` or a larger bucket. */
export const LEDGER_HOLDINGS_HISTORY_TOO_LARGE = 'ledger.holdings_history_too_large' as const;

/** Bucket sizes in seconds: one minute, five minutes, an hour, four hours, a day (UTC). */
export const LEDGER_HOLDINGS_HISTORY_BUCKETS = [60, 300, 3_600, 14_400, 86_400] as const;
export type LedgerHoldingsHistoryBucket = (typeof LEDGER_HOLDINGS_HISTORY_BUCKETS)[number];

/** A technical bound on one answer, not a business limit. Past it the read refuses rather than answer short. */
export const LEDGER_HOLDINGS_HISTORY_MAX_ROWS = 10_000;

const decimal = /^\d+(\.\d{1,18})?$/;
const signedDecimal = /^-?\d+(\.\d{1,18})?$/;

export const ledgerHoldingsHistoryInputSchema = z
  .object({
    ownerType: z.enum(['user', 'subaccount']),
    ownerId: z.string().min(1).max(128),
    /** Inclusive. Movements posted at or after it are returned. */
    from: z.string().datetime({ offset: true }),
    bucketSeconds: z.literal(LEDGER_HOLDINGS_HISTORY_BUCKETS),
  })
  .strict();
export type LedgerHoldingsHistoryInput = z.infer<typeof ledgerHoldingsHistoryInputSchema>;

export const ledgerHoldingSchema = z.object({
  assetId: z.string().min(1),
  /** Decimal string. */
  amount: z.string().regex(decimal),
});

export const ledgerMovementSchema = z.object({
  assetId: z.string().min(1),
  module: z.string(),
  reason: z.string(),
  /** ISO start of the bucket (UTC, aligned to `bucketSeconds`). */
  bucketStart: z.string(),
  /** Signed decimal string: debits to the owner's accounts less credits from them. */
  net: z.string().regex(signedDecimal),
  /** Decimal string: the trading fee taken from the owner's receiving fill lines in this row, `0` when none. */
  fee: z.string().regex(decimal),
});
export type LedgerMovement = z.infer<typeof ledgerMovementSchema>;

export const ledgerHoldingsHistorySchema = z.object({
  /** ISO time of the read: the holdings are as of this moment, and the movements run up to it. */
  asOf: z.string(),
  from: z.string(),
  bucketSeconds: z.number().int(),
  holdings: z.array(ledgerHoldingSchema),
  /** Oldest bucket first, then asset, module and reason. */
  movements: z.array(ledgerMovementSchema),
});
export type LedgerHoldingsHistory = z.infer<typeof ledgerHoldingsHistorySchema>;
