/**
 * svc-trade's futures and margin answers (`/api/v1/futures/...`, `/positions/...`), as the Futures and Margin rooms read
 * them. Browser-safe (zod only). Money fields are exact decimal strings.
 */
import { z } from 'zod';
import { signedAmountSchema, unsignedAmountSchema } from './wire-amount.js';

export const tickerStripSchema = z.object({
  markPrice: unsignedAmountSchema.nullable(),
  markSource: z.unknown().nullable().optional(),
  fundingRate: unsignedAmountSchema.nullable(),
  fundingPeriodId: z.string().nullable().optional(),
  nextFundingTime: z.string().nullable(),
});
export type TickerStrip = z.infer<typeof tickerStripSchema>;

export const fundingRateSchema = z.object({
  symbol: z.string(),
  markPrice: unsignedAmountSchema.nullable(),
  indexPrice: unsignedAmountSchema.nullable(),
  fundingRate: unsignedAmountSchema,
  fundingTimestamp: z.number(),
  fundingDatetime: z.string(),
  nextFundingTimestamp: z.number().nullable(),
});
export type FundingRate = z.infer<typeof fundingRateSchema>;

export const marginCallSchema = z.object({
  positionId: z.string(),
  sequence: z.number().int(),
  healthBps: z.number(),
  calledAt: z.string(),
  deliveredAt: z.string(),
  delivered: z.literal(true),
});
export type MarginCall = z.infer<typeof marginCallSchema>;

/**
 * A position's pre-liquidation stop (`GET/PUT /positions/:id/risk-stop`, D-margin-04): the margin-ratio level the trader
 * set, the mark at which the service closes the position for it, and the ratio now, each worked out by the service.
 * `none` is a fact (no stop); `fired` names the close order it placed.
 */
