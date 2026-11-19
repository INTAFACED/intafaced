import { z } from 'zod';
import { defineProcedure } from '@intafaced/contracts/procedure';
import { marketLifecycleAdmissionProofSchema } from './market-lifecycle-admission-proof.js';
import { orderSideSchema, timeInForceSchema } from './schemas.js';

/**
 * svc-matching `POST /markets/:marketId/orders`: place one order on one book. Served by svc-matching, which parses the body
 * with this record's input, and sent by svc-trade, svc-execution and svc-fix, which build the body from this record's
 * input type and read the reply by its output. A caller with its own copy of the body can miss a required field, such as
 * the lifecycle proof, and every order it sends is refused.
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

/** A TEST order a desk would send: a limit buy with the lifecycle proof svc-trade attaches (its digest computed, not typed). */
const SAMPLE_PROOF_SNAPSHOT = {
  marketId: 'BTC-USDT',
  ruleVersion: 'test.rules.v1',
  instrumentId: 'BTC-USDT',
  instrumentVersion: 'test.instrument.v1',
  state: 'OPEN',
  reasonCategory: 'NORMAL',
  reasonCode: 'trade.lifecycle.ready',
  effectiveAt: '2026-08-25T16:00:00.000Z',
  observedAt: '2026-08-25T16:00:00.000Z',
  lastGoodState: 'OPEN',
  allowedActions: ['PLACE', 'PLACE_POST_ONLY'],
  transitionId: 'test.transition',
  evidenceRefs: ['test.evidence'],
};
const SAMPLE_ORDER = {
  orderId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  accountId: 'desk',
  type: 'limit',
  side: 'buy',
  qty: '10',
  price: '100',
  tif: 'GTC',
  lifecycleProof: {
    action: 'PLACE',
    decision: 'ELIGIBLE',
    checkedAt: '2026-08-25T16:00:00.000Z',
    snapshotId: 'trade.lifecycle.snapshot:a934c96f1d538289f94b67756c7c5595ff49f20b4523d478444eb4b18db92cba',
    transitionId: 'test.transition',
    evidenceRefs: ['test.evidence'],
    snapshot: SAMPLE_PROOF_SNAPSHOT,
  },
};

export const MATCHING_SUBMIT_ORDER = defineProcedure({
  name: 'matching.orders.submit',
  service: 'svc-matching',
  transport: 'http',
  method: 'POST',
  path: '/markets/:marketId/orders',
  params: z.object({ marketId: z.string() }),
  access: { caller: 'service', callers: ['svc-trade', 'svc-execution', 'svc-fix'] },
  /** Its refusals are 400 `{ code: 'BadRequest', issues }` with no machine code per cause, so none is listed by code yet. */
  refusals: {},
  accept: {
    'matching.proof_binds_snapshot': {
      at: 'input.lifecycleProof',
      says: "the proof's action is one the snapshot allows; its checkedAt, transitionId and evidenceRefs equal the snapshot's; its snapshotId is the SHA-256 of the snapshot as parsed",
    },
    'matching.snapshot_actions_fit_state': {
      at: 'input.lifecycleProof.snapshot',
      says: "the snapshot's allowed actions are unique and permitted by its state (none in a no-action state; only risk-reducing ones when halted)",
    },
    'exchange.spine_id_clean': {
      at: ['marketId', 'ruleVersion', 'instrumentId', 'instrumentVersion', 'reasonCode', 'transitionId', 'evidenceRefs[]'].map(
        (field) => `input.lifecycleProof.snapshot.${field}`,
      ),
      says: 'an identifier has no leading or trailing space and no control character',
    },
  },
  input: matchingSubmitBodySchema,
  output: matchingSubmitReplySchema,
  samples: [
    { verdict: 'accept', input: SAMPLE_ORDER },
    { verdict: 'accept', input: { ...SAMPLE_ORDER, type: 'market', price: null, tif: 'IOC' } },
    // A client order id where a GUID belongs, and no lifecycle proof.
    {
      verdict: 'refuse',
      input: { orderId: 'ORD-0001', accountId: 'acct-desk', type: 'limit', side: 'buy', qty: '1', price: '1', tif: 'GTC' },
    },
    { verdict: 'refuse', input: { ...SAMPLE_ORDER, qty: '-1' } },
    {
      verdict: 'refuse',
      input: { ...SAMPLE_ORDER, lifecycleProof: { ...SAMPLE_ORDER.lifecycleProof, checkedAt: '2026-08-25T16:00:01.000Z' } },
      by: 'matching.proof_binds_snapshot',
    },
    {
      verdict: 'refuse',
      input: {
        ...SAMPLE_ORDER,
        lifecycleProof: {
          ...SAMPLE_ORDER.lifecycleProof,
          snapshot: { ...SAMPLE_PROOF_SNAPSHOT, state: 'HALTED', allowedActions: ['PLACE'] },
        },
      },
      by: 'matching.snapshot_actions_fit_state',
    },
    {
      verdict: 'refuse',
      input: {
        ...SAMPLE_ORDER,
        lifecycleProof: { ...SAMPLE_ORDER.lifecycleProof, snapshot: { ...SAMPLE_PROOF_SNAPSHOT, reasonCode: ' trade.lifecycle.ready' } },
      },
      by: 'exchange.spine_id_clean',
    },
  ],
});
