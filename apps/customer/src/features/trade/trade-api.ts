import { tradeError, tradeRefusal, tradeCopy as copy } from './copy';
import { z } from 'zod';
import {
  orderBookSchema,
  tickerSchema,
  ohlcvSchema,
  tradeSchema,
  positionSchema,
  TIMEFRAMES,
  type Market,
  type Trade,
} from '@intafaced/exchange-contract/schemas';
import type { ApiClient, ApiResult } from '../../shared/api';
import { parseAmount, formatAmount } from '../../shared/money';
import { dailyHistoryWindow, deriveUtc8Daily, DailyHistoryError } from './daily-history';
import { listingSchema } from './listing';
import { planZonedDaily, deriveZonedDaily, ZonedDailyError } from './zoned-daily-history';

import {
  orderSchema,
  type Order,
  cancelAllAfterSchema,
  type CancelAllAfter,
  ledgerPageSchema,
  type LedgerPage,
  statementJobSchema,
  type StatementJob,
  statementFileSchema,
  type StatementFile,
  batchCancelSchema,
  type BatchCancel,
  previewSchema,
  type Preview,
  queuePositionSchema,
  type QueuePosition,
  orderChangesSchema,
  type OrderChange,
  amendmentSchema,
  replacementSchema,
  accountBalancesSchema,
} from '@intafaced/exchange-contract/customer-reads';
import { draftSchema, type Draft, previewBody, placeBody } from './order-draft';

export { listingSchema, type Listing } from './listing';
/** svc-trade's spot answers live once in exchange-contract, and the order draft in its own file; this file keeps the calls. */
export * from '@intafaced/exchange-contract/customer-reads';
export * from './order-draft';
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
/** The most lines one ledger page answers (the ledger's own page cap). */
export const LEDGER_PAGE_LIMIT = 200;

/** The most ids svc-trade takes in one batch cancel (its MAX_BATCH_ORDERS). */
export const BATCH_CANCEL_MAX = 100;
export function isTerminalOrder(order: Order) {
  return !order.recoveryRequired && ['closed', 'canceled', 'expired', 'rejected'].includes(order.status);
}
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
    // A stop-market names no price; the preview answers with the protection price the service will place it at.
    (draft.type === 'stop'
      ? preview.price !== null
      : draft.price
        ? preview.price !== null && parseAmount(draft.price) === parseAmount(preview.price)
        : preview.price === null) &&
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
    balances: (signal?: AbortSignal) => api.rest('/account/balance', accountBalancesSchema, { signal }),
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
    /** My place in the queue for one of my resting orders. A reply for another order is refused, never shown. */
    async queue(orderId: string, signal?: AbortSignal): Promise<ApiResult<QueuePosition>> {
      const result = await api.rest(`/orders/${encodeURIComponent(orderId)}/queue`, queuePositionSchema, { signal });
      return result.ok && result.data.orderId.toLowerCase() !== orderId.toLowerCase()
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
    /** The dead-man switch as it stands, and the published timeouts. */
    cancelAllAfter: (signal?: AbortSignal): Promise<ApiResult<CancelAllAfter>> =>
      api.rest('/orders/cancel-all-after', cancelAllAfterSchema, { signal }),
    /** Arm (or push out) the dead-man switch; 0 disarms. A reply that does not answer this timeout is refused. */
    async armCancelAllAfter(timeout: number): Promise<ApiResult<CancelAllAfter>> {
      const result = await api.rest('/orders/cancel-all-after', cancelAllAfterSchema, { method: 'POST', body: { timeout } });
      return result.ok && (result.data.timeout !== timeout || result.data.armed !== timeout > 0)
        ? tradeRefusal('theOrderResponseDoesNotIdentifyTheRequestedOriginalOrder', { reason: 'invalid_response' })
        : result;
    },
    /** One page of the person's balance changes, newest first. */
    ledger: (input: { limit: number; cursor?: string; code?: string }, signal?: AbortSignal): Promise<ApiResult<LedgerPage>> =>
      api.rest('/ledger', ledgerPageSchema, { signal, query: { limit: input.limit, cursor: input.cursor, code: input.code } }),
    /** Ask for a statement of [from, to); the same key answers the same job. A reply for another key or range is refused. */
    async requestStatement(input: { from: string; to: string; requestKey: string }): Promise<ApiResult<StatementJob>> {
      const result = await api.rest('/statements', statementJobSchema, { method: 'POST', body: input });
      return result.ok &&
        (result.data.requestKey !== input.requestKey ||
          Date.parse(result.data.from) !== Date.parse(input.from) ||
          Date.parse(result.data.to) !== Date.parse(input.to))
        ? tradeRefusal('theOrderResponseDoesNotIdentifyTheRequestedOriginalOrder', { reason: 'invalid_response' })
        : result;
    },
    statement: (id: string): Promise<ApiResult<StatementJob>> => api.rest(`/statements/${encodeURIComponent(id)}`, statementJobSchema),
    statementFile: (id: string): Promise<ApiResult<StatementFile>> =>
      api.rest(`/statements/${encodeURIComponent(id)}/file`, statementFileSchema, { query: { as: 'json' } }),
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
