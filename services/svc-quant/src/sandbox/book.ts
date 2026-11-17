import { add, div, formatAmount, mul, parseAmount, sub, type Amount } from '@intafaced/ledger-client/money';
import { QUANT_PAPER_FEE_UNSET, QUANT_VENUE_VAULT_UNSET, QuantError } from '../errors.js';

/** Fixture marks for the internal paper book. Not a live feed. Not a network. */
export const INTERNAL_MARKS: Readonly<Record<string, string>> = {
  'BTC-USD': '50000',
  'ETH-USD': '3000',
  'IFC-USD': '1',
};

/**
 * TEST price path the paper book walks after a run's script ends, so a resting limit order can fill "when the price
 * reaches it" (AL-orders-01). Each path starts and ends at the symbol's fixture mark, so a run's end mark and its pnl
 * are those of the mark. It is a fixture, never a feed, and the result names it as TEST.
 */
export const TEST_TICKS: Readonly<Record<string, readonly string[]>> = {
  'BTC-USD': ['49995', '49985', '50010', '50000'],
  'ETH-USD': ['2999.5', '2998.5', '3001', '3000'],
  'IFC-USD': ['0.9995', '0.9985', '1.001', '1'],
};

export interface PaperFill {
  readonly side: 'buy' | 'sell';
  readonly symbol: string;
  readonly qty: string;
  readonly price: string;
  readonly venue: 'internal';
}

export type OrderType = 'market' | 'limit';
export type TimeInForce = 'gtc' | 'ioc';
export type OrderStatus = 'accepted' | 'filled' | 'rejected' | 'cancelled';
export type OrderEventKind = 'new' | 'accepted' | 'filled' | 'rejected' | 'cancel_pending' | 'cancelled';

/** Why an order was rejected, as the strategy and the screen read it. */
export type RejectReason =
  | 'quantity invalid'
  | 'price invalid'
  | 'time in force invalid'
  | 'unknown symbol'
  | 'limit hit'
  | 'insufficient cash'
  | 'exceeds position'
  | 'no short rule'
  | 'unknown order'
  | 'not open';

/** One event of one order, in the order it happened. Every figure is a decimal string. */
export interface OrderEvent {
  readonly seq: number;
  readonly order: string;
  readonly kind: OrderEventKind;
  readonly type: OrderType;
  readonly side: 'buy' | 'sell';
  readonly symbol: string;
  readonly qty: string;
  readonly tif: TimeInForce;
  /** The mark when the event happened. */
  readonly market: string;
  readonly limit?: string;
  readonly price?: string;
  readonly reason?: RejectReason;
  /** On a cash rejection: what the order needed and what the book held. */
  readonly notional?: string;
  readonly fee?: string;
  readonly cash?: string;
  /** On a position rejection: the position and what resting sells already hold of it. */
  readonly position?: string;
  readonly reserved?: string;
}

/** What the strategy gets back from an order call: a snapshot at the moment of the call. */
export interface OrderAck {
  readonly id: string;
  readonly status: OrderStatus;
  readonly reason: RejectReason | null;
}

/** One leg of a reversal, each checked on its own. */
export interface ReverseLeg {
  readonly leg: 'close' | 'open';
  readonly side: 'buy' | 'sell';
  readonly symbol: string;
  readonly qty: string;
  readonly checked: true;
  readonly outcome: 'filled' | 'refused';
  readonly order: string;
  readonly reason: RejectReason | null;
}

export interface ReverseAck {
  readonly legs: readonly ReverseLeg[];
}

export interface PaperBook {
  last(symbol: string): string;
  bid(symbol: string): string;
  ask(symbol: string): string;
  buy(symbol: string, qty: string): OrderAck;
  sell(symbol: string, qty: string): OrderAck;
  limitBuy(symbol: string, qty: string, limit: string, tif: string): OrderAck;
  limitSell(symbol: string, qty: string, limit: string, tif: string): OrderAck;
  cancel(id: string): OrderAck;
  setPyramiding(entries: string): void;
  reverse(symbol: string, target: string): ReverseAck;
  /** Walks the TEST price path once, filling resting limits it reaches. Called once, after the script. */
  settle(): void;
  venueBuy(symbol: string, qty: string): PaperFill;
  venueSell(symbol: string, qty: string): PaperFill;
  cash(): string;
  position(symbol: string): string;
  pnl(): string;
  fills(): readonly PaperFill[];
  events(): readonly OrderEvent[];
  legs(): readonly ReverseLeg[];
}

