/**
 * Option through matching. Rest as a limit on the public book.
 * Take against a resting option with the same strike and expiry.
 * Exercise a long option at strike. Assign the earliest short fill first, using that fill's order id.
 * Cover a short option after assignment.
 * Expire a resting option at expiry. Unfilled remainder leaves the book.
 * An incoming option whose expiry is at or before now expires before it prints. No trade is recorded. Other due rests are still pulled.
 * Cancel a resting option. Unfilled remainder leaves the book.
 * Amend qty on a resting option. Refuse if strike, expiry, or qty is missing.
 * Amend price on a resting option. Refuse if strike, expiry, or price is missing.
 * Native amend of price and/or qty. Cancel/replace is never atomic amend.
 * Refuse if strike or expiry is missing or disagrees.
 * Refuse an amend whose price would cross a plain limit, or a different strike or expiry.
 * Accepted amend fills update the option position for that strike and expiry.
 * A plain, stop, or market order that would take a resting option refuses before the book.
 * A stop that triggers later refuses at activation. An amend that would move a plain into the option refuses.
 * Qty in front counts only what the sweep would print. An OCO sibling pulled before it is reached, or a reduce-only clip, is not a full print.
 * A GTD or GTT rest that is due on this clock is not size in front. A peg or relative order is judged after it binds.
 * The resting option stays. The engine does not invent a strike, an expiry, or an option long.
 * A combo without named legs/ratios refuses. Missing strike/expiry/ratio on a combo rest refuses.
 * The engine does not invent a mark or a combo book.
 */
