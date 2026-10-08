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
} from '@intafaced/exchange-contract/schemas';
import type { ApiClient, ApiResult } from '../../shared/api';
import { decimalSchema, parseAmount, formatAmount } from '../../shared/money';

const positive = decimalSchema.refine((value) => parseAmount(value) > 0n, 'Expected a positive exact decimal string');
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
export function isTerminalOrder(order: Order) {
  return !order.recoveryRequired && ['closed', 'canceled', 'expired', 'rejected'].includes(order.status);
}
export const previewSchema = z.object({
  symbol: z.string(),
  side: z.enum(['buy', 'sell']),
  type: z.enum(['market', 'limit']),
  amount: positive,
  price: positive.nullable(),
  timeInForce: z.enum(['GTC', 'IOC', 'FOK', 'PO']),
  holdAsset: z.string().nullable(),
  holdAmount: decimalSchema.nullable(),
  protectionPrice: positive.nullable(),
  estimatedFee: decimalSchema.nullable(),
  feeAsset: z.string().nullable(),
  feeBps: z.number().int().nonnegative().nullable(),
  feeRole: z.enum(['maker', 'taker']).nullable(),
  orderable: z.boolean(),
  refusals: z.array(z.object({ code: z.string(), field: z.string(), message: z.string() })),
});
export type Preview = z.infer<typeof previewSchema>;
export const draftSchema = z
  .object({
    symbol: z.string().min(3),
    side: z.enum(['buy', 'sell']),
    type: z.enum(['market', 'limit']),
    amount: positive,
    price: positive.optional(),
    timeInForce: z.enum(['GTC', 'IOC', 'FOK', 'PO']),
    postOnly: z.boolean(),
    clientOrderId: z.string().min(1).max(64),
  })
  .superRefine((draft, ctx) => {
    if (draft.type === 'limit' && !draft.price) ctx.addIssue({ code: 'custom', path: ['price'], message: 'Enter a limit price.' });
    if (draft.type === 'market' && draft.price !== undefined)
      ctx.addIssue({ code: 'custom', path: ['price'], message: 'A market order cannot carry a limit price.' });
    if (draft.postOnly && (draft.type !== 'limit' || !['GTC', 'PO'].includes(draft.timeInForce)))
      ctx.addIssue({ code: 'custom', path: ['postOnly'], message: 'Post only requires a limit order with GTC.' });
  });