export const riskStopSchema = z.object({
  positionId: z.string(),
  status: z.enum(['none', 'armed', 'fired', 'ended']),
  level: unsignedAmountSchema.nullable(),
  marginRatio: unsignedAmountSchema.nullable(),
  marginRatioReason: z.string().nullable(),
  triggerPrice: unsignedAmountSchema.nullable(),
  triggerPriceReason: z.string().nullable(),
  liquidationPrice: unsignedAmountSchema.nullable(),
  closeOrder: z.object({ clientOrderId: z.string(), status: z.string(), orderId: z.string().nullable() }).nullable(),
  firedRatio: unsignedAmountSchema.nullable(),
  firedAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type RiskStop = z.infer<typeof riskStopSchema>;

export const adlDisclosureSchema = z.object({ version: z.string(), copy: z.string(), acknowledged: z.boolean() });
export type AdlDisclosure = z.infer<typeof adlDisclosureSchema>;

export const adlEventSchema = z.object({
  eventId: z.string(),
  at: z.string(),
  version: z.string(),
  bankruptPositionId: z.string(),
  candidatePositionId: z.string(),
  sizeToReduce: unsignedAmountSchema,
  beforeAction: z.literal(true),
});
export type AdlEvent = z.infer<typeof adlEventSchema>;

/** What counts as futures margin for the account (`GET /futures/collateral`): cash with the haircut, and refused classes. */
export const collateralSchema = z.object({
  /** The venue whose margin rule this is. */
  venue: z.object({ id: z.string(), name: z.string() }),
  assets: z.array(
    z.object({
      asset: z.string(),
      collateralClass: z.literal('cash'),
      counts: z.literal(true),
      haircutBps: z.number().int().nullable(),
      haircutReason: z.string().nullable(),
      free: unsignedAmountSchema,
      posted: unsignedAmountSchema,
      committed: unsignedAmountSchema,
      credit: unsignedAmountSchema.nullable(),
      buyingPower: unsignedAmountSchema.nullable(),
      buyingPowerReason: z.string().nullable(),
    }),
  ),
  refusedClasses: z.array(
    z.object({ collateralClass: z.string(), counts: z.literal(false), code: z.string().nullable(), message: z.string().nullable() }),
  ),
});
export type Collateral = z.infer<typeof collateralSchema>;

/**
 * The account metrics (`GET /futures/margin-summary`), worked out by the service from the same marked rows the positions
 * list shows. Every figure is an exact decimal or null; `missing` names the input a null figure is waiting for.
 */
export const marginSummarySchema = z.object({
  positions: z.number().int(),
  asset: z.string().nullable(),
  available: unsignedAmountSchema.nullable(),
  usedMargin: unsignedAmountSchema.nullable(),
  totalInitialMargin: unsignedAmountSchema.nullable(),
  totalMaintenanceMargin: unsignedAmountSchema.nullable(),
  equity: unsignedAmountSchema.nullable(),
  excess: unsignedAmountSchema.nullable(),
  deficit: unsignedAmountSchema.nullable(),
  marginRatio: unsignedAmountSchema.nullable(),
  buyingPower: unsignedAmountSchema.nullable(),
  missing: z.array(z.object({ field: z.string(), code: z.string() })),
});
export type MarginSummary = z.infer<typeof marginSummarySchema>;

/** The owner's maintenance tiers (`GET /futures/tiers`): the bound as a share of depth, and the notional it takes today. */
export const riskTiersSchema = z.object({
  symbol: z.string(),
  tiers: z.array(
    z.object({
      tier: z.number().int(),
      uptoDepthBps: z.number().int().nullable(),
      maintenanceBps: z.number().int(),
      maintenanceRate: unsignedAmountSchema,
      notionalUpto: z.object({ long: unsignedAmountSchema.nullable(), short: unsignedAmountSchema.nullable() }),
    }),
  ),
  depth: z.object({ long: unsignedAmountSchema.nullable(), short: unsignedAmountSchema.nullable() }),
  maxLeverage: unsignedAmountSchema.nullable(),
  leverageBasis: z.string(),
  formula: z.string(),
});
export type RiskTiers = z.infer<typeof riskTiersSchema>;

/** The margin and P&L calculator (`POST /futures/calculator`): arithmetic on typed inputs, nothing stored. */
export const calculatorSchema = z.object({
  symbol: z.string(),
  side: z.enum(['long', 'short']),
  size: unsignedAmountSchema,
  entryPrice: unsignedAmountSchema,
  exitPrice: unsignedAmountSchema.nullable(),
  leverage: unsignedAmountSchema,
  leverageCap: unsignedAmountSchema.nullable(),
  notional: unsignedAmountSchema,
  initialMargin: unsignedAmountSchema,
  tier: z.number().int().nullable(),
  maintenanceBps: z.number().int().nullable(),
  maintenanceMargin: unsignedAmountSchema.nullable(),
  liquidationPrice: unsignedAmountSchema.nullable(),
  pnl: unsignedAmountSchema.nullable(),
  roePercent: unsignedAmountSchema.nullable(),
  takerFeeBps: z.number().int().nullable(),
  entryFee: unsignedAmountSchema.nullable(),
  exitFee: unsignedAmountSchema.nullable(),
  netPnl: unsignedAmountSchema.nullable(),
  formulas: z.record(z.string(), z.string()),
  refusals: z.array(z.object({ code: z.string(), field: z.string(), message: z.string() })),
});
export type CalculatorResult = z.infer<typeof calculatorSchema>;

/** One futures order through the book (`POST /futures/orders`): an open, or a reduce-only close. */
/**
 * A take profit and stop loss attached to an opening order. The service arms them on the position once the order
 * fills, sized to what has filled, and grows them as more fills: waiting, armed (the order may fill more), done,
 * not_filled (it ended with no fill), no_position (nothing open on its side to protect) or not_placed (no order came).
 */
export const entryProtectionSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  clientOrderId: z.string(),
  side: z.enum(['buy', 'sell']),
  takeProfit: unsignedAmountSchema.nullable(),
  stopLoss: unsignedAmountSchema.nullable(),
  status: z.enum(['waiting', 'armed', 'done', 'not_filled', 'no_position', 'not_placed']),
  armedQuantity: unsignedAmountSchema,
  takeProfitClientOrderId: z.string().nullable(),
  stopLossClientOrderId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type EntryProtection = z.infer<typeof entryProtectionSchema>;

/** The service's rule for a trader's order label: 1 to 36 of letters, digits and . _ : - */
export const ORDER_LABEL = /^[A-Za-z0-9._:-]{1,36}$/;

/** Who can place a futures order (the service's own list, `FUTURES_ORDER_ORIGINS`). */
export const FUTURES_ORDER_ORIGINS = ['user', 'stop', 'take_profit', 'stop_loss', 'trailing_stop', 'liquidation', 'reverse'] as const;
export const FUTURES_EXECUTION_KINDS = ['open', 'close', 'liquidation', 'adl'] as const;

export const futuresOrderSchema = z.object({
  orderId: z.string(),
  clientOrderId: z.string().optional(),
  marketId: z.string(),
  side: z.enum(['buy', 'sell']),
  type: z.enum(['limit', 'market']),
  qty: unsignedAmountSchema,
  limitPrice: unsignedAmountSchema,
  markPrice: unsignedAmountSchema,
  bandLow: unsignedAmountSchema,
  bandHigh: unsignedAmountSchema,
  holdAmount: unsignedAmountSchema,
  filledQty: unsignedAmountSchema,
  appliedAmount: unsignedAmountSchema,
  releasedAmount: unsignedAmountSchema,
  /** What the order's fills paid in trading fees from its hold. */
  feesPaid: unsignedAmountSchema.optional(),
  status: z.string(),
  refusalCode: z.string().nullable(),
  reduceOnly: z.boolean(),
  positionId: z.string().nullable(),
  bankruptcyPrice: unsignedAmountSchema.nullable(),
  symbol: z.string().optional(),
  createdAt: z.string().optional(),
  /** Present when the order asked for a take profit or stop loss. */
  protection: entryProtectionSchema.optional(),
  /** Who placed it: the trader, a fired stop, take profit, stop loss or trailing stop, a liquidation, or a reverse. */
  origin: z.enum(FUTURES_ORDER_ORIGINS).optional(),
  /** The conditional order, liquidation or reverse it came from. */
  originRef: z.string().nullable().optional(),
  /** The trader's own label. */
  orderLabel: z.string().nullable().optional(),
});
export type FuturesOrder = z.infer<typeof futuresOrderSchema>;
export type FuturesOrderOrigin = (typeof FUTURES_ORDER_ORIGINS)[number];

/** One change to a futures position a trade or the venue made: a fill through the book, or an ADL pair. */
export const futuresExecutionSchema = z.object({
  id: z.string(),
  kind: z.enum(FUTURES_EXECUTION_KINDS),
  symbol: z.string(),
  side: z.enum(['buy', 'sell']),
  qty: unsignedAmountSchema,
  price: unsignedAmountSchema,
  fee: unsignedAmountSchema.nullable(),
  feeRole: z.enum(['maker', 'taker']).nullable(),
  // A close realises a loss as often as a profit.
  realizedPnl: signedAmountSchema.nullable(),
  orderId: z.string().nullable(),
  origin: z.enum(FUTURES_ORDER_ORIGINS).nullable(),
  orderLabel: z.string().nullable(),
  positionId: z.string(),
  at: z.string(),
});
export type FuturesExecution = z.infer<typeof futuresExecutionSchema>;
export const futuresExecutionPageSchema = z.object({ executions: z.array(futuresExecutionSchema), next: z.string().nullable() });

/**
 * A futures conditional order: a stop, take-profit or trailing stop, or one leg of a position's take-profit and
 * stop-loss (`attachment`). Armed until the mark crosses its trigger; a fired one places a reduce-only order in the book
 * (`closeOrderId`) and keeps working until its size is closed.
 */
export const conditionalOrderSchema = z.object({
  id: z.string(),
  market: z.string(),
  kind: z.enum(['stop_market', 'stop_limit', 'take_profit', 'trailing_stop']),
  side: z.enum(['buy', 'sell']),
  quantity: unsignedAmountSchema,
  triggerPrice: unsignedAmountSchema.nullable(),
  limitPrice: unsignedAmountSchema.nullable(),
  /** A trailing stop's distance behind the best price its source reached (`trailExtreme`). */
  trailingDistance: unsignedAmountSchema.nullable().optional(),
  trailExtreme: unsignedAmountSchema.nullable().optional(),
  clientOrderId: z.string().optional(),
  positionId: z.string().nullable(),
  attachment: z.enum(['take_profit', 'stop_loss']).nullable(),
  /** A take profit or stop loss that closes the position as it is when it fires. Older answers carry none: whole. */
  wholePosition: z.boolean().optional(),
  status: z.enum(['armed', 'triggered', 'filled', 'cancelled', 'failed']),
  cancelReason: z.string().nullable(),
  failureReason: z.string().nullable(),
  /** The price a trigger is judged against. Older answers carry none: the published mark was the only source. */
  triggerSource: z.enum(['mark', 'last', 'index']).optional(),
  closeOrderId: z.string().nullable().optional(),
  firedQuantity: unsignedAmountSchema.nullable().optional(),
  closedQuantity: unsignedAmountSchema.nullable().optional(),
  createdAt: z.string(),
});
export type ConditionalOrder = z.infer<typeof conditionalOrderSchema>;

export const protectionSchema = z.object({
  positionId: z.string(),
  takeProfit: conditionalOrderSchema.nullable(),
  stopLoss: conditionalOrderSchema.nullable(),
});
export type Protection = z.infer<typeof protectionSchema>;

export const orderTypeEntrySchema = z.object({
  id: z.string(),
  state: z.enum(['available', 'refused']),
  code: z.string().optional(),
  reason: z.string().optional(),
});
export const orderTypeCatalogueSchema = z.object({
  markets: z.array(
    z.object({
      market: z.string(),
      orderTypes: z.array(orderTypeEntrySchema),
      timeInForce: z.array(orderTypeEntrySchema).optional(),
    }),
  ),
});
export type OrderTypeEntry = z.infer<typeof orderTypeEntrySchema>;
export type OrderTypeCatalogue = z.infer<typeof orderTypeCatalogueSchema>;

const blockerSchema = z.object({ code: z.string(), message: z.string() });
export const gatedListSchema = z.object({
  contracts: z.array(
    z.object({
      symbol: z.string(),
      marketId: z.string(),
      open: z.boolean(),
      code: z.string().nullable(),
      message: z.string().nullable(),
      blockers: z.array(blockerSchema),
    }),
  ),
});
export type GatedList = z.infer<typeof gatedListSchema>;

/**
 * One-tap reverse (J-derivatives-03 #9): one request closes the position through the book and opens the other side at
 * the same size and leverage. `closing` and `opening` are still working (the same request id sent again carries it on);
 * `closed_only` means the close stands and the open was refused or not sent, with `refusalCode`; never a silent half.
 */
export const reverseSchema = z.object({
  clientRequestId: z.string(),
  positionId: z.string(),
  symbol: z.string(),
  from: z.enum(['long', 'short']),
  to: z.enum(['long', 'short']),
  size: unsignedAmountSchema,
  leverage: unsignedAmountSchema,
  status: z.enum(['closing', 'opening', 'done', 'opened_part', 'closed_only', 'close_incomplete', 'refused']),
  closeClientOrderId: z.string(),
  openClientOrderId: z.string(),
  closeOrderId: z.string().nullable(),
  openOrderId: z.string().nullable(),
  closedQuantity: unsignedAmountSchema.nullable(),
  openedQuantity: unsignedAmountSchema.nullable(),
  newPositionId: z.string().nullable(),
  refusalCode: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Reverse = z.infer<typeof reverseSchema>;

export const futuresSplitSchema = z.object({
  parts: z.number().int(),
  orders: z.array(futuresOrderSchema),
  /** The child a typed refusal stopped at; the children before it are live. */
  stopped: z.object({ child: z.number().int(), code: z.string(), message: z.string() }).nullable(),
});
export type FuturesSplit = z.infer<typeof futuresSplitSchema>;

/** `GET /futures/conditional-orders`: the trader's conditional orders. */
export const conditionalOrderListSchema = z.object({ orders: z.array(conditionalOrderSchema) });
/** `GET /futures/entry-protection`: every take profit and stop loss attached to an opening order. */
export const entryProtectionListSchema = z.object({ protections: z.array(entryProtectionSchema) });
