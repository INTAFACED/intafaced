// hand-declared-ok: svc-trade's user-venue door (/api/v1/venue/*) has no browser-safe zod schema in packages/contracts yet; packages/venue-contracts holds its TypeScript types only, so these schemas follow services/svc-trade/src/venue/user-venue-rest.ts and packages/venue-contracts/src/user-venue.ts field for field
import { z } from 'zod';
import type { ApiClient, ApiResult } from '../../shared/api';
import { decimalSchema, formatAmount, parseAmount, signedDecimalSchema } from '../../shared/money';
import type { TypedDataDocument } from '../protocol/wallet/eip1193';

/**
 * The customer's own account on a user-signed venue, through svc-trade's user-venue door (B1). The venue is the record of
 * balances, locks, fills, positions and withdrawals: every figure here is the venue's, with the venue's as-of time, and
 * every Amount is a decimal string. A figure the venue does not publish is `known: false` and is shown as "not known".
 *
 * Prepare → the person's wallet signs → submit. The app keeps nothing but the business key of an action: the door stores
 * the prepared action and its first signature under that key, so a second prepare of the key returns the same action (one
 * wallet prompt), and an answer that is not definite is read back by its client id or nonce, never sent as a new action.
 */

const isoTime = z.string().datetime({ offset: true });
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

/** A figure the venue may not publish. */
export const maybeKnown = <T extends z.ZodTypeAny>(value: T) =>
  z.union([z.object({ known: z.literal(true), value }), z.object({ known: z.literal(false) })]);
export type MaybeKnown<T> = { known: true; value: T } | { known: false };

const asOf = <T extends z.ZodTypeAny>(value: T) => z.object({ venueId: z.string(), value, asOf: isoTime });
export type AsOf<T> = { venueId: string; value: T; asOf: string };

const refusalSchema = z.object({ venueId: z.string(), code: z.string(), detail: z.string() });
export type VenueRefusal = z.infer<typeof refusalSchema>;

/** `/venue/status`: `{ enabled: false }` when the door is off; else whether the venue answers, and who it is. */
export const venueStatusSchema = z.union([
  z.object({ enabled: z.literal(false) }),
  z.object({ enabled: z.literal(true), available: z.literal(false), refusal: z.object({ code: z.string(), detail: z.string() }) }),
  z.object({
    enabled: z.literal(true),
    available: z.literal(true),
    venue: z.object({ id: z.string(), displayName: z.string(), proofLevel: z.enum(['simulator', 'partner-sandbox', 'live']) }),
    test: z.boolean(),
    label: z.literal('TEST').optional(),
    chainId: z.number().int().positive().nullable(),
    /** Where the person's own wallet sends a token to fund the venue account (B2); null or absent when the venue names none. */
    deposit: z
      .object({
        chainId: z.number().int().positive(),
        token: address,
        tokenDecimals: z.number().int().min(0).max(18),
        address,
        asset: z.string().min(1),
      })
      .nullable()
      .optional(),
    builder: z.object({ address, feeBps: decimalSchema }).nullable(),
    // J-derivatives-03 #9: the most orders the venue takes in one signed action; above 1, a reverse is signed once.
    ordersPerAction: z.number().int().positive().optional(),
    // J-cex-spot-05: whether the venue lowers an order in place, and how many it cancels in one signed action (0: one each).
    amendsInPlace: z.boolean().optional(),
    cancelsPerAction: z.number().int().min(0).optional(),
    // J-cex-spot-07: the venue's own scheduled cancel with the owner's published timeouts (null: blank); null where the
    // venue offers none.
    scheduledCancel: z
      .object({ minLeadMs: z.number().int().min(0), timeoutsSec: z.array(z.number().int().positive()).nullable() })
      .nullable()
      .optional(),
    // J-derivatives-28: true when more than one venue is configured; the ticket then routes over them.
    routes: z.boolean().optional(),
    // Every configured venue with its health and the position modes it offers (J-derivatives-28, J-derivatives-05 #1 #3).
    // Absent from an older door: the primary venue alone.
    venues: z
      .array(
        z.object({
          venueId: z.string().nullable(),
          displayName: z.string().nullable(),
          test: z.boolean(),
          health: z.object({ state: z.string() }).passthrough(),
          positionModes: z.array(z.enum(['one_way', 'hedge'])).optional(),
        }),
      )
      .optional(),
  }),
]);
export type VenueStatus = z.infer<typeof venueStatusSchema>;
export type VenueUp = Extract<VenueStatus, { available: true }>;

const timeInForce = z.enum(['GTC', 'IOC', 'ALO']);
const marginMode = z.enum(['cross', 'isolated']);
export type VenueTimeInForce = z.infer<typeof timeInForce>;
export type VenueMarginMode = z.infer<typeof marginMode>;

export const venueMarketSchema = z.object({
  symbol: z.string(),
  kind: z.enum(['spot', 'perpetual']),
  baseAsset: z.string(),
  quoteAsset: z.string(),
  orderTypes: z.array(z.string()),
  timeInForce: z.array(timeInForce),
  marginModes: z.array(marginMode),
  maxLeverageBps: z.number().int().positive().nullable(),
  tickSize: decimalSchema,
  lotSize: decimalSchema,
  // The venue's published smallest order value (quote), price band (bps around the middle of its book) and open-order
  // cap per account, each null where the venue publishes none (J-cex-spot-04). Absent from an older door: not published.
  minOrderNotional: decimalSchema.nullable().optional(),
  priceBandBps: decimalSchema.nullable().optional(),
  maxOpenOrders: z.number().int().positive().nullable().optional(),
  // The venue's largest order, null where it reports none.
  maxOrderQty: decimalSchema.nullable().optional(),
  maxOrderNotional: decimalSchema.nullable().optional(),
  makerFeeBps: maybeKnown(signedDecimalSchema),
  takerFeeBps: maybeKnown(signedDecimalSchema),
  // The venue's own published words for the market, each "not published" where the venue gives none (J-derivatives-21).
  listedBy: maybeKnown(z.object({ kind: z.enum(['venue', 'hip3', 'ostium']), name: z.string() })),
  oracleRule: maybeKnown(z.string()),
  markRule: maybeKnown(z.string()),
  tradingHours: maybeKnown(z.string()),
  feed: maybeKnown(z.object({ state: z.enum(['live', 'stale']), lastOracleUpdateAt: isoTime, staleRule: maybeKnown(z.string()) })),
  // A stock perpetual's home market and the venue's off-hours mode, each in the venue's words (J-derivatives-27).
  session: maybeKnown(
    z.object({
      state: z.enum(['open', 'off_hours']),
      homeMarket: z.string(),
      offHoursMode: maybeKnown(z.string()),
      offHoursBand: maybeKnown(z.string()),
      offHoursMaxLeverageBps: z.number().int().positive().nullable(),
      reopensAt: isoTime.nullable(),
      offHoursRule: maybeKnown(z.string()),
    }),
  ),
  // The margin account a market's deployer keeps for it, apart from the main account, and its open interest with the
  // deployer's cap (J-derivatives-27 #7 #8). Absent from an older door: read as not published.
  marginAccount: maybeKnown(z.object({ name: z.string(), collateralAsset: z.string(), marginMode })).optional(),
  openInterest: maybeKnown(z.object({ size: decimalSchema, capSize: decimalSchema.nullable() })).optional(),
  // The latest deployer's halt or split that settled the market's positions, as the venue reports it (J-derivatives-27 #9 #10).
  lastEvent: maybeKnown(
    z.object({
      kind: z.enum(['deployer_halt', 'split']),
      eventAt: isoTime,
      settlementPrice: decimalSchema,
      reopenedAt: isoTime.nullable(),
      splitRatio: z.string().nullable(),
    }),
  ).optional(),
  // The contract strip's figures, each the venue's own or "not published" (J-derivatives-01 #4).
  contractSize: maybeKnown(decimalSchema),
  mark: maybeKnown(decimalSchema),
  funding: maybeKnown(
    z.object({
      rate: signedDecimalSchema,
      intervalSeconds: z.number().int().positive(),
      nextFundingAt: isoTime,
      // What the venue built the rate from, as it publishes them (J-derivatives-08 #1); absent from an older door: not published.
      inputs: maybeKnown(
        z.object({
          premium: signedDecimalSchema,
          interestRate: signedDecimalSchema,
          rateCap: decimalSchema,
          markPrice: decimalSchema,
          indexPrice: decimalSchema,
          rule: maybeKnown(z.string()),
        }),
      ).optional(),
    }),
  ),
  // The prices the venue judges its trigger orders on, and its published index (J-derivatives-03). Absent: none.
  triggerSources: z.array(z.enum(['mark', 'last'])).optional(),
  index: maybeKnown(decimalSchema).optional(),
  // The venue's own self-trade rule (J-cex-spot-03 #8); absent from an older door: read as not published.
  selfTrade: maybeKnown(z.enum(['cancel_resting', 'cancel_new', 'cancel_both'])).optional(),
  // The venue's published margin tiers, and what it takes as margin with each haircut (J-derivatives-02 #2 #3). Absent
  // from an older door: read as not published.
  marginTiers: maybeKnown(
    z.array(z.object({ fromNotional: decimalSchema, maxLeverageBps: z.number().int().positive(), maintenanceRate: decimalSchema })),
  ).optional(),
  collateral: maybeKnown(z.array(z.object({ asset: z.string(), haircut: maybeKnown(decimalSchema) }))).optional(),
  // The venue's own trading state for the market, null where it reports none, and our listing's routing beside it
  // (J-charts-desk-15 #6: the chart refuses order entry naming either). Absent from an older door: not reported.
  status: z.enum(['trading', 'halted', 'cancel_only', 'delisted']).nullable().optional(),
  listing: z.object({ routing: z.enum(['show', 'close_only', 'stop']), delisted: z.boolean().optional() }).optional(),
});
export type VenueMarket = z.infer<typeof venueMarketSchema>;
/** One of the venue's published margin tiers (J-derivatives-02 #2). */
export type VenueMarginTier = Extract<NonNullable<VenueMarket['marginTiers']>, { known: true }>['value'][number];
/** One asset the venue takes as margin, with its haircut (J-derivatives-02 #3). */
export type VenueCollateral = Extract<NonNullable<VenueMarket['collateral']>, { known: true }>['value'][number];
export type VenueSelfTradeMode = 'cancel_resting' | 'cancel_new' | 'cancel_both';
/** A perpetual's funding as the venue publishes it (J-derivatives-01 #4). */
export type VenueFunding = Extract<VenueMarket['funding'], { known: true }>['value'];
/** A deployer's halt or a split that settled a market's positions, as the venue reports it (J-derivatives-27 #9 #10). */
export type VenueMarketEvent = Extract<NonNullable<VenueMarket['lastEvent']>, { known: true }>['value'];
/** One owner's balance in a market deployer's own margin account, as the venue reports it (J-derivatives-27 #7). */
export const venueMarketMarginSchema = z.object({
  symbol: z.string(),
  name: z.string(),
  collateralAsset: z.string(),
  marginMode,
  free: decimalSchema,
  locked: decimalSchema,
  total: decimalSchema,
});
export type VenueMarketMargin = z.infer<typeof venueMarketMarginSchema>;
/** The venue's scheduled cancel on one account (J-cex-spot-07): its time, or null, and its last firing. */
export const venueScheduledCancelSchema = z.object({
  cancelsAt: isoTime.nullable(),
  lastFired: z.object({ firedAt: isoTime, canceled: z.number().int().min(0) }).nullable(),
});
export type VenueScheduledCancel = z.infer<typeof venueScheduledCancelSchema>;

