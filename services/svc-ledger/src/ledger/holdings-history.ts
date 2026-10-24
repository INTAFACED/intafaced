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
 * - movements: the signed net of the owner's entries per asset, ledger reason and time bucket, posted at or after
 *   `from`. Rows that net to zero with no fee are left out: they are moves between the owner's own accounts.
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
  /** Epoch seconds of the bucket's start. */
  readonly bucketStart: number;
  readonly net: Amount;
  readonly fee: Amount;
}

export interface HoldingsHistory {
  readonly asOf: Date;
  readonly holdings: ReadonlyArray<{ readonly assetId: string; readonly amount: Amount }>;
  readonly movements: readonly HoldingsHistoryRow[];
}

/** Door parse. `from` must sit on a bucket boundary and not be in the future, so every bucket is whole. */
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
      bucketStart: new Date(m.bucketStart * 1000).toISOString(),
      net: formatAmount(m.net),
      fee: formatAmount(m.fee),
    })),
  };
}
