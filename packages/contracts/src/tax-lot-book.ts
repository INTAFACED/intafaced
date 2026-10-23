import { z } from 'zod';

/**
 * `tax.lotBook`: the customer's profit and loss indicator, built by svc-tax from their own ledger history. Shared by the
 * service (its output) and the customer app (what it reads). Browser-safe: zod only.
 *
 * Every amount is a decimal string. A figure that cannot be known is null, never zero, and the reason is in `residuals`.
 */

/** Matching methods the lot book offers. AVERAGE keeps one running cost per coin for each asset. */
export const LOT_BOOK_METHODS = ['FIFO', 'LIFO', 'HIFO', 'AVERAGE'] as const;
export type LotBookMethod = (typeof LOT_BOOK_METHODS)[number];
export const lotBookMethodSchema = z.enum(LOT_BOOK_METHODS);

/** How a lot arrived: bought on the exchange, deposited, paid as a reward, or moved in from another account. */
export const LOT_SOURCES = ['trade', 'deposit', 'reward', 'transfer_in', 'other_in'] as const;
export type LotSourceKind = (typeof LOT_SOURCES)[number];

export const lotBookInputSchema = z.object({ method: lotBookMethodSchema.optional() }).strict().optional();

export const lotBookValuedAtSchema = z.object({
  /** Value in dollars when it arrived: quantity times `price`. */
  usd: z.string(),
  price: z.string(),
  /** The market whose candle gave the price, e.g. `BTC/USDT`. */
  market: z.string(),
  /** Candle size used: `1m`, then `1h`, then `1d` when a smaller one had no trade. */
  timeframe: z.string().nullable(),
  /** Start of that candle (ISO time). */
  candleAt: z.string().nullable(),
});

export const lotBookLotSchema = z.object({
  /** `lot:<acquireTxId>:<assetId>`: the same history gives the same id. */
  id: z.string(),
  assetId: z.string(),
  acquiredAt: z.string(),
  source: z.enum(LOT_SOURCES),
  qty: z.string(),
  remaining: z.string(),
  costUsd: z.string().nullable(),
  remainingCostUsd: z.string().nullable(),
  valuedAt: lotBookValuedAtSchema.nullable(),
  /** Whole days since it arrived, for a lot still open; null once all of it is sold. */
  daysHeld: z.number().int().nonnegative().nullable(),
  /** Short or long term is an owner tax rule that is not published, so it is always null. */
  termClass: z.null(),
});

export const lotBookMatchSchema = z.object({
  lotId: z.string(),
  qty: z.string(),
  costUsd: z.string().nullable(),
  proceedsUsd: z.string().nullable(),
  realizedUsd: z.string().nullable(),
});

export const lotBookSaleSchema = z.object({
  assetId: z.string(),
  txId: z.string(),
  disposedAt: z.string(),
  qty: z.string(),
  unmatchedQty: z.string(),
  proceedsUsd: z.string().nullable(),
  costUsd: z.string().nullable(),
  realizedUsd: z.string().nullable(),
  matches: z.array(lotBookMatchSchema),
});

export const lotBookAssetSchema = z.object({
  assetId: z.string(),
  openQty: z.string(),
  openCostUsd: z.string().nullable(),
  held: z.string(),
});

export const lotBookSchema = z.object({
  method: lotBookMethodSchema,
  indicator: z.literal('indicator_not_tax_advice'),
  assets: z.array(lotBookAssetSchema),
  sales: z.array(lotBookSaleSchema),
  lots: z.array(lotBookLotSchema),
  realizedUsd: z.string().nullable(),
  termRule: z.object({ status: z.literal('unset'), code: z.literal('tax.term_rule_unset') }),
  residuals: z.array(z.string()),
});

export type LotBookAnswer = z.infer<typeof lotBookSchema>;
export type LotBookLot = z.infer<typeof lotBookLotSchema>;
export type LotBookSale = z.infer<typeof lotBookSaleSchema>;