/** One statement job on the venue's own records (J-cex-spot-07 #5; svc-trade venue-statements.ts). */
export const venueStatementJobSchema = z.object({
  id: z.string(),
  requestKey: z.string(),
  venueId: z.string(),
  owner: z.string(),
  from: isoTime,
  to: isoTime,
  status: z.enum(['pending', 'finished', 'failed']),
  rows: z.object({ orders: z.number().int(), trades: z.number().int(), movements: z.number().int() }).nullable(),
  sha256: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: isoTime,
  finishedAt: isoTime.nullable(),
});
export type VenueStatementJob = z.infer<typeof venueStatementJobSchema>;

/**
 * One funding payment on one of the owner's positions, as the venue booked it when it closed a period (J-derivatives-08
 * #3 #4 #5): positive `amount` received, negative paid, in `asset`.
 */
const venueFundingPaymentSchema = z.object({
  paymentId: z.string(),
  symbol: z.string(),
  side: z.enum(['long', 'short']),
  size: decimalSchema,
  markPrice: decimalSchema,
  rate: signedDecimalSchema,
  amount: signedDecimalSchema,
  asset: z.string(),
  periodAt: isoTime,
});
export type VenueFundingPayment = z.infer<typeof venueFundingPaymentSchema>;

/** One of the owner's settlements in a deployer's halt or a split, as the venue records it (J-derivatives-27 #9 #10). */
export const venueSettlementSchema = z.object({
  symbol: z.string(),
  kind: z.enum(['deployer_halt', 'split']),
  side: z.enum(['long', 'short']).nullable(),
  size: decimalSchema,
  price: decimalSchema,
  realisedPnl: signedDecimalSchema,
  cancelledOrders: z.array(z.string().nullable()),
  settledAt: isoTime,
});
export type VenueSettlement = z.infer<typeof venueSettlementSchema>;
/** A stock perpetual's home-market session as the venue publishes it (J-derivatives-27). */
export type VenueSession = Extract<VenueMarket['session'], { known: true }>['value'];

export const venueBestPricesSchema = z.object({ symbol: z.string(), bid: decimalSchema.nullable(), ask: decimalSchema.nullable() });
export type VenueBestPrices = z.infer<typeof venueBestPricesSchema>;
/** The venue's best prices with the owner's market price protection (TRADE_MARKET_SLIPPAGE_CAP_BPS) svc-trade adds: blank is not known. */
export const venueBestPricesReadSchema = asOf(venueBestPricesSchema).extend({
  slippageCapBps: maybeKnown(decimalSchema),
  // The owner's spread limit for a spot market order (J-cex-spot-03 #2); absent from an older door: read as not set.
  spreadLimitBps: maybeKnown(decimalSchema).optional(),
});

// ── The venue's own market data on a market we list (J-cex-spot-01 #5: the spot desk's ticker, book, chart and tape) ──
const venueLevelSchema = z.object({ price: decimalSchema, amount: decimalSchema });
export const venueBookReadSchema = asOf(
  z.object({ symbol: z.string(), bids: z.array(venueLevelSchema), asks: z.array(venueLevelSchema) }),
).extend({
  test: z.boolean(),
});
export type VenueBookRead = z.infer<typeof venueBookReadSchema>;
export const venuePrintSchema = z.object({
  tradeId: z.string(),
  symbol: z.string(),
  price: decimalSchema,
  amount: decimalSchema,
  takerSide: z.enum(['buy', 'sell']).nullable(),
  tradedAt: isoTime,
});
export type VenuePrint = z.infer<typeof venuePrintSchema>;
export const venueTradesReadSchema = asOf(z.array(venuePrintSchema)).extend({ test: z.boolean() });
export const venueCandleSchema = z.object({
  openAt: isoTime,
  openPrice: decimalSchema,
  highPrice: decimalSchema,
  lowPrice: decimalSchema,
  closePrice: decimalSchema,
  baseVolume: decimalSchema,
});
export type VenueCandle = z.infer<typeof venueCandleSchema>;
export const venueCandlesReadSchema = asOf(z.array(venueCandleSchema)).extend({ test: z.boolean() });

export const venueBalanceSchema = z.object({
  asset: z.string(),
  free: decimalSchema,
  locked: decimalSchema,
  total: decimalSchema,
  /** What holds `locked`, as the venue splits it (J-portfolio-01 #4); absent when the venue reports no split. */
  lockedBy: z.object({ inOrders: decimalSchema, margin: decimalSchema, staked: decimalSchema }).optional(),
});
export type VenueBalance = z.infer<typeof venueBalanceSchema>;

export const venueOrderSchema = z.object({
  venueOrderId: z.string().nullable(),
  venueClientOrderId: z.string().nullable(),
  symbol: z.string(),
  side: z.enum(['buy', 'sell']),
  type: z.string(),
  timeInForce,
  price: decimalSchema,
  amount: decimalSchema,
  filled: decimalSchema,
  remaining: decimalSchema,
  averagePrice: decimalSchema.nullable(),
  status: z.string(),
  locked: decimalSchema,
  lockedAsset: z.string(),
  reduceOnly: z.boolean(),
  /** A trigger order's trigger, as the venue reports it (J-cex-spot-06 #6); absent on an ordinary order. */
  trigger: z
    .object({
      price: decimalSchema,
      source: z.string(),
      role: z.string(),
      state: z.enum(['waiting', 'triggered', 'failed']),
      triggeredAt: isoTime.nullable(),
      failure: z.string().nullable(),
    })
    .nullable()
    .optional(),
  /** Why the venue cancelled it, where it says (`position_closed`, `linked`). */
  cancelReason: z.string().nullable().optional(),
});
export type VenueOrder = z.infer<typeof venueOrderSchema>;

