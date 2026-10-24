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

/**
 * `method` previews one method for every sale (the customer's saved choices and lot picks are not applied). Without it the
 * book applies what the customer saved.
 */
export const lotBookInputSchema = z.object({ method: lotBookMethodSchema.optional() }).strict().optional();

/** A coin as the ledger names it, e.g. `BTC`. */
const lotAssetIdSchema = z.string().regex(/^[A-Za-z0-9]{1,20}$/);
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
  z.object({ status: z.literal('unwired'), code: z.literal('tax.basis_store_unwired') }),
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
  /** Whole days since it arrived, for a lot still open; null once all of it is sold. */
  daysHeld: z.number().int().nonnegative().nullable(),
  /** Short or long term is an owner tax rule that is not published, so it is always null. */
  termClass: z.null(),
  /** Present only when this lot's cost is a price the customer entered. */
  basisSource: z.literal('customer-entered').optional(),
  /** Present when the lot sits in one of the customer's named spaces (listed in `spaces`); absent: the main account. */
  spaceId: z.string().optional(),
  /** Present when the customer-entered cost is a price stored under another lot (the one this lot was carried from). */
  basisLotId: z.string().optional(),
  /** Present when the lot was moved here from another of the customer's own accounts, keeping its date and basis. */
  carriedFrom: z.object({ lotId: z.string(), txId: z.string(), movedAt: z.string() }).optional(),
});

/** The customer's named spaces whose lots the book follows, or why it could not ask which spaces are theirs. */
export const lotBookSpacesSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('read'),
    list: z.array(z.object({ spaceId: z.string(), assetId: z.string(), name: z.string(), archived: z.boolean() })),
  }),
  /** No bank to ask: the book follows the main account only. */
  z.object({ status: z.literal('unwired'), code: z.literal('tax.own_spaces_unwired') }),
  /** The bank did not answer just now: moves to and from spaces are not followed in this answer, and it says so. */
  z.object({ status: z.literal('unavailable'), code: z.literal('tax.own_spaces_unavailable') }),
]);

export const lotBookMatchSchema = z.object({
  lotId: z.string(),
  qty: z.string(),
  costUsd: z.string().nullable(),
  proceedsUsd: z.string().nullable(),
  realizedUsd: z.string().nullable(),
  /** Present only when this part's cost is a price the customer entered. */
  basisSource: z.literal('customer-entered').optional(),
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
  matches: z.array(lotBookMatchSchema),
  /** Present when any part of this sale used a price the customer entered. */
  basisSource: z.literal('customer-entered').optional(),
});

export const lotBookAssetSchema = z.object({
  assetId: z.string(),
  openQty: z.string(),
  openCostUsd: z.string().nullable(),
  held: z.string(),
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
  termRule: z.object({ status: z.literal('unset'), code: z.literal('tax.term_rule_unset') }),
  residuals: z.array(z.string()),
  /** Absent from a book built without asking about spaces. */
  spaces: lotBookSpacesSchema.optional(),
  /**
   * Positions the customer typed that are not a balance and not a ledger lot. Absent when there are none, so a book
   * with no manual position stays the same shape.
   */
  manualPositions: z
    .array(
      z.object({
        id: z.string(),
        assetId: z.string(),
        acquiredAt: z.string(),
        qty: z.string(),
        costUsd: z.string(),
        pricePerUnit: z.string(),
        sourceNote: z.string(),
        basisSource: z.literal('customer-entered'),
        heldApart: z.literal(true),
      }),
    )
    .optional(),
});

/** The effect row for a missing basis. A sentence, never a number. */
export const UNKNOWN_SHARE = 'unknown share' as const;

export const missingBasisItemSchema = z.object({
  lotId: z.string().nullable(),
  assetId: z.string(),
  kind: z.enum(['open', 'disposal']),
  qty: z.string(),
  code: z.enum(['tax.cost_basis_unavailable', 'tax.lot_underflow']),
  effect: z.literal(UNKNOWN_SHARE),
  saleTxId: z.string().nullable(),
});

export const missingBasisSchema = z.object({
  items: z.array(missingBasisItemSchema),
});

export const basisOverrideSetInputSchema = z
  .object({
    lotId: z.string(),
    pricePerUnit: z.string(),
    date: z.string(),
    sourceNote: z.string(),
    assetId: z.string().optional(),
    qty: z.string().optional(),
  })
  .strict();

export const basisOverrideRemoveInputSchema = z.object({ lotId: z.string() }).strict();

export const basisWriteResultSchema = z.object({
  businessKey: z.string(),
  version: z.number().int().positive(),
  lotId: z.string(),
  kind: z.enum(['override', 'manual', 'tombstone']),
  basisSource: z.literal('customer-entered').nullable(),
});

export type LotBookAnswer = z.infer<typeof lotBookSchema>;
export type LotBookLot = z.infer<typeof lotBookLotSchema>;
export type LotBookSale = z.infer<typeof lotBookSaleSchema>;
export type LotBookChoices = z.infer<typeof lotBookChoicesSchema>;
export type LotBookSpaces = z.infer<typeof lotBookSpacesSchema>;
export type LotMethodSource = (typeof LOT_METHOD_SOURCES)[number];
