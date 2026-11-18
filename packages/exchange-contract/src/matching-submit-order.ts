import { z } from 'zod';
import { defineProcedure } from '@intafaced/contracts/procedure';
import { marketLifecycleAdmissionProofSchema } from './market-lifecycle-admission-proof.js';
import { orderSideSchema, timeInForceSchema } from './schemas.js';

/**
 * svc-matching `POST /markets/:marketId/orders`: place one order on one book. Served by svc-matching, which parses the body
 * with this record's input, and sent by svc-trade, svc-execution and svc-fix, which build the body from this record's
 * input type and read the reply by its output. A caller's own copy of the body once missed the lifecycle proof and sent a
 * client order id where a GUID is required, so every order it sent would have been refused (#8847).
 */

const decimal = z.string().regex(/^\d+(\.\d{1,18})?$/, 'amounts are positive decimal strings with at most 18 decimal places');
/** Offset may be negative. Still a decimal string — never a JSON number. */
const signedDecimal = z.string().regex(/^-?\d+(\.\d{1,18})?$/, 'offsets are signed decimal strings with at most 18 decimal places');

/** §5.1 order types. `take_profit` is mapped down by svc-trade before it reaches here. */
export const engineOrderTypeSchema = z.enum(['market', 'limit', 'stop', 'stop_limit']);

/** What a caller sends to place one order. */
export const matchingSubmitBodySchema = z.object({
  orderId: z.string().guid(),
  /** §5.1: account ids only. This service never learns whose account it is. */
  accountId: z.string().min(1).max(128),
  type: engineOrderTypeSchema,
  side: orderSideSchema,
  qty: decimal,
  price: decimal.nullish(),
  stopPrice: decimal.nullish(),
  /** Caller stop trigger. Same money as stopPrice. The engine does not invent one. */
  stopPx: decimal.nullish(),
  tif: timeInForceSchema,
  /** Linked TP+SL sibling. First fill cancels the other; refuse if that sibling is already terminal. */
  ocoSiblingId: z.string().guid().optional(),
  /** One-cancels-other exit pair: take-profit (limit) and stop-loss (stop). Missing a leg refuses; the engine does not invent one. */
  oco: z.boolean().optional(),
  takeProfit: decimal.nullish(),
  stopLoss: decimal.nullish(),
  /** Limit price of the stop-loss leg (a stop-limit instead of a market stop). Needed to bound a buy-side stop. */
  stopLossLimit: decimal.nullish(),
  /** Caller expire instant for GTD/GTT. The engine does not invent one. */
  expireAt: z.string().min(1).optional(),
  /** Caller session for cancel-on-disconnect. Missing is untagged — the engine does not invent one. */
  sessionId: z.string().max(128).optional(),
  /** Rest only if it shrinks this account's position. The engine does not invent a mark. */
  reduceOnly: z.boolean().optional(),
  /** Rest only if it would not take. The engine does not invent a price. */
  postOnly: z.boolean().optional(),
  iceberg: z.boolean().optional(),
  displayQty: decimal.optional(),
  /** Trail distance. Required to rest a trailing stop. The engine does not invent a distance. */
  trail: decimal.nullish(),
  /** Injected mark the trail walks with. The engine does not invent a mark. */
  mark: decimal.nullish(),
  /** Strike. Required to rest an option. The engine does not invent a strike. */
  strike: decimal.nullish(),
  /** Expiry. Required to rest an option. The engine does not invent an expiry. */
  expiry: z.string().nullish(),
  /** Minimum fill qty. Missing or zero is not set. The engine does not invent a default. */
  minQty: decimal.nullish(),
  /** All-or-none. Missing or false is a normal order. The engine does not invent a fill. */
  aon: z.boolean().optional(),
  /** Pegged to caller reference + offset. Missing those refuses. The engine does not invent a mid. */
  peg: z.boolean().optional(),
  /** Midpoint. Unsupported — refuses. The engine does not invent a mid. */
  midpoint: z.boolean().optional(),
  /** Relative to caller reference + offset. Missing those refuses. The engine does not invent a mid. */
  relative: z.boolean().optional(),
  /** Caller reference for peg/relative. The engine does not invent a mid. */
  reference: decimal.nullish(),
  /** Caller offset for peg/relative. Added to reference. Missing refuses. */
  offset: signedDecimal.nullish(),
  /** Auction. Unsupported — refuses. The engine does not invent an auction price. */
  auction: z.boolean().optional(),
  /** Benchmark. Unsupported — refuses. The engine does not invent a benchmark price. */
  benchmark: z.boolean().optional(),
  /** Price collar. Missing or false is a normal order. */
  collar: z.boolean().optional(),
  /** Caller collar min. Required when collar is true. The engine does not invent last or mid. */
  min: decimal.nullish(),
  /** Caller collar max. Required when collar is true. The engine does not invent last or mid. */
  max: decimal.nullish(),
  /** Caller min notional. Missing notional when requested refuses. The engine does not invent last. */
  minNotional: decimal.nullish(),
  /** Combo / multi-leg. Named legs with ratios required. The engine does not invent a combo book. */
  combo: z.boolean().optional(),
  /** Named combo legs. Missing when combo is requested refuses. Ratio is a signed ledger decimal. */
  legs: z
    .array(
      z.object({
        name: z.string().nullish(),
        ratio: signedDecimal.nullish(),
        strike: decimal.nullish(),
        expiry: z.string().nullish(),
      }),
    )
    .nullish(),
  /** PX-S01 evidence is mandatory at this private risk-increasing boundary. */
  lifecycleProof: marketLifecycleAdmissionProofSchema,
});