/** One page of the venue's own order history (`GET /venue/orders/history`, J-cex-spot-06 #1), newest placed first. */
export const venueHistoryPageSchema = z.object({
  orders: z.array(z.object({ order: venueOrderSchema, placedAt: isoTime })),
  next: z.string().nullable(),
  asOf: isoTime,
});
export type VenueHistoryPage = z.infer<typeof venueHistoryPageSchema>;
export type VenueHistoryQuery = { side?: string; status?: string; from?: string; to?: string; limit?: string; before?: string };

/** Our own record of one venue order (`GET /venue/orders/record`): the amendments the venue accepted and our builder fee. */
export const venueOrderRecordSchema = z.object({
  placedAt: isoTime.nullable(),
  amendments: z.array(z.object({ actionKey: z.string(), amount: decimalSchema, price: decimalSchema, recordedAt: isoTime })),
  builderFee: z
    .object({ chargedBps: decimalSchema, publishedBps: decimalSchema.nullable(), discountBps: z.number().int().nullable() })
    .nullable(),
});
export type VenueOrderRecord = z.infer<typeof venueOrderRecordSchema>;

/**
 * One order the person's door kept, read back from the venue (`GET /venue/orders`): `origin` is `agent:<keyId>` when their
 * own assistant placed it with its agent key (J-agents-21 #7), and `order` is the venue's record once it accepted it.
 */
export const venueKeptOrderSchema = z.object({
  actionKey: z.string(),
  venueClientOrderId: z.string().nullable(),
  origin: z.string().nullable(),
  state: z.enum(['accepted', 'unknown', 'refused', 'not_sent']),
  order: venueOrderSchema.nullable(),
  asOf: isoTime.nullable(),
});
export type VenueKeptOrder = z.infer<typeof venueKeptOrderSchema>;
export const venueOrderPageSchema = z.object({ orders: z.array(venueKeptOrderSchema), nextCursor: z.string().nullable() });

/** The person's agent accounts (J-agents-21): the wallet that owns each and its venue sub-account. */
export const agentAccountRowSchema = z.object({
  accountId: z.string(),
  status: z.string(),
  owner: z.string(),
  subAccount: z.string().nullable(),
});
export type AgentAccountRow = z.infer<typeof agentAccountRowSchema>;

export const venueFillSchema = z.object({
  fillId: z.string(),
  venueClientOrderId: z.string().nullable(),
  symbol: z.string(),
  side: z.enum(['buy', 'sell']),
  price: decimalSchema,
  amount: decimalSchema,
  role: z.enum(['maker', 'taker']),
  venueFee: signedDecimalSchema,
  builderFee: decimalSchema,
  feeAsset: z.string(),
  realisedPnl: signedDecimalSchema.nullable(),
  filledAt: isoTime,
});
export type VenueFill = z.infer<typeof venueFillSchema>;

export const venuePositionSchema = z.object({
  symbol: z.string(),
  side: z.enum(['long', 'short']),
  size: decimalSchema,
  entryPrice: decimalSchema,
  markPrice: decimalSchema,
  unrealisedPnl: signedDecimalSchema,
  marginMode,
  margin: decimalSchema,
  leverageBps: z.number().int().positive(),
  liquidationPrice: maybeKnown(decimalSchema),
  // The margin the venue requires to keep the position open (J-derivatives-05 #2); absent from an older door: not published.
  maintenanceMargin: maybeKnown(decimalSchema).optional(),
});
export type VenuePosition = z.infer<typeof venuePositionSchema>;

/** What a leverage change would do to the open position's margin, by the venue's own rule (J-derivatives-05 #4). */
const venueLeverageChangeSchema = z.object({
  symbol: z.string(),
  leverageBps: z.number().int().positive(),
  marginMode,
  maxLeverageBps: z.number().int().positive().nullable(),
  positionSize: decimalSchema,
  marginNow: decimalSchema,
  marginAfter: decimalSchema,
  difference: signedDecimalSchema,
});
export type VenueLeverageChange = z.infer<typeof venueLeverageChangeSchema>;

/** An open isolated position's margin and the venue's own limit for removing it (J-derivatives-06 #2 #3). */
const venueIsolatedMarginSchema = z.object({
  symbol: z.string(),
  side: z.enum(['long', 'short']),
  size: decimalSchema,
  margin: decimalSchema,
  minimumMargin: decimalSchema,
  removable: decimalSchema,
  free: decimalSchema,
  asset: z.string(),
  liquidationPrice: maybeKnown(decimalSchema),
  rule: z.string(),
});
export type VenueIsolatedMargin = z.infer<typeof venueIsolatedMarginSchema>;

/** The account's margin as the venue reports it (J-derivatives-06 #1). */
const venueAccountSummarySchema = z.object({
  asset: z.string(),
  equity: signedDecimalSchema,
  free: decimalSchema,
  usedMargin: decimalSchema,
  maintenanceMargin: decimalSchema,
  marginRatio: maybeKnown(decimalSchema),
});
export type VenueAccountSummary = z.infer<typeof venueAccountSummarySchema>;

// ── J-derivatives-07: a liquidation and its aftermath, each the venue's own figure ────────────────────────────────

/** One part of a liquidation the venue carried out, with its own id, size, price and fee. */
const venueLiquidationPartSchema = z.object({
  partId: z.string(),
  size: decimalSchema,
  price: decimalSchema,
  fee: decimalSchema,
  feeAsset: z.string(),
  liquidatedAt: isoTime,
});
/** One liquidation of one position, every part listed (J-derivatives-07 #2). */
const venueLiquidationSchema = z.object({
  liquidationId: z.string(),
  symbol: z.string(),
  side: z.enum(['long', 'short']),
  state: z.enum(['in_progress', 'done']),
  parts: z.array(venueLiquidationPartSchema),
  startedAt: isoTime,
});
export type VenueLiquidation = z.infer<typeof venueLiquidationSchema>;
/** A position's liquidation state on one market and the venue's price and fee rules (J-derivatives-07 #1 #3). */
const venueLiquidationStatusSchema = z.object({
  symbol: z.string(),
  state: z.enum(['none', 'in_progress', 'done']),
  liquidationId: z.string().nullable(),
  priceRule: z.string(),
  feeRule: z.string().nullable(),
});
export type VenueLiquidationStatus = z.infer<typeof venueLiquidationStatusSchema>;
/** The venue's insurance fund, or not published (J-derivatives-07 #4). */
const venueInsuranceFundSchema = asOf(
  maybeKnown(z.object({ name: z.string(), asset: z.string(), balance: decimalSchema, whereToRead: z.string(), rule: z.string() })),
).extend({ venueName: z.string() });
export type VenueInsuranceFund = z.infer<typeof venueInsuranceFundSchema>;
/** The venue's auto-deleveraging rules and this person's acknowledged version (J-derivatives-07 #5). */
const venueAdlDisclosureSchema = z.object({
  venueId: z.string(),
  venueName: z.string(),
  asOf: isoTime,
  rules: z.object({ version: z.string(), text: z.string() }).nullable(),
  acknowledged: z.boolean(),
  acknowledgedVersion: z.string().nullable(),
  acknowledgedAt: isoTime.nullable(),
});
export type VenueAdlDisclosure = z.infer<typeof venueAdlDisclosureSchema>;
/** One auto-deleveraging of the person's position, with the venue's notice (J-derivatives-07 #6). */
const venueDeleverageSchema = z.object({
  adlId: z.string(),
  symbol: z.string(),
  side: z.enum(['long', 'short']),
  size: decimalSchema,
  price: decimalSchema,
  realisedPnl: signedDecimalSchema,
  notice: z.string(),
  deleveragedAt: isoTime,
});
export type VenueDeleverage = z.infer<typeof venueDeleverageSchema>;
/** One public liquidation or auto-deleveraging alert: no account in it (J-derivatives-07 #7). */
const venueLiquidationAlertSchema = z.object({
  kind: z.enum(['liquidation', 'deleverage']),
  symbol: z.string(),
  side: z.enum(['long', 'short']),
  size: decimalSchema,
  price: decimalSchema,
  alertedAt: isoTime,
});
export type VenueLiquidationAlert = z.infer<typeof venueLiquidationAlertSchema>;

export const venueWithdrawalSchema = z.object({
  nonce: z.string(),
  asset: z.string(),
  amount: decimalSchema,
  destination: z.string(),
  status: z.enum(['pending', 'done', 'failed']),
  fee: maybeKnown(decimalSchema),
  /** The network fee taken from what arrives (the contract's `UserVenueWithdrawal.networkFee`); "not known", never 0. */
  networkFee: maybeKnown(decimalSchema),
});
export type VenueWithdrawal = z.infer<typeof venueWithdrawalSchema>;

