import { tradeError, tradeRefusal, tradeCopy as copy } from './copy';
import { z } from 'zod';
import {
  marketSchema,
  orderSchema as contractOrderSchema,
  orderBookSchema,
  tickerSchema,
  ohlcvSchema,
  tradeSchema,
  balancesSchema,
  positionSchema,
  TIMEFRAMES,
  type Market,
  type Trade,
} from '@intafaced/exchange-contract/schemas';
import type { ApiClient, ApiResult } from '../../shared/api';
import { decimalSchema, parseAmount, formatAmount } from '../../shared/money';
import { dailyHistoryWindow, deriveUtc8Daily, DailyHistoryError } from './daily-history';
import { planZonedDaily, deriveZonedDaily, ZonedDailyError } from './zoned-daily-history';

const positive = decimalSchema.refine(
  (value) => parseAmount(value) > 0n,
  () => ({ message: copy.t('expectedAPositiveExactDecimalString') }),
);
export const listingSchema = marketSchema.extend({
  orderable: z.boolean(),
  precision: z.object({ price: positive, amount: positive }),
  taker: decimalSchema,
  maker: decimalSchema,
});
export type Listing = z.infer<typeof listingSchema>;
export const orderSchema = contractOrderSchema.extend({
  amount: positive,
  filled: decimalSchema,
  remaining: decimalSchema,
  price: positive.nullable(),
  cost: decimalSchema.nullable(),
  recoveryRequired: z.boolean(),
  recoveryReason: z.string().nullable(),
  reconciliationKey: z.string().nullable(),
});
export type Order = z.infer<typeof orderSchema>;
export type ReviewedOrder = Pick<Order, 'id' | 'symbol'>;
/** The order-history filters as the service reads them; each is sent only when set. */
export interface HistoryQuery {
  readonly limit: number;
  readonly side?: string;
  readonly status?: string;
  readonly type?: string;
  readonly since?: number;
  readonly until?: number;
  readonly before?: string;
}
/** The most fills one order's detail reads (the service's own ceiling for a fills read). */
export const ORDER_TRADES_LIMIT = 500;
/** One answer per id of a batch cancel, in the order sent: cancelled, refused with the service's reason, or unknown. */
export const batchCancelSchema = z.object({
  atomic: z.literal(false),
  results: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      orderId: z.string().nullable(),
      status: z.enum(['success', 'refused', 'unknown']),
      order: orderSchema.optional(),
      error: z
        .object({ code: z.string().optional(), message: z.string().optional(), intafacedCode: z.string().optional() })
        .passthrough()
        .optional(),
    }),
  ),
});
export type BatchCancel = z.infer<typeof batchCancelSchema>;
/** The most ids svc-trade takes in one batch cancel (its MAX_BATCH_ORDERS). */
export const BATCH_CANCEL_MAX = 100;
export function isTerminalOrder(order: Order) {
  return !order.recoveryRequired && ['closed', 'canceled', 'expired', 'rejected'].includes(order.status);
}
const exitLegFeeSchema = z.object({
  price: positive,
  feeRole: z.enum(['maker', 'taker']),
  feeBps: z.number().int().nonnegative(),
  estimatedFee: decimalSchema,
  feeAsset: z.string(),
});
export const previewSchema = z.object({
  symbol: z.string(),
  side: z.enum(['buy', 'sell']),
  type: z.enum(['market', 'limit', 'stop_limit']),
  amount: positive,
  price: positive.nullable(),
  stopPrice: positive.nullable().optional(),
  timeInForce: z.enum(['GTC', 'IOC', 'FOK', 'PO', 'GTD']),
  holdAsset: z.string().nullable(),
  holdAmount: decimalSchema.nullable(),
  protectionPrice: positive.nullable(),
  estimatedFee: decimalSchema.nullable(),
  feeAsset: z.string().nullable(),
  feeBps: z.number().int().nonnegative().nullable(),
  feeRole: z.enum(['maker', 'taker']).nullable(),
  orderable: z.boolean(),
  refusals: z.array(
    z.object({ code: z.string(), field: z.string(), message: z.string(), data: z.record(z.string(), z.string()).optional() }),
  ),
  /** The fee each linked exit leg would post if it filled. Absent or null when the draft has no exit legs. */
  exitFees: z
    .object({
      side: z.enum(['buy', 'sell']),
      takeProfit: exitLegFeeSchema,
      stopLoss: exitLegFeeSchema,
    })
    .nullable()
    .optional(),
});
export type Preview = z.infer<typeof previewSchema>;
export const draftSchema = z
  .object({
    symbol: z.string().min(3),
    side: z.enum(['buy', 'sell']),
    type: z.enum(['market', 'limit', 'stop_limit']),
    amount: positive,
    price: positive.optional(),
    stopPrice: positive.optional(),
    timeInForce: z.enum(['GTC', 'IOC', 'FOK', 'PO', 'GTD']),
    postOnly: z.boolean(),
    /** The instant a good-till-date order ends, as a UTC ISO string. Only a GTD order carries one. */
    expireAt: z.string().datetime().optional(),
    clientOrderId: z.string().min(1).max(64),
    /**
     * What happens if the order meets one of the person's own resting orders. The engine has one way: the resting order
     * is cancelled and this one carries on. The other modes are listed on the desk, disabled, and the service refuses them.
     */
    stpMode: z.literal('cancel_maker').optional(),
    /** The person's own label for the order (1 to 16 characters). Shown on the order; never part of its identity. */
    tag: z.string().min(1).max(16).optional(),
    /**
     * An OCO or a buy bracket. A bracket: the order above is its entry. A sell OCO: the order above is its take-profit leg.
     * A buy OCO: the order above is a limit buy at the stop-loss limit (where its one hold is sized); `stopLoss` is the trigger.
     */
    exit: z
      .object({ kind: z.enum(['oco', 'bracket']), takeProfit: positive, stopLoss: positive, stopLossLimit: positive.optional() })
      .optional(),
  })
  .superRefine((draft, ctx) => {
    if (draft.exit) {
      const { kind, takeProfit, stopLoss, stopLossLimit } = draft.exit;
      const bad = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: ['exit', path], message });
      const buyOco = kind === 'oco' && draft.side === 'buy';
      if (kind === 'oco' && (draft.type !== 'limit' || draft.timeInForce !== 'GTC' || draft.postOnly))
        bad('kind', copy.t('enterALimitPrice'));
      if (buyOco) {
        // The engine's order for a buy OCO: take-profit < stop trigger <= stop-loss limit, and the hold is sized at the limit.
        if (stopLossLimit === undefined) bad('stopLossLimit', copy.t('enterALimitPrice'));
        else {
          if (parseAmount(takeProfit) >= parseAmount(stopLoss) || parseAmount(stopLossLimit) < parseAmount(stopLoss))
            bad('takeProfit', copy.t('enterALimitPrice'));
          if (draft.price !== undefined && parseAmount(draft.price) !== parseAmount(stopLossLimit))
            bad('price', copy.t('enterALimitPrice'));
        }
      } else {
        if (parseAmount(takeProfit) <= parseAmount(stopLoss)) bad('takeProfit', copy.t('enterALimitPrice'));
        if (stopLossLimit !== undefined) bad('stopLossLimit', copy.t('enterALimitPrice'));
        if (kind === 'oco' && draft.price !== undefined && parseAmount(draft.price) !== parseAmount(takeProfit))
          bad('price', copy.t('enterALimitPrice'));
      }
      if (kind === 'bracket' && (draft.side !== 'buy' || draft.type === 'stop_limit' || draft.postOnly || draft.timeInForce === 'PO'))
        bad('kind', copy.t('enterALimitPrice'));
    }
    if (draft.type === 'stop_limit' && !draft.stopPrice)
      ctx.addIssue({ code: 'custom', path: ['stopPrice'], message: copy.t('enterALimitPrice') });
    if (draft.type !== 'stop_limit' && draft.stopPrice !== undefined)
      ctx.addIssue({ code: 'custom', path: ['stopPrice'], message: copy.t('enterALimitPrice') });
    if (draft.type !== 'market' && !draft.price) ctx.addIssue({ code: 'custom', path: ['price'], message: copy.t('enterALimitPrice') });
    if (draft.type === 'market' && draft.price !== undefined)
      ctx.addIssue({ code: 'custom', path: ['price'], message: copy.t('aMarketOrderCannotCarryALimitPrice') });
    if (draft.timeInForce === 'GTD' && (draft.type !== 'limit' || !draft.expireAt || draft.exit))
      ctx.addIssue({ code: 'custom', path: ['expireAt'], message: copy.t('aGoodTillDateLimitOrderNeedsAnExpiry') });
    if (draft.timeInForce !== 'GTD' && draft.expireAt !== undefined)
      ctx.addIssue({ code: 'custom', path: ['expireAt'], message: copy.t('aGoodTillDateLimitOrderNeedsAnExpiry') });
    if (draft.postOnly && (draft.type === 'market' || !['GTC', 'PO'].includes(draft.timeInForce)))
      ctx.addIssue({ code: 'custom', path: ['postOnly'], message: copy.t('postOnlyRequiresALimitOrderWithGtc') });
  });
