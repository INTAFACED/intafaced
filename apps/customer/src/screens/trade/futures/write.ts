/**
 * Every futures write goes through here: one at a time, under the shared device guard (`../buy/write-lock`), with the
 * original request saved so an unknown outcome can be looked up again with the SAME request id.
 *
 * Opens and closes are orders through the book (futures ADR): an open is `POST /futures/orders`, a close is a reduce-only
 * market order for the size asked. The service makes each retry-safe on its own request identity: an order by its
 * `clientOrderId` (the open's `clientOpenId`, the close's `clientCloseId`: the same id returns the same order and holds
 * nothing twice), leverage and margin by `clientAdjustmentId` plus the position id. "Check status" reads first; an open
 * is sent again only on the trader's explicit second step. Nothing here retries by itself.
 */
import type { Position } from '@intafaced/exchange-contract/schemas';
import type { ApiResult } from '../../../shared/api';
import { dec, isPositive } from '../../../data/decimal';
import { clearPending, readPending, runGuarded, type BlockReason, type Pending } from '../buy/write-lock';
import type {
  ConditionalOrder,
  FuturesApi,
  FuturesOrder,
  FuturesSplit,
  OpenInput,
  PlaceOrderInput,
  Protection,
  ProtectionInput,
} from './api';
import { futuresRefusal, type FuturesRefusal } from './refusals';

export type Intent =
  | { op: 'open'; input: OpenInput }
  | { op: 'close'; positionId: string; symbol: string; side: 'long' | 'short'; size: string; clientCloseId: string }
  | { op: 'leverage'; input: { symbol: string; positionId: string; leverage: string; clientAdjustmentId: string } }
  | { op: 'margin-add'; input: { symbol: string; positionId: string; amount: string; clientAdjustmentId: string } }
  | { op: 'margin-reduce'; input: { symbol: string; positionId: string; amount: string; clientAdjustmentId: string } }
  | {
      op: 'protection';
      input: ProtectionInput & { symbol: string };
    }
  /** Cancel one armed take profit, stop loss or stop. The order's own id names it, so a second send changes nothing. */
  | { op: 'cancel-trigger'; input: { symbol: string; id: string } };

export type Operation = Intent['op'];

export function intentId(intent: Intent): string {
  switch (intent.op) {
    case 'open':
      return intent.input.clientOpenId;
    case 'close':
      return `close:${intent.positionId}`;
    case 'protection':
      return intent.input.clientRequestId;
    case 'cancel-trigger':
      return `cancel-trigger:${intent.input.id}`;
    default:
      return intent.input.clientAdjustmentId;
  }
}

export function intentSymbol(intent: Intent): string {
  return intent.op === 'close' ? intent.symbol : intent.input.symbol;
}

const intentKey = (userId: string, id: string) => `futures-intent:${userId}:${id}`;

function saveIntent(userId: string, intent: Intent): boolean {
  try {
    localStorage.setItem(intentKey(userId, intentId(intent)), JSON.stringify(intent));
    return true;
  } catch {
    return false;
  }
}

export function loadIntent(userId: string, id: string): Intent | null {
  try {
    const raw = localStorage.getItem(intentKey(userId, id));
    return raw ? (JSON.parse(raw) as Intent) : null;
  } catch {
    return null;
  }
}

function dropIntent(userId: string, id: string): void {
  try {
    localStorage.removeItem(intentKey(userId, id));
  } catch {
    // The guard note is what blocks new actions; a stuck copy of the intent is harmless.
  }
}

/** What the book did with an order. `null`: nothing filled and nothing rests, so the order's own code is the answer. */
function nothingDone(order: FuturesOrder): Extract<ApiResult<never>, { ok: false }> | null {
  if (isPositive(order.filledQty)) return null;
  if (!['rejected', 'refused', 'cancelled'].includes(order.status)) return null;
  return {
    ok: false,
    reason: 'error',
    code: order.refusalCode ?? 'trade.futures_order_unfilled',
    message: 'The book did not fill this order and nothing rests.',
  };
}