import { ZERO, formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client/money';
import { unsupportedAmendField } from './amend-priority.js';
import { OrderBook, registerOptionActivationGuard } from './book.js';
import { comboIntentRefuse } from './option-combo.js';
import { bindPegRelative, pegIntentRefuse } from './peg.js';
import { isSelfTrade } from './self-trade.js';
import type { AmendResult, CancelledRef, EngineAmend, EngineOrder, Fill, OrderSide, SubmitResult } from './types.js';

export const STRIKE_MISSING = 'missing_strike' as const;
export const EXPIRY_MISSING = 'missing_expiry' as const;
export const PRICE_MISSING = 'missing_price' as const;
export const STRIKE_DISAGREES = 'strike_disagrees' as const;
export const EXPIRY_DISAGREES = 'expiry_disagrees' as const;

export type OptionRefuse =
  typeof STRIKE_MISSING | typeof EXPIRY_MISSING | typeof PRICE_MISSING | typeof STRIKE_DISAGREES | typeof EXPIRY_DISAGREES;

const FLAG = Symbol.for('intafaced.matching.option');

type OptionLive = { readonly strike: Amount; readonly expiry: string };
type OptionLot = { qty: Amount; orderId: string; sequence: number };
type OptionOpen = {
  readonly rest: Map<string, OptionLive>;
  readonly open: Map<string, Map<string, OptionLot[]>>;
  readonly assigned: Map<string, Map<string, OptionLot[]>>;
};

const books = new WeakMap<OrderBook, OptionOpen>();

export function wantsOption(order: { readonly type?: string; readonly strike?: Amount | null; readonly expiry?: string | null }): boolean {
  return order.type === 'option' || order.strike !== undefined || order.expiry !== undefined;
}

/** Caller strike. Null/zero is missing — never invent from last, mid, best, or mark. */
export function readStrike(order: { readonly strike?: Amount | null }): Amount | null {
  if (order.strike === undefined || order.strike === null || order.strike <= ZERO) return null;
  return order.strike;
}

/** Caller expiry. Null/blank is missing — never invent. */
export function readExpiry(order: { readonly expiry?: string | null }): string | null {
  if (order.expiry === undefined || order.expiry === null) return null;
  const expiry = order.expiry.trim();
  if (expiry.length === 0) return null;
  return expiry;
}

export function strikeRefuse(strike: Amount | null): { readonly code: typeof STRIKE_MISSING; readonly message: string } | null {
  if (strike !== null && strike > ZERO) return null;
  return {
    code: STRIKE_MISSING,
    message: 'an option requires a strike; the engine does not invent a strike',
  };
}

export function expiryRefuse(expiry: string | null): { readonly code: typeof EXPIRY_MISSING; readonly message: string } | null {
  if (expiry !== null) return null;
  return {
    code: EXPIRY_MISSING,
    message: 'an option requires an expiry; the engine does not invent an expiry',
  };
}

export function priceRefuse(price: Amount | null): { readonly code: typeof PRICE_MISSING; readonly message: string } | null {
  if (price !== null) return null;
  return {
    code: PRICE_MISSING,
    message: 'an option amend requires a price; the engine does not invent a mark',
  };
}

export function wantsExercise(order: { readonly exercise?: boolean }): boolean {
  return order.exercise === true;
}

export function wantsCover(order: { readonly cover?: boolean }): boolean {
  return order.cover === true;
}

export function wantsCancel(order: { readonly cancel?: boolean }): boolean {
  return order.cancel === true;
}

export function wantsAmend(order: { readonly amend?: boolean }): boolean {
  return order.amend === true;
}

export function wantsReplace(order: { readonly replace?: boolean }): boolean {
  return order.replace === true;
}

function crossesLevel(side: OrderSide, limitPrice: Amount, levelPrice: Amount): boolean {
  return side === 'buy' ? levelPrice <= limitPrice : levelPrice >= limitPrice;
}

function of(book: OrderBook): OptionOpen {
  let rows = books.get(book);
  if (!rows) {
    rows = { rest: new Map(), open: new Map(), assigned: new Map() };
    books.set(book, rows);
  }
  return rows;
}

function contractKey(strike: Amount, expiry: string): string {
  return `${formatAmount(strike)}|${expiry}`;
}

/**
 * Apply one signed fill.
 * A short open appends that fill's order id and does not rewrite an earlier short.
 * A reduction consumes the earliest lot and leaves that lot's order id on any remainder.
 */
function bump(
  open: Map<string, Map<string, OptionLot[]>>,
  key: string,
  accountId: string,
  orderId: string,
  delta: Amount,
  sequence = 0,
): void {
  if (delta === ZERO) return;
  let lots = open.get(key);
  if (!lots) {
    lots = new Map();
    open.set(key, lots);
  }
  const prev = lots.get(accountId) ?? [];
  const next: OptionLot[] = [];
  if (delta < ZERO) {
    let left = -delta;
    for (const lot of prev) {
      if (left === ZERO || lot.qty < ZERO) {
        next.push(lot);
        continue;
      }
      if (lot.qty > left) {
        next.push({ ...lot, qty: lot.qty - left });
        left = ZERO;
      } else {
        left -= lot.qty;
      }
    }
    if (left > ZERO) next.push({ qty: -left, orderId, sequence });
  } else {
    let left = delta;
    for (const lot of prev) {
      if (left === ZERO || lot.qty > ZERO) {
        next.push(lot);
        continue;
      }
      const avail = -lot.qty;
      if (avail > left) {
        next.push({ ...lot, qty: lot.qty + left });
        left = ZERO;
      } else {
        left -= avail;
      }
    }
    if (left > ZERO) next.push({ qty: left, orderId, sequence });
  }
  if (next.length === 0) lots.delete(accountId);
  else lots.set(accountId, next);
  if (lots.size === 0) open.delete(key);
}

function applyFills(open: Map<string, Map<string, OptionLot[]>>, fills: readonly Fill[], strike: Amount, expiry: string): void {
  const key = contractKey(strike, expiry);
  for (const fill of fills) {
    const signed = fill.takerSide === 'buy' ? fill.qty : -fill.qty;
    bump(open, key, fill.takerAccountId, fill.takerOrderId, signed, fill.sequence);
    bump(open, key, fill.makerAccountId, fill.makerOrderId, -signed, fill.sequence);
  }
}

/** Rest that a take would print. Same strike+expiry option, or refuse. Never invent a match. */
export function takeDisagrees(
  book: OrderBook,
  order: { readonly side: OrderSide; readonly price: Amount },
  strike: Amount,
  expiry: string,
): { readonly code: typeof STRIKE_DISAGREES | typeof EXPIRY_DISAGREES; readonly message: string } | null {
  const rows = books.get(book)?.rest;
  const state = book.toState();
  const opposite = order.side === 'buy' ? state.asks : state.bids;
  for (const level of opposite) {
    const levelPrice = parseAmount(level.price);
    if (!crossesLevel(order.side, order.price, levelPrice)) break;
    for (const rest of level.orders) {
      const rec = rows?.get(rest.orderId);
      if (!rec) {
        return {
          code: STRIKE_DISAGREES,
          message: 'an option takes a resting option with the same strike; the engine does not invent a match',
        };
      }
      if (rec.strike !== strike) {
        return {
          code: STRIKE_DISAGREES,
          message: 'an option takes a resting option with the same strike; the engine does not invent a match',
        };
      }
      if (rec.expiry !== expiry) {
        return {
          code: EXPIRY_DISAGREES,
          message: 'an option takes a resting option with the same expiry; the engine does not invent a match',
        };
      }
    }
  }
  return null;
}

/**
 * Limit a non-option would match now. `null` is a market (no limit).
 * `undefined` means this submit does not enter the book: a stop that is not triggered, or an order the book will refuse for shape.
 * The caller passes the order after bindPegRelative, so a peg or relative order is already a limit at reference plus offset.
 */
function crossingLimit(book: OrderBook, order: EngineOrder): Amount | null | undefined {
  if (order.qty <= ZERO) return undefined;
  if (order.type === 'limit') {
    if (order.price === null || order.price <= ZERO || order.stopPrice !== null) return undefined;
    return order.price;
  }
  if (order.type === 'market') {
    if (order.price !== null || order.stopPrice !== null) return undefined;
    return null;
  }
  if (order.type !== 'stop' && order.type !== 'stop_limit') return undefined;
  if (order.stopPrice === null || order.stopPrice <= ZERO) return undefined;
  if (order.type === 'stop' && order.price !== null) return undefined;
  if (order.type === 'stop_limit' && (order.price === null || order.price <= ZERO)) return undefined;
  if (!stopTriggersNow(book, order.side, order.stopPrice)) return undefined;
  return order.type === 'stop' ? null : order.price;
}

/** Same trigger rule as the book. No last trade means the stop rests. */
function stopTriggersNow(book: OrderBook, side: OrderSide, stopPrice: Amount): boolean {
  const last = book.toState().lastTradePrice;
  if (last === null) return false;
  const lastPx = parseAmount(last);
  return side === 'buy' ? lastPx >= stopPrice : lastPx <= stopPrice;
}

type SweepFill = {
  readonly takerAccountId: string;
  readonly makerAccountId: string;
  readonly takerSide: OrderSide;
  readonly qty: Amount;
};

/** Signed net after fills already counted in this sweep. Position is fills, never a mark. */
function netAfterSweep(positions: ReadonlyMap<string, Amount>, fills: readonly SweepFill[], accountId: string): Amount {
  let net = positions.get(accountId) ?? ZERO;
  for (const fill of fills) {
    const signed = fill.takerSide === 'buy' ? fill.qty : -fill.qty;
    if (fill.takerAccountId === accountId) net += signed;
    if (fill.makerAccountId === accountId) net -= signed;
  }
  return net;
}

/** Qty a reduce-only maker can print. A sell reduces a long. A buy reduces a short. */
function openQty(net: Amount, side: OrderSide): Amount {
  if (side === 'sell') return net > ZERO ? net : ZERO;
  return net < ZERO ? -net : ZERO;
}

/** True when expireAt is due on the clock the book will expire before it prints. No clock, or no expireAt, is not due. */
function clockDue(expireAt: string | undefined, now: Date | null | undefined): boolean {
  if (now == null || !expireAt) return false;
  return Date.parse(expireAt) <= now.getTime();
}

/** Pull rests and stops the book would expire before this sweep. The option they sat in front of stays. */
function pullClockDue(book: OrderBook, now?: Date | null): CancelledRef[] {
  if (now == null) return [];
  const state = book.toState();
  const due: string[] = [];
  for (const level of [...state.bids, ...state.asks]) {
    for (const rest of level.orders) {
      if (clockDue(rest.expireAt, now)) due.push(rest.orderId);
    }
  }
  for (const stop of state.stops) {
    if (clockDue(stop.expireAt, now)) due.push(stop.orderId);
  }
  due.sort();
  const out: CancelledRef[] = [];
  for (const orderId of due) {
    const result = book.cancel(orderId, 'expired');
    if (result.cancellation) out.push(result.cancellation);
  }
  return out;
}

/**
 * True when this non-option would print a resting option.
 * Only qty the sweep would print counts as in front. An OCO sibling pulled before it is reached prints nothing.
 * A reduce-only ask prints the clip, not its full visible qty. A self-trade of the option refuses so the option stays.
 * A rest whose expireAt is due on this clock prints nothing: the book pulls it before the sweep.
 */
function wouldTakeRestingOption(book: OrderBook, order: EngineOrder, limit: Amount | null, now?: Date | null): boolean {
  const rows = books.get(book)?.rest;
  if (!rows || rows.size === 0) return false;
  const state = book.toState();
  const opposite = order.side === 'buy' ? state.asks : state.bids;
  const makerSide: OrderSide = order.side === 'buy' ? 'sell' : 'buy';
  const positions = new Map<string, Amount>();
  for (const row of state.positions ?? []) positions.set(row.accountId, parseAmount(row.qty));
  let need = order.qty;
  const pulled = new Set<string>();
  const sweep: SweepFill[] = [];
  for (const level of opposite) {
    if (need <= ZERO) return false;
    const levelPrice = parseAmount(level.price);
    if (limit !== null && !crossesLevel(order.side, limit, levelPrice)) break;
    for (const rest of level.orders) {
      if (need <= ZERO) return false;
      if (pulled.has(rest.orderId)) continue;
      if (clockDue(rest.expireAt, now)) continue;
      const visible = parseAmount(rest.displayRemaining ?? rest.remaining);
      if (visible <= ZERO) continue;
      if (isSelfTrade(order.accountId, rest.accountId)) {
        if (rows.has(rest.orderId)) return true;
        continue;
      }
      let print = need > visible ? visible : need;
      if (rest.reduceOnly === true) {
        const open = openQty(netAfterSweep(positions, sweep, rest.accountId), makerSide);
        if (open <= ZERO) continue;
        if (print > open) print = open;
      }
      if (print <= ZERO) continue;
      if (rows.has(rest.orderId)) return true;
      need = need > print ? need - print : ZERO;
      sweep.push({
        takerAccountId: order.accountId,
        makerAccountId: rest.accountId,
        takerSide: order.side,
        qty: print,
      });
      if (rest.ocoSiblingId) pulled.add(rest.ocoSiblingId);
      if (order.ocoSiblingId) pulled.add(order.ocoSiblingId);
    }
  }
  return false;
}

function nonOptionTakeRefuse(
  book: OrderBook,
  order: EngineOrder,
  now?: Date | null,
): { readonly code: typeof STRIKE_DISAGREES; readonly message: string } | null {
  if (pegIntentRefuse(order)) return null;
  const bound = bindPegRelative(order);
  const limit = crossingLimit(book, bound);
  if (limit === undefined) return null;
  if (!wouldTakeRestingOption(book, bound, limit, now)) return null;
  return {
    code: STRIKE_DISAGREES,
    message: 'a non-option order cannot take a resting option; the engine does not invent a strike',
  };
}

/** A plain amend that would reprice into a resting option. The option is not on this order. */
function nonOptionAmendRefuse(
  book: OrderBook,
  cmd: EngineAmend,
  now?: Date | null,
): { readonly code: typeof STRIKE_DISAGREES; readonly message: string } | null {
  const target = book.amendTarget(cmd.orderId);
  if (!target || target.kind !== 'book' || target.price === null) return null;
  const levels = target.side === 'buy' ? book.toState().bids : book.toState().asks;
  let found: (typeof levels)[number]['orders'][number] | null = null;
  for (const level of levels) {
    const row = level.orders.find((rest) => rest.orderId === cmd.orderId);
    if (row) {
      found = row;
      break;
    }
  }
  if (!found) return null;
  if (clockDue(found.expireAt, now)) return null;
  const price = cmd.price ?? target.price;
  return nonOptionTakeRefuse(
    book,
    {
      orderId: cmd.orderId,
      accountId: found.accountId,
      type: 'limit',
      side: target.side,
      qty: cmd.qty ?? parseAmount(found.remaining),
      price,
      stopPrice: null,
      tif: cmd.tif ?? target.inheritedTif,
      ...(found.ocoSiblingId ? { ocoSiblingId: found.ocoSiblingId } : {}),
      ...(found.reduceOnly ? { reduceOnly: true } : {}),
      ...(found.minQty ? { minQty: parseAmount(found.minQty) } : {}),
      ...(found.aon ? { aon: true } : {}),
    },
    now,
  );
}

/** Live rest side and price. Null when the id is not on the book — never invent a side or a mark. */
function restingQuote(book: OrderBook, orderId: string): { readonly side: OrderSide; readonly price: Amount } | null {
  const state = book.toState();
  for (const level of state.bids) {
    if (level.orders.some((rest) => rest.orderId === orderId)) {
      return { side: 'buy', price: parseAmount(level.price) };
    }
  }
  for (const level of state.asks) {
    if (level.orders.some((rest) => rest.orderId === orderId)) {
      return { side: 'sell', price: parseAmount(level.price) };
    }
  }
  return null;
}

function rejected(
  code: SubmitResult['rejected'] extends infer R ? (R extends { code: infer C } ? C : never) : never,
  message: string,
): SubmitResult {
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

function amendRefused(
  orderId: string,
  code: AmendResult['rejected'] extends infer R ? (R extends { code: infer C } ? C : never) : never,
  message: string,
): AmendResult {
  return {
    accepted: false,
    orderId,
    sequence: null,
    version: null,
    priority: null,
    fills: [],
    resting: null,
    rejected: { code, message },
    cancellations: [],
    triggered: [],
  };
}

type OptionAmendExtra = EngineAmend & {
  readonly strike?: Amount | null;
  readonly expiry?: string | null;
  readonly price?: Amount | null;
};

export type OptionAmendDecision =
  | { readonly kind: 'unseen' }
  | { readonly kind: 'refuse'; readonly result: AmendResult }
  | { readonly kind: 'apply'; readonly patch: EngineAmend };

/**
 * Option amend rules before the book mutates.
 * `unseen` when this book has no option identity for the order.
 * A fromState copy is unseen until identity is copied onto it.
 */
export function optionAmendDecision(book: OrderBook, cmd: EngineAmend): OptionAmendDecision {
  const rec = books.get(book)?.rest.get(cmd.orderId);
  if (!rec) return { kind: 'unseen' };
  const field = unsupportedAmendField(cmd);
  if (field) return { kind: 'refuse', result: amendRefused(cmd.orderId, field.code, field.message) };
  const extra = cmd as OptionAmendExtra;
  const strike = readStrike(extra);
  const missingStrike = strikeRefuse(strike);
  if (missingStrike) return { kind: 'refuse', result: amendRefused(cmd.orderId, missingStrike.code, missingStrike.message) };
  const expiry = readExpiry(extra);
  const missingExpiry = expiryRefuse(expiry);
  if (missingExpiry) return { kind: 'refuse', result: amendRefused(cmd.orderId, missingExpiry.code, missingExpiry.message) };
  const priceGiven = extra.price !== undefined;
  const qtyGiven = extra.qty !== undefined;
  if (priceGiven) {
    const price = extra.price ?? null;
    const missingPrice = priceRefuse(price === null || price <= ZERO ? null : price);
    if (missingPrice) return { kind: 'refuse', result: amendRefused(cmd.orderId, missingPrice.code, missingPrice.message) };
  }
  if (!priceGiven) {
    if (!qtyGiven || extra.qty <= ZERO) {
      return {
        kind: 'refuse',
        result: amendRefused(cmd.orderId, 'invalid_qty', 'an option amend requires a qty; the engine does not invent a mark'),
      };
    }
  }
  if (qtyGiven && extra.qty <= ZERO) {
    return {
      kind: 'refuse',
      result: amendRefused(cmd.orderId, 'invalid_qty', 'an option amend requires a qty; the engine does not invent a mark'),
    };
  }
  if (rec.strike !== strike) {
    return {
      kind: 'refuse',
      result: amendRefused(
        cmd.orderId,
        STRIKE_DISAGREES,
        'amend is a resting option with the same strike; the engine does not invent a mark',
      ),
    };
  }
  if (rec.expiry !== expiry) {
    return {
      kind: 'refuse',
      result: amendRefused(
        cmd.orderId,
        EXPIRY_DISAGREES,
        'amend is a resting option with the same expiry; the engine does not invent a mark',
      ),
    };
  }
  return {
    kind: 'apply',
    patch: {
      orderId: cmd.orderId,
      expectedVersion: cmd.expectedVersion,
      ...(qtyGiven ? { qty: extra.qty } : {}),
      ...(priceGiven ? { price: extra.price as Amount } : {}),
      tif: cmd.tif,
      expireAt: cmd.expireAt,
    },
  };
}

export function optionRestSeen(book: OrderBook, orderId: string): boolean {
  return books.get(book)?.rest.has(orderId) === true;
}

/** Resting option identity for a preview copy. `fromState` does not carry the WeakMap. */
export function copyOptionRests(from: OrderBook, to: OrderBook): void {
  const src = books.get(from);
  if (!src) return;
  for (const [orderId, rec] of src.rest) {
    of(to).rest.set(orderId, { strike: rec.strike, expiry: rec.expiry });
  }
}

function remember(book: OrderBook, orderId: string, rec: OptionLive): void {
  of(book).rest.set(orderId, rec);
}

type AssignClip = { readonly accountId: string; readonly orderId: string; readonly qty: Amount };

function netQty(accountLots: readonly OptionLot[] | undefined): Amount {
  let qty = ZERO;
  if (!accountLots) return qty;
  for (const lot of accountLots) qty += lot.qty;
  return qty;
}

/** Positive lots, earliest first. Null when qty is short — never invent an order id. */
function clipPositive(accountId: string, accountLots: readonly OptionLot[] | undefined, qty: Amount): AssignClip[] | null {
  if (!accountLots || qty <= ZERO) return null;
  let need = qty;
  const clips: AssignClip[] = [];
  for (const lot of accountLots) {
    if (lot.qty <= ZERO) continue;
    const clip = lot.qty < need ? lot.qty : need;
    clips.push({ accountId, orderId: lot.orderId, qty: clip });
    need -= clip;
    if (need === ZERO) return clips;
  }
  return null;
}

/** Earliest short fill first. Each clip keeps that fill's order id. Null when there is not enough short — never invent a writer. */
function assignShorts(lots: Map<string, OptionLot[]> | undefined, holderId: string, qty: Amount): AssignClip[] | null {
  if (!lots || qty <= ZERO) return null;
  let need = qty;
  const clips: AssignClip[] = [];
  const shorts = [...lots]
    .flatMap(([accountId, accountLots]) =>
      accountId === holderId ? [] : accountLots.filter((lot) => lot.qty < ZERO).map((lot) => ({ accountId, lot })),
    )
    .sort((a, b) => a.lot.sequence - b.lot.sequence);
  for (const { accountId, lot } of shorts) {
    const avail = -lot.qty;
    const clip = avail < need ? avail : need;
    clips.push({ accountId, orderId: lot.orderId, qty: clip });
    need -= clip;
    if (need === ZERO) return clips;
  }
  return null;
}

function dueAt(expiry: string, now: Date): boolean {
  const ms = Date.parse(expiry);
  return Number.isFinite(ms) && ms <= now.getTime();
}

/** Pull resting options whose expiry has arrived. Remainder leaves. Never invent an expiry or a mark. */
function expireDueOptions(book: OrderBook, now?: Date | null): CancelledRef[] {
  if (now == null) return [];
  const rows = of(book).rest;
  const due = [...rows.entries()]
    .filter(([, rec]) => dueAt(rec.expiry, now))
    .map(([orderId]) => orderId)
    .sort();
  const out: CancelledRef[] = [];
  for (const orderId of due) {
    const result = book.cancel(orderId, 'expired');
    if (result.cancellation) {
      out.push(result.cancellation);
      rows.delete(orderId);
    }
  }
  return out;
}

function withExpired(result: SubmitResult, expired: readonly CancelledRef[]): SubmitResult {
  if (expired.length === 0) return result;
  return { ...result, cancellations: [...expired, ...result.cancellations] };
}

/**
 * Incoming option is already due. Pull other due rests, then expire this order.
 * This runs before orig and before applyFills, so the taker does not print and the option position map does not gain a long or a short.
 */
function expireIncomingDue(book: OrderBook, order: EngineOrder, now: Date): SubmitResult {
  const expired = [...expireDueOptions(book, now), ...pullClockDue(book, now)];
  const seq = book as unknown as {
    nextSequence: () => number;
    rememberAccepted: (orderId: string) => void;
  };
  const sequence = seq.nextSequence();
  seq.rememberAccepted(order.orderId);
  return {
    accepted: true,
    sequence,
    fills: [],
    resting: null,
    cancellations: [
      ...expired,
      {
        orderId: order.orderId,
        accountId: order.accountId,
        remainingQty: order.qty,
        sequence,
        reason: 'expired',
      },
    ],
    triggered: [],
  };
}

export function installOption(ctor: typeof OrderBook): void {
  if (!ctor) return;
  const proto = ctor.prototype as {
    submit: (order: EngineOrder, now?: Date | null) => SubmitResult;
    cancel: (orderId: string, reason?: 'expired' | 'requested') => { cancellation: CancelledRef | null };
    amend: (cmd: EngineAmend, now?: Date | null) => AmendResult;
    [FLAG]?: boolean;
  };
  if (proto[FLAG]) return;
  proto[FLAG] = true;
  registerOptionActivationGuard((book, order) => nonOptionTakeRefuse(book, order));

  const orig = proto.submit;
  const origCancel = proto.cancel as OrderBook['cancel'];
  const origAmend = proto.amend;
  proto.cancel = function (this: OrderBook, orderId: string, reason?: 'expired' | 'requested') {
    const result = origCancel.call(this, orderId, reason);
    if (result.cancellation) of(this).rest.delete(orderId);
    return result;
  };
  proto.amend = function (this: OrderBook, cmd: EngineAmend, now?: Date | null) {
    const field = unsupportedAmendField(cmd);
    if (field) return amendRefused(cmd.orderId, field.code, field.message);
    const decision = optionAmendDecision(this, cmd);
    if (decision.kind === 'refuse') return decision.result;
    if (decision.kind === 'apply') {
      const rec = books.get(this)?.rest.get(cmd.orderId);
      const quote = restingQuote(this, cmd.orderId);
      if (rec && quote) {
        const extra = cmd as OptionAmendExtra;
        const price = extra.price !== undefined ? extra.price : quote.price;
        if (price !== null && price > ZERO) {
          const disagrees = takeDisagrees(this, { side: quote.side, price }, rec.strike, rec.expiry);
          if (disagrees) return amendRefused(cmd.orderId, disagrees.code, disagrees.message);
        }
      }
      const result = origAmend.call(this, decision.patch, now);
      if (result.accepted && rec) applyFills(of(this).open, result.fills, rec.strike, rec.expiry);
      return result;
    }
    const crossed = nonOptionAmendRefuse(this, cmd, now);
    if (crossed) {
      const due = pullClockDue(this, now);
      return { ...amendRefused(cmd.orderId, crossed.code, crossed.message), cancellations: due };
    }
    of(this);
    return origAmend.call(this, cmd, now);
  };

  proto.submit = function (this: OrderBook, order: EngineOrder, now?: Date | null) {
    const comboed = comboIntentRefuse(order);
    if (comboed) return rejected(comboed.code, comboed.message);
    if (wantsCover(order as { readonly cover?: boolean })) {
      const strike = readStrike(order);
      const missingStrike = strikeRefuse(strike);
      if (missingStrike) return rejected(missingStrike.code, missingStrike.message);
      const expiry = readExpiry(order);
      const missingExpiry = expiryRefuse(expiry);
      if (missingExpiry) return rejected(missingExpiry.code, missingExpiry.message);
      if (order.qty <= ZERO) {
        return rejected('invalid_qty', 'an option cover requires a qty; the engine does not invent a mark');
      }
      const book = this as unknown as {
        nextSequence: () => number;
        addPosition: (accountId: string, delta: Amount) => void;
      };
      const rows = of(this);
      const key = contractKey(strike as Amount, expiry as string);
      const clips = clipPositive(order.accountId, rows.assigned.get(key)?.get(order.accountId), order.qty);
      if (!clips) {
        return rejected('position_flat', 'cover is a short option after assignment; the engine does not invent a mark');
      }
      const expired = expireDueOptions(this, now);
      const sequence = book.nextSequence();
      const fills: Fill[] = [];
      for (const clip of clips) {
        fills.push({
          sequence,
          makerOrderId: clip.orderId,
          makerAccountId: order.accountId,
          takerOrderId: order.orderId,
          takerAccountId: order.accountId,
          takerSide: 'buy',
          price: strike as Amount,
          qty: clip.qty,
        });
        bump(rows.assigned, key, order.accountId, clip.orderId, -clip.qty);
      }
      return withExpired(
        {
          accepted: true,
          sequence,
          fills,
          resting: null,
          cancellations: [],
          triggered: [],
        },
        expired,
      );
    }
    if (wantsExercise(order)) {
      const strike = readStrike(order);
      const missingStrike = strikeRefuse(strike);
      if (missingStrike) return rejected(missingStrike.code, missingStrike.message);
      const expiry = readExpiry(order);
      const missingExpiry = expiryRefuse(expiry);
      if (missingExpiry) return rejected(missingExpiry.code, missingExpiry.message);
      if (order.qty <= ZERO) {
        return rejected('invalid_qty', 'an option exercise requires a qty; the engine does not invent a mark');
      }
      const book = this as unknown as {
        nextSequence: () => number;
        addPosition: (accountId: string, delta: Amount) => void;
      };
      const rows = of(this);
      const key = contractKey(strike as Amount, expiry as string);
      const lots = rows.open.get(key);
      const longQty = netQty(lots?.get(order.accountId));
      if (longQty <= ZERO || longQty < order.qty) {
        return rejected('position_flat', 'exercise is a long option; the engine does not invent a mark');
      }
      const clips = assignShorts(lots, order.accountId, order.qty);
      if (!clips) {
        return rejected('position_flat', 'exercise assigns a short option; the engine does not invent a mark');
      }
      const expired = expireDueOptions(this, now);
      const sequence = book.nextSequence();
      const fills: Fill[] = [];
      for (const clip of clips) {
        fills.push({
          sequence,
          makerOrderId: clip.orderId,
          makerAccountId: clip.accountId,
          takerOrderId: order.orderId,
          takerAccountId: order.accountId,
          takerSide: 'sell',
          price: strike as Amount,
          qty: clip.qty,
        });
        book.addPosition(clip.accountId, clip.qty);
        bump(rows.open, key, clip.accountId, clip.orderId, clip.qty);
        bump(rows.assigned, key, clip.accountId, clip.orderId, clip.qty);
      }
      book.addPosition(order.accountId, -order.qty);
      bump(rows.open, key, order.accountId, order.orderId, -order.qty);
      return withExpired(
        {
          accepted: true,
          sequence,
          fills,
          resting: null,
          cancellations: [],
          triggered: [],
        },
        expired,
      );
    }
    if (wantsCancel(order as { cancel?: boolean })) {
      const strike = readStrike(order);
      const missingStrike = strikeRefuse(strike);
      if (missingStrike) return rejected(missingStrike.code, missingStrike.message);
      const expiry = readExpiry(order);
      const missingExpiry = expiryRefuse(expiry);
      if (missingExpiry) return rejected(missingExpiry.code, missingExpiry.message);
      const rec = of(this).rest.get(order.orderId);
      if (!rec) {
        return rejected('order_not_found', 'cancel is a resting option; the engine does not invent a mark');
      }
      if (rec.strike !== strike) {
        return rejected(STRIKE_DISAGREES, 'cancel is a resting option with the same strike; the engine does not invent a mark');
      }
      if (rec.expiry !== expiry) {
        return rejected(EXPIRY_DISAGREES, 'cancel is a resting option with the same expiry; the engine does not invent a mark');
      }
      const pulled = origCancel.call(this, order.orderId, 'requested');
      of(this).rest.delete(order.orderId);
      if (!pulled.cancellation) {
        return rejected('order_not_found', 'cancel is a resting option; the engine does not invent a mark');
      }
      return {
        accepted: true,
        sequence: pulled.cancellation.sequence,
        fills: [],
        resting: null,
        cancellations: [pulled.cancellation],
        triggered: [],
      };
    }
    if (!wantsOption(order)) {
      const expired = expireDueOptions(this, now);
      const crossed = nonOptionTakeRefuse(this, order, now);
      if (crossed) return withExpired(rejected(crossed.code, crossed.message), [...expired, ...pullClockDue(this, now)]);
      return withExpired(orig.call(this, order, now), expired);
    }
    const strike = readStrike(order);
    const missingStrike = strikeRefuse(strike);
    if (missingStrike) return rejected(missingStrike.code, missingStrike.message);
    const expiry = readExpiry(order);
    const missingExpiry = expiryRefuse(expiry);
    if (missingExpiry) return rejected(missingExpiry.code, missingExpiry.message);
    const price = order.price;
    if (price === null || price <= ZERO) {
      return rejected('invalid_price', 'an option rests as a limit; the engine does not invent a mark');
    }
    if (now != null && order.qty > ZERO && dueAt(expiry as string, now)) {
      return expireIncomingDue(this, order, now);
    }
    const expired = expireDueOptions(this, now);
    const disagrees = takeDisagrees(this, { side: order.side, price }, strike as Amount, expiry as string);
    if (disagrees) return withExpired(rejected(disagrees.code, disagrees.message), expired);
    const result = orig.call(
      this,
      {
        ...order,
        type: 'limit',
        price,
        strike,
        expiry,
      },
      now,
    );
    if (result.accepted) {
      applyFills(of(this).open, result.fills, strike as Amount, expiry as string);
      if (result.resting) remember(this, order.orderId, { strike: strike as Amount, expiry: expiry as string });
    }
    return withExpired(result, expired);
  };
}

installOption(OrderBook);
