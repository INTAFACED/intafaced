/**
 * Rest a linked bracket with entry, take-profit, and stop-loss.
 * Entry fill rests the exits. Refuse if any leg is missing.
 * The engine does not invent a trigger.
 * Not a redo of #3628 (OCO rest) or #3654 (bazaar OCO cancel).
 */
import { ZERO, sub, sum, type Amount } from '@intafaced/ledger-client/money';
import { OrderBook } from './book.js';
import { readStopLoss, readTakeProfit } from './oco-link.js';
import type { AmendResult, EngineAmend, EngineOrder, Fill, OrderSide, SubmitResult } from './types.js';

export const ENTRY_MISSING = 'missing_price' as const;
export const TAKE_PROFIT_MISSING = 'missing_stop_price' as const;
export const STOP_LOSS_MISSING = 'missing_stop_price' as const;

const FLAG = Symbol.for('intafaced.matching.bracket');

type BracketOrder = EngineOrder & {
  readonly bracket?: boolean;
  readonly takeProfit?: Amount | null;
  readonly stopLoss?: Amount | null;
  readonly takeProfitOrderId?: string | null;
  readonly stopLossOrderId?: string | null;
  readonly oco?: boolean;
  readonly mark?: Amount | null;
};

type Pending = {
  readonly entryId: string;
  readonly takeProfit: Amount;
  readonly stopLoss: Amount;
  readonly tpId: string;
  readonly slId: string;
  readonly side: OrderSide;
  readonly qty: Amount;
  /** Fills already seen while this entry was still live. */
  readonly traded: Amount;
  readonly accountId: string;
  readonly tif: EngineOrder['tif'];
};

const pending = new WeakMap<OrderBook, Map<string, Pending>>();

type LiveExit = {
  readonly tpId: string;
  readonly slId: string;
};

/** Take-profit still resting after restExits, with the stop that must not sell again. */
const liveExits = new WeakMap<OrderBook, Map<string, LiveExit>>();

export function wantsBracket(order: { readonly bracket?: boolean }): boolean {
  return order.bracket === true;
}

/** Caller entry price. Null/zero is missing — never last, mid, or mark. */
export function readEntry(order: { readonly type?: string; readonly price?: Amount | null }): Amount | null {
  if (order.type === 'market') return null;
  if (order.price === undefined || order.price === null || order.price <= ZERO) return null;
  return order.price;
}

export function entryRefuse(order: {
  readonly type?: string;
  readonly price?: Amount | null;
}): { readonly code: typeof ENTRY_MISSING; readonly message: string } | null {
  if (order.type === 'market') return null;
  if (readEntry(order) !== null) return null;
  return {
    code: ENTRY_MISSING,
    message: 'a bracket entry is missing; the engine does not invent a trigger',
  };
}

export function takeProfitRefuse(
  takeProfit: Amount | null,
): { readonly code: typeof TAKE_PROFIT_MISSING; readonly message: string } | null {
  if (takeProfit !== null) return null;
  return {
    code: TAKE_PROFIT_MISSING,
    message: 'a bracket take-profit is missing; the engine does not invent a trigger',
  };
}