export const venueLeverageSchema = z.object({ symbol: z.string(), leverageBps: z.number().int().positive(), marginMode });
export type VenueLeverage = z.infer<typeof venueLeverageSchema>;

const assetAmount = z.object({ asset: z.string(), amount: signedDecimalSchema });
/** The venue's maker and taker rates in bps (J-cex-spot-10); a maker rate below zero is the venue's rebate. */
const feeRatesSchema = z.object({ makerFeeBps: maybeKnown(signedDecimalSchema), takerFeeBps: maybeKnown(signedDecimalSchema) });
export type VenueFeeRates = z.infer<typeof feeRatesSchema>;
const feeTiersSchema = z.object({
  tiers: z.array(z.object({ name: z.string(), fromVolume: decimalSchema, spot: feeRatesSchema, perpetual: feeRatesSchema })).nullable(),
  volumeAsset: z.string(),
  volumeDays: z.number().int().positive(),
});
export type VenueFeeTiers = z.infer<typeof feeTiersSchema>;
/** `GET /venue/fees` (J-cex-spot-10 #2): the venue's tiers, each listed market's rates and builder-fee cap, and ours. */
export const venuePublicFeesSchema = asOf(
  z.object({
    venue: z.object({ id: z.string(), displayName: z.string() }),
    schedule: feeTiersSchema,
    markets: z.array(
      z.object({
        symbol: z.string(),
        kind: z.enum(['spot', 'perpetual']),
        makerFeeBps: maybeKnown(signedDecimalSchema),
        takerFeeBps: maybeKnown(signedDecimalSchema),
        builderFeeCapBps: maybeKnown(decimalSchema),
        builderFeeBps: maybeKnown(decimalSchema),
      }),
    ),
    test: z.boolean(),
  }),
);
export type VenuePublicFees = z.infer<typeof venuePublicFeesSchema>;
/** One fee the venue publishes beside its trading fees (J-derivatives-12 #2), in bps of what it is charged on. */
const venueOtherFeeSchema = z.object({
  kind: z.enum(['settlement', 'liquidation', 'other']),
  name: z.string(),
  symbol: z.string().nullable(),
  feeBps: decimalSchema,
  rule: z.string(),
});
export type VenueOtherFee = z.infer<typeof venueOtherFeeSchema>;
/** `GET /venue/fee-tier` (J-cex-spot-10 #6): the account's tier, counted volume and rates as the venue reports them. */
export const venueFeeTierSchema = asOf(
  z.object({
    schedule: feeTiersSchema,
    // J-derivatives-12 #2: the venue's settlement and other fees; absent or null where it publishes none.
    otherFees: z.array(venueOtherFeeSchema).nullable().optional(),
    account: z
      .object({
        tierName: z.string().nullable(),
        volume: maybeKnown(decimalSchema),
        spot: feeRatesSchema,
        perpetual: feeRatesSchema,
        tierUpdatedAt: isoTime.nullable(),
      })
      .nullable(),
  }),
).and(z.object({ test: z.boolean() }));
export type VenueFeeTier = z.infer<typeof venueFeeTierSchema>;
export const venuePreviewSchema = z.object({
  symbol: z.string(),
  kind: z.enum(['spot', 'perpetual']),
  lock: assetAmount,
  role: z.enum(['maker', 'taker']),
  venueFee: maybeKnown(assetAmount),
  builderFee: maybeKnown(assetAmount),
  // The venue's rates for this account on this market, from the preview itself (J-cex-spot-10 #1).
  rates: feeRatesSchema.optional(),
  // What lowered our builder fee on this order (J-campaigns-09 #2): a fee-saver coupon or the rank, the larger of the two.
  feeDiscount: z
    .union([
      z.object({ source: z.literal('coupon'), bps: z.number().int(), code: z.string(), voucherId: z.string() }),
      z.object({ source: z.literal('rank'), bps: z.number().int() }),
    ])
    .nullable()
    .optional(),
  // What fills now against the venue's book, and at what average price (the venue's word; not a quote).
  fill: maybeKnown(z.object({ amount: decimalSchema, averagePrice: decimalSchema.nullable() })).optional(),
  perpetual: z
    .object({
      leverageBps: z.number().int().positive(),
      marginMode,
      initialMargin: maybeKnown(decimalSchema),
      liquidationPrice: maybeKnown(decimalSchema),
    })
    .nullable(),
});
export type VenuePreview = z.infer<typeof venuePreviewSchema>;

// ── Routing over several venues (J-derivatives-28) ───────────────────────────────────────────────────────────────

const health = z.object({ state: z.enum(['up', 'down']), since: isoTime, reason: z.string().nullable(), checkedAt: isoTime });
export type VenueHealth = z.infer<typeof health>;
const level = z.object({ price: decimalSchema, amount: decimalSchema });
export const marketVenueSchema = z.object({
  venueId: z.string().nullable(),
  displayName: z.string().nullable(),
  test: z.boolean(),
  health,
  listed: z.boolean().nullable(),
  market: z
    .object({
      kind: z.enum(['spot', 'perpetual']),
      baseAsset: z.string(),
      quoteAsset: z.string(),
      makerFeeBps: maybeKnown(decimalSchema),
      takerFeeBps: maybeKnown(decimalSchema),
      lotSize: decimalSchema,
      tickSize: decimalSchema,
    })
    .nullable(),
  book: z
    .object({ venueId: z.string(), asOf: isoTime, value: z.object({ symbol: z.string(), bids: z.array(level), asks: z.array(level) }) })
    .nullable(),
  builderFee: z
    .union([
      z.object({ published: z.literal(false) }),
      z.object({ published: z.literal(true), carries: z.literal(false) }),
      z.object({ published: z.literal(true), carries: z.literal(true), feeBps: decimalSchema }),
    ])
    .nullable(),
  account: z.enum(['signable', 'connect', 'unknown']),
});
export type MarketVenue = z.infer<typeof marketVenueSchema>;
export const marketVenuesSchema = z.object({ symbol: z.string(), venues: z.array(marketVenueSchema), at: isoTime });

const cost = z.object({
  venueId: z.string(),
  fillsNow: decimalSchema.nullable(),
  averagePrice: decimalSchema.nullable(),
  fillsWhole: z.boolean(),
  notional: decimalSchema,
  knownFees: decimalSchema,
  total: signedDecimalSchema,
  unknownFees: z.array(z.enum(['venue_fee', 'builder_fee'])),
});
export type RouteCost = z.infer<typeof cost>;
const shownBest = level.nullable();
export const routePreviewSchema = z.object({
  symbol: z.string(),
  side: z.enum(['buy', 'sell']),
  amount: decimalSchema,
  quoteAsset: z.string().nullable(),
  chosen: z
    .object({
      venueId: z.string(),
      displayName: z.string(),
      test: z.boolean(),
      shownBest,
      preview: z.object({ venueId: z.string(), asOf: isoTime, value: venuePreviewSchema }),
      cost,
    })
    .nullable(),
  others: z.array(cost.extend({ displayName: z.string(), shownBest })),
  excluded: z.array(z.object({ venueId: z.string().nullable(), displayName: z.string().nullable(), code: z.string(), detail: z.string() })),
  reason: z.enum(['only_venue', 'fills_whole', 'lowest_cost', 'fills_most', 'tie_by_id', 'no_signable_venue_up']),
  at: isoTime,
});
export type RoutePreview = z.infer<typeof routePreviewSchema>;

/** The venue's own answer for one order of orders signed together (J-derivatives-03 #9). */
const legOutcome = z.union([
  z.object({
    definite: z.literal(true),
    accepted: z.literal(true),
    venueRef: z.string().nullable(),
    order: venueOrderSchema.nullable(),
    asOf: isoTime,
  }),
  z.object({ definite: z.literal(true), accepted: z.literal(false), refusal: refusalSchema, asOf: isoTime }),
]);
export type VenueLegOutcome = z.infer<typeof legOutcome>;

const orderOutcome = z.union([
  z.object({
    definite: z.literal(true),
    accepted: z.literal(true),
    venueRef: z.string().nullable(),
    order: venueOrderSchema.nullable(),
    /** Orders signed together: each order's own answer, in the order sent. */
    legs: z.array(legOutcome).optional(),
    asOf: isoTime,
  }),
  z.object({ definite: z.literal(true), accepted: z.literal(false), refusal: refusalSchema, asOf: isoTime }),
  z.object({ definite: z.literal(false), reason: z.enum(['timeout', 'connection_lost', 'venue_error_after_send', 'already_submitted']) }),
]);
export type VenueOutcome = z.infer<typeof orderOutcome>;

