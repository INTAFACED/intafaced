/**
 * Scale order flow (ticket v2): build the orders, check each with the service, add up what they cost, send them in one
 * batch, and find out afterwards which of them arrived.
 *
 * The service takes a batch as a list of ordinary orders and runs each one through the same hold, match and finalise
 * path as a single order. It is NOT all-or-nothing: some orders can go in while others are refused or their outcome is
 * unknown. So this file never claims the batch as a whole worked; it reports each order, and anything doubtful is
 * looked up by its `clientOrderId` (a read) and may be sent again under the SAME id, which the service can never make
 * into a second order.
 */
import { z } from 'zod';
import type { ApiClient, ApiResult } from '../../../../shared/api';
import { orderSchema, isTerminalOrder, type Draft, type Order, type Preview, type TradeApi } from '../../../../features/trade/trade-api';
import { formatAmount, parseAmount } from '../../../../shared/money';
import { CONFLICT_CODE } from '../resend';
import { previewIsOrderable } from '../preview';
import type { ScaleRow } from './scale-math';

/** One id per order: `desk:scale:<batch>:<n>`. Under the service's 64 character limit with a 36 character batch id. */
export const scaleOrderId = (batchId: string, index: number): string => `desk:scale:${batchId}:${index}`;
/** The id the account's single order slot is held under while a scale batch is unconfirmed. */
export const scaleSlotId = (batchId: string): string => `scale:${batchId}`;

export function buildDrafts(args: {
  symbol: string;
  side: 'buy' | 'sell';
  rows: readonly ScaleRow[];
  postOnly: boolean;
  batchId: string;
}): Draft[] {
  return args.rows.map((row, index) => ({
    symbol: args.symbol,
    side: args.side,
    type: 'limit' as const,
    amount: row.amount,
    price: row.price,
    timeInForce: 'GTC' as const,
    postOnly: args.postOnly,
    clientOrderId: scaleOrderId(args.batchId, index),
  }));
}

// ---- Checking every order with the service (reads only) ----

export type CheckAll =
  | { ok: true; previews: Preview[] }
  /** `index` is the first order that failed; `failure` is the call's refusal, or `preview` is the service's own "no". */
  | { ok: false; index: number; failure?: Extract<ApiResult<Preview>, { ok: false }>; preview?: Preview };

const CONCURRENCY = 4;

/** Ask the service about every order (4 at a time), keeping the answers in order. Stops starting new asks after a failure. */
export async function checkAll(
  api: TradeApi,
  drafts: readonly Draft[],
  onAsk: () => void,
  alive: () => boolean = () => true,
): Promise<CheckAll> {
  const previews: Array<Preview | undefined> = Array.from({ length: drafts.length });
  let next = 0;
  const state: { failed: Extract<CheckAll, { ok: false }> | null } = { failed: null };
  /** Keep the lowest-numbered failure, so the person is told about the first bad order. */
  const fail = (found: Extract<CheckAll, { ok: false }>): void => {
    if (state.failed === null || found.index < state.failed.index) state.failed = found;
  };
  const worker = async (): Promise<void> => {
    while (state.failed === null && alive()) {
      const index = next;
      next += 1;
      const draft = drafts[index];
      if (!draft) return;
      onAsk();
      const result = await api.preview(draft);
      if (!result.ok) {
        fail({ ok: false, index, failure: result });
      } else if (!previewIsOrderable(result.data)) {
        fail({ ok: false, index, preview: result.data });
      } else previews[index] = result.data;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, drafts.length) }, () => worker()));
  if (state.failed) return state.failed;
  if (!alive() || previews.some((p) => p === undefined))
    return { ok: false, index: 0, failure: { ok: false, reason: 'aborted', message: '' } };
  return { ok: true, previews: previews as Preview[] };
}

export interface ScaleTotals {
  holdAsset: string;
  hold: string;
  feeAsset: string;
  fee: string;
  /** The fee rate when every order carries the same one; null when they differ. */
  feeBps: number | null;
}

/**
 * Add up the service's own numbers: what it will hold and the fee it estimates. Null when any order is not orderable
 * or the orders disagree on an asset (they never should; two assets are never added together).
 */
