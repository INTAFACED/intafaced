import { z } from 'zod';
import { decimalString } from './instruments.js';

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

/**
 * `method` previews one method for every sale (the customer's saved choices and lot picks are not applied). Without it the
 * book applies what the customer saved.
 */
export const lotBookInputSchema = z
  .object({
    method: lotBookMethodSchema.optional(),
    /** Work the book out as if this price were entered for this lot, without saving it: the effect shown before a save. */
    trial: z
      .object({ lotId: z.string().min(1).max(300), pricePerUnitUsd: decimalString })
      .strict()
      .optional(),
  })
  .strict()
  .optional();

/** A coin as the ledger names it, e.g. `BTC`. */
const lotAssetIdSchema = z.string().regex(/^[A-Z0-9]{1,20}$/);
/** A UTC calendar day, `YYYY-MM-DD`, that exists. */
const utcDaySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((day) => !Number.isNaN(Date.parse(`${day}T00:00:00Z`)) && new Date(`${day}T00:00:00Z`).toISOString().startsWith(day));

/** `tax.setLotMethod`: the method for the whole account (`assetId` null) or one coin. `method` null clears it. */
export const setLotMethodInputSchema = z.object({ assetId: lotAssetIdSchema.nullable(), method: lotBookMethodSchema.nullable() }).strict();

/** `tax.setDayMethod`: the method for one UTC day, for one coin or every coin (`assetId` null). `method` null clears it. */
export const setDayMethodInputSchema = z
  .object({ day: utcDaySchema, assetId: lotAssetIdSchema.nullable(), method: lotBookMethodSchema.nullable() })
  .strict();

/** `tax.pickSaleLot`: the lot one sale draws on first. `lotId` null clears the pick. */
export const pickSaleLotInputSchema = z
  .object({ saleTxId: z.string().min(1).max(200), assetId: lotAssetIdSchema, lotId: z.string().min(1).max(300).nullable() })
  .strict();

export const lotChoiceSavedSchema = z.object({ saved: z.literal(true) });

/**
 * `tax.setLotBasis`: the customer's own price per coin, in dollars, for a lot whose cost the platform does not know (a
 * deposit, a reward, a move in). `pricePerUnitUsd` null removes it, and the lot's cost is unknown again. Each change is a
 * new version; the same price and note sent again is not. A lot whose cost comes from our own records is refused.
 */
export const setLotBasisInputSchema = z
  .object({
    lotId: z.string().min(1).max(300),
    pricePerUnitUsd: decimalString.refine((v) => /[1-9]/.test(v), 'must be greater than zero').nullable(),
    /** Where the price comes from, in the customer's words. */
    note: z.string().trim().max(200).default(''),
  })
  .strict();

export const lotBasisSavedSchema = z.object({ saved: z.literal(true), version: z.number().int().positive() });

/** Where a sale's method came from, most specific first. `preview`: one method asked for every sale. */
export const LOT_METHOD_SOURCES = ['preview', 'day', 'asset', 'account', 'default'] as const;

export const lotBookChoicesSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('saved'),
    accountMethod: lotBookMethodSchema.nullable(),
    assetMethods: z.array(z.object({ assetId: z.string(), method: lotBookMethodSchema })),
    days: z.array(z.object({ day: z.string(), assetId: z.string().nullable(), method: lotBookMethodSchema })),
    picks: z.array(z.object({ saleTxId: z.string(), assetId: z.string(), lotId: z.string() })),
  }),
  /** No settings store: nothing can be saved and the product default applies. */
  z.object({ status: z.literal('unwired'), code: z.enum(['tax.database_url_unset', 'tax.database_pool_max_unset']) }),
  /** The saved choices could not be read just now: the product default applies to this answer, and it says so. */
  z.object({ status: z.literal('unavailable'), code: z.literal('tax.choices_unavailable') }),
]);

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
  /**
   * Where the cost comes from: `ours` (what was paid, or the value at arrival under the owner's deposit policy), `customer`
   * (a price the customer entered; every figure that uses it says so), or `unknown`.
   */
  basis: z.enum(['ours', 'customer', 'unknown']),
  /**
   * The customer's entry when `basis` is `customer`: price per coin, their note, and its version (0: the trial price of this
   * answer, not saved). Our own record stays unknown.
   */
  entered: z.object({ pricePerUnitUsd: z.string(), note: z.string(), version: z.number().int().nonnegative() }).nullable(),
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
  /** The cost uses a price the customer entered. */
  customerEntered: z.boolean(),
});