export function stopLossRefuse(stopLoss: Amount | null): { readonly code: typeof STOP_LOSS_MISSING; readonly message: string } | null {
  if (stopLoss !== null) return null;
  return {
    code: STOP_LOSS_MISSING,
    message: 'a bracket stop-loss is missing; the engine does not invent a trigger',
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

function exitSide(side: OrderSide): OrderSide {
  return side === 'buy' ? 'sell' : 'buy';
}

function namedId(raw: string | null | undefined, fallback: string): string {
  if (raw == null) return fallback;
  const id = raw.trim();
  return id.length > 0 ? id : fallback;
}

function of(book: OrderBook): Map<string, Pending> {
  let rows = pending.get(book);
  if (!rows) {
    rows = new Map();
    pending.set(book, rows);
  }
  return rows;
}

function exitsOf(book: OrderBook): Map<string, LiveExit> {
  let rows = liveExits.get(book);
  if (!rows) {
    rows = new Map();
    liveExits.set(book, rows);
  }
  return rows;
}

function liveIds(book: OrderBook): Set<string> {
  const state = book.toState();
  const ids = new Set<string>();
  for (const level of state.bids) {
    for (const row of level.orders) ids.add(row.orderId);
  }
  for (const level of state.asks) {
    for (const row of level.orders) ids.add(row.orderId);
  }
  for (const stop of state.stops) ids.add(stop.orderId);
  return ids;
}

function collectFills(result: SubmitResult): Fill[] {
  const out = [...result.fills];
  for (const triggered of result.triggered) {
    out.push(...triggered.fills);
  }
  return out;
}

function fillKey(fill: Fill): string {
  return `${fill.sequence}:${fill.makerOrderId}:${fill.takerOrderId}`;
}

/** IOC and FOK cannot rest. A child that leaves immediately is already terminal, so the stop is refused. */
function exitTif(tif: EngineOrder['tif']): EngineOrder['tif'] {
  if (tif === 'IOC' || tif === 'FOK') return 'GTC';
  return tif;
}

function mergeResults(left: SubmitResult, right: SubmitResult): SubmitResult {
  return {
    accepted: left.accepted && right.accepted,
    sequence: right.sequence ?? left.sequence,
    fills: [...left.fills, ...right.fills],
    resting: right.resting ?? left.resting,
    rejected: right.rejected ?? left.rejected,
    cancellations: [...left.cancellations, ...right.cancellations],
    triggered: [...left.triggered, ...right.triggered],
  };
}

function baseEntry(extra: BracketOrder): EngineOrder {
  const {
    takeProfit: _takeProfit,
    stopLoss: _stopLoss,
    stopLossLimit: _stopLossLimit,
    bracket: _bracket,
    oco: _oco,
    takeProfitOrderId: _takeProfitOrderId,
    stopLossOrderId: _stopLossOrderId,
    mark: _mark,
    ...base
  } = extra;
  return base;
}

function restExits(
  book: OrderBook,
  orig: (order: EngineOrder, now?: Date | null) => SubmitResult,
  rec: Pending,
  now?: Date | null,
): SubmitResult {
  // The entry id is already on the book. Submitting it again is
  // duplicate_order_id, and that rejection was folded over a fill that
  // had already happened. The exits are their own orders.
  //
  // Rest the take-profit before the stop. The entry fill has already set
  // lastTradePrice, so a stop at or through that price executes inside the
  // stop submit. The take-profit has to be live so that fill can pull it.
  const side = exitSide(rec.side);
  const tp = orig.call(
    book,
    {
      orderId: rec.tpId,
      accountId: rec.accountId,
      type: 'limit',
      side,
      qty: rec.qty,
      price: rec.takeProfit,
      stopPrice: null,
      tif: exitTif(rec.tif),
      ocoSiblingId: rec.slId,
    } as EngineOrder,
    now,
  );
  if (!tp.accepted) return tp;

  // A partial take-profit has already sold. The stop covers the size still
  // open, so the two exits together cannot sell the entry twice. A print
  // from that submit can fill more of the take-profit before this qty is
  // chosen; those sales sit on triggered, not on fills. A complete
  // take-profit still submits this qty: the book then refuses the stop
  // because that sibling is terminal. This qty is the size the entry
  // traded, so an unfilled remainder is not on the stop.
  const sold = sum(
    collectFills(tp)
      .filter((fill) => fill.makerOrderId === rec.tpId || fill.takerOrderId === rec.tpId)
      .map((fill) => fill.qty),
  );
  const stopQty = sold > ZERO && sold < rec.qty ? sub(rec.qty, sold) : rec.qty;

  const sl = orig.call(
    book,
    {
      orderId: rec.slId,
      accountId: rec.accountId,
      type: 'stop',
      side,
      qty: stopQty,
      price: null,
      stopPrice: rec.stopLoss,
      tif: exitTif(rec.tif),
      ocoSiblingId: rec.tpId,
    } as EngineOrder,
    now,
  );
  if (!sl.accepted) {
    const rollback = book.cancel(rec.tpId);
    // The take-profit may already have traded. Dropping those fills hides
    // the entry they completed, so the refusal still carries them.
    return {
      accepted: false,
      sequence: sl.sequence ?? tp.sequence,
      fills: [...tp.fills, ...sl.fills],
      resting: null,
      rejected: sl.rejected,
      cancellations: [...tp.cancellations, ...sl.cancellations, ...(rollback.cancellation ? [rollback.cancellation] : [])],
      triggered: [...tp.triggered, ...sl.triggered],
    };
  }

  // Both exits still live. A later complete fill of the take-profit leaves
  // the book index before sibling lookup, so this wrapper has to pull the stop.
  const live = liveIds(book);
  if (live.has(rec.tpId) && live.has(rec.slId)) {
    exitsOf(book).set(rec.tpId, { tpId: rec.tpId, slId: rec.slId });
  }

  const pulledTp = sl.cancellations.some((row) => row.orderId === rec.tpId);
  return {
    accepted: true,
    sequence: sl.sequence ?? tp.sequence,
    fills: [...tp.fills, ...sl.fills],
    resting: pulledTp ? sl.resting : (tp.resting ?? sl.resting),
    cancellations: [...tp.cancellations, ...sl.cancellations],
    triggered: [...tp.triggered, ...sl.triggered],
  };
}

function restExitsForFills(
  book: OrderBook,
  orig: (order: EngineOrder, now?: Date | null) => SubmitResult,
  result: SubmitResult,
  now?: Date | null,
): SubmitResult {
  const rows = pending.get(book);
  if (!rows || rows.size === 0) return result;
  let combined = result;
  let merged = false;
  let incoming = collectFills(result);
  const seen = new Set<string>();
  const filledThisWave = new Set<string>();

  // An exit submit can fill another resting entry. That fill is not in the
  // snapshot taken before the call, so each armed pair is applied before the
  // next entry is judged.
  for (;;) {
    for (const fill of incoming) {
      const key = fillKey(fill);
      if (seen.has(key)) continue;
      seen.add(key);
      for (const orderId of [fill.makerOrderId, fill.takerOrderId]) {
        const rec = rows.get(orderId);
        if (!rec) continue;
        rows.set(orderId, { ...rec, traded: sum([rec.traded, fill.qty]) });
        filledThisWave.add(orderId);
      }
    }
    incoming = [];

    const live = liveIds(book);
    let armed: SubmitResult | null = null;
    for (const [orderId, rec] of [...rows]) {
      if (live.has(orderId)) continue;
      rows.delete(orderId);
      if (!filledThisWave.has(orderId) || rec.traded <= ZERO) continue;
      armed = restExits(book, orig, { ...rec, qty: rec.traded }, now);
      break;
    }
    if (!armed) break;
    combined = mergeResults(combined, armed);
    merged = true;
    incoming = collectFills(armed);
  }

  return merged ? combined : result;
}

function asSubmit(result: AmendResult): SubmitResult {
  return {
    accepted: result.accepted,
    sequence: result.sequence,
    fills: result.fills,
    resting: result.resting,
    ...(result.rejected ? { rejected: result.rejected } : {}),
    cancellations: result.cancellations,
    triggered: result.triggered,
  };
}

function pullLiveStop(book: OrderBook, result: SubmitResult, armedBefore: ReadonlySet<string>): SubmitResult {
  const rows = liveExits.get(book);
  if (!rows || armedBefore.size === 0) return result;
  const fills = collectFills(result);
  const live = liveIds(book);
  let combined = result;
  for (const tpId of armedBefore) {
    const rec = rows.get(tpId);
    if (!rec) continue;
    const filled = fills.some((fill) => fill.makerOrderId === tpId || fill.takerOrderId === tpId);
    if (!filled) {
      if (!live.has(tpId) || !live.has(rec.slId)) rows.delete(tpId);
      continue;
    }
    rows.delete(tpId);
    if (!live.has(rec.slId)) continue;
    const cancelled = book.cancel(rec.slId, 'oco_sibling_filled');
    if (!cancelled.cancellation) continue;
    combined = {
      ...combined,
      cancellations: [...combined.cancellations, cancelled.cancellation],
    };
  }
  return combined;
}

export function installBracket(ctor: typeof OrderBook): void {
  if (!ctor) return;
  const proto = ctor.prototype as {
    submit: (order: EngineOrder, now?: Date | null) => SubmitResult;
    amend: (cmd: EngineAmend, now?: Date | null) => AmendResult;
    [FLAG]?: boolean;
  };
  if (proto[FLAG]) return;
  proto[FLAG] = true;

  const orig = proto.submit;
  const origAmend = proto.amend;
  proto.amend = function (this: OrderBook, cmd: EngineAmend, now?: Date | null) {
    const amended = origAmend.call(this, cmd, now);
    if (!amended.accepted) return amended;
    const viewed = asSubmit(amended);
    const combined = restExitsForFills(this, orig, viewed);
    if (combined === viewed) return amended;
    return {
      ...amended,
      accepted: combined.accepted,
      sequence: combined.sequence ?? amended.sequence,
      fills: combined.fills,
      resting: combined.resting,
      cancellations: combined.cancellations,
      triggered: combined.triggered,
      ...(combined.rejected ? { rejected: combined.rejected } : {}),
    };
  };
  proto.submit = function (this: OrderBook, order: EngineOrder, now?: Date | null) {
    const armedBefore = new Set(liveExits.get(this)?.keys() ?? []);
    const extra = order as BracketOrder;
    if (!wantsBracket(extra)) {
      return pullLiveStop(this, restExitsForFills(this, orig, orig.call(this, order, now), now), armedBefore);
    }

    const missingEntry = entryRefuse(extra);
    if (missingEntry) return rejected(missingEntry.code, missingEntry.message);
    const takeProfit = readTakeProfit(extra);
    const missingTp = takeProfitRefuse(takeProfit);
    if (missingTp) return rejected(missingTp.code, missingTp.message);
    const stopLoss = readStopLoss(extra);
    const missingSl = stopLossRefuse(stopLoss);
    if (missingSl) return rejected(missingSl.code, missingSl.message);

    const tpId = namedId(extra.takeProfitOrderId, `${order.orderId}:tp`);
    const slId = namedId(extra.stopLossOrderId, `${order.orderId}:sl`);
    const entry = orig.call(this, baseEntry(extra), now);
    if (!entry.accepted) return entry;

    of(this).set(order.orderId, {
      entryId: order.orderId,
      takeProfit: takeProfit as Amount,
      stopLoss: stopLoss as Amount,
      tpId,
      slId,
      side: extra.side,
      qty: extra.qty,
      traded: ZERO,
      accountId: extra.accountId,
      tif: extra.tif,
    });
    return pullLiveStop(this, restExitsForFills(this, orig, entry, now), armedBefore);
  };
}

installBracket(OrderBook);