export type Draft = z.infer<typeof draftSchema>;

/**
 * The advisory preview: the order itself, plus its exit legs so the service can price their fees. The service
 * names a bracket's exit `bracket_exit`; the prices ride as the decimal strings the person entered.
 */
export function previewBody(draft: Draft): Omit<Draft, 'exit' | 'stpMode' | 'tag'> & { exit?: Record<string, string> } {
  // The preview takes only what prices the order: a self-trade mode and a tag change neither, and it refuses unknown fields.
  const { exit, stpMode: _stpMode, tag: _tag, ...order } = draft;
  if (!exit) return order;
  const { kind, takeProfit, stopLoss, stopLossLimit } = exit;
  return {
    ...order,
    exit: { kind: kind === 'bracket' ? 'bracket_exit' : 'oco', takeProfit, stopLoss, ...(stopLossLimit ? { stopLossLimit } : {}) },
  };
}

/**
 * The create-order body: the order, plus `oco` or `bracket` with both exit prices as decimal strings. A bracket's exit
 * is placed by the service after the entry fills, for the base actually received.
 */
export function placeBody(draft: Draft): Record<string, unknown> {
  const { exit, ...order } = draft;
  if (!exit) return order;
  // A buy OCO's stop-loss leg is a stop-limit: its limit price rides beside its trigger.
  const legs = {
    takeProfit: { stopPrice: exit.takeProfit },
    stopLoss: { stopPrice: exit.stopLoss, ...(exit.stopLossLimit ? { price: exit.stopLossLimit } : {}) },
  };
  return exit.kind === 'oco' ? { ...order, oco: true, ...legs } : { ...order, bracket: true, ...legs };
}
/** One amend or replace of an order, as GET /orders/:id/amendments lists it (oldest first). */
export const orderChangeSchema = z.object({
  kind: z.enum(['amend', 'replace']),
  at: z.string(),
  quantity: decimalSchema.nullable(),
  price: decimalSchema.nullable(),
  version: z.string().nullable(),
  relatedOrderId: z.string().nullable(),
  direction: z.enum(['replaced_by', 'replaces']).nullable(),
});
export const orderChangesSchema = z.object({ orderId: z.string(), amendments: z.array(orderChangeSchema) });
export type OrderChange = z.infer<typeof orderChangeSchema>;