export const lotBookSaleSchema = z.object({
  /** The method this sale was matched by, and where that came from. */
  method: lotBookMethodSchema,
  methodSource: z.enum(LOT_METHOD_SOURCES),
  /** The lot the customer picked for this sale, when it was open and so drawn first. */
  pickedLotId: z.string().nullable(),
  assetId: z.string(),
  txId: z.string(),
  disposedAt: z.string(),
  qty: z.string(),
  unmatchedQty: z.string(),
  proceedsUsd: z.string().nullable(),
  costUsd: z.string().nullable(),
  realizedUsd: z.string().nullable(),
  /** The cost uses a price the customer entered. */
  customerEntered: z.boolean(),
  matches: z.array(lotBookMatchSchema),
});

export const lotBookAssetSchema = z.object({
  assetId: z.string(),
  openQty: z.string(),
  openCostUsd: z.string().nullable(),
  /** The open cost uses a price the customer entered. */
  customerEntered: z.boolean(),
  held: z.string(),
});

/**
 * What a missing cost touches. `lots`: every lot whose cost is not known, with the sales that drew on it. `sales`: every sale
 * with an unknown share (drawn from such a lot, or from no lot at all): that share's quantity and proceeds, while its
 * result stays unknown and is never worked out from a made-up cost.
 */
export const lotBookMissingBasisSchema = z.object({
  lots: z.array(
    z.object({
      lotId: z.string(),
      assetId: z.string(),
      source: z.enum(LOT_SOURCES),
      qty: z.string(),
      remaining: z.string(),
      sales: z.array(z.object({ txId: z.string(), qty: z.string(), proceedsUsd: z.string().nullable() })),
    }),
  ),
  sales: z.array(
    z.object({
      txId: z.string(),
      assetId: z.string(),
      unknownQty: z.string(),
      /** Proceeds of the unknown share; null when the sale's proceeds are not in dollars. */
      unknownProceedsUsd: z.string().nullable(),
    }),
  ),
});

export const lotBookSchema = z.object({
  /** The account's method: the previewed one, else the saved one, else the product default. */
  method: lotBookMethodSchema,
  preview: z.boolean(),
  choices: lotBookChoicesSchema,
  indicator: z.literal('indicator_not_tax_advice'),
  assets: z.array(lotBookAssetSchema),
  sales: z.array(lotBookSaleSchema),
  lots: z.array(lotBookLotSchema),
  realizedUsd: z.string().nullable(),
  /** The total uses a price the customer entered. */
  realizedCustomerEntered: z.boolean(),
  missingBasis: lotBookMissingBasisSchema,
  /** The price tried for one lot (`trial` in the input): this answer is not saved. */
  trial: z.object({ lotId: z.string(), pricePerUnitUsd: z.string() }).nullable(),
  termRule: z.object({ status: z.literal('unset'), code: z.literal('tax.term_rule_unset') }),
  residuals: z.array(z.string()),
});

export type LotBookAnswer = z.infer<typeof lotBookSchema>;
export type LotBookLot = z.infer<typeof lotBookLotSchema>;
export type LotBookSale = z.infer<typeof lotBookSaleSchema>;
export type LotBookChoices = z.infer<typeof lotBookChoicesSchema>;
export type LotBookMissingBasis = z.infer<typeof lotBookMissingBasisSchema>;
export type LotMethodSource = (typeof LOT_METHOD_SOURCES)[number];
