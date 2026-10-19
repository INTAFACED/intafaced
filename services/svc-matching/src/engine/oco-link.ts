/**
 * Rest a linked OCO with take-profit and stop-loss.
 * First fill cancels the sibling (existing ocoSiblingId path).
 * Refuse if either sibling trigger is missing. The engine does not invent a trigger.
 * A linked cancel is not a new place: resolve the pair already on the book.
 */
import { ZERO, parseAmount, type Amount } from '@intafaced/ledger-client/money';
import { OrderBook } from './book.js';
import { ocoCancelResult, wantsOcoCancel } from './oco-cancel.js';
import type { EngineOrder, RestingRef, SubmitResult } from './types.js';

export const TAKE_PROFIT_MISSING = 'missing_stop_price' as const;
export const STOP_LOSS_MISSING = 'missing_stop_price' as const;

const FLAG = Symbol.for('intafaced.matching.ocoLink');

type OcoOrder = EngineOrder & {
  readonly oco?: boolean;
  readonly takeProfit?: Amount | null;
  readonly stopLoss?: Amount | null;
  readonly stopLossLimit?: Amount | null;
  readonly takeProfitOrderId?: string | null;
  readonly stopLossOrderId?: string | null;
};

export function wantsOco(order: {
  readonly oco?: boolean;
  readonly takeProfit?: Amount | null;
  readonly stopLoss?: Amount | null;
}): boolean {
  return order.oco === true || order.takeProfit !== undefined || order.stopLoss !== undefined;
}

/** Caller take-profit. Null/zero is missing — never last, mid, or mark. */
export function readTakeProfit(order: { readonly takeProfit?: Amount | null }): Amount | null {
  if (order.takeProfit === undefined || order.takeProfit === null || order.takeProfit <= ZERO) return null;
  return order.takeProfit;
}

/** Caller stop-loss. Null/zero is missing — never last, mid, or mark. */
export function readStopLoss(order: { readonly stopLoss?: Amount | null }): Amount | null {
  if (order.stopLoss === undefined || order.stopLoss === null || order.stopLoss <= ZERO) return null;
  return order.stopLoss;
}

export function takeProfitRefuse(
  takeProfit: Amount | null,
): { readonly code: typeof TAKE_PROFIT_MISSING; readonly message: string } | null {
  if (takeProfit !== null) return null;
  return {
    code: TAKE_PROFIT_MISSING,
    message: 'an OCO take-profit is missing; the engine does not invent a trigger',
  };
}