export function totalsOf(previews: readonly Preview[]): ScaleTotals | null {
  if (previews.length === 0 || !previews.every(previewIsOrderable)) return null;
  const first = previews[0]!;
  if (!previews.every((p) => p.holdAsset === first.holdAsset && p.feeAsset === first.feeAsset)) return null;
  let hold = 0n;
  let fee = 0n;
  for (const p of previews) {
    hold += parseAmount(p.holdAmount!);
    fee += parseAmount(p.estimatedFee!);
  }
  const rates = new Set(previews.map((p) => p.feeBps));
  const only = rates.size === 1 ? [...rates][0]! : null;
  return { holdAsset: first.holdAsset!, hold: formatAmount(hold), feeAsset: first.feeAsset!, fee: formatAmount(fee), feeBps: only };
}

/** Are these the very same answers? Any difference means the numbers on screen are no longer the ones reviewed. */
export function samePreviews(reviewed: readonly Preview[], fresh: readonly Preview[]): boolean {
  return reviewed.length === fresh.length && reviewed.every((p, i) => JSON.stringify(p) === JSON.stringify(fresh[i]));
}

// ---- Sending the batch ----

export type ItemOutcome =
  | { kind: 'placed'; order: Order }
  /** The service said no to this order (nothing was held). `code` is the service's refusal code, shown only as words. */
  | { kind: 'refused'; code: string | null }
  /** The order may or may not exist. It is looked up, never assumed. */
  | { kind: 'unknown' };

export interface BatchOutcome {
  /** `refused`: the whole request was turned away before any order was looked at. `unsure`: no usable answer came back. */
  request: 'answered' | 'refused' | 'unsure';
  items: ItemOutcome[];
}

const itemSchema = z
  .object({
    index: z.number().int(),
    clientOrderId: z.string().nullable().optional(),
    status: z.enum(['success', 'refused', 'unknown']),
    order: z.unknown().optional(),
    error: z.object({ intafacedCode: z.string().optional(), code: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();
const batchSchema = z.object({ results: z.array(itemSchema) });

/** One POST, no retry. */
export async function sendBatch(client: ApiClient, drafts: readonly Draft[]): Promise<BatchOutcome> {
  const unknownAll = (request: BatchOutcome['request']): BatchOutcome => ({
    request,
    items: drafts.map((): ItemOutcome => ({ kind: 'unknown' })),
  });
  const result = await client.rest('/orders/batch', batchSchema, { method: 'POST', body: { orders: drafts } });
  if (!result.ok) {
    // Auth, scope, jurisdiction, size and shape checks all happen before the first order is looked at, so a typed 4xx
    // means nothing was placed. A 5xx, a lost connection or an unreadable answer means we do not know.
    if (result.reason === 'uncertain') return unknownAll('unsure');
    const code = result.code ?? null;
    return { request: 'refused', items: drafts.map((): ItemOutcome => ({ kind: 'refused', code })) };
  }
  const items = drafts.map((draft, i): ItemOutcome => {
    const row = result.data.results[i];
    if (!row || row.index !== i || row.clientOrderId !== draft.clientOrderId) return { kind: 'unknown' };
    if (row.status === 'refused') {
      const code = row.error?.intafacedCode ?? row.error?.code ?? null;
      // "This id was used for a different order" means an order under that id exists: not a refusal.
      return code === CONFLICT_CODE ? { kind: 'unknown' } : { kind: 'refused', code };
    }
    if (row.status !== 'success') return { kind: 'unknown' };
    const order = orderSchema.safeParse(row.order);
    if (!order.success) return { kind: 'unknown' };
    const placed = order.data;
    if (placed.symbol !== draft.symbol || placed.clientOrderId !== draft.clientOrderId) return { kind: 'unknown' };
    if (placed.recoveryRequired && !isTerminalOrder(placed)) return { kind: 'unknown' };
    return { kind: 'placed', order: placed };
  });
  return { request: 'answered', items };
}

// ---- Finding out afterwards (reads only) ----

export type Found = { ok: true; found: Map<string, Order> } | { ok: false };

/** Which of these orders does the service know? Looks in Open and Closed orders for the market, by `clientOrderId`. */
export async function findPlaced(api: TradeApi, symbol: string, ids: readonly string[], onAsk: () => void): Promise<Found> {
  onAsk();
  onAsk();
  const [open, closed] = await Promise.all([api.orders('open', symbol, 500), api.orders('closed', symbol, 500)]);
  if (!open.ok || !closed.ok) return { ok: false };
  const wanted = new Set(ids);
  const found = new Map<string, Order>();
  for (const order of [...open.data, ...closed.data]) {
    if (order.symbol === symbol && order.clientOrderId && wanted.has(order.clientOrderId) && !order.recoveryRequired)
      found.set(order.clientOrderId, order);
  }
  return { ok: true, found };
}
