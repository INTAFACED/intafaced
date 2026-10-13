/**
 * Combo book (PTX-M11-R04 / CARD E2 + H4).
 * Named legs + ratios rest and match as one instrument. Do not rest two options independently and call it a combo.
 * Incomplete combo keeps A8 refuse. Hitch wraps OrderBook.submit after option so this wrap is outermost.
 * A parked combo stop is not on the bid/ask scan. Activation re-enters this refuse before execute can print.
 */
import { parseAmount, type Amount } from '@intafaced/ledger-client/money';
import { OrderBook } from './book.js';
import { comboDisagreesRefuse, comboIdentity, comboIntentRefuse, readRatio, wantsCombo } from './option-combo.js';
import type { CancelReason, CancelResult, ComboLeg, EngineOrder, OrderSide, SubmitResult, TriggerOutcome } from './types.js';

const FLAG = Symbol.for('intafaced.matching.combo-book');

export type ComboRestLeg = {
  readonly name: string;
  readonly ratio: Amount;
};

export type ComboRest = {
  readonly orderId: string;
  readonly identity: string;
  readonly legs: readonly ComboRestLeg[];
};

const rests = new WeakMap<OrderBook, Map<string, ComboRest>>();

function of(book: OrderBook): Map<string, ComboRest> {
  let rows = rests.get(book);
  if (!rows) {
    rows = new Map();
    rests.set(book, rows);
  }
  return rows;
}

function remember(book: OrderBook, orderId: string, legs: readonly ComboLeg[], identity: string): void {
  of(book).set(orderId, {
    orderId,
    identity,
    legs: legs.map((leg) => ({
      name: (leg.name ?? '').trim(),
      ratio: readRatio(leg) as Amount,
    })),
  });
}

function forget(book: OrderBook, orderId: string): void {
  rests.get(book)?.delete(orderId);
}

export function comboRestOf(book: OrderBook, orderId: string): ComboRest | undefined {
  return rests.get(book)?.get(orderId);
}

function crossesLevel(side: OrderSide, limitPrice: Amount | null, levelPrice: Amount): boolean {
  if (limitPrice === null) return true;
  return side === 'buy' ? levelPrice <= limitPrice : levelPrice >= limitPrice;
}

function liveIds(book: OrderBook): Set<string> {
  const state = book.toState();
  return new Set([
    ...state.bids.flatMap((level) => level.orders.map((order) => order.orderId)),
    ...state.asks.flatMap((level) => level.orders.map((order) => order.orderId)),
  ]);
}

/** Rest that a take would print. Same named legs+ratios combo, or refuse. Never invent a match. */
export function takeComboDisagrees(
  book: OrderBook,
  order: { readonly side: OrderSide; readonly price: Amount | null },
  incomingIdentity: string | null,
): ReturnType<typeof comboDisagreesRefuse> | null {
  const rows = rests.get(book);
  const state = book.toState();
  const opposite = order.side === 'buy' ? state.asks : state.bids;
  for (const level of opposite) {
    const levelPrice = parseAmount(level.price);
    if (!crossesLevel(order.side, order.price, levelPrice)) break;
    for (const rest of level.orders) {
      const rec = rows?.get(rest.orderId);
      if (incomingIdentity === null) {
        if (rec) return comboDisagreesRefuse();
        continue;
      }
      if (!rec || rec.identity !== incomingIdentity) return comboDisagreesRefuse();
    }
  }
  return null;
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

function forgetFilled(book: OrderBook, result: SubmitResult): void {
  const live = liveIds(book);
  const fills = [...result.fills, ...result.triggered.flatMap((outcome) => outcome.fills)];
  for (const fill of fills) {
    if (!live.has(fill.makerOrderId)) forget(book, fill.makerOrderId);
    if (!live.has(fill.takerOrderId)) forget(book, fill.takerOrderId);
  }
}

type ArmedStop = {
  readonly orderId: string;
  readonly accountId: string;
  readonly type: 'stop' | 'stop_limit';
  readonly side: OrderSide;
  readonly qty: Amount;
  readonly price: Amount | null;
};

function activationPrice(stop: ArmedStop): Amount | null {
  return stop.type === 'stop_limit' ? stop.price : null;
}

/** The stop already left the stop list. One sequence covers the cancel. Do not print. */
function refuseTriggered(book: OrderBook, stop: ArmedStop, disagrees: ReturnType<typeof comboDisagreesRefuse>): TriggerOutcome {
  forget(book, stop.orderId);
  const sequence = (book as unknown as { nextSequence(): number }).nextSequence();
  return {
    orderId: stop.orderId,
    sequence,
    fills: [],
    resting: null,
    cancellations: [
      {
        orderId: stop.orderId,
        accountId: stop.accountId,
        remainingQty: stop.qty,
        sequence,
        reason: 'trigger_rejected',
      },
    ],
    rejected: disagrees,
  };
}

export function installComboBook(ctor: typeof OrderBook = OrderBook): void {
  const proto = ctor.prototype as unknown as {
    submit: (order: EngineOrder, now?: Date | null) => SubmitResult;
    cancel: (orderId: string, reason?: CancelReason) => CancelResult;
    activate: (stop: ArmedStop) => TriggerOutcome;
    [FLAG]?: boolean;
  };
  if (proto[FLAG]) return;
  proto[FLAG] = true;

  const orig = proto.submit;
  const origCancel = proto.cancel;
  const origActivate = proto.activate;
  proto.activate = function (this: OrderBook, stop: ArmedStop) {
    const rec = rests.get(this)?.get(stop.orderId);
    if (rec) {
      const disagrees = takeComboDisagrees(this, { side: stop.side, price: activationPrice(stop) }, rec.identity);
      if (disagrees) return refuseTriggered(this, stop, disagrees);
    }
    return origActivate.call(this, stop);
  };
  proto.cancel = function (this: OrderBook, orderId: string, reason?: CancelReason) {
    const result = origCancel.call(this, orderId, reason);
    if (result.cancellation) forget(this, orderId);
    return result;
  };
  proto.submit = function (this: OrderBook, order: EngineOrder, now?: Date | null) {
    const incomplete = wantsCombo(order) ? comboIntentRefuse(order) : null;
    if (incomplete) return orig.call(this, order, now);
    const incomingCombo = wantsCombo(order);
    const minted = incomingCombo ? comboIdentity(order.legs as readonly ComboLeg[]) : null;
    if (typeof minted === 'object' && minted !== null) {
      return rejected(minted.code, minted.message);
    }
    const identity = minted;
    const disagrees = takeComboDisagrees(this, order, identity);
    if (disagrees) return rejected(disagrees.code, disagrees.message);
    // One EngineOrder, one rest, one match. Never loop submit per leg. Never mint a second option orderId.
    const result = orig.call(this, order, now);
    if (!result.accepted) return result;
    forgetFilled(this, result);
    if (incomingCombo && result.resting) {
      remember(this, result.resting.orderId, order.legs as readonly ComboLeg[], identity as string);
    }
    return result;
  };
}

try {
  installComboBook();
} catch {
  queueMicrotask(() => installComboBook());
}