function openOrder(input: OpenInput): PlaceOrderInput {
  return {
    symbol: input.symbol,
    side: input.side === 'long' ? 'buy' : 'sell',
    type: input.type,
    amount: input.size,
    ...(input.type === 'limit' && input.price ? { price: input.price } : {}),
    ...(input.type === 'limit' && input.priceCorrection ? { priceCorrection: input.priceCorrection } : {}),
    leverage: input.leverage,
    clientOrderId: input.clientOpenId,
    ...(input.collateralClass ? { collateralClass: input.collateralClass } : {}),
    ...(input.confirmTier !== undefined ? { confirmTier: input.confirmTier } : {}),
  };
}

/** A split open: every child the book took. Nothing filled and nothing rests in any of them is the first child's refusal. */
async function sendSplit(api: FuturesApi, input: OpenInput): Promise<ApiResult<WriteResult>> {
  const placed = await api.placeSplit(openOrder(input));
  if (!placed.ok) return placed;
  const { orders, stopped } = placed.data;
  const none = orders.map(nothingDone);
  if (!stopped && orders.length > 0 && none.every((n) => n !== null)) return none[0]!;
  return { ok: true, data: { order: orders[0], orders, ...(stopped ? { stopped } : {}) } };
}

async function sendOrder(api: FuturesApi, intent: Extract<Intent, { op: 'open' | 'close' }>): Promise<ApiResult<WriteResult>> {
  if (intent.op === 'open' && intent.input.split) return sendSplit(api, intent.input);
  const placed =
    intent.op === 'open'
      ? await api.placeOrder(openOrder(intent.input))
      : await api.placeOrder({
          symbol: intent.symbol,
          side: intent.side === 'long' ? 'sell' : 'buy',
          type: 'market',
          amount: intent.size,
          reduceOnly: true,
          clientOrderId: intent.clientCloseId,
        });
  if (!placed.ok) return placed;
  const none = nothingDone(placed.data);
  if (none) return none;
  if (intent.op === 'open') return { ok: true, data: { order: placed.data } };
  // A close answers with the position as it now stands (smaller, or closed). The order is the record if that read fails.
  const after = await api.position(intent.positionId);
  return { ok: true, data: after.ok ? { order: placed.data, position: after.data } : { order: placed.data } };
}

/** A finished write: the position it changed, and for an order, the order. */
export interface WriteResult {
  position?: Position;
  order?: FuturesOrder;
  /** A split open: every child placed, in order (`order` is the first). */
  orders?: FuturesOrder[];
  /** A split that a child's own refusal stopped: the children in `orders` are live, the rest were not placed. */
  stopped?: FuturesSplit['stopped'];
  /** A take-profit and stop-loss replace: the legs now armed. */
  protection?: Protection;
  /** A cancelled take profit, stop loss or stop, as it now stands. */
  trigger?: ConditionalOrder;
}

async function sendAdjustment(api: FuturesApi, intent: Exclude<Intent, { op: 'open' | 'close' }>): Promise<ApiResult<WriteResult>> {
  if (intent.op === 'protection') {
    const set = await api.setProtection(intent.input);
    return set.ok ? { ok: true, data: { protection: set.data } } : set;
  }
  if (intent.op === 'cancel-trigger') {
    const cancelled = await api.cancelConditional(intent.input.id);
    return cancelled.ok ? { ok: true, data: { trigger: cancelled.data } } : cancelled;
  }
  const result = await sendPosition(api, intent);
  return result.ok ? { ok: true, data: { position: result.data } } : result;
}

export function send(api: FuturesApi, intent: Intent): Promise<ApiResult<WriteResult>> {
  return intent.op === 'open' || intent.op === 'close' ? sendOrder(api, intent) : sendAdjustment(api, intent);
}

function sendPosition(
  api: FuturesApi,
  intent: Exclude<Intent, { op: 'open' | 'close' | 'protection' | 'cancel-trigger' }>,
): Promise<ApiResult<Position>> {
  switch (intent.op) {
    case 'leverage':
      return api.setLeverage(intent.input);
    case 'margin-add':
      return api.addMargin(intent.input);
    case 'margin-reduce':
      return api.reduceMargin(intent.input);
  }
}