/** The wallet's payload, passed through as the door sent it (the venue rebuilds and checks it at submit). */
const typedDataSchema = z.object({
  domain: z.record(z.string(), z.unknown()),
  types: z.record(z.string(), z.array(z.object({ name: z.string(), type: z.string() }))),
  primaryType: z.string(),
  message: z.record(z.string(), z.unknown()),
});

export const preparedAnswerSchema = z.object({
  actionKey: z.string(),
  prepared: z.object({
    venueId: z.string(),
    signer: z.object({ role: z.enum(['owner', 'agent']), address: z.string() }),
    nonce: z.string(),
    venueClientOrderId: z.string().nullable(),
    typedData: typedDataSchema,
    digest: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  }),
  reused: z.boolean(),
  signed: z.boolean(),
  lastOutcome: orderOutcome.nullable(),
});
export type PreparedAnswer = z.infer<typeof preparedAnswerSchema>;

export const submitAnswerSchema = z.object({
  actionKey: z.string(),
  outcome: orderOutcome,
  readBack: z
    .union([
      z.object({ venueClientOrderId: z.string() }),
      z.object({ venueClientOrderIds: z.array(z.string()) }),
      z.object({ nonce: z.string() }),
    ])
    .nullable(),
});
export type SubmitAnswer = z.infer<typeof submitAnswerSchema>;

/** The signature this page made for one prepared action, kept in memory only. */
export interface KeptSignature {
  digest: string;
  signature: string;
  signedBy: string;
}

/**
 * What to do with the door's answer to a prepare, given what this page itself knows about the key:
 * - a definite answer already recorded stands (`outcome`);
 * - a signed action with no definite answer is read back (`unknown`) and never sent again, unless this page's own last
 *   submit of it was refused definitely before it was sent (`resend` the same bytes);
 * - an unsigned action another tab or press is prompting for (`reused` and not this page's own prompt) waits for that
 *   prompt; a second press here prompts here (`sign`);
 * - otherwise the wallet signs (`sign`).
 */
export type PreparedStep =
  | { step: 'outcome'; outcome: Extract<VenueOutcome, { definite: true }> }
  | { step: 'unknown' }
  | { step: 'resend'; signature: KeptSignature }
  | { step: 'wait' }
  | { step: 'sign' };

export function preparedStep(
  answer: Pick<PreparedAnswer, 'signed' | 'reused' | 'lastOutcome'>,
  local: { kept: KeptSignature | undefined; refusedBeforeSend: boolean; promptedHere: boolean },
): PreparedStep {
  const last = answer.lastOutcome;
  if (answer.signed) {
    if (last?.definite) return { step: 'outcome', outcome: last };
    if (!last && local.kept && local.refusedBeforeSend) return { step: 'resend', signature: local.kept };
    return { step: 'unknown' };
  }
  if (answer.reused && !local.promptedHere) return { step: 'wait' };
  return { step: 'sign' };
}

// ── A position's protections (J-derivatives-03; svc-trade src/venue/protections.ts) ─────────────────────────────

export const PROTECTION_KINDS = ['take_profit', 'stop_loss', 'stop_market', 'stop_limit', 'trailing_stop'] as const;
export type ProtectionKind = (typeof PROTECTION_KINDS)[number];
export const PROTECTION_SOURCES = ['mark', 'last', 'index'] as const;
export type ProtectionSource = (typeof PROTECTION_SOURCES)[number];

export const protectionViewSchema = z.object({
  id: z.string(),
  kind: z.enum(PROTECTION_KINDS),
  role: z.enum(['take_profit', 'stop_loss']),
  restsOn: z.enum(['venue', 'engine']),
  label: z.string(),
  symbol: z.string(),
  side: z.enum(['buy', 'sell']),
  quantity: decimalSchema,
  triggerSource: z.enum(PROTECTION_SOURCES),
  triggerPrice: decimalSchema.nullable(),
  limitPrice: decimalSchema.nullable(),
  trailingDistance: decimalSchema.nullable(),
  currentTrigger: decimalSchema.nullable(),
  status: z.enum(['armed', 'triggered', 'filled', 'failed', 'cancelled']),
  failure: z.string().nullable(),
  cancelReason: z.string().nullable(),
  venueOrderId: z.string().nullable(),
  venueClientOrderId: z.string().nullable(),
  parentClientOrderId: z.string().nullable(),
  agentPermission: z.object({ agentAddress: z.string() }).nullable(),
  clientOrderId: z.string(),
  actionKey: z.string().nullable(),
});
export type ProtectionView = z.infer<typeof protectionViewSchema>;

export const protectionCreatedSchema = z.union([
  z.object({ restsOn: z.literal('venue'), actionKey: z.string(), prepared: preparedAnswerSchema.shape.prepared, reused: z.boolean() }),
  z.object({ restsOn: z.literal('engine'), protection: protectionViewSchema }),
]);
export type ProtectionCreated = z.infer<typeof protectionCreatedSchema>;

export const protectionAgentSchema = z.object({
  agentAddress: z.string(),
  agentName: z.string(),
  approved: z.boolean(),
  validUntil: z.string().nullable(),
});
export type ProtectionAgent = z.infer<typeof protectionAgentSchema>;

/** One protection to arm: only the price fields its kind takes are sent. Amounts are decimal strings. */
export interface ProtectionRequest {
  owner: string;
  symbol: string;
  kind: ProtectionKind;
  side: 'buy' | 'sell';
  quantity: string;
  triggerPrice?: string;
  limitPrice?: string;
  trailingDistance?: string;
  triggerSource: ProtectionSource;
  clientOrderId: string;
  /** The entry order's own client order key, for a take profit or stop loss attached to it. */
  attachTo?: string;
}

// ── Conditional spot orders (J-cex-spot-08; svc-trade src/venue/spot-conditionals.ts) ─────────────────────────────

export const SPOT_CONDITIONAL_KINDS = ['stop_limit', 'stop_market', 'oco', 'bracket', 'oto'] as const;
export type SpotConditionalKind = (typeof SPOT_CONDITIONAL_KINDS)[number];
export const SPOT_LEG_ROLES = ['stop', 'take_profit', 'stop_loss', 'entry', 'close'] as const;
export type SpotLegRole = (typeof SPOT_LEG_ROLES)[number];

export const spotLegSchema = z.object({
  role: z.enum(SPOT_LEG_ROLES),
  side: z.enum(['buy', 'sell']),
  type: z.enum(['limit', 'market']),
  price: decimalSchema.nullable(),
  triggerPrice: decimalSchema.nullable(),
  quantity: decimalSchema,
  restsOn: z.enum(['venue', 'engine']),
  signedBy: z.enum(['wallet', 'agent']),
  status: z.enum(['waiting', 'armed', 'triggered', 'open', 'partially_filled', 'filled', 'cancelled', 'failed']),
  orderKey: z.string().nullable(),
  venueClientOrderId: z.string().nullable(),
  filled: decimalSchema.nullable(),
  locked: decimalSchema.nullable(),
  lockedAsset: z.string().nullable(),
  linkedTo: z.enum(SPOT_LEG_ROLES).nullable(),
});
export type SpotLegView = z.infer<typeof spotLegSchema>;

export const spotConditionalSchema = z.object({
  id: z.string(),
  clientOrderId: z.string(),
  kind: z.enum(SPOT_CONDITIONAL_KINDS),
  symbol: z.string(),
  side: z.enum(['buy', 'sell']),
  quantity: decimalSchema,
  status: z.enum(['entry', 'placing', 'open', 'armed', 'firing', 'cancelling', 'fired', 'filled', 'failed', 'cancelled']),
  restsOn: z.literal('engine'),
  label: z.string(),
  agentPermission: z.object({ agentAddress: z.string() }),
  triggerSource: z.literal('last'),
  triggerPrice: decimalSchema.nullable(),
  limitPrice: decimalSchema.nullable(),
  takeProfitPrice: decimalSchema.nullable(),
  entryPrice: decimalSchema.nullable(),
  entryTif: z.enum(['GTC', 'IOC']).nullable(),
  closePrice: decimalSchema.nullable(),
  exitQuantity: decimalSchema.nullable(),
  referencePrice: decimalSchema.nullable(),
  failure: z.string().nullable(),
  cancelReason: z.string().nullable(),
  createdAt: z.string(),
  legs: z.array(spotLegSchema),
});
export type SpotConditionalView = z.infer<typeof spotConditionalSchema>;

export const spotConditionalCreatedSchema = z.union([
  z.object({ restsOn: z.literal('venue'), actionKey: z.string(), prepared: preparedAnswerSchema.shape.prepared, reused: z.boolean() }),
  z.object({
    restsOn: z.literal('engine'),
    conditional: spotConditionalSchema,
    reused: z.boolean(),
    entry: preparedAnswerSchema.nullable(),
  }),
]);
export type SpotConditionalCreated = z.infer<typeof spotConditionalCreatedSchema>;

