import { z } from 'zod';
import { dec, decOrNull, ratio, sub, sumOf, times, type Scaled } from '../../data/decimal';
import type { Decimal } from '../../data';
import type { MoneyRow } from './portfolio-source';

/**
 * Profit and loss, as the customer sees it. The lot book (tax.lotBook) says what was bought and sold and at what dollar
 * cost; the Money screen's own valuation says what the coins are worth now. Every figure is a decimal string or null:
 * a figure that cannot be known is null with a reason, never a zero.
 */

export const LOT_METHODS = ['FIFO', 'LIFO', 'HIFO'] as const;
export type LotMethod = (typeof LOT_METHODS)[number];

/** `?method=` on /money/pnl: absent is the product default FIFO, one of the three is that method, anything else is refused. */
export function methodFromQuery(search: string): LotMethod | { unknown: string } {
  const raw = new URLSearchParams(search).get('method');
  if (raw === null || raw === '') return 'FIFO';
  const upper = raw.toUpperCase();
  return (LOT_METHODS as readonly string[]).includes(upper) ? (upper as LotMethod) : { unknown: raw };
}

export const lotBookSchema = z.object({
  method: z.enum(LOT_METHODS),
  indicator: z.literal('indicator_not_tax_advice'),
  assets: z.array(z.object({ assetId: z.string(), openQty: z.string(), openCostUsd: z.string().nullable(), held: z.string() })),
  sales: z.array(
    z.object({
      assetId: z.string(),
      txId: z.string(),
      disposedAt: z.string(),
      qty: z.string(),
      unmatchedQty: z.string(),
      proceedsUsd: z.string().nullable(),
      costUsd: z.string().nullable(),
      realizedUsd: z.string().nullable(),
    }),
  ),
  realizedUsd: z.string().nullable(),
  residuals: z.array(z.string()),
});
export type LotBook = z.infer<typeof lotBookSchema>;

export type UnknownReason = 'cost_unknown' | 'no_price' | 'not_reconciled';

export interface AssetPnl {
  asset: string;
  /** Quantity whose cost the trades tell us. */
  knownQty: Decimal;
  /** Quantity held that no trade accounts for (arrived by deposit or transfer, or left another way). */
  otherQty: Decimal;
  costUsd: Decimal | null;
  /** Cost per coin of the bought quantity (cost / bought quantity), fee included; null when the cost is unknown. */
  avgPriceUsd: Decimal | null;
  valueUsd: Decimal | null;
  unrealisedUsd: Decimal | null;
  /** Unrealised as a ratio of cost ("0.25"); null when cost is zero or unknown. */
  unrealisedRatio: Decimal | null;
  reason: UnknownReason | null;
}

export interface PnlView {
  assets: AssetPnl[];
  /** Sum over every asset; null when any asset's unrealised result is unknown. */
  unrealisedUsd: Decimal | null;
  realisedUsd: Decimal | null;
}

/** Quantity of `asset` held beyond what the open lots cover, never negative. */
function otherOf(held: Scaled | null, open: Scaled): Decimal {
  const left = held === null ? 0n : held - open;
  return decOrNull(left > 0n ? left : 0n) ?? '0';
}

export function pnlView(book: LotBook, rows: readonly MoneyRow[] | null): PnlView {
  const byAsset = new Map((rows ?? []).map((row) => [row.asset, row]));
  const assets: AssetPnl[] = [];
  for (const line of book.assets) {
    const open = dec(line.openQty);
    if (open === null || open <= 0n) continue;
    const price = byAsset.get(line.assetId);
    const cost = dec(line.openCostUsd);
    let reason: UnknownReason | null = null;
    let value: Scaled | null = null;
    if (cost === null)
      reason = book.residuals.includes('tax.lot_book_unreconciled') && dec(line.held)! < open ? 'not_reconciled' : 'cost_unknown';
    const total = dec(price?.amount);
    const worth = dec(price?.usdValue);
    if (total !== null && total > 0n && worth !== null) {
      const share = ratio(open, total);
      value = share === null ? null : times(worth, share > 10n ** 18n ? 10n ** 18n : share);
    } else if (reason === null) {
      reason = 'no_price';
    }
    const unrealised = cost !== null && value !== null ? sub(value, cost) : null;
    assets.push({
      asset: line.assetId,
      knownQty: line.openQty,
      otherQty: otherOf(dec(line.held), open),
      costUsd: line.openCostUsd,
      avgPriceUsd: cost === null ? null : decOrNull(ratio(cost, open)),
      valueUsd: decOrNull(value),
      unrealisedUsd: decOrNull(unrealised),
      unrealisedRatio: unrealised !== null && cost !== null && cost > 0n ? decOrNull(ratio(unrealised, cost)) : null,
      reason: unrealised === null ? (reason ?? 'cost_unknown') : null,
    });
  }
  const known = assets.map((a) => dec(a.unrealisedUsd));
  const unrealisedUsd = assets.length > 0 && known.every((v) => v !== null) ? decOrNull(sumOf(known as Scaled[])) : null;
  return { assets, unrealisedUsd, realisedUsd: book.realizedUsd };
}