const matchingRejectedSchema = z.object({ code: z.string().min(1), message: z.string() });
const matchingFillSchema = z.object({
  sequence: z.number().int(),
  makerOrderId: z.string(),
  makerAccountId: z.string(),
  takerOrderId: z.string(),
  takerAccountId: z.string(),
  takerSide: orderSideSchema,
  /** On a spread book the spread price, which may be zero or negative. */
  price: signedDecimal,
  qty: decimal,
  /** Spread fills only: every leg's qty and price, in listing order. */
  legs: z.array(z.object({ symbol: z.string(), takerSide: orderSideSchema, qty: decimal, price: signedDecimal })).optional(),
});
const matchingRestingSchema = z
  .object({
    kind: z.enum(['book', 'stop']),
    orderId: z.string(),
    accountId: z.string(),
    side: orderSideSchema,
    price: signedDecimal,
    remaining: decimal,
    sequence: z.number().int(),
    version: z.number().int(),
  })
  .nullable();
const matchingCancellationSchema = z.object({
  orderId: z.string(),
  accountId: z.string(),
  remainingQty: decimal,
  sequence: z.number().int(),
  reason: z.string().min(1),
});

/** What svc-matching answers for one submit: accepted or rejected, the fills, where it rests, what it cancelled or fired. */
export const matchingSubmitReplySchema = z.object({
  accepted: z.boolean(),
  /** Assigned only on acceptance; a rejected order never touched the book. */
  sequence: z.number().int().nullable(),
  fills: z.array(matchingFillSchema),
  resting: matchingRestingSchema,
  rejected: matchingRejectedSchema.nullable(),
  cancellations: z.array(matchingCancellationSchema),
  triggered: z.array(
    z.object({
      orderId: z.string(),
      sequence: z.number().int().nullable(),
      fills: z.array(matchingFillSchema),
      resting: matchingRestingSchema,
      cancellations: z.array(matchingCancellationSchema),
      rejected: matchingRejectedSchema.nullable(),
    }),
  ),
});

export const MATCHING_SUBMIT_ORDER = defineProcedure({
  name: 'matching.orders.submit',
  service: 'svc-matching',
  transport: 'http',
  method: 'POST',
  path: '/markets/:marketId/orders',
  input: matchingSubmitBodySchema,
  output: matchingSubmitReplySchema,
});