export const spotFeeLegSchema = z.object({
  role: z.enum(SPOT_LEG_ROLES),
  side: z.enum(['buy', 'sell']),
  liquidity: z.enum(['maker', 'taker']),
  price: decimalSchema,
  quantity: decimalSchema,
  venueFeeBps: decimalSchema.nullable(),
  builderFeeBps: decimalSchema.nullable(),
  feeAsset: z.string(),
  estimatedFee: decimalSchema.nullable(),
});
export type SpotFeeLeg = z.infer<typeof spotFeeLegSchema>;

/** One conditional spot order: only the price fields its kind takes are sent. Amounts are decimal strings. */
export interface SpotConditionalRequest {
  owner: string;
  symbol: string;
  kind: SpotConditionalKind;
  side: 'buy' | 'sell';
  quantity: string;
  triggerPrice?: string;
  limitPrice?: string;
  takeProfitPrice?: string;
  entryPrice?: string;
  entryTif?: 'GTC' | 'IOC';
  closePrice?: string;
  clientOrderId: string;
}

// ── Intents, as the door takes them: every Amount a decimal string ─────────────────────────────────────────────────

export interface OrderIntent {
  kind: 'place_order';
  symbol: string;
  side: 'buy' | 'sell';
  type: 'limit' | 'market';
  amount: string;
  /** A limit's price, or a market order's worst accepted price (its slippage limit). */
  price: string;
  timeInForce: VenueTimeInForce;
  reduceOnly: boolean;
  clientOrderKey: string;
  /** Our builder fee is the door's (the owner value), never the browser's. */
  builderFee: null;
}
export type VenueIntent =
  | OrderIntent
  // Orders the venue takes in one signed action (J-derivatives-03 #9), each keyed `<actionKey>:<part>`.
  | { kind: 'place_orders'; actionKey: string; orders: OrderIntent[] }
  | { kind: 'cancel_order'; symbol: string; clientOrderKey: string }
  // J-cex-spot-05: a resting order lowered in place, replaced in one signed action, or several cancelled in one, each
  // named by the venue's own client id, so an order placed from any page can be changed.
  | { kind: 'amend_order'; symbol: string; venueClientOrderId: string; amount: string; price: string }
  | { kind: 'replace_order'; symbol: string; venueClientOrderId: string; order: OrderIntent }
  | { kind: 'cancel_orders'; orders: Array<{ symbol: string; venueClientOrderId: string }> }
  // J-cex-spot-07: the venue's own scheduled cancel; the door times it from now (`time` is set there), timeout 0 removes it.
  | { kind: 'schedule_cancel'; timeoutSec: number; time: null }
  | { kind: 'update_leverage'; symbol: string; leverageBps: number; marginMode: VenueMarginMode }
  | { kind: 'approve_builder_fee'; builder: string; maxFeeBps: string }
  | { kind: 'withdraw'; asset: string; amount: string; destination: string; withdrawalKey: string }
  // The person's own sub-account (J-portfolio-04 #2): opened and moved into, each signed on the main account.
  | { kind: 'create_sub_account'; name: string; subAccountKey: string }
  | {
      kind: 'sub_account_transfer';
      subAccount: string;
      direction: 'into_sub_account' | 'out_of_sub_account';
      asset: string;
      amount: string;
      moveKey: string;
    }
  | {
      kind: 'market_margin_transfer';
      symbol: string;
      direction: 'into_market' | 'out_of_market';
      asset: string;
      amount: string;
      moveKey: string;
    }
  // J-derivatives-06 #2 #3: margin added to or removed from an open isolated position, one signed venue change.
  | { kind: 'update_isolated_margin'; symbol: string; direction: 'add' | 'remove'; amount: string; changeKey: string };

// ── Business keys ──────────────────────────────────────────────────────────────────────────────────────────────────

/** A key part: lowercase, no separators the door's key shape reserves. */
const part = (value: string) => value.toLowerCase().replace(/[^a-z0-9.-]/g, '-');

/**
 * The id of one reviewed draft: minted once when Review is pressed and held for every retry of that draft, so a double
 * press, a lost answer or a reload sends the same client order id. A new draft gets a new one.
 */
export function draftId(now: number = Date.now(), counter: number = 0): string {
  return `${now.toString(36)}${counter.toString(36)}`;
}

export const keys = {
  order: (owner: string, symbol: string, draft: string) => `order:${part(owner)}:${part(symbol)}:${draft}`,
  close: (owner: string, symbol: string, draft: string) => `close:${part(owner)}:${part(symbol)}:${draft}`,
  cancel: (clientOrderKey: string) => `cancel:${clientOrderKey}`,
  /** One reverse of a position: its close is `<key>:close` and its open `<key>:open`, each under the one reverse key. */
  reverse: (owner: string, draft: string) => `order:${part(owner)}:reverse:${draft}`,
  /** The person's own sub-account, by its name: a second press opens the same one (user-venue-door.ts OWN_SUB_ACCOUNT_PREFIX). */
  ownSubAccount: (owner: string, name: string) => `own:sub-account:${part(owner)}:${part(name.trim())}`,
  /** One move between the main account and an own sub-account, by its reviewed draft (OWN_MOVE_PREFIX). */
  ownMove: (owner: string, draft: string) => `own:move:${part(owner)}:${draft}`,
  leverage: (owner: string, symbol: string, mode: VenueMarginMode, leverageBps: number, draft: string) =>
    `leverage:${part(owner)}:${part(symbol)}:${mode}:${leverageBps}:${draft}`,
  builderApproval: (owner: string, builder: string, maxFeeBps: string, venueId?: string) =>
    venueId
      ? `builder-approval:${part(owner)}:${part(venueId)}:${part(builder)}:${maxFeeBps}`
      : `builder-approval:${part(owner)}:${part(builder)}:${maxFeeBps}`,
  withdraw: (owner: string, draft: string) => `withdraw:${part(owner)}:${draft}`,
  /** One lowering of a resting order, by the venue's client id and the amount left: the same change asked twice is one. */
  amend: (owner: string, venueClientOrderId: string, amount: string) =>
    `amend:${part(owner)}:${part(venueClientOrderId)}:${canonicalDecimal(amount)}`,
  /** One reviewed cancel-and-replace; its replacement is placed under `<key>:new`'s own client id. */
  replace: (owner: string, draft: string) => `replace:${part(owner)}:${draft}`,
  replacement: (owner: string, symbol: string, draft: string) => `order:${part(owner)}:${part(symbol)}:replace-${draft}`,
  /** One confirmed batch cancel. */
  cancelBatch: (owner: string, draft: string) => `cancel-batch:${part(owner)}:${draft}`,
  /** One press of the dead-man switch: arming, refreshing or removing the venue's scheduled cancel (J-cex-spot-07). */
  scheduleCancel: (owner: string, draft: string) => `schedule-cancel:${part(owner)}:${draft}`,
  /** One reviewed margin change on an isolated position (J-derivatives-06 #2 #3). */
  isolatedMargin: (owner: string, symbol: string, direction: 'add' | 'remove', draft: string) =>
    `margin:${part(owner)}:${part(symbol)}:${direction}:${draft}`,
  marketMargin: (owner: string, symbol: string, direction: 'into_market' | 'out_of_market', draft: string) =>
    `market-margin:${part(owner)}:${part(symbol)}:${direction === 'into_market' ? 'in' : 'out'}:${draft}`,
};

// ── Figures ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** The canonical decimal a service hashes (`formatAmount`): no trailing zeros, no plus sign. */
export function canonicalDecimal(value: string): string {
  return formatAmount(parseAmount(value.trim()));
}

/** A sum of the venue's own figures; `null` when any of them is not known. */
export function sumKnown(values: ReadonlyArray<MaybeKnown<string>>): string | null {
  let total = 0n;
  for (const v of values) {
    if (!v.known) return null;
    total += parseAmount(v.value);
  }
  return formatAmount(total);
}

export function sumDecimals(values: readonly string[]): string {
  return formatAmount(values.reduce((total, v) => total + parseAmount(v), 0n));
}

/** True when `value` is a whole multiple of `step` (tick or lot), compared exactly. */
export function onStep(value: string, step: string): boolean {
  try {
    const v = parseAmount(value);
    const s = parseAmount(step);
    return s > 0n && v > 0n && v % s === 0n;
  } catch {
    return false;
  }
}

/** `percent` (whole number) of `size`, rounded down to the lot. */
export function partOf(size: string, percent: number, lot: string): string {
  const s = parseAmount(size);
  const l = parseAmount(lot);
  const raw = (s * BigInt(percent)) / 100n;
  return formatAmount(l > 0n ? (raw / l) * l : raw);
}