export type WriteOutcome =
  | { kind: 'blocked'; reason: BlockReason; pending?: Pending }
  | {
      kind: 'done';
      position?: Position;
      order?: FuturesOrder;
      orders?: FuturesOrder[];
      stopped?: FuturesSplit['stopped'];
      protection?: Protection;
      trigger?: ConditionalOrder;
    }
  | { kind: 'refused'; refusal: FuturesRefusal }
  /**
   * The outcome is unknown. The note stays, so no other trade write goes out until this one is looked up. `notFound`: a
   * read looked and found nothing. `found`: a split's read found some of its children, not all; sending the same request
   * again places only the rest.
   */
  | { kind: 'uncertain'; id: string; notFound?: boolean; found?: FuturesOrder[] };

/**
 * 5xx answers the service sends AFTER rolling back with nothing posted (position-service.ts: no usable mark on open, or on a
 * profitable close that fails the payout-grade mark check). The shared client calls any 5xx on a write "uncertain"; for these
 * codes the answer is definite, so they must not leave the device-wide note behind.
 */
// Answered as 503 but nothing was changed: a missing mark, and price triggers switched off (nothing is armed or replaced).
const ROLLED_BACK_CODES: ReadonlySet<string> = new Set(['trade.mark_missing', 'trade.mark_unusable', 'trade.conditional_trigger_off']);
const isDefinite = (result: { ok: boolean; reason?: string; code?: string }) =>
  !result.ok && result.reason === 'uncertain' && result.code !== undefined && ROLLED_BACK_CODES.has(result.code);

/** Send ONE write. An unknown outcome keeps the device note and the saved request; nothing re-sends by itself. */
export async function runIntent(
  api: FuturesApi,
  userId: string | null,
  intent: Intent,
  options: { recheck?: boolean } = {},
): Promise<WriteOutcome> {
  const id = intentId(intent);
  const pending: Pending = { kind: 'position', id, symbol: intentSymbol(intent), startedAt: Date.now() };
  if (userId && !options.recheck && !saveIntent(userId, intent)) return { kind: 'blocked', reason: 'storage' };
  const guarded = await runGuarded(
    userId,
    pending,
    () => send(api, intent),
    (result) => !result.ok && result.reason === 'uncertain' && !isDefinite(result),
    options,
  );
  if (guarded.kind === 'blocked') {
    if (userId && !options.recheck) dropIntent(userId, id);
    return { kind: 'blocked', reason: guarded.reason, pending: guarded.pending };
  }
  if (guarded.kind === 'threw') return { kind: 'uncertain', id };
  const result = guarded.value;
  if (result.ok) {
    if (userId) dropIntent(userId, id);
    return { kind: 'done', ...result.data };
  }
  if (result.reason === 'uncertain' && !isDefinite(result)) return { kind: 'uncertain', id };
  if (userId) dropIntent(userId, id);
  return { kind: 'refused', refusal: futuresRefusal(result) };
}

const SETTLED = new Set(['closed', 'liquidated', 'closing']);

/** Look for the effect of an unknown close without sending anything. Null = looked, found nothing; undefined = could not look. */
async function lookup(api: FuturesApi, intent: Extract<Intent, { op: 'close' }>): Promise<Position | null | undefined> {
  const result = await api.position(intent.positionId);
  return result.ok ? result.data : result.code === 'trade.position_not_found' ? null : undefined;
}

/** Look for an unknown open's order by its request id, without sending anything. Same null/undefined meaning. */
async function lookupOrder(api: FuturesApi, clientOrderId: string): Promise<FuturesOrder | null | undefined> {
  const result = await api.orders('all');
  return result.ok ? (result.data.find((order) => order.clientOrderId === clientOrderId) ?? null) : undefined;
}

