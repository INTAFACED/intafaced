/**
 * Cancel both siblings of a linked OCO.
 * Refuse if either sibling is already terminal.
 * The engine does not invent a trigger.
 * Not a redo of #3628 (rest) or #3638 (bazaar place).
 */
import { OrderBook } from './book.js';
import type { CancelledRef, EngineOrder, SubmitResult } from './types.js';

export const OCO_SIBLING_TERMINAL = 'oco_sibling_terminal' as const;
export const OCO_NOT_FOUND = 'order_not_found' as const;

const FLAG = Symbol.for('intafaced.matching.ocoCancel');

type OcoCancelOrder = EngineOrder & {
  readonly type?: string;
  readonly cancel?: boolean;
  readonly oco?: boolean;
  readonly takeProfit?: unknown;
  readonly stopLoss?: unknown;
  readonly takeProfitOrderId?: string | null;
  readonly stopLossOrderId?: string | null;
  readonly ocoSiblingId?: string | null;
  readonly exercise?: boolean;
  readonly cover?: boolean;
  readonly expire?: boolean;
  readonly replace?: boolean;
  readonly amend?: boolean;
  readonly strike?: unknown;
  readonly expiry?: unknown;
};

type Live = { readonly orderId: string; readonly ocoSiblingId?: string };

export function wantsOcoCancel(order: OcoCancelOrder): boolean {
  if (order.cancel !== true) return false;
  if ((order as { type?: string }).type === 'option') return false;
  if (order.exercise === true) return false;
  if (order.cover === true) return false;
  if (order.expire === true) return false;
  if (order.replace === true) return false;
  if (order.amend === true) return false;
  if (order.strike !== undefined || order.expiry !== undefined) return false;
  if (order.oco === true) return true;
  if (order.takeProfit !== undefined || order.stopLoss !== undefined) return true;
  if (order.ocoSiblingId) return true;
  if (order.takeProfitOrderId || order.stopLossOrderId) return true;
  return false;
}

function namedId(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const id = raw.trim();
  return id.length > 0 ? id : null;
}

function liveOrders(book: OrderBook): Live[] {
  const state = book.toState();
  const out: Live[] = [];
  for (const level of state.bids) {
    for (const row of level.orders) out.push({ orderId: row.orderId, ocoSiblingId: row.ocoSiblingId });
  }
  for (const level of state.asks) {
    for (const row of level.orders) out.push({ orderId: row.orderId, ocoSiblingId: row.ocoSiblingId });
  }
  for (const stop of state.stops) {
    out.push({ orderId: stop.orderId, ocoSiblingId: stop.ocoSiblingId });
  }
  return out;
}

function sortPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/**
 * Both sibling ids when the caller named both take-profit and stop-loss ids,
 * a live order already stores ocoSiblingId, or the caller named ocoSiblingId.
 * One named side with nothing live linked is null — never invent orderId:tp or orderId:sl.
 */
export function readOcoPair(book: OrderBook, order: OcoCancelOrder): [string, string] | null {
  const namedTp = namedId(order.takeProfitOrderId);
  const namedSl = namedId(order.stopLossOrderId);
  if (namedTp && namedSl && namedTp !== namedSl) return sortPair(namedTp, namedSl);

  const live = liveOrders(book);
  const byId = new Map(live.map((row) => [row.orderId, row]));
  const self = byId.get(order.orderId);
  if (self?.ocoSiblingId && self.ocoSiblingId !== order.orderId) {
    return sortPair(order.orderId, self.ocoSiblingId);
  }

  const namedSibling = namedId(order.ocoSiblingId ?? null);
  if (namedSibling && namedSibling !== order.orderId) return sortPair(order.orderId, namedSibling);

  return null;
}

export function ocoCancelRefuse(
  liveCount: number,
): { readonly code: typeof OCO_SIBLING_TERMINAL | typeof OCO_NOT_FOUND; readonly message: string } | null {
  if (liveCount === 2) return null;
  if (liveCount === 1) {
    return {
      code: OCO_SIBLING_TERMINAL,
      message: 'an OCO sibling is already terminal; the engine does not invent a trigger',
    };
  }
  return {
    code: OCO_NOT_FOUND,
    message: 'a linked OCO requires both siblings; the engine does not invent a trigger',
  };
}

function rejected(code: NonNullable<SubmitResult['rejected']>['code'], message: string): SubmitResult {
  return {
    accepted: false,
    sequence: null,
    fills: [],
    resting: null,
    rejected: { code, message },
    cancellations: [],
    triggered: [],
  };
}

/**
 * Cancel the live pair readOcoPair already resolved.
 * Null only when no pair was named and the refuse helper declines — never invents orderId:tp.
 */
export function ocoCancelResult(book: OrderBook, order: OcoCancelOrder, cancel: OrderBook['cancel']): SubmitResult | null {
  const pair = readOcoPair(book, order);
  if (!pair) {
    const missing = ocoCancelRefuse(0);
    if (!missing) return null;
    return rejected(missing.code, missing.message);
  }
  const live = new Set(liveOrders(book).map((row) => row.orderId));
  const liveCount = pair.filter((id) => live.has(id)).length;
  const refuse = ocoCancelRefuse(liveCount);
  if (refuse) return rejected(refuse.code, refuse.message);

  const cancellations: CancelledRef[] = [];
  let sequence: number | null = null;
  for (const id of pair) {
    const pulled = cancel.call(book, id, 'requested');
    if (pulled.cancellation) {
      cancellations.push(pulled.cancellation);
      sequence = pulled.sequence ?? sequence;
    }
  }
  return {
    accepted: true,
    sequence,
    fills: [],
    resting: null,
    cancellations,
    triggered: [],
  };
}

export function installOcoCancel(ctor: typeof OrderBook): void {
  if (!ctor) return;
  const proto = ctor.prototype as {
    submit: (order: EngineOrder, now?: Date | null) => SubmitResult;
    cancel: OrderBook['cancel'];
    [FLAG]?: boolean;
  };
  if (proto[FLAG]) return;
  proto[FLAG] = true;

  const orig = proto.submit;
  const origCancel = proto.cancel;
  proto.submit = function (this: OrderBook, order: EngineOrder, now?: Date | null) {
    const extra = order as OcoCancelOrder;
    if (!wantsOcoCancel(extra)) return orig.call(this, order, now);
    const result = ocoCancelResult(this, extra, origCancel);
    if (!result) return orig.call(this, order, now);
    return result;
  };
}

installOcoCancel(OrderBook);