export type Draft = z.infer<typeof draftSchema>;
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
      ctx.addIssue({ code: 'custom', path: [index], message: 'History contains a duplicate timestamp or invalid exact candle.' });
    }
  });
});
export { TIMEFRAMES, type Market };
const invalid = (message: string): ApiResult<never> => ({ ok: false, reason: 'invalid_response', message });
const refused = (message: string): ApiResult<never> => ({ ok: false, reason: 'error', message });
function matchesPreview(draft: Draft, preview: Preview) {
  return (
    preview.symbol === draft.symbol &&
    preview.side === draft.side &&
    preview.type === draft.type &&
    parseAmount(preview.amount) === parseAmount(draft.amount) &&
    (draft.price ? preview.price !== null && parseAmount(draft.price) === parseAmount(preview.price) : preview.price === null) &&
    preview.timeInForce === (draft.postOnly ? 'PO' : draft.timeInForce)
  );
}
export function createTradeApi(api: ApiClient) {
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
      return refused(
        result.data.refusals.map((row) => row.message).join(' ') || 'Fee or reservation is unavailable. Placement is disabled.',
      );
    if (JSON.stringify(result.data) !== JSON.stringify(reviewed))
      return {
        ok: false,
        reason: 'changed',
        message: 'Fee, price protection, or reservation changed. Review the refreshed values.',
        preview: result.data,
      };
    return result;
  }
  const client = {
    markets: (signal?: AbortSignal) => api.rest('/markets', z.array(listingSchema), { query: { limit: 500 }, signal }),
    book: async (symbol: string, signal?: AbortSignal) => {
      const result = await api.rest(`/orderbook/${encodeURIComponent(symbol)}`, orderBookSchema, { query: { limit: 200 }, signal });
      return result.ok && result.data.symbol !== symbol ? invalid('The order book belongs to another market.') : result;
    },
    ticker: async (symbol: string, signal?: AbortSignal) => {
      const result = await api.rest(`/ticker/${encodeURIComponent(symbol)}`, tickerSchema, { signal });
      return result.ok && result.data.symbol !== symbol ? invalid('The ticker belongs to another market.') : result;
    },
    history: (symbol: string, timeframe: string, signal?: AbortSignal, since?: number) =>
      api.rest(`/ohlcv/${encodeURIComponent(symbol)}`, historySchema, { query: { timeframe, limit: 500, since }, signal }),
    tape: async (symbol: string, signal?: AbortSignal) => {
      const result = await api.rest(`/trades/${encodeURIComponent(symbol)}`, z.array(tradeSchema), { query: { limit: 40 }, signal });
      return result.ok && result.data.some((row) => row.symbol !== symbol)
        ? invalid('The public trades belong to another market.')
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
    fills: (symbol?: string, limit = 100, signal?: AbortSignal, since?: number) =>
      api.rest('/account/trades', z.array(tradeSchema), { query: { symbol, limit, since }, signal }),
    positions: (symbol?: string, signal?: AbortSignal) => api.rest('/positions', z.array(positionSchema), { query: { symbol }, signal }),
    async order(id: string): Promise<ApiResult<Order>> {
      const result = await api.rest(`/orders/${encodeURIComponent(id)}`, orderSchema);
      return result.ok && result.data.id !== id ? invalid('The order response does not identify the requested original order.') : result;
    },
    async cancel(reviewed: ReviewedOrder): Promise<ApiResult<Order>> {
      const { id, symbol } = reviewed;
      const result = await api.rest(`/orders/${encodeURIComponent(id)}`, orderSchema, { method: 'DELETE' });
      if (result.ok && (result.data.id !== id || result.data.symbol !== symbol || !isTerminalOrder(result.data)))
        return {
          ok: false,
          reason: 'uncertain',
          message: 'Cancellation does not confirm the original order’s terminal outcome. Check its original status before another action.',
        };
      return result;
    },
    async amend(reviewed: ReviewedOrder, amount: string): Promise<ApiResult<z.infer<typeof amendmentSchema>>> {
      const { id, symbol } = reviewed;
      const result = await api.rest(`/orders/${encodeURIComponent(id)}`, amendmentSchema, { method: 'PATCH', body: { qty: amount } });
      if (result.ok && (result.data.orderId !== id || result.data.order.id !== id || result.data.order.symbol !== symbol))
        return {
          ok: false,
          reason: 'uncertain',
          message: 'The amendment response does not identify the original order. Check its original status before another action.',
        };
      if (result.ok && (result.data.reconciliationRequired || result.data.order.recoveryRequired))
        return {
          ok: false,
          reason: 'uncertain',
          message: 'The original amendment is still recovering. Check its original status before another action.',
        };
      return result;
    },
    async preview(input: Draft): Promise<ApiResult<Preview>> {
      const draft = draftSchema.safeParse(input);
      if (!draft.success) return refused(draft.error.issues.map((row) => row.message).join(' '));
      const result = await api.rest('/orders/preview', previewSchema, { method: 'POST', body: draft.data });
      if (!result.ok && result.reason === 'uncertain')
        return { ok: false, reason: 'invalid_response', message: 'Order preview could not be verified. No order was sent.' };
      return result.ok && !matchesPreview(draft.data, result.data)
        ? invalid('The preview does not match this order. Review again.')
        : result;
    },
    async place(
      draft: Draft,
      reviewed: Preview,
      canDispatch: (preview: Preview) => boolean = () => true,
    ): Promise<ApiResult<Order> | ChangedReview> {
      const result = await currentReview(draft, reviewed);
      if (!result.ok) return result;
      if (!canDispatch(result.data))
        return { ok: false, reason: 'aborted', message: 'Trading context changed before placement. No order was sent.' };
      const placed = await api.rest('/orders', orderSchema, { method: 'POST', body: draft });
      if (placed.ok && (placed.data.symbol !== draft.symbol || placed.data.clientOrderId !== draft.clientOrderId))
        return {
          ok: false,
          reason: 'uncertain',
          message: 'The placement response does not identify this request. Reconcile the original request.',
        };
      if (placed.ok && placed.data.recoveryRequired)
        return {
          ok: false,
          reason: 'uncertain',
          message: `Placement requires reconciliation: ${placed.data.recoveryReason ?? 'outcome unknown'}. Holds remain reserved.`,
        };
      return placed;
    },
    async replace(
      original: ReviewedOrder,
      draft: Draft,
      reviewed: Preview,
      canDispatch: (preview: Preview) => boolean = () => true,
    ): Promise<ApiResult<z.infer<typeof replacementSchema>> | ChangedReview> {
      const { id, symbol } = original;
      if (draft.symbol !== symbol) return refused('The replacement market does not match the reviewed original order.');
      const result = await currentReview(draft, reviewed);
      if (!result.ok) return result;
      if (!canDispatch(result.data))
        return { ok: false, reason: 'aborted', message: 'Trading context changed before replacement. No cancel/replace was sent.' };
      const replaced = await api.rest(`/orders/${encodeURIComponent(id)}/replace`, replacementSchema, { method: 'POST', body: draft });
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
        return {
          ok: false,
          reason: 'uncertain',
          message: 'The response does not identify this replacement. Reconcile its original request.',
        };
      if (
        replaced.ok &&
        (replaced.data.reconciliationRequired || replaced.data.original.recoveryRequired || replaced.data.replacement?.recoveryRequired)
      )
        return {
          ok: false,
          reason: 'uncertain',
          message: `Cancel/replace requires reconciliation: ${replaced.data.reasonCode ?? replaced.data.code}. Original and replacement funds remain as reported by the ledger.`,
        };
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
            ? {
                ok: false,
                reason: 'uncertain',
                message: `Original request is still recovering: ${found.recoveryReason ?? 'outcome unknown'}.`,
              }
            : { ok: true, data: found };
      }
      return {
        ok: false,
        reason: 'uncertain',
        message:
          'The request was not found in the returned order pages. Its outcome remains unknown; no new order or retry is enabled. Contact support with the request ID.',
      };
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
  if (quoted <= 0n || reference <= 0n || step <= 0n) throw new Error('Enter a positive value and limit price.');
  const quantity = ((quoted * parseAmount('1')) / reference / step) * step;
  if (quantity <= 0n) throw new Error('This value cannot buy one whole published lot.');
  return formatAmount(quantity);
}
export function portionInLots(available: string, percent: bigint, lot: string) {
  const step = parseAmount(lot);
  if (step <= 0n) return null;
  return formatAmount(((parseAmount(available) * percent) / 100n / step) * step);
}