/** The children of an unknown split open, by their `<id>:<n>:<tag>` keys, in order. Same undefined meaning as `lookupOrder`. */
async function lookupChildren(api: FuturesApi, symbol: string, clientOpenId: string): Promise<FuturesOrder[] | undefined> {
  const result = await api.ordersOn(symbol);
  if (!result.ok) return undefined;
  const nth = (order: FuturesOrder) => {
    const rest = order.clientOrderId?.startsWith(`${clientOpenId}:`) ? order.clientOrderId.slice(clientOpenId.length + 1) : '';
    const child = /^(\d+):[0-9a-f]{8}$/.exec(rest);
    return child ? Number(child[1]) : null;
  };
  return result.data.filter((order) => nth(order) !== null).sort((a, b) => nth(a)! - nth(b)!);
}

function settle(userId: string, id: string, outcome: WriteOutcome): WriteOutcome {
  clearPending(userId, id);
  dropIntent(userId, id);
  return outcome;
}

/**
 * After an unknown outcome, every check READS first and sends nothing: an open looks for its order by request id, a
 * close reads the position. An open the book never saw is sent again only on the trader's explicit second step
 * (`resend`), with the same request id, so the service answers a replay with the first order and holds nothing twice.
 * A close still open, and a margin or leverage change, replay the saved request unchanged: their request id makes it safe.
 */
export async function checkPending(
  api: FuturesApi,
  userId: string | null,
  pending: Pending,
  options: { resend?: boolean } = {},
): Promise<WriteOutcome> {
  if (!userId) return { kind: 'blocked', reason: 'signedOut' };
  const intent = loadIntent(userId, pending.id);
  if (!intent) return { kind: 'blocked', reason: 'unreadable' };
  if (intent.op === 'open' && intent.input.split && !options.resend) {
    // A split's children are keyed `<id>:<n>:<tag>`. All of the size found: done. None, or only some: nothing is sent
    // here; the trader's explicit second step sends the same request, which replays the children found and places the rest.
    const found = await lookupChildren(api, intent.input.symbol, intent.input.clientOpenId);
    if (found === undefined) return { kind: 'uncertain', id: pending.id };
    if (found.length === 0) return { kind: 'uncertain', id: pending.id, notFound: true };
    const total = found.reduce((sum, order) => sum + (dec(order.qty) ?? 0n), 0n);
    if (total === dec(intent.input.size)) return settle(userId, pending.id, { kind: 'done', order: found[0], orders: found });
    return { kind: 'uncertain', id: pending.id, notFound: true, found };
  } else if (intent.op === 'open' && !options.resend) {
    const order = await lookupOrder(api, intent.input.clientOpenId);
    if (order === undefined) return { kind: 'uncertain', id: pending.id };
    if (order === null) return { kind: 'uncertain', id: pending.id, notFound: true };
    const none = nothingDone(order);
    return settle(userId, pending.id, none ? { kind: 'refused', refusal: futuresRefusal(none) } : { kind: 'done', order });
  }
  if (intent.op === 'cancel-trigger') {
    // Read the order first: cancelled is the answer; still armed is sent again; one that fired or ended cannot be cancelled.
    const read = await api.conditionalOrder(intent.input.id);
    if (!read.ok) return { kind: 'uncertain', id: pending.id };
    if (read.data.status === 'cancelled') return settle(userId, pending.id, { kind: 'done', trigger: read.data });
    if (read.data.status !== 'armed')
      return settle(userId, pending.id, { kind: 'refused', refusal: futuresRefusal({ code: 'trade.conditional_not_cancellable' }) });
  }
  if (intent.op === 'close') {
    const found = await lookup(api, intent);
    if (found && SETTLED.has(found.status ?? '')) return settle(userId, pending.id, { kind: 'done', position: found });
    if (found === undefined) return { kind: 'uncertain', id: pending.id };
  }
  const outcome = await runIntent(api, userId, intent, { recheck: true });
  if (outcome.kind === 'done' || outcome.kind === 'refused') clearPending(userId, pending.id);
  return outcome;
}

export { readPending };