/** Basis points of 1x, as the venue keeps leverage (`100_000` is 10x). */
export const leverageBpsOf = (times: number) => Math.round(times * 10_000);
export const leverageTimes = (bps: number) => bps / 10_000;

/**
 * The venue's typed data as the wallet signs it. The venue's payload leaves `EIP712Domain` implicit; a wallet request
 * declares it, field for field from the domain in the order EIP-712 hashes them, so the wallet signs the same digest.
 */
export function walletTypedData(typedData: PreparedAnswer['prepared']['typedData']): TypedDataDocument {
  const order = ['name', 'version', 'chainId', 'verifyingContract', 'salt'] as const;
  const kind: Record<(typeof order)[number], string> = {
    name: 'string',
    version: 'string',
    chainId: 'uint256',
    verifyingContract: 'address',
    salt: 'bytes32',
  };
  const domain = typedData.domain;
  const declared = order.filter((name) => domain[name] !== undefined).map((name) => ({ name, type: kind[name] }));
  return {
    types: { EIP712Domain: declared, ...typedData.types },
    primaryType: typedData.primaryType,
    domain: domain as TypedDataDocument['domain'],
    message: typedData.message,
  };
}

/** J-derivatives-01 #2: one perpetual open or blocked for this account, with every reason (svc-trade venue-gated-list.ts). */
const venueGatedContractSchema = z.object({
  symbol: z.string(),
  open: z.boolean(),
  code: z.string().nullable(),
  message: z.string().nullable(),
  blockers: z.array(z.object({ code: z.string(), message: z.string() })),
});
export type VenueGatedContract = z.infer<typeof venueGatedContractSchema>;

/** J-derivatives-12 #5: the perpetuals this account is eligible for, or none with the reason (svc-trade venue-eligibility.ts). */
const venueEligibleSchema = z.object({
  level: z.enum(['basic', 'full', 'institutional']).nullable(),
  reason: z.object({ code: z.string(), message: z.string() }).nullable(),
  instruments: z.array(z.object({ symbol: z.string(), settleAsset: z.string(), maxLeverageBps: z.number().int().positive().nullable() })),
});
export type VenueEligible = z.infer<typeof venueEligibleSchema>;

/** J-derivatives-12 #4: our builder fee on one fill of the person's own orders, and the ledger transaction it posted. */
const venueBuilderFeeRowSchema = z.object({
  fillId: z.string(),
  amount: decimalSchema,
  asset: z.string(),
  filledAt: isoTime,
  status: z.enum(['posted', 'refused', 'not_our_order']),
  refusalCode: z.string().nullable(),
  ledgerTxId: z.string().nullable(),
});
export type VenueBuilderFeeRow = z.infer<typeof venueBuilderFeeRowSchema>;

// ── The door ──────────────────────────────────────────────────────────────────────────────────────────────────────

