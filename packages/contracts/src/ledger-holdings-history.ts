/**
 * LEDGER HOLDINGS HISTORY — what one owner holds now, and how it moved since a point in time (J-portfolio-05 #6-#7).
 *
 * A read over the custodial ledger, served to svc-bank so it can replay a customer's holdings backwards to any past
 * moment (value over time) and name the flows between two moments (the change-in-value bridge), without a second
 * book. One answer, read in one snapshot, so the holdings and the movements agree:
 *
 * - `holdings`: every account of the owner (available and every lock: hold, escrow, stake, collateral), summed per
 *   asset, as of `asOf`. An asset the owner holds none of is absent, never a zero row.
 * - `movements`: what crossed the owner's edge in every transaction posted at or after `from`, per asset, ledger
 *   reason and time bucket. Each transaction is netted over the owner's accounts first, so a move between two of
 *   them (an order hold, a hold released, a withdrawal put on hold or reversed) is zero and left out; a transaction
 *   that left the owner with more counts in `inflow`, one that left it with less in `outflow`, so money in and money
 *   out under one reason in one bucket stay apart. `fee` is the trading fee taken from the owner's receiving line of
 *   a fill in that row (`0` when none).
 *
 * So holdings at any bucket boundary T after `from` are `holdings` minus (inflow - outflow) of every row whose bucket
 * starts at or after T. `asOf` is the database time of the read; the holdings and the movements come from one
 * snapshot, so they agree with each other whatever the clocks say. Browser-safe: zod only.
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
const isoTime = z.string().datetime({ offset: true });

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
  bucketStart: isoTime,
  /** Decimal string: what the transactions that left the owner with more brought in. */
  inflow: z.string().regex(decimal),
  /** Decimal string: what the transactions that left the owner with less took out. */
  outflow: z.string().regex(decimal),
  /** Decimal string: the trading fee taken from the owner's receiving fill lines in this row, `0` when none. */
  fee: z.string().regex(decimal),
});
export type LedgerMovement = z.infer<typeof ledgerMovementSchema>;

export const ledgerHoldingsHistorySchema = z.object({
  /** ISO time of the read: the holdings are as of this moment, and the movements run up to it. */
  asOf: isoTime,
  from: isoTime,
  bucketSeconds: z.literal(LEDGER_HOLDINGS_HISTORY_BUCKETS),
  holdings: z.array(ledgerHoldingSchema),
  /** Oldest bucket first, then asset, module and reason. */
  movements: z.array(ledgerMovementSchema),
});
export type LedgerHoldingsHistory = z.infer<typeof ledgerHoldingsHistorySchema>;
