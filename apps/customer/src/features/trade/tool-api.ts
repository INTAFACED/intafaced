import { z } from 'zod';
import { positionSchema } from '@intafaced/exchange-contract/schemas';
import { decimalSchema } from '../../shared/money';
import type { ApiClient } from '../../shared/api';

const side = z.enum(['buy', 'sell']);
const source = z.object({ kind: z.literal('book'), symbol: z.string(), asOf: z.string() });
export const convertQuoteSchema = z.object({
  quoteId: z.string(),
  symbol: z.string(),
  side,
  requestedQty: decimalSchema,
  filledQty: decimalSchema,
  bookNotional: decimalSchema,
  userNotional: decimalSchema,
  avgPrice: decimalSchema,
  fullyFilled: z.boolean(),
  convertSpreadBps: z.number().int(),
  expiresAt: z.string(),
  source,
  inAsset: z.string(),
  outAsset: z.string(),
  inAmount: decimalSchema,
  outAmount: decimalSchema,
});
export const convertTradeSchema = z.object({
  quoteId: z.string(),
  fillId: z.string(),
  takerOrderId: z.string(),
  makerOrderId: z.string(),
  symbol: z.string(),
  side,
  inAsset: z.string(),
  outAsset: z.string(),
  inAmount: decimalSchema,
  outAmount: decimalSchema,
  fillPrice: decimalSchema,
  fillNotional: decimalSchema,
  convertSpreadBps: z.number().int(),
  source,
  expiresAt: z.string(),
  acceptedAt: z.string(),
  settledAt: z.string(),
});
export const algoSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  side,
  kind: z.enum(['twap', 'vwap', 'pov']),
  totalQty: decimalSchema,
  durationMs: z.number().int(),
  sliceIntervalMs: z.number().int(),
  limitPrice: decimalSchema.nullable(),
  status: z.enum(['active', 'paused', 'cancelled', 'completed', 'halted']),
  slicesPlanned: z.number().int(),
  nextSliceIndex: z.number().int(),
  childrenEmitted: z.number().int(),
  missesRecorded: z.number().int(),
  haltReason: z.string().nullable(),
  createdAt: z.string(),
  projectedEndsAt: z.string(),
});
export const algoProgressSchema = z.object({
  parentId: z.string(),
  status: z.enum(['active', 'paused', 'cancelled', 'completed', 'halted']),
  haltReason: z.string().nullable(),
  childrenEmitted: z.number().int(),
  missesRecorded: z.number().int(),
  slicesPlanned: z.number().int(),
  nextSliceIndex: z.number().int(),
  filledQty: decimalSchema,
  totalQty: decimalSchema,
});
export const copyFollowSchema = z.object({
  followId: z.string(),
  // A listed leader is named by its public ref only; the service sends no user id for it.
  leaderId: z.string().nullable(),
  leaderRef: z.string().nullable().optional(),
  permittedMarkets: z.array(z.string()),
  maxNotionalPerOrder: decimalSchema,
  maxAggregateExposure: decimalSchema,
  fixedOrderSize: decimalSchema.nullable().optional(),
  /** What this follow may use of the spot balance. A limit, not a hold: nothing moved when it was set. */
  reserve: z.object({ asset: z.string(), amount: decimalSchema, released: z.boolean() }).nullable().optional(),
  maxLoss: decimalSchema.nullable(),
  currentExposure: decimalSchema,
  remainingExposure: decimalSchema,
  expiresAt: z.string(),
  region: z.string(),
  feeShareKilled: z.boolean(),
  sessionKeyGranted: z.boolean(),
  sessionKeyRevoked: z.boolean(),
  relationshipState: z.string(),
  newIntentFenced: z.boolean(),
  createdAt: z.string().optional(),
});
export const copyStatusSchema = z.object({
  feeSharePublished: z.boolean(),
  leaderShareBps: z.string().nullable(),
  jurisdictionPublished: z.boolean(),
  statusLine: z.string(),
  residual: z.string().nullable().optional(),
  autoMirrorPlace: z.object({ published: z.boolean(), residual: z.string().nullable() }).optional(),
});
export const otcStatusSchema = z.object({ published: z.boolean(), statusLine: z.string(), residual: z.string().nullable().optional() });
/** `otc.makers.list` (CB-otc-01): the owner's provider list and pick cap, or the honest empty state. */
export const otcMakersSchema = z.object({
  published: z.boolean(),
  makers: z.array(z.object({ id: z.string(), name: z.string(), route: z.enum(['platform', 'outside']) })),
  selectCap: z.number().nullable(),
  emptyLabel: z.string().nullable(),
});
export const otcQuoteSchema = z.object({
  quoteId: z.string(),
  side,
  baseAsset: z.string(),
  quoteAsset: z.string(),
  qty: decimalSchema,
  midPrice: decimalSchema,
  quotedPrice: decimalSchema,
  midNotional: decimalSchema,
  userNotional: decimalSchema,
  spreadBps: z.number().int(),
  spreadNotional: decimalSchema,
  counterparty: z.string(),
  counterpartyId: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  status: z.string(),
  lifecycle: z.string().optional(),
  acceptedAt: z.string().nullable().optional(),
  fillPrice: decimalSchema.nullable().optional(),
  /** Deferred-settle deadline of an accepted quote; null when the owner window is blank. */
  settleBy: z.string().nullable().optional(),
  settleWindowMs: z.number().int().nullable().optional(),
});
export const otcFillSchema = z.object({
  quoteId: z.string(),
  side,
  baseAsset: z.string(),
  quoteAsset: z.string(),
  qty: decimalSchema,
  fillPrice: decimalSchema,
  fillNotional: decimalSchema,
  spreadBps: z.number().int(),
  counterparty: z.string(),
  counterpartyId: z.string(),
  acceptedAt: z.string(),
});
export const positionPreviewSchema = z.object({
  symbol: z.string(),
  side: z.enum(['long', 'short']),
  size: decimalSchema,
  leverage: decimalSchema,
  marginMode: z.literal('isolated'),
  markPrice: decimalSchema.nullable(),
  markSource: z.unknown().nullable(),
  leverageCap: decimalSchema.nullable(),
  orderValue: decimalSchema.nullable(),
  initialMargin: decimalSchema.nullable(),
  estimatedFee: decimalSchema.nullable(),
  liquidationPrice: decimalSchema.nullable(),
  /** The size and price controls the order path applies (D-orders-06). Optional: older answers carry none of them. */
  type: z.enum(['market', 'limit']).optional(),
  /**
   * The band in force: the owner's static band, or wider while the operator's dynamic range has widened it
   * (D-instruments-08). The fields after `high` are optional: older answers carry none of them.
   */
  band: z
    .object({
      fraction: decimalSchema,
      low: decimalSchema,
      high: decimalSchema,
      staticFraction: decimalSchema.optional(),
      source: z.enum(['static', 'dynamic']).optional(),
      reason: z.string().optional(),
      max: decimalSchema.nullable().optional(),
      premium: decimalSchema.nullable().optional(),
      changedAt: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  slippageCapBps: z.number().int().nullable().optional(),
  orderPrice: decimalSchema.nullable().optional(),
  priceCorrection: z.object({ asked: decimalSchema, applied: decimalSchema }).nullable().optional(),
  maxOrderNotional: decimalSchema.nullable().optional(),
  split: z
    .object({ parts: z.number().int(), sizes: z.array(decimalSchema) })
    .nullable()
    .optional(),
  /** The margin tier the order carries its side into (D-orders-10); `confirmRequired` asks for `confirmTier`. */
  riskTier: z
    .object({
      current: z.number().int().nullable(),
      projected: z.number().int(),
      maintenanceBps: z.number().int(),
      maintenanceRate: decimalSchema,
      notional: decimalSchema,
      confirmRequired: z.boolean(),
    })
    .nullable()
    .optional(),
  /** The market's open-interest limits and the room this account has left (D-margin-05), in the base asset. */
  openInterest: z
    .object({
      limit: decimalSchema,
      shareBps: z.number().int(),
      accountCap: decimalSchema,
      accountCommitted: decimalSchema,
      marketCommitted: decimalSchema,
      room: decimalSchema,
      binding: z.enum(['account', 'market']),
    })
    .nullable()
    .optional(),
  orderable: z.boolean(),
  refusals: z.array(z.object({ code: z.string(), field: z.string(), message: z.string() })),
});
/** One stored convert quote as `convert.list` reads it. A quote that was never accepted shows as `quoted` or `expired`. */
export const convertHistoryRowSchema = z.object({
  quoteId: z.string(),
  inAsset: z.string(),
  outAsset: z.string(),
  inAmount: decimalSchema,
  outAmount: decimalSchema,
  lifecycle: z.enum(['quoted', 'accepted', 'settled', 'refused', 'expired', 'unknown']),
  createdAt: z.string(),
  expiresAt: z.string(),
  acceptedAt: z.string().nullable(),
  settledAt: z.string().nullable(),
});
export type ConvertHistoryRow = z.infer<typeof convertHistoryRowSchema>;
export const convertHistorySchema = z.object({ rows: z.array(convertHistoryRowSchema), nextCursor: z.string().nullable() });

/**
 * `convert.quote` takes exactly one size: a base amount (`qty`, buy or sell) or a spend in the quote asset
 * (`quoteQty`, buy only; the service never charges more than it). The union makes sending both, or neither, a type error.
 */
export type ConvertQuoteInput =
  { symbol: string; side: 'buy' | 'sell'; qty: string; quoteQty?: never } | { symbol: string; side: 'buy'; quoteQty: string; qty?: never };

export function createToolApi(api: ApiClient) {
  return {
    convertQuote: (input: ConvertQuoteInput) => api.query('trade', 'convert.quote', input, convertQuoteSchema),
    /** The service refuses without a window (92 days at most) and a limit, so the caller always names both. */
    convertList: (input: { from: string; to: string; limit: number; cursor?: string }, signal?: AbortSignal) =>
      api.query('trade', 'convert.list', input, convertHistorySchema, { signal }),
    convertAccept: (quoteId: string, clientConvertId: string) =>
      api.mutate('trade', 'convert.accept', { quoteId, clientConvertId }, convertTradeSchema),
    algoGet: (algoId: string, signal?: AbortSignal) => api.query('trade', 'algo.get', { algoId }, algoSchema, { signal }),
    algoProgress: (algoId: string, signal?: AbortSignal) => api.query('trade', 'algo.progress', { algoId }, algoProgressSchema, { signal }),
    algoAction: (action: 'pause' | 'resume' | 'cancel', algoId: string) => api.mutate('trade', `algo.${action}`, { algoId }, algoSchema),
    copyStatus: (signal?: AbortSignal) => api.query('trade', 'copy.deskStatus', undefined, copyStatusSchema, { signal }),
    copyFollows: (signal?: AbortSignal) => api.query('trade', 'copy.listMyFollows', { limit: 100 }, z.array(copyFollowSchema), { signal }),
    copyAction: (action: 'pause' | 'stop' | 'detach' | 'resume', followId: string) =>
      api.mutate(
        'trade',
        `copy.${action}`,
        { followId },
        z.object({ followId: z.string(), relationshipState: z.string(), newIntentFenced: z.boolean(), disposition: z.string() }),
      ),
    otcStatus: (signal?: AbortSignal) => api.query('trade', 'otc.deskStatus', undefined, otcStatusSchema, { signal }),
    otcMakers: (signal?: AbortSignal) => api.query('trade', 'otc.makers.list', undefined, otcMakersSchema, { signal }),
    otcQuote: (input: { side: 'buy' | 'sell'; baseAsset: string; quoteAsset: string; qty: string; makerIds: string[] }) =>
      api.mutate('trade', 'rfq.quote', input, otcQuoteSchema),
    otcGet: (quoteId: string) => api.query('trade', 'rfq.get', { quoteId }, otcQuoteSchema),
    otcAccept: (quoteId: string, assertedPrice: string) => api.mutate('trade', 'otc.accept', { quoteId, assertedPrice }, otcFillSchema),
    otcSettle: (quoteId: string) =>
      api.mutate(
        'trade',
        'otc.settle',
        { quoteId },
        otcFillSchema.extend({ fillId: z.string(), takerOrderId: z.string(), makerOrderId: z.string() }),
      ),
    positionPreview: (input: { symbol: string; side: 'long' | 'short'; size: string; leverage: string; marginMode: 'isolated' }) =>
      api.rest('/positions/preview', positionPreviewSchema, { method: 'POST', body: input }),
    position: (id: string) => api.rest(`/positions/${encodeURIComponent(id)}`, positionSchema),
    positionClose: (id: string, input: { quantity: string; clientCloseId: string }) =>
      api.rest(`/positions/${encodeURIComponent(id)}/close`, positionSchema, {
        method: 'POST',
        body: { quantity: input.quantity, clientCloseId: input.clientCloseId },
      }),
    positionHistory: (signal?: AbortSignal) => api.rest('/positions/closed', z.array(positionSchema), { query: { limit: 100 }, signal }),
    disclosure: (signal?: AbortSignal) =>
      api.rest('/futures/adl-disclosure', z.object({ version: z.string(), copy: z.string(), acknowledged: z.boolean() }), { signal }),
    executionSpine: (signal?: AbortSignal) =>
      api.query(
        'execution',
        'execution.spine',
        undefined,
        z.object({
          doors: z.array(z.object({ id: z.string(), module: z.string(), kind: z.string(), callerSubmit: z.boolean() })),
          externalOnly: z.boolean(),
          houseInternalRefuse: z.boolean(),
        }),
        { signal },
      ),
  };
}
export type ToolApi = ReturnType<typeof createToolApi>;