export function venueApi(api: ApiClient) {
  const read = <T>(path: string, schema: z.ZodType<T>, query: Record<string, string | undefined>, signal?: AbortSignal) =>
    api.rest(`/venue${path}`, schema, { query, signal });
  const write = <T>(path: string, schema: z.ZodType<T>, body: unknown): Promise<ApiResult<T>> =>
    api.rest(`/venue${path}`, schema, { method: 'POST', body });
  return {
    status: (signal?: AbortSignal) => api.rest('/venue/status', venueStatusSchema, { signal }),
    markets: (signal?: AbortSignal, venueId?: string) => read('/markets', asOf(z.array(venueMarketSchema)), { venueId }, signal),
    bestPrices: (symbol: string, signal?: AbortSignal) => read('/best-prices', venueBestPricesReadSchema, { symbol }, signal),
    book: (symbol: string, depth: number, signal?: AbortSignal) =>
      read('/book', venueBookReadSchema, { symbol, depth: String(depth) }, signal),
    trades: (symbol: string, limit: number, signal?: AbortSignal) =>
      read('/trades', venueTradesReadSchema, { symbol, limit: String(limit) }, signal),
    candles: (symbol: string, interval: string, limit: number, signal?: AbortSignal) =>
      read('/candles', venueCandlesReadSchema, { symbol, interval, limit: String(limit) }, signal),
    gatedList: (signal?: AbortSignal) => read('/gated-list', asOf(z.array(venueGatedContractSchema)), {}, signal),
    balances: (owner: string, signal?: AbortSignal, subAccount?: string, venueId?: string) =>
      read('/balances', asOf(z.array(venueBalanceSchema)), { owner, subAccount, venueId }, signal),
    openOrders: (owner: string, signal?: AbortSignal) => read('/orders/open', asOf(z.array(venueOrderSchema)), { owner }, signal),
    /** The orders this person's door kept on the owner's accounts, oldest first, a page at a time (J-agents-21 #7). */
    keptOrders: (owner: string, cursor?: string, signal?: AbortSignal) => read('/orders', venueOrderPageSchema, { owner, cursor }, signal),
    /** The person's agent accounts, each with its owner wallet and venue sub-account (J-agents-21). */
    agentAccounts: (signal?: AbortSignal) => read('/agent-accounts', z.object({ accounts: z.array(agentAccountRowSchema) }), {}, signal),
    /** The account's orders in every state as the venue keeps them, filtered and a page at a time (J-cex-spot-06 #1). */
    orderHistory: (owner: string, query: VenueHistoryQuery, signal?: AbortSignal) =>
      read('/orders/history', venueHistoryPageSchema, { owner, ...query }, signal),
    /** Our record of one order: amendments the venue accepted, and our builder fee on it (J-cex-spot-06 #5 #10). */
    orderRecord: (owner: string, clientOrderId: string, signal?: AbortSignal) =>
      read('/orders/record', venueOrderRecordSchema, { owner, clientOrderId }, signal),
    orderByClientId: (owner: string, clientOrderId: string, signal?: AbortSignal) =>
      read('/orders/by-client-id', asOf(venueOrderSchema.nullable()), { owner, clientOrderId }, signal),
    fills: (owner: string, since: string, signal?: AbortSignal, at: { venueId?: string; subAccount?: string } = {}) =>
      read('/fills', asOf(z.array(venueFillSchema)), { owner, since, ...at }, signal),
    /** The positions on one account: the main account, or one of the owner's sub-accounts, on a venue (J-derivatives-05). */
    positions: (owner: string, signal?: AbortSignal, at: { venueId?: string; subAccount?: string } = {}) =>
      read('/positions', asOf(z.array(venuePositionSchema)), { owner, ...at }, signal),
    /** The owner's own sub-accounts, as the venue lists them on the main account (J-agents-08 #2). */
    subAccounts: (owner: string, signal?: AbortSignal, venueId?: string) =>
      read('/sub-accounts', asOf(z.array(z.object({ subAccount: z.string(), name: z.string() }))), { owner, venueId }, signal),
    /** What a leverage change would do to the open position's margin, read before anything is signed (J-derivatives-05 #4). */
    leverageChange: (
      owner: string,
      q: { symbol: string; leverageBps: number; marginMode: VenueMarginMode; venueId?: string },
      signal?: AbortSignal,
    ) =>
      read(
        '/leverage-change',
        asOf(venueLeverageChangeSchema),
        { owner, symbol: q.symbol, leverageBps: String(q.leverageBps), marginMode: q.marginMode, venueId: q.venueId },
        signal,
      ),
    /** An open isolated position's margin and the venue's removal limit, read before anything is signed (J-derivatives-06 #2 #3). */
    isolatedMargin: (owner: string, q: { symbol: string; venueId?: string }, signal?: AbortSignal) =>
      read('/isolated-margin', asOf(venueIsolatedMarginSchema), { owner, symbol: q.symbol, venueId: q.venueId }, signal),
    /** The account's equity, free, used margin, maintenance and margin ratio as the venue reports them (J-derivatives-06 #1). */
    accountSummary: (owner: string, signal?: AbortSignal, venueId?: string) =>
      read('/account-summary', asOf(venueAccountSummarySchema), { owner, venueId }, signal),
    /** The position's liquidation state on one market and the venue's rules (J-derivatives-07 #1 #3). */
    liquidation: (owner: string, q: { symbol: string; venueId?: string }, signal?: AbortSignal) =>
      read('/liquidation', asOf(venueLiquidationStatusSchema), { owner, symbol: q.symbol, venueId: q.venueId }, signal),
    /** Each liquidation the venue reports on the account, every part listed (J-derivatives-07 #2). */
    liquidations: (owner: string, signal?: AbortSignal, venueId?: string) =>
      read('/liquidations', asOf(z.array(venueLiquidationSchema)), { owner, venueId }, signal),
    /** Each auto-deleveraging of the account's positions, with the venue's notice (J-derivatives-07 #6). */
    deleverages: (owner: string, signal?: AbortSignal, venueId?: string) =>
      read('/deleverages', asOf(z.array(venueDeleverageSchema)), { owner, venueId }, signal),
    /** The venue's insurance fund, or not published; signed in or not (J-derivatives-07 #4). */
    insuranceFund: (signal?: AbortSignal, venueId?: string) => read('/insurance-fund', venueInsuranceFundSchema, { venueId }, signal),
    /** The venue's public liquidation and auto-deleveraging alerts, newest first (J-derivatives-07 #7). */
    liquidationAlerts: (q: { symbol?: string; limit?: number; venueId?: string }, signal?: AbortSignal) =>
      read(
        '/liquidation-alerts',
        asOf(z.array(venueLiquidationAlertSchema)),
        { symbol: q.symbol, limit: q.limit === undefined ? undefined : String(q.limit), venueId: q.venueId },
        signal,
      ),
    /** The venue's auto-deleveraging rules and whether this person acknowledged their version (J-derivatives-07 #5). */
    adlDisclosure: (signal?: AbortSignal, venueId?: string) => read('/adl-disclosure', venueAdlDisclosureSchema, { venueId }, signal),
    /** "I have read this": stores the version read; a version the venue replaced is refused. */
    acknowledgeAdl: (version: string, venueId?: string) =>
      write('/adl-disclosure/ack', venueAdlDisclosureSchema, { version, ...(venueId ? { venueId } : {}) }),
    /** The owner's balance in the margin account a market's deployer keeps for it (J-derivatives-27 #7). */
    marketMargin: (owner: string, symbol: string, signal?: AbortSignal) =>
      read('/market-margin', asOf(venueMarketMarginSchema), { owner, symbol }, signal),
    /** The owner's settlements in a deployer's halt or a split since `since` (J-derivatives-27 #9 #10). */
    settlements: (owner: string, since: string, signal?: AbortSignal) =>
      read('/settlements', asOf(z.array(venueSettlementSchema)), { owner, since }, signal),
    /** The funding the venue charged or paid on the owner's positions since `since` (J-derivatives-08 #3 #4 #5). */
    fundingPayments: (owner: string, since: string, signal?: AbortSignal, venueId?: string) =>
      read('/funding-payments', asOf(z.array(venueFundingPaymentSchema)), { owner, since, venueId }, signal),
    /** Our builder fee on each fill of the person's own orders on the account, with its ledger transaction (J-derivatives-12 #4). */
    builderFees: (owner: string, since: string, signal?: AbortSignal, venueId?: string) =>
      read('/builder-fees', asOf(z.array(venueBuilderFeeRowSchema)), { owner, since, venueId }, signal),
    /** The perpetuals this account is eligible for, each with its settle asset, or none with the reason (J-derivatives-12 #5). */
    eligibleInstruments: (signal?: AbortSignal, venueId?: string) =>
      read('/eligible-instruments', asOf(venueEligibleSchema), { venueId }, signal),
    /** The venue's scheduled cancel on the owner's account: when it cancels, and when it last did (J-cex-spot-07). */
    scheduledCancel: (owner: string, signal?: AbortSignal) =>
      read('/scheduled-cancel', asOf(venueScheduledCancelSchema), { owner }, signal),
    /** The statement job for this request key: created once and built once from the venue's own records (J-cex-spot-07 #5). */
    statement: (input: { owner: string; from: string; to: string; requestKey: string }) =>
      write('/statements', venueStatementJobSchema, input),
    statementFile: (id: string) =>
      api.rest(
        `/venue/statements/${encodeURIComponent(id)}/file`,
        z.object({ filename: z.string(), sha256: z.string(), csv: z.string() }),
        {},
      ),
    leverage: (owner: string, symbol: string, signal?: AbortSignal, venueId?: string) =>
      read('/leverage', asOf(venueLeverageSchema.nullable()), { owner, symbol, venueId }, signal),
    builderFeeApproval: (owner: string, signal?: AbortSignal, venueId?: string) =>
      read('/builder-fee-approval', asOf(decimalSchema), { owner, venueId }, signal),
    /** The venue's published fees, its builder-fee caps and ours, signed in or not (J-cex-spot-10 #2). */
    publicFees: (signal?: AbortSignal, venueId?: string) => read('/fees', venuePublicFeesSchema, { venueId }, signal),
    /** The owner's own fee tier as the venue reports it (J-cex-spot-10 #6). */
    feeTier: (owner: string, signal?: AbortSignal, venueId?: string) => read('/fee-tier', venueFeeTierSchema, { owner, venueId }, signal),
    marketVenues: (symbol: string, owner: string, side: 'buy' | 'sell', signal?: AbortSignal) =>
      api.rest(`/venue/markets/${encodeURIComponent(symbol)}/venues`, marketVenuesSchema, { query: { owner, side }, signal }),
    routePreview: (owner: string, intent: OrderIntent) => write('/route-preview', routePreviewSchema, { owner, intent }),
    ordersByClientIdOn: (venueId: string, owner: string, clientOrderId: string, signal?: AbortSignal) =>
      read('/orders/by-client-id', asOf(venueOrderSchema.nullable()), { owner, clientOrderId, venueId }, signal),
    withdrawal: (owner: string, nonce: string, signal?: AbortSignal) =>
      api.rest(`/venue/withdrawals/${encodeURIComponent(nonce)}`, asOf(venueWithdrawalSchema.nullable()), { query: { owner }, signal }),
    preview: (owner: string, intent: OrderIntent) => write('/preview', asOf(venuePreviewSchema), { owner, intent }),
    prepare: (input: {
      owner: string;
      /** One of the person's own sub-accounts under `owner`, which the wallet signs for as its owner; omitted is the main account. */
      subAccount?: string | null;
      intent: VenueIntent;
      actionKey?: string;
      stepUpApprovalId?: string | null;
      venueId?: string;
    }) =>
      write('/prepare', preparedAnswerSchema, {
        ...(input.venueId ? { venueId: input.venueId } : {}),
        ...(input.subAccount ? { subAccount: input.subAccount } : {}),
        owner: input.owner,
        signer: { role: 'owner', address: input.owner },
        intent: input.intent,
        actionKey: input.actionKey ?? null,
        stepUpApprovalId: input.stepUpApprovalId ?? null,
      }),
    submit: (actionKey: string, signature: { digest: string; signature: string; signedBy: string }) =>
      write('/submit', submitAnswerSchema, { actionKey, signature }),
    /** The person's protections: the venue's trigger orders our door sent and our engine's stops (J-derivatives-03). */
    protections: (owner: string, signal?: AbortSignal) =>
      read('/protections', z.object({ protections: z.array(protectionViewSchema) }), { owner }, signal),
    createProtection: (input: ProtectionRequest) => write('/protections', protectionCreatedSchema, input),
    cancelProtection: (id: string) => api.rest(`/venue/protections/${encodeURIComponent(id)}`, protectionViewSchema, { method: 'DELETE' }),
    protectionAgent: (owner: string, signal?: AbortSignal) => read('/protection-agent', protectionAgentSchema, { owner }, signal),
    prepareProtectionAgent: (owner: string) => write('/protection-agent/prepare', preparedAnswerSchema, { owner }),
    /** The person's conditional spot orders: stops, OCOs, brackets and linked closes (J-cex-spot-08). */
    spotOrders: (owner: string, signal?: AbortSignal) =>
      read('/spot-orders', z.object({ orders: z.array(spotConditionalSchema) }), { owner }, signal),
    createSpotOrder: (input: SpotConditionalRequest) => write('/spot-orders', spotConditionalCreatedSchema, input),
    reviewSpotOrder: (input: SpotConditionalRequest) => write('/spot-orders/review', z.object({ legs: z.array(spotFeeLegSchema) }), input),
    modifySpotOrder: (id: string, body: { triggerPrice: string; limitPrice?: string }) =>
      api.rest(`/venue/spot-orders/${encodeURIComponent(id)}`, spotConditionalSchema, { method: 'PATCH', body }),
    cancelSpotOrder: (id: string) => api.rest(`/venue/spot-orders/${encodeURIComponent(id)}`, spotConditionalSchema, { method: 'DELETE' }),
    spotAgent: (owner: string, signal?: AbortSignal) => read('/spot-agent', protectionAgentSchema, { owner }, signal),
    prepareSpotAgent: (owner: string) => write('/spot-agent/prepare', preparedAnswerSchema, { owner }),
  };
}
export type VenueApi = ReturnType<typeof venueApi>;