export function stopLossRefuse(stopLoss: Amount | null): { readonly code: typeof STOP_LOSS_MISSING; readonly message: string } | null {
  if (stopLoss !== null) return null;
  return {
    code: STOP_LOSS_MISSING,
    message: 'an OCO stop-loss is missing; the engine does not invent a trigger',
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

function baseOrder(extra: OcoOrder): EngineOrder {
  const {
    takeProfit: _takeProfit,
    stopLoss: _stopLoss,
    oco: _oco,
    stopLossLimit: _stopLossLimit,
    takeProfitOrderId: _takeProfitOrderId,
    stopLossOrderId: _stopLossOrderId,
    ...base
  } = extra;
  return base;
}

/** Live rest for an order id already on the book. Null when that id is gone. Amounts stay scaled bigint. */
function liveResting(book: OrderBook, orderId: string): RestingRef | null {
  const state = book.toState();
  for (const level of state.bids) {
    const row = level.orders.find((o) => o.orderId === orderId);
    if (!row) continue;
    return {
      kind: 'book',
      orderId: row.orderId,
      accountId: row.accountId,
      side: 'buy',
      price: parseAmount(level.price),
      remaining: parseAmount(row.remaining),
      sequence: row.sequence,
      version: row.version ?? 1,
    };
  }
  for (const level of state.asks) {
    const row = level.orders.find((o) => o.orderId === orderId);
    if (!row) continue;
    return {
      kind: 'book',
      orderId: row.orderId,
      accountId: row.accountId,
      side: 'sell',
      price: parseAmount(level.price),
      remaining: parseAmount(row.remaining),
      sequence: row.sequence,
      version: row.version ?? 1,
    };
  }
  const stop = state.stops.find((s) => s.orderId === orderId);
  if (!stop) return null;
  return {
    kind: 'stop',
    orderId: stop.orderId,
    accountId: stop.accountId,
    side: stop.side,
    price: parseAmount(stop.stopPrice),
    remaining: parseAmount(stop.qty),
    sequence: stop.sequence,
    version: stop.version ?? 1,
  };
}

export function installOcoLink(ctor: typeof OrderBook): void {
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
    const extra = order as OcoOrder;
    const cancelOrder = order as Parameters<typeof wantsOcoCancel>[0];
    // Cancel before readTakeProfit. A linked cancel omits the take-profit amount;
    // refusing it leaves both siblings on the book. Pair ids come from readOcoPair.
    if (wantsOcoCancel(cancelOrder)) {
      const cancelled = ocoCancelResult(this, cancelOrder, origCancel);
      if (cancelled) return cancelled;
      return orig.call(this, order, now);
    }
    if (!wantsOco(extra)) return orig.call(this, order, now);

    const takeProfit = readTakeProfit(extra);
    if (takeProfit === null) {
      const missingTp = takeProfitRefuse(takeProfit);
      return rejected(missingTp!.code, missingTp!.message);
    }
    const stopLoss = readStopLoss(extra);
    if (stopLoss === null) {
      const missingSl = stopLossRefuse(stopLoss);
      return rejected(missingSl!.code, missingSl!.message);
    }

    const tpId = extra.takeProfitOrderId && extra.takeProfitOrderId.length > 0 ? extra.takeProfitOrderId : `${order.orderId}:tp`;
    const slId = extra.stopLossOrderId && extra.stopLossOrderId.length > 0 ? extra.stopLossOrderId : `${order.orderId}:sl`;
    const base = baseOrder(extra);
    // A stop-limit leg when the caller gave a limit price (it bounds what a buy stop can pay), else a market stop.
    const stopLimit = extra.stopLossLimit != null && extra.stopLossLimit > ZERO ? extra.stopLossLimit : null;
    const stopLeg = stopLimit === null ? ({ type: 'stop', price: null } as const) : ({ type: 'stop_limit', price: stopLimit } as const);

    // Atomic reject (L287): rehearse both legs on a throwaway copy of the book first. If the
    // take-profit leg is refused after the stop leg ran, the stop's fills and triggers would
    // stay executed on the live book, so a refused OCO must never touch it.
    const rehearsal = this.clone();
    const rehearsalSl = orig.call(rehearsal, { ...base, orderId: slId, ...stopLeg, stopPrice: stopLoss, ocoSiblingId: tpId }, now);
    if (rehearsalSl.accepted) {
      const rehearsalTp = orig.call(
        rehearsal,
        { ...base, orderId: tpId, type: 'limit', price: takeProfit, stopPrice: null, ocoSiblingId: slId },
        now,
      );
      if (!rehearsalTp.accepted) {
        return {
          accepted: false,
          sequence: rehearsalTp.sequence,
          fills: [],
          resting: null,
          rejected: rehearsalTp.rejected,
          cancellations: [],
          triggered: [],
        };
      }
    }

    const sl = orig.call(
      this,
      {
        ...base,
        orderId: slId,
        ...stopLeg,
        stopPrice: stopLoss,
        ocoSiblingId: tpId,
      },
      now,
    );
    if (!sl.accepted) return sl;

    const tp = orig.call(
      this,
      {
        ...base,
        orderId: tpId,
        type: 'limit',
        price: takeProfit,
        stopPrice: null,
        ocoSiblingId: slId,
      },
      now,
    );
    if (!tp.accepted) {
      const pulled = proto.cancel.call(this, slId);
      // A missed cancel leaves the stop on the book. Resting null would claim that book is clean.
      const resting = pulled.cancellation ? null : liveResting(this, slId);
      return {
        accepted: false,
        sequence: sl.sequence ?? pulled.sequence ?? tp.sequence,
        fills: [...sl.fills, ...tp.fills],
        resting,
        rejected: tp.rejected,
        cancellations: [...sl.cancellations, ...(pulled.cancellation ? [pulled.cancellation] : []), ...tp.cancellations],
        triggered: [...sl.triggered, ...tp.triggered],
      };
    }

    return {
      accepted: true,
      sequence: tp.sequence ?? sl.sequence,
      fills: [...sl.fills, ...tp.fills],
      resting: tp.resting,
      cancellations: [...sl.cancellations, ...tp.cancellations],
      triggered: [...sl.triggered, ...tp.triggered],
    };
  };
}

installOcoLink(OrderBook);