export interface PaperBookOptions {
  readonly startingCash: string;
  readonly marks?: Readonly<Record<string, string>>;
  /** When false, venue OMS refuses `quant.venue_vault_unset`. */
  readonly venueVaultSet: boolean;
  /**
   * The paper book's fee rate in basis points of notional, an owner value (QUANT_PAPER_FEE_BPS). Blank refuses every
   * order `quant.paper_fee_unset`: the pre-trade check is notional plus fee, and a fee is never invented as zero.
   */
  readonly feeBps?: string | null;
}

interface Resting {
  readonly id: string;
  readonly side: 'buy' | 'sell';
  readonly symbol: string;
  readonly qty: Amount;
  readonly limit: Amount;
  readonly tif: TimeInForce;
}

const BPS = parseAmount('10000');

function decimal(raw: unknown): Amount | null {
  if (typeof raw !== 'string' || !/^-?\d+(\.\d+)?$/.test(raw.trim())) return null;
  try {
    return parseAmount(raw.trim());
  } catch {
    return null;
  }
}

export function createPaperBook(options: PaperBookOptions): PaperBook {
  const marks = { ...INTERNAL_MARKS, ...options.marks };
  let cash: Amount = parseAmount(options.startingCash);
  const starting = cash;
  const positions = new Map<string, Amount>();
  /** Filled entries since the position was last flat, per symbol (pyramiding). */
  const entries = new Map<string, number>();
  const fills: PaperFill[] = [];
  const events: OrderEvent[] = [];
  const legs: ReverseLeg[] = [];
  const resting = new Map<string, Resting>();
  const done = new Set<string>();
  let pyramiding: number | null = null;
  let nextId = 1;
  let settled = false;
  /** The mark each symbol trades at now: the fixture, or the TEST path's tick while settling. */
  const now = new Map<string, Amount>();

  const feeRate = (): Amount => {
    const raw = options.feeBps;
    const bps = raw == null ? null : decimal(raw);
    if (bps === null || bps < 0n) {
      throw new QuantError(QUANT_PAPER_FEE_UNSET, 'QUANT_PAPER_FEE_BPS is unset — the paper fee is never invented as zero');
    }
    return bps;
  };
  const feeOf = (notional: Amount): Amount => div(mul(notional, feeRate(), 'half-up'), BPS, 'half-up');

  const known = (symbol: string): boolean => typeof marks[symbol] === 'string';
  const markOf = (symbol: string): Amount => {
    const live = now.get(symbol);
    if (live !== undefined) return live;
    const m = marks[symbol];
    if (!m) throw new QuantError('quant.params_invalid', `unknown symbol ${symbol}`);
    return parseAmount(m);
  };
  const positionOf = (symbol: string): Amount => positions.get(symbol) ?? 0n;
  /** Cash held by resting buys at their limit, fee included. */
  const cashReserved = (): Amount => {
    let held = 0n;
    for (const r of resting.values()) {
      if (r.side !== 'buy') continue;
      const notional = mul(r.qty, r.limit, 'half-up');
      held = add(held, add(notional, feeOf(notional)));
    }
    return held;
  };
  const sellsReserved = (symbol: string): Amount => {
    let held = 0n;
    for (const r of resting.values()) if (r.side === 'sell' && r.symbol === symbol) held = add(held, r.qty);
    return held;
  };

  type Base = Pick<OrderEvent, 'order' | 'type' | 'side' | 'symbol' | 'qty' | 'tif'> & { limit?: string };
  const emit = (base: Base, kind: OrderEventKind, extra: Partial<OrderEvent> = {}) => {
    const market = known(base.symbol) ? formatAmount(markOf(base.symbol)) : '0';
    events.push({ seq: events.length + 1, ...base, kind, market, ...extra });
  };
  const reject = (base: Base, reason: RejectReason, extra: Partial<OrderEvent> = {}): OrderAck => {
    emit(base, 'rejected', { reason, ...extra });
    done.add(base.order);
    return { id: base.order, status: 'rejected', reason };
  };

  const fill = (base: Base, qty: Amount, price: Amount) => {
    const notional = mul(qty, price, 'half-up');
    const fee = feeOf(notional);
    const pos = positionOf(base.symbol);
    if (base.side === 'buy') {
      cash = sub(cash, add(notional, fee));
      positions.set(base.symbol, add(pos, qty));
      entries.set(base.symbol, pos === 0n ? 1 : (entries.get(base.symbol) ?? 0) + 1);
    } else {
      cash = sub(add(cash, notional), fee);
      const left = sub(pos, qty);
      positions.set(base.symbol, left);
      if (left === 0n) entries.set(base.symbol, 0);
    }
    fills.push({ side: base.side, symbol: base.symbol, qty: formatAmount(qty), price: formatAmount(price), venue: 'internal' });
    emit(base, 'filled', { price: formatAmount(price), fee: formatAmount(fee) });
    done.add(base.order);
  };

  /** The pre-trade checks, in order. Returns the rejection, or null when the order may go on. */
  const check = (base: Base, qty: Amount, price: Amount): ((b: Base) => OrderAck) | null => {
    if (base.side === 'buy') {
      if (pyramiding !== null && positionOf(base.symbol) > 0n && (entries.get(base.symbol) ?? 0) >= pyramiding) {
        return (b) => reject(b, 'limit hit');
      }
      const notional = mul(qty, price, 'half-up');
      const fee = feeOf(notional);
      const free = sub(cash, cashReserved());
      if (add(notional, fee) > free) {
        return (b) =>
          reject(b, 'insufficient cash', { notional: formatAmount(notional), fee: formatAmount(fee), cash: formatAmount(free) });
      }
      return null;
    }
    // Spot paper: a sell may close what is held, never open a short. Resting sells already hold part of it.
    const pos = positionOf(base.symbol);
    const held = sellsReserved(base.symbol);
    if (pos <= 0n) return (b) => reject(b, 'no short rule', { position: formatAmount(pos), reserved: formatAmount(held) });
    if (add(qty, held) > pos) {
      return (b) => reject(b, 'exceeds position', { position: formatAmount(pos), reserved: formatAmount(held) });
    }
    return null;
  };

  const place = (side: 'buy' | 'sell', symbol: string, qtyRaw: string, type: OrderType, limitRaw?: string, tifRaw?: string): OrderAck => {
    if (settled) throw new QuantError('quant.params_invalid', 'the run has ended; no order may be placed');
    feeRate();
    const order = `o${nextId++}`;
    const qty = decimal(qtyRaw);
    const tif: TimeInForce = tifRaw === 'ioc' ? 'ioc' : 'gtc';
    const base: Base = {
      order,
      type,
      side,
      symbol,
      qty: qty === null ? String(qtyRaw) : formatAmount(qty),
      tif,
      ...(type === 'limit' ? { limit: decimal(limitRaw) === null ? String(limitRaw) : formatAmount(decimal(limitRaw) as Amount) } : {}),
    };
    if (!known(symbol)) return reject(base, 'unknown symbol');
    if (qty === null || qty <= 0n) return reject(base, 'quantity invalid');
    let limit: Amount | null = null;
    if (type === 'limit') {
      limit = decimal(limitRaw);
      if (limit === null || limit <= 0n) return reject(base, 'price invalid');
      if (tifRaw !== 'gtc' && tifRaw !== 'ioc') return reject(base, 'time in force invalid');
    }
    const mark = markOf(symbol);
    const marketable = limit === null || (side === 'buy' ? mark <= limit : mark >= limit);
    // A resting buy holds cash at its limit; a marketable one is checked at the mark it fills at.
    const refused = check(base, qty, marketable ? mark : (limit as Amount));
    if (refused) return refused(base);
    emit(base, 'new');
    emit(base, 'accepted');
    if (marketable) {
      fill(base, qty, mark);
      return { id: order, status: 'filled', reason: null };
    }
    if (tif === 'ioc') {
      emit(base, 'cancelled');
      done.add(order);
      return { id: order, status: 'cancelled', reason: null };
    }
    resting.set(order, { id: order, side, symbol, qty, limit: limit as Amount, tif });
    return { id: order, status: 'accepted', reason: null };
  };

  const baseOf = (r: Resting): Base => ({
    order: r.id,
    type: 'limit',
    side: r.side,
    symbol: r.symbol,
    qty: formatAmount(r.qty),
    tif: r.tif,
    limit: formatAmount(r.limit),
  });

  const venue = (_side: 'buy' | 'sell', _symbol: string, _qty: string): PaperFill => {
    if (!options.venueVaultSet) {
      throw new QuantError(
        QUANT_VENUE_VAULT_UNSET,
        'Venue Vault unset — internal book still runs; venue OMS is trade-only when QUANT_VENUE_VAULT is set',
      );
    }
    // Env is set, but this process still has no vault unwrap. Refuse rather
    // than paint an external fill that never left the paper book.
    throw new QuantError(QUANT_VENUE_VAULT_UNSET, 'Venue Vault pin is set but trade-only unwrap is not wired — internal book still runs');
  };

  return {
    last: (symbol) => formatAmount(markOf(symbol)),
    bid: (symbol) => formatAmount(markOf(symbol)),
    ask: (symbol) => formatAmount(markOf(symbol)),
    buy: (symbol, qty) => place('buy', symbol, qty, 'market'),
    sell: (symbol, qty) => place('sell', symbol, qty, 'market'),
    limitBuy: (symbol, qty, limit, tif) => place('buy', symbol, qty, 'limit', limit, tif),
    limitSell: (symbol, qty, limit, tif) => place('sell', symbol, qty, 'limit', limit, tif),
    cancel: (id) => {
      const r = resting.get(id);
      if (!r) {
        if (done.has(id)) return { id, status: 'rejected', reason: 'not open' };
        return { id, status: 'rejected', reason: 'unknown order' };
      }
      const base = baseOf(r);
      emit(base, 'cancel_pending');
      resting.delete(id);
      emit(base, 'cancelled');
      done.add(id);
      return { id, status: 'cancelled', reason: null };
    },
    setPyramiding: (raw) => {
      const n = decimal(raw);
      if (n === null || n < parseAmount('1') || formatAmount(n).includes('.')) {
        throw new QuantError('quant.param_out_of_range', 'pyramiding — entries at most must be a whole number of 1 or more');
      }
      pyramiding = Number(formatAmount(n));
    },
    reverse: (symbol, targetRaw) => {
      const target = decimal(targetRaw);
      if (target === null || target === 0n)
        throw new QuantError('quant.params_invalid', 'reverse — the target position is a signed decimal string');
      const pos = positionOf(symbol);
      if (pos === 0n || pos > 0n === target > 0n) {
        throw new QuantError('quant.params_invalid', 'reverse — the target must be on the other side of the open position');
      }
      const closeSide = pos > 0n ? 'sell' : 'buy';
      const abs = (v: Amount) => (v < 0n ? -v : v);
      const out: ReverseLeg[] = [];
      const close = place(closeSide, symbol, formatAmount(abs(pos)), 'market');
      out.push({
        leg: 'close',
        side: closeSide,
        symbol,
        qty: formatAmount(abs(pos)),
        checked: true,
        outcome: close.status === 'filled' ? 'filled' : 'refused',
        order: close.id,
        reason: close.reason,
      });
      if (close.status === 'filled') {
        const opened = place(closeSide, symbol, formatAmount(abs(target)), 'market');
        out.push({
          leg: 'open',
          side: closeSide,
          symbol,
          qty: formatAmount(abs(target)),
          checked: true,
          outcome: opened.status === 'filled' ? 'filled' : 'refused',
          order: opened.id,
          reason: opened.reason,
        });
      }
      legs.push(...out);
      return { legs: out };
    },
    settle: () => {
      if (settled) return;
      settled = true;
      const symbols = new Set([...resting.values()].map((r) => r.symbol));
      for (const symbol of symbols) {
        if (options.marks?.[symbol] !== undefined) continue; // a caller's own mark has no TEST path
        for (const tick of TEST_TICKS[symbol] ?? []) {
          now.set(symbol, parseAmount(tick));
          for (const r of [...resting.values()]) {
            if (r.symbol !== symbol) continue;
            const price = parseAmount(tick);
            const reached = r.side === 'buy' ? price <= r.limit : price >= r.limit;
            if (!reached) continue;
            resting.delete(r.id);
            fill(baseOf(r), r.qty, price);
          }
        }
        now.delete(symbol);
      }
    },
    venueBuy: (symbol, qty) => venue('buy', symbol, qty),
    venueSell: (symbol, qty) => venue('sell', symbol, qty),
    cash: () => formatAmount(cash),
    position: (symbol) => formatAmount(positionOf(symbol)),
    pnl: () => {
      let equity = cash;
      for (const [symbol, qty] of positions) {
        equity = add(equity, mul(qty, markOf(symbol), 'half-up'));
      }
      return formatAmount(sub(equity, starting));
    },
    fills: () => fills,
    events: () => events,
    legs: () => legs,
  };
}