export const amendmentSchema = z.object({
  accepted: z.boolean(),
  idempotent: z.boolean(),
  code: z.string(),
  reasonCode: z.string().nullable(),
  reconciliationRequired: z.boolean(),
  path: z.string(),
  priority: z.enum(['retained', 'lost']).nullable(),
  orderId: z.string(),
  order: orderSchema,
});
export const replacementSchema = z.object({
  accepted: z.boolean(),
  idempotent: z.boolean(),
  code: z.string(),
  reasonCode: z.string().nullable(),
  reconciliationRequired: z.boolean(),
  path: z.literal('CANCEL_REPLACE'),
  originalOrderId: z.string(),
  originalState: z.string(),
  replacementOrderId: z.string().nullable(),
  replacementState: z.string().nullable(),
  original: orderSchema,
  replacement: orderSchema.nullable(),
});
type ChangedReview = { ok: false; reason: 'changed'; message: string; preview: Preview };
const historySchema = z.array(ohlcvSchema).superRefine((rows, ctx) => {
  const timestamps = new Set<number>();
  rows.forEach((row, index) => {
    try {
      const open = parseAmount(row[1]),
        high = parseAmount(row[2]),
        low = parseAmount(row[3]),
        close = parseAmount(row[4]),
        volume = parseAmount(row[5]);
      if (
        timestamps.has(row[0]) ||
        [open, high, low, close].some((value) => value <= 0n) ||
        volume < 0n ||
        high < low ||
        high < open ||
        high < close ||
        low > open ||
        low > close
      )
        throw new Error();
      timestamps.add(row[0]);
    } catch {
      ctx.addIssue({ code: 'custom', path: [index], message: copy.t('historyContainsADuplicateTimestampOrInvalidExactCandle') });
    }
  });
});
export { TIMEFRAMES, type Market };
const refused = (message: string): ApiResult<never> => ({ ok: false, reason: 'error', message });
function matchesPreview(draft: Draft, preview: Preview) {
  return (
    preview.symbol === draft.symbol &&
    preview.side === draft.side &&
    preview.type === draft.type &&
    (draft.stopPrice
      ? preview.stopPrice != null && parseAmount(draft.stopPrice) === parseAmount(preview.stopPrice)
      : preview.stopPrice == null) &&
    parseAmount(preview.amount) === parseAmount(draft.amount) &&
    (draft.price ? preview.price !== null && parseAmount(draft.price) === parseAmount(preview.price) : preview.price === null) &&
    preview.timeInForce === (draft.postOnly ? 'PO' : draft.timeInForce)
  );
}
export function createTradeApi(api: ApiClient, now: () => number = Date.now) {
  async function currentReview(draft: Draft, reviewed: Preview): Promise<ApiResult<Preview> | ChangedReview> {
    const result = await client.preview(draft);
    if (!result.ok) return result;
    if (
      !result.data.orderable ||
      result.data.refusals.length ||
      result.data.holdAmount === null ||
      result.data.holdAsset === null ||
      result.data.estimatedFee === null ||
      result.data.feeAsset === null
    )
      return result.data.refusals.map((row) => row.message).join(' ')
        ? refused(result.data.refusals.map((row) => row.message).join(' '))
        : tradeRefusal('feeOrReservationIsUnavailablePlacementIsDisabled', { reason: 'error' });
    if (JSON.stringify(result.data) !== JSON.stringify(reviewed))
      return tradeRefusal('feePriceProtectionOrReservationChangedReviewTheRefreshedValues', { reason: 'changed', preview: result.data });
    return result;
  }
  const client = {
    markets: (signal?: AbortSignal) => api.rest('/markets', z.array(listingSchema), { query: { limit: 500 }, signal }),
    book: async (symbol: string, signal?: AbortSignal) => {
      const result = await api.rest(`/orderbook/${encodeURIComponent(symbol)}`, orderBookSchema, { query: { limit: 200 }, signal });
      return result.ok && result.data.symbol !== symbol
        ? tradeRefusal('theOrderBookBelongsToAnotherMarket', { reason: 'invalid_response' })
        : result;
    },
    ticker: async (symbol: string, signal?: AbortSignal) => {
      const result = await api.rest(`/ticker/${encodeURIComponent(symbol)}`, tickerSchema, { signal });
      return result.ok && result.data.symbol !== symbol
        ? tradeRefusal('theTickerBelongsToAnotherMarket', { reason: 'invalid_response' })
        : result;
    },
    history: (symbol: string, timeframe: string, signal?: AbortSignal, since?: number) =>
      api.rest(`/ohlcv/${encodeURIComponent(symbol)}`, historySchema, { query: { timeframe, limit: 500, since }, signal }),
    dailyHistory: async (symbol: string, signal?: AbortSignal) => {
      try {
        const window = dailyHistoryWindow(now());
        const result = await client.history(symbol, '1h', signal, window.sinceMs);
        if (!result.ok) return result;
        return { ok: true as const, data: deriveUtc8Daily(result.data, window, now()) };
      } catch (error) {
        return tradeRefusal(
          error instanceof DailyHistoryError && error.code === 'invalid_clock_window'
            ? 'dailyHistoryClockWindowInvalid'
            : 'dailyHistoryHourlySourceInvalid',
          { reason: 'invalid_response' as const },
        );
      }
    },
    zonedDailyHistory: async (symbol: string, zone: string, signal?: AbortSignal) => {
      try {
        const plan = planZonedDaily(zone, now());
        const result = await client.history(symbol, plan.sourceInterval, signal, plan.sinceMs);
        if (!result.ok) return result;
        return { ok: true as const, data: deriveZonedDaily(result.data, plan, now()) };
      } catch (error) {
        const code = error instanceof ZonedDailyError ? error.code : 'invalid_source_history';
        return tradeRefusal(
          code === 'invalid_zone'
            ? 'dailyZoneInvalid'
            : code === 'unrepresentable_boundary'
              ? 'dailyZoneBoundaryUnavailable'
              : code === 'invalid_clock_window'
                ? 'dailyHistoryClockWindowInvalid'
                : 'dailyZoneSourceInvalid',
          { reason: 'invalid_response' as const },
        );
      }
    },
    tape: async (symbol: string, signal?: AbortSignal) => {
      const result = await api.rest(`/trades/${encodeURIComponent(symbol)}`, z.array(tradeSchema), { query: { limit: 40 }, signal });
      return result.ok && result.data.some((row) => row.symbol !== symbol)
        ? tradeRefusal('thePublicTradesBelongToAnotherMarket', { reason: 'invalid_response' })
        : result;
    },
    balances: (signal?: AbortSignal) =>
      api.rest(
        '/account/balance',
        balancesSchema.extend({ balances: z.record(z.object({ free: decimalSchema, used: decimalSchema, total: decimalSchema })) }),
        { signal },
      ),
    orders: (kind: 'open' | 'closed', symbol?: string, limit = 100, signal?: AbortSignal, since?: number) =>
      api.rest(`/orders/${kind}`, z.array(orderSchema), { query: { symbol, limit, since }, signal }),
    /**
     * One page of order history, newest first, with the service doing the filtering. `before` is the previous page's
     * last order. The filter values go as written: the service, not this client, refuses one it does not know.
     */
    orderHistory: (query: HistoryQuery, signal?: AbortSignal) =>
      api.rest('/orders/closed', z.array(orderSchema), {
        query: {
          limit: query.limit,
          side: query.side,
          status: query.status,
          type: query.type,
          since: query.since,
          until: query.until,
          before: query.before,
        },
        signal,
      }),
    /** One order by id. A reply for another order is refused, never shown. */
    async orderById(id: string, signal?: AbortSignal): Promise<ApiResult<Order>> {
      const result = await api.rest(`/orders/${encodeURIComponent(id)}`, orderSchema, { signal });
      return result.ok && result.data.id.toLowerCase() !== id.toLowerCase()
        ? tradeRefusal('theOrderResponseDoesNotIdentifyTheRequestedOriginalOrder', { reason: 'invalid_response' })
        : result;
    },
    /** One order's fills, oldest first. A fill of another order is refused, never shown. */
    async orderTrades(id: string, signal?: AbortSignal): Promise<ApiResult<Trade[]>> {
      const result = await api.rest(`/orders/${encodeURIComponent(id)}/trades`, z.array(tradeSchema), {
        query: { limit: ORDER_TRADES_LIMIT },
        signal,
      });
      return result.ok && result.data.some((fill) => fill.order?.toLowerCase() !== id.toLowerCase())
        ? tradeRefusal('theOrderResponseDoesNotIdentifyTheRequestedOriginalOrder', { reason: 'invalid_response' })
        : result;
    },
    fills: (symbol?: string, limit = 100, signal?: AbortSignal, since?: number) =>
      api.rest('/account/trades', z.array(tradeSchema), { query: { symbol, limit, since }, signal }),
    positions: (symbol?: string, signal?: AbortSignal) => api.rest('/positions', z.array(positionSchema), { query: { symbol }, signal }),
    async order(reviewed: ReviewedOrder): Promise<ApiResult<Order>> {
      const { id, symbol } = reviewed;
      const result = await api.rest(`/orders/${encodeURIComponent(id)}`, orderSchema);
      return result.ok && (result.data.id !== id || result.data.symbol !== symbol)
        ? tradeRefusal('theOrderResponseDoesNotIdentifyTheRequestedOriginalOrder', { reason: 'invalid_response' })
        : result;
    },
    /** Every amend and replace of one order, oldest first. A reply for another order is refused, never shown. */
    async changes(orderId: string, signal?: AbortSignal): Promise<ApiResult<OrderChange[]>> {
      const result = await api.rest(`/orders/${encodeURIComponent(orderId)}/amendments`, orderChangesSchema, { signal });
      if (!result.ok) return result;
      return result.data.orderId === orderId
        ? { ...result, data: result.data.amendments }
        : tradeRefusal('theOrderResponseDoesNotIdentifyTheRequestedOriginalOrder', { reason: 'invalid_response' });
    },
    async cancel(reviewed: ReviewedOrder): Promise<ApiResult<Order>> {
      const { id, symbol } = reviewed;
      const result = await api.rest(`/orders/${encodeURIComponent(id)}`, orderSchema, { method: 'DELETE' });
      if (result.ok && (result.data.id !== id || result.data.symbol !== symbol || !isTerminalOrder(result.data)))
        return tradeRefusal('cancellationDoesNotConfirmTheOriginalOrderSTerminalOutcomeCheck', { reason: 'uncertain' });
      return result;
    },
    /** Cancel every open order in one market (DELETE /orders?symbol=). The reply lists the orders it cancelled. */
    cancelAll: (symbol: string): Promise<ApiResult<Order[]>> =>
      // Without a symbol the service would cancel every market, so an empty one is never sent.
      symbol.trim() === ''
        ? Promise.resolve({ ok: false as const, reason: 'error' as const, message: 'symbol is required' })
        : api.rest('/orders', z.array(orderSchema), { method: 'DELETE', query: { symbol } }),
    /** Cancel every open order in every market (DELETE /orders with no symbol). The reply lists the orders it cancelled. */
    cancelAllMarkets: (): Promise<ApiResult<Order[]>> => api.rest('/orders', z.array(orderSchema), { method: 'DELETE' }),
    /** Cancel every open order in every spot market, and none of another product's (DELETE /orders?kind=spot). */
    cancelAllSpot: (): Promise<ApiResult<Order[]>> =>
      api.rest('/orders', z.array(orderSchema), { method: 'DELETE', query: { kind: 'spot' } }),
    /** Cancel these orders by id in one request (POST /orders/batch-cancel). A reply that does not answer each id, in order, is refused. */
    async cancelBatch(ids: readonly string[]): Promise<ApiResult<BatchCancel>> {
      if (ids.length === 0) return { ok: false as const, reason: 'error' as const, message: 'no orders chosen' };
      // The service answers at most this many ids in one request; more is refused before anything is sent.
      if (ids.length > BATCH_CANCEL_MAX)
        return { ok: false as const, reason: 'error' as const, code: 'trade.batch_too_large', message: 'too many orders' };
      const result = await api.rest('/orders/batch-cancel', batchCancelSchema, { method: 'POST', body: { ids } });
      if (
        result.ok &&
        (result.data.results.length !== ids.length || result.data.results.some((row, i) => row.index !== i || row.orderId !== ids[i]))
      )
        return tradeRefusal('cancellationDoesNotConfirmTheOriginalOrderSTerminalOutcomeCheck', { reason: 'uncertain' });
      return result;
    },
    async amend(reviewed: ReviewedOrder, amount: string): Promise<ApiResult<z.infer<typeof amendmentSchema>>> {
      const { id, symbol } = reviewed;
      const result = await api.rest(`/orders/${encodeURIComponent(id)}`, amendmentSchema, { method: 'PATCH', body: { qty: amount } });
      if (result.ok && (result.data.orderId !== id || result.data.order.id !== id || result.data.order.symbol !== symbol))
        return tradeRefusal('theAmendmentResponseDoesNotIdentifyTheOriginalOrderCheckIts', { reason: 'uncertain' });
      if (result.ok && (result.data.reconciliationRequired || result.data.order.recoveryRequired))
        return tradeRefusal('theOriginalAmendmentIsStillRecoveringCheckItsOriginalStatusBefore', { reason: 'uncertain' });
      return result;
    },
    async preview(input: Draft): Promise<ApiResult<Preview>> {
      const draft = draftSchema.safeParse(input);
      if (!draft.success) return refused(draft.error.issues.map((row) => row.message).join(' '));
      const result = await api.rest('/orders/preview', previewSchema, { method: 'POST', body: previewBody(draft.data) });
      if (!result.ok && result.reason === 'uncertain')
        return tradeRefusal('orderPreviewCouldNotBeVerifiedNoOrderWasSent', { reason: 'invalid_response' });
      return result.ok && !matchesPreview(draft.data, result.data)
        ? tradeRefusal('thePreviewDoesNotMatchThisOrderReviewAgain', { reason: 'invalid_response' })
        : result;
    },
    async place(
      draft: Draft,
      reviewed: Preview,
      canDispatch: (preview: Preview) => boolean = () => true,
    ): Promise<ApiResult<Order> | ChangedReview> {
      const result = await currentReview(draft, reviewed);
      if (!result.ok) return result;
      if (!canDispatch(result.data)) return tradeRefusal('tradingContextChangedBeforePlacementNoOrderWasSent', { reason: 'aborted' });
      const placed = await api.rest('/orders', orderSchema, { method: 'POST', body: placeBody(draft) });
      if (placed.ok && (placed.data.symbol !== draft.symbol || placed.data.clientOrderId !== draft.clientOrderId))
        return tradeRefusal('thePlacementResponseDoesNotIdentifyThisRequestReconcileTheOriginal', { reason: 'uncertain' });
      if (placed.ok && placed.data.recoveryRequired)
        return tradeRefusal('placementRequiresReconciliationHoldsRemainReserved', { reason: 'uncertain' }, () => [
          {
            placedDataRecoveryReasonOutcome: String(placed.data.recoveryReason ?? copy.t('unknownOutcome')),
          },
        ]);
      return placed;
    },
    /** The same create-order request again, on the person's click (same `clientOrderId`): the service never makes a second order. */
    resend: (draft: Draft): Promise<ApiResult<Order>> => api.rest('/orders', orderSchema, { method: 'POST', body: placeBody(draft) }),
    async replace(
      original: ReviewedOrder,
      draft: Draft,
      reviewed: Preview,
      canDispatch: (preview: Preview) => boolean = () => true,
    ): Promise<ApiResult<z.infer<typeof replacementSchema>> | ChangedReview> {
      const { id, symbol } = original;
      if (draft.symbol !== symbol) return tradeRefusal('replacementMarketMismatch', { reason: 'error' });
      const result = await currentReview(draft, reviewed);
      if (!result.ok) return result;
      if (!canDispatch(result.data))
        return tradeRefusal('tradingContextChangedBeforeReplacementNoCancelReplaceWasSent', { reason: 'aborted' });
      const replaced = await api.rest(`/orders/${encodeURIComponent(id)}/replace`, replacementSchema, { method: 'POST', body: draft });
      // The service cancels the original before it places the replacement, so any refusal after the request went out may
      // come after the original is gone: it is never reported as "nothing changed".
      if (!replaced.ok) return { ...replaced, reason: 'uncertain' as const };
      if (
        replaced.ok &&
        (replaced.data.originalOrderId !== id ||
          replaced.data.original.id !== id ||
          replaced.data.original.symbol !== symbol ||
          replaced.data.replacementOrderId !== (replaced.data.replacement?.id ?? null) ||
          (replaced.data.accepted && !isTerminalOrder(replaced.data.original)) ||
          (replaced.data.replacement &&
            (replaced.data.replacement.symbol !== draft.symbol || replaced.data.replacement.clientOrderId !== draft.clientOrderId)))
      )
        return tradeRefusal('theResponseDoesNotIdentifyThisReplacementReconcileItsOriginalRequest', { reason: 'uncertain' });
      if (
        replaced.ok &&
        (replaced.data.reconciliationRequired || replaced.data.original.recoveryRequired || replaced.data.replacement?.recoveryRequired)
      )
        return tradeRefusal(
          'cancelReplaceRequiresReconciliationOriginalAndReplacementFundsRemainAsReported',
          { reason: 'uncertain' },
          {
            replacedDataReasonCodeReplaced: String(replaced.data.reasonCode ?? replaced.data.code),
          },
        );
      return replaced;
    },
    async reconcile(clientOrderId: string, symbol: string, accountWide = false): Promise<ApiResult<Order>> {
      const scope = accountWide ? undefined : symbol;
      const results = await Promise.all([client.orders('open', scope, 500), client.orders('closed', scope, 500)]);
      for (const result of results) {
        if (!result.ok) return result;
        const found = result.data.find((order) => order.clientOrderId === clientOrderId && order.symbol === symbol);
        if (found)
          return found.recoveryRequired
            ? tradeRefusal('originalRequestIsStillRecovering', { reason: 'uncertain' }, () => [
                {
                  foundRecoveryReasonOutcomeUnknown: String(found.recoveryReason ?? copy.t('unknownOutcome')),
                },
              ])
            : { ok: true, data: found };
      }
      return tradeRefusal('theRequestWasNotFoundInTheReturnedOrderPagesIts', { reason: 'uncertain' });
    },
  };
  return client;
}
export type TradeApi = ReturnType<typeof createTradeApi>;
export function exactValue(price: string, amount: string) {
  return formatAmount((parseAmount(price) * parseAmount(amount)) / parseAmount('1'));
}
export function baseQuantityForValue(value: string, price: string, lot: string) {
  const quoted = parseAmount(value),
    reference = parseAmount(price),
    step = parseAmount(lot);
  if (quoted <= 0n || reference <= 0n || step <= 0n) throw tradeError('enterAPositiveValueAndLimitPrice');
  const quantity = ((quoted * parseAmount('1')) / reference / step) * step;
  if (quantity <= 0n) throw tradeError('thisValueCannotBuyOneWholePublishedLot');
  return formatAmount(quantity);
}
export function portionInLots(available: string, percent: bigint, lot: string) {
  const step = parseAmount(lot);
  if (step <= 0n) return null;
  return formatAmount(((parseAmount(available) * percent) / 100n / step) * step);
}
