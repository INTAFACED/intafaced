import { formatAmount, LedgerError, type AccountRef, type Amount } from '@intafaced/ledger-client';
import {
  LEDGER_HOLDINGS_HISTORY_WINDOW_INVALID,
  ledgerHoldingsHistoryInputSchema,
  type LedgerHoldingsHistory,
  type LedgerHoldingsHistoryBucket,
} from '@intafaced/contracts';

/**
 * HOLDINGS HISTORY: what one owner holds now, and how it moved since `from` (contract in
 * `packages/contracts/src/ledger-holdings-history.ts`).
 *
 * A READ, like `history`: no lock, no write, no path into `post()`. Both halves are read in one repeatable-read
 * snapshot, so the holdings are exactly what the movements lead up to. The sums run in the database:
 *
 * - holdings: `accounts.balance` summed per asset over every account of the owner (available and every lock kind);
 * - movements: each transaction posted at or after `from` netted over the owner's accounts per asset (a move between
 *   two of them is zero), then summed per asset, ledger reason and time bucket into what came in (`inflow`, from the
 *   transactions that left the owner with more) and what went out (`outflow`). A row with neither and no fee is
 *   left out.
 *
 * `asOf` is the database clock; `posted_at` is stamped by the posting replica. The two halves come from one snapshot,
 * so holdings less movements is exact whatever the clocks say: a transaction that commits after this read is in
 * neither half, and the next read has it in both.
 *
 * The fee on a row is the same figure `historyPage` names per line ("ON A FILL, THE FEE" in `history.ts`): on the
 * owner's own receiving line of a fill, the trade-fee leg of that transaction in that asset.
 *
 * Only a customer or a Space can be asked for; the caller (svc-bank) decides whose they are before it asks.
 */

export interface HoldingsHistoryInput {
  readonly ownerType: Extract<AccountRef['ownerType'], 'user' | 'subaccount'>;
  readonly ownerId: string;
  readonly from: Date;
  readonly bucketSeconds: LedgerHoldingsHistoryBucket;
}

export interface HoldingsHistoryRow {
  readonly assetId: string;
  readonly module: string;
  readonly reason: string;
  readonly bucketStart: Date;
  readonly inflow: Amount;
  readonly outflow: Amount;
  readonly fee: Amount;
}

export interface HoldingsHistory {
  readonly asOf: Date;
  readonly holdings: ReadonlyArray<{ readonly assetId: string; readonly amount: Amount }>;
  readonly movements: readonly HoldingsHistoryRow[];
}

/**
 * Door parse. `from` must sit on a bucket boundary, so every bucket is whole, and not lie ahead of this process's
 * clock. (A `from` a moment ahead of the database clock only answers with no movements: the holdings are still exact.)
 */
export function parseHoldingsHistoryInput(body: unknown, now: Date = new Date()): HoldingsHistoryInput {
  const input = ledgerHoldingsHistoryInputSchema.parse(body);
  const from = new Date(input.from);
  if (from.getTime() > now.getTime()) {
    throw new LedgerError('Holdings history must start in the past', LEDGER_HOLDINGS_HISTORY_WINDOW_INVALID);
  }
  if (from.getTime() % (input.bucketSeconds * 1000) !== 0) {
    throw new LedgerError(
      `Holdings history must start on a ${input.bucketSeconds}-second boundary (UTC), so no bucket is cut`,
      LEDGER_HOLDINGS_HISTORY_WINDOW_INVALID,
    );
  }
  return { ownerType: input.ownerType, ownerId: input.ownerId, from, bucketSeconds: input.bucketSeconds };
}

export function serializeHoldingsHistory(input: HoldingsHistoryInput, read: HoldingsHistory): LedgerHoldingsHistory {
  return {
    asOf: read.asOf.toISOString(),
    from: input.from.toISOString(),
    bucketSeconds: input.bucketSeconds,
    holdings: read.holdings.map((h) => ({ assetId: h.assetId, amount: formatAmount(h.amount) })),
    movements: read.movements.map((m) => ({
      assetId: m.assetId,
      module: m.module,
      reason: m.reason,
      bucketStart: m.bucketStart.toISOString(),
      inflow: formatAmount(m.inflow),
      outflow: formatAmount(m.outflow),
      fee: formatAmount(m.fee),
    })),
  };
}
