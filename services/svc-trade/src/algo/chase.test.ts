import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { TradeError, type OrderSide } from '../spot/types.js';
import { algoStopReason } from './stop-reason.js';
import { presentChase } from './present.js';
import {
  CANCEL_INCOMPLETE_HALT,
  CHASE_EXPIRED_HALT,
  CHASE_MAX_DISTANCE_HALT,
  TwapEngine,
  beyondChaseDistance,
  chaseFurthestPrice,
  type TwapEnginePorts,
} from './twap-engine.js';
import type { CreateTwapInput } from './types.js';

const LOT = parseAmount('0.01');
const MARKET = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';
const p = parseAmount;

interface SimOrder {
  price: Amount;
  qty: Amount;
  filled: Amount;
  /** Matched by the engine, its fill rows not written yet (the taker's settlement is still on its way). */
  matched: Amount;
  open: boolean;
}

/** A book with one other participant's best price per side, plus the chase's own children. */
function makeChase(side: OrderSide = 'buy', opts: { cancelFails?: boolean; noChildReader?: boolean } = {}) {
  let t = 1_700_000_000_000;
  const book = { otherBid: p('0.99') as Amount | null, otherAsk: p('1.10') as Amount | null };
  const orders = new Map<string, SimOrder>();
  const placed: Array<{ price: Amount | null; qty: Amount; clientOrderId: string }> = [];
  const cancels: string[] = [];
  let cancelFails = opts.cancelFails ?? false;
  let cancelNoop = false;
  let onPlace: (() => Promise<unknown>) | null = null;
  const byClientId = new Map<string, string>();
  const ownOpen = () => [...orders.values()].filter((o) => o.open);
  const ports: TwapEnginePorts = {
    now: () => new Date(t),
    randomId: () => `id-${t}`,
    placeChild: async (req) => {
      const orderId = `order-${placed.length}`;
      placed.push({ price: req.limitPrice, qty: req.qty, clientOrderId: req.clientOrderId });
      orders.set(orderId, { price: req.limitPrice!, qty: req.qty, filled: 0n, matched: 0n, open: true });
      byClientId.set(req.clientOrderId, orderId);
      const hook = onPlace;
      onPlace = null;
      if (hook) await hook();
      return { orderId };
    },
    cancelChild: async (orderId) => {
      cancels.push(orderId);
      if (cancelFails) throw new TradeError('venue down', 'trade.algo_child_refused');
      const o = orders.get(orderId);
      if (!o) return { engineRemainingQty: null };
      const remaining = o.qty - o.filled - o.matched;
      if (!cancelNoop) o.open = false;
      // What the engine still held: nothing once the matched and filled parts cover the child.
      return { engineRemainingQty: remaining > 0n ? remaining : 0n };
    },
    chaseChildByClientOrderId: async (_parent, clientOrderId) => {
      const orderId = byClientId.get(clientOrderId);
      const o = orderId ? orders.get(orderId) : undefined;
      return orderId && o ? { orderId, qty: o.qty, price: o.price, placedAt: new Date(t) } : null;
    },
    // bestOpposingPrice(m, 'sell') is the best bid; the chase's own resting child is part of that side.
    bestOpposingPrice: async (_m, s) => {
      if (s === 'sell') {
        const prices = [
          book.otherBid,
          ...ownOpen()
            .filter(() => side === 'buy')
            .map((o) => o.price),
        ].filter((x): x is Amount => x !== null);
        return prices.length ? prices.reduce((a, b) => (b > a ? b : a)) : null;
      }
      const prices = [
        book.otherAsk,
        ...ownOpen()
          .filter(() => side === 'sell')
          .map((o) => o.price),
      ].filter((x): x is Amount => x !== null);
      return prices.length ? prices.reduce((a, b) => (b < a ? b : a)) : null;
    },
    markFor: async () => null,
    ...(opts.noChildReader
      ? {}
      : {
          chaseChildState: async (ids: readonly string[]) => {
            let filledQty = 0n;
            const filledByOrderId = new Map<string, Amount>();
            const openOrderIds = new Set<string>();
            for (const id of ids) {
              const o = orders.get(id);
              if (!o) continue;
              filledQty += o.filled;
              if (o.filled > 0n) filledByOrderId.set(id, o.filled);
              if (o.open) openOrderIds.add(id);
            }
            return { filledQty, filledByOrderId, openOrderIds };
          },
        }),
  };
  const engine = new TwapEngine(ports);
  const start = side === 'buy' ? book.otherBid! : book.otherAsk!;
  const input = (over: Partial<CreateTwapInput> = {}): CreateTwapInput => ({
    marketId: MARKET,
    symbol: 'IFC/USDC',
    side,
    totalQty: p('1'),
    durationMs: 600_000,
    sliceIntervalMs: 5_000,
    limitPrice: null,
    subAccountId: null,
    clientAlgoId: `chase-${t}`,
    kind: 'chase',
    chaseMaxDistanceBps: 200,
    chaseStartPrice: start,
    ...over,
  });
  return {
    engine,
    book,
    orders,
    placed,
    cancels,
    input,
    setCancelFails: (v: boolean) => (cancelFails = v),
    setCancelNoop: (v: boolean) => (cancelNoop = v),
    /** Run `fn` while the next child is being placed (after the order exists, before the engine hears back). */
    duringNextPlace: (fn: () => Promise<unknown>) => (onPlace = fn),
    /** An order the engine never heard of, under `clientOrderId`: what a crash between place and save leaves. */
    stray: (clientOrderId: string, price: string, qty: string) => {
      const orderId = `stray-${clientOrderId}`;
      orders.set(orderId, { price: p(price), qty: p(qty), filled: 0n, matched: 0n, open: true });
      byClientId.set(clientOrderId, orderId);
      return orderId;
    },
    ownOpen: () => [...orders.entries()].filter(([, o]) => o.open).map(([id]) => id),
    advance: (ms: number) => (t += ms),
    fill: (orderId: string, qty: string, close = false) => {
      const o = orders.get(orderId)!;
      o.filled += p(qty);
      if (close) o.open = false;
    },
    /** A seller's sweep matched `qty` of this child in the engine; its fill rows land only at `settle`. */
    engineMatch: (orderId: string, qty: string) => {
      orders.get(orderId)!.matched += p(qty);
    },
    /** The taker's settlement lands: the matched quantity becomes fill rows. */
    settle: (orderId: string) => {
      const o = orders.get(orderId)!;
      o.filled += o.matched;
      o.matched = 0n;
    },
  };
}

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof TradeError) return err.code;
    throw err;
  }
  return undefined;
}

describe('chase limit order with a maximum distance', () => {
  it('joins the best bid, and does not re-price while the book does not move', async () => {
    const c = makeChase();
    const parent = c.engine.create(USER, c.input(), LOT);
    expect(parent.chaseStartPrice).toBe(p('0.99'));
    expect((await c.engine.tick(parent.id)).kind).toBe('placed');
    expect(c.placed).toEqual([{ price: p('0.99'), qty: p('1'), clientOrderId: `algo:${parent.id}:0` }]);
    for (let i = 0; i < 3; i++) {
      c.advance(5_000);
      expect(await c.engine.tick(parent.id)).toEqual({ kind: 'idle', reason: 'no_book_move' });
    }
    expect(c.placed).toHaveLength(1);
    expect(c.cancels).toHaveLength(0);
  });

  it('re-prices once per book move: cancels the old child once and rests the rest at the new best', async () => {
    const c = makeChase();
    const parent = c.engine.create(USER, c.input(), LOT);
    await c.engine.tick(parent.id);
    c.book.otherBid = p('1.00');
    expect((await c.engine.tick(parent.id)).kind).toBe('placed');
    expect(c.cancels).toEqual(['order-0']);
    expect(c.placed.map((o) => o.price)).toEqual([p('0.99'), p('1.00')]);
    // The same book on the next ticks is no move: no second re-price.
    expect((await c.engine.tick(parent.id)).kind).toBe('idle');
    expect((await c.engine.tick(parent.id)).kind).toBe('idle');
    expect(c.placed).toHaveLength(2);
    expect(c.cancels).toEqual(['order-0']);
    const live = c.engine.get(parent.id)!;
    expect(live.children.map((ch) => ch.price)).toEqual([p('0.99'), p('1.00')]);
    expect(live.children[1]!.clientOrderId).toBe(`algo:${parent.id}:1`);
    expect(live.status).toBe('active');
  });

  it('the parent view reads back the distance, the start price, the current price and one re-price', async () => {
    const c = makeChase();
    const parent = c.engine.create(USER, c.input(), LOT);
    await c.engine.tick(parent.id);
    expect(presentChase(c.engine.get(parent.id)!)).toEqual({
      chaseMaxDistanceBps: 200,
      chaseStartPrice: formatAmount(p('0.99')),
      chasePrice: formatAmount(p('0.99')),
      chaseReprices: 0,
    });
    c.book.otherBid = p('1.00');
    await c.engine.tick(parent.id);
    await c.engine.tick(parent.id);
    expect(presentChase(c.engine.get(parent.id)!)).toMatchObject({ chasePrice: formatAmount(p('1.00')), chaseReprices: 1 });
  });

  it('a child re-placed at the same price after a crash is not counted as a re-price', async () => {
    const c = makeChase();
    const parent = c.engine.create(USER, c.input(), LOT);
    await c.engine.tick(parent.id);
    c.orders.get('order-0')!.open = false; // cancelled, new child never placed; the book did not move
    expect((await c.engine.tick(parent.id)).kind).toBe('placed');
    expect(c.placed.map((o) => o.price)).toEqual([p('0.99'), p('0.99')]);
    expect(presentChase(c.engine.get(parent.id)!).chaseReprices).toBe(0);
  });

  it('does not follow the book away from it: a lower bid elsewhere is no move for a buy', async () => {
    const c = makeChase();
    const parent = c.engine.create(USER, c.input(), LOT);
    await c.engine.tick(parent.id);
    c.book.otherBid = p('0.95');
    expect(await c.engine.tick(parent.id)).toEqual({ kind: 'idle', reason: 'no_book_move' });
    expect(c.placed).toHaveLength(1);
  });

  it('re-prices up to exactly the distance, and never past it', async () => {
    const c = makeChase();
    const parent = c.engine.create(USER, c.input(), LOT);
    await c.engine.tick(parent.id);
    // 2% of 0.99 is 0.0198: 1.0098 is exactly at the distance, still allowed.
    c.book.otherBid = p('1.0098');
    expect((await c.engine.tick(parent.id)).kind).toBe('placed');
    expect(c.placed[1]!.price).toBe(p('1.0098'));
    expect(beyondChaseDistance('buy', p('0.99'), p('1.0098'), 200)).toBe(false);
    expect(beyondChaseDistance('buy', p('0.99'), p('1.0099'), 200)).toBe(true);
  });

  it('beyond the distance stops with that reason and cancels once', async () => {
    const c = makeChase();
    const parent = c.engine.create(USER, c.input(), LOT);
    await c.engine.tick(parent.id);
    c.book.otherBid = p('1.00');
    await c.engine.tick(parent.id);
    c.book.otherBid = p('1.05');
    expect(await c.engine.tick(parent.id)).toEqual({ kind: 'idle', reason: 'halted' });
    const stopped = c.engine.get(parent.id)!;
    expect(stopped.status).toBe('halted');
    expect(stopped.haltReason).toBe(CHASE_MAX_DISTANCE_HALT);
    expect(algoStopReason(stopped)).toEqual({ code: 'chase_max_distance', label: 'Maximum chase distance reached' });
    expect(c.cancels).toEqual(['order-0', 'order-1']);
    expect(c.orders.get('order-1')!.open).toBe(false);
    // Later ticks place nothing and cancel nothing more.
    for (let i = 0; i < 3; i++) await c.engine.tick(parent.id);
    expect(c.placed).toHaveLength(2);
    expect(c.cancels).toEqual(['order-0', 'order-1']);
  });

  it('a partial fill re-prices only the unfilled rest; a full fill completes with no new child', async () => {
    const c = makeChase();
    const parent = c.engine.create(USER, c.input(), LOT);
    await c.engine.tick(parent.id);
    c.fill('order-0', '0.4');
    c.book.otherBid = p('1.00');
    await c.engine.tick(parent.id);
    expect(c.placed[1]!.qty).toBe(p('0.6'));
    c.fill('order-1', '0.6', true);
    expect((await c.engine.tick(parent.id)).kind).toBe('completed');
    c.book.otherBid = p('1.01');
    await c.engine.tick(parent.id);
    expect(c.placed).toHaveLength(2);
    expect(c.engine.get(parent.id)!.status).toBe('completed');
  });

  it('a failed cancel on a re-price places no second order and parks the chase as cancel-incomplete', async () => {
    const c = makeChase();
    const parent = c.engine.create(USER, c.input(), LOT);
    await c.engine.tick(parent.id);
    c.setCancelFails(true);
    c.book.otherBid = p('1.00');
    const r = await c.engine.tick(parent.id);
    expect(r.kind).toBe('halted');
    expect(c.placed).toHaveLength(1);
    const parked = c.engine.get(parent.id)!;
    expect(parked.status).toBe('paused');
    expect(parked.haltReason).toBe(CANCEL_INCOMPLETE_HALT);
    expect(code(() => c.engine.resume(USER, parent.id))).toBe('trade.algo_cancel_incomplete');
    await c.engine.tick(parent.id);
    expect(c.placed).toHaveLength(1);
  });

  it('after a crash between cancel and place, the next tick rests the rest once at the best price', async () => {
    const c = makeChase();
    const parent = c.engine.create(USER, c.input(), LOT);
    await c.engine.tick(parent.id);
    c.orders.get('order-0')!.open = false; // cancelled, new child never placed
    c.book.otherBid = p('1.00');
    expect((await c.engine.tick(parent.id)).kind).toBe('placed');
    expect((await c.engine.tick(parent.id)).kind).toBe('idle');
    expect(c.placed.map((o) => o.price)).toEqual([p('0.99'), p('1.00')]);
  });

  it('when its time runs out it cancels the resting child and stops with that reason', async () => {
    const c = makeChase();
    const parent = c.engine.create(USER, c.input(), LOT);
    await c.engine.tick(parent.id);
    c.advance(600_000);
    expect(await c.engine.tick(parent.id)).toEqual({ kind: 'idle', reason: 'halted' });
    expect(c.engine.get(parent.id)!.haltReason).toBe(CHASE_EXPIRED_HALT);
    expect(c.cancels).toEqual(['order-0']);
  });

  it('a sell chase follows the best ask down and stops below its distance', async () => {
    const c = makeChase('sell');
    const parent = c.engine.create(USER, c.input(), LOT);
    expect(parent.chaseStartPrice).toBe(p('1.10'));
    await c.engine.tick(parent.id);
    c.book.otherAsk = p('1.09');
    await c.engine.tick(parent.id);
    expect(c.placed.map((o) => o.price)).toEqual([p('1.10'), p('1.09')]);
    c.book.otherAsk = p('1.05');
    await c.engine.tick(parent.id);
    expect(c.engine.get(parent.id)!.haltReason).toBe(CHASE_MAX_DISTANCE_HALT);
    expect(chaseFurthestPrice('sell', p('1.10'), 200)).toBe(p('1.078'));
  });

  it('halts rather than guess when it cannot read what its children filled', async () => {
    const c = makeChase('buy', { noChildReader: true });
    const parent = c.engine.create(USER, c.input(), LOT);
    expect((await c.engine.tick(parent.id)).kind).toBe('halted');
    expect(c.placed).toHaveLength(0);
  });

  it('a cancel that lands while a re-priced child is being placed wins: the child is recorded and cancelled', async () => {
    const c = makeChase();
    const parent = c.engine.create(USER, c.input(), LOT);
    await c.engine.tick(parent.id);
    c.book.otherBid = p('1.00');
    c.duringNextPlace(() => c.engine.cancel(USER, parent.id));
    expect(await c.engine.tick(parent.id)).toEqual({ kind: 'idle', reason: 'superseded' });
    const live = c.engine.get(parent.id)!;
    expect(live.status).toBe('cancelled');
    expect(live.children.map((ch) => ch.orderId)).toEqual(['order-0', 'order-1']);
    expect(c.ownOpen()).toEqual([]);
    expect(c.cancels.filter((id) => id === 'order-1')).toHaveLength(1);
  });

  it('a pause that lands while a child is being placed wins: the child is cancelled and the chase stays paused', async () => {
    const c = makeChase();
    const parent = c.engine.create(USER, c.input(), LOT);
    c.duringNextPlace(async () => c.engine.pause(USER, parent.id));
    expect(await c.engine.tick(parent.id)).toEqual({ kind: 'idle', reason: 'paused' });
    const live = c.engine.get(parent.id)!;
    expect(live.status).toBe('paused');
    expect(live.children.map((ch) => ch.orderId)).toEqual(['order-0']);
    expect(c.ownOpen()).toEqual([]);
  });

  it('a child placed just before a crash is adopted, not placed over, and re-priced like any other', async () => {
    const c = makeChase();
    const parent = c.engine.create(USER, c.input(), LOT);
    await c.engine.tick(parent.id);
    // The crash: order-0 was cancelled and the next child placed at 0.995, but the parent was never saved.
    c.orders.get('order-0')!.open = false;
    const stray = c.stray(`algo:${parent.id}:1`, '0.995', '1');
    c.book.otherBid = p('1.00');
    expect(await c.engine.tick(parent.id)).toEqual({ kind: 'idle', reason: 'adopted' });
    expect(c.placed).toHaveLength(1);
    expect(c.engine.get(parent.id)!.children.map((ch) => ch.orderId)).toEqual(['order-0', stray]);
    expect((await c.engine.tick(parent.id)).kind).toBe('placed');
    expect(c.cancels).toEqual([stray]);
    expect(c.placed.map((o) => [o.price, o.clientOrderId])).toEqual([
      [p('0.99'), `algo:${parent.id}:0`],
      [p('1.00'), `algo:${parent.id}:2`],
    ]);
    expect(c.ownOpen()).toEqual(['order-1']);
  });

  it('a re-price cancels every child still resting, not only the last, and then rests one', async () => {
    const c = makeChase();
    const parent = c.engine.create(USER, c.input(), LOT);
    await c.engine.tick(parent.id);
    // order-0 still rests and an unsaved child rests too: both must go before the next one is placed.
    const stray = c.stray(`algo:${parent.id}:1`, '0.995', '1');
    c.book.otherBid = p('1.00');
    expect(await c.engine.tick(parent.id)).toEqual({ kind: 'idle', reason: 'adopted' });
    expect((await c.engine.tick(parent.id)).kind).toBe('placed');
    expect([...c.cancels].sort()).toEqual(['order-0', stray].sort());
    expect(c.ownOpen()).toEqual(['order-1']);
  });

  it('a child that still reads open after its cancel is waited out: no second working order', async () => {
    const c = makeChase();
    const parent = c.engine.create(USER, c.input(), LOT);
    await c.engine.tick(parent.id);
    c.setCancelNoop(true);
    c.book.otherBid = p('1.00');
    expect(await c.engine.tick(parent.id)).toEqual({ kind: 'idle', reason: 'child_open' });
    expect(c.placed).toHaveLength(1);
    c.setCancelNoop(false);
    expect((await c.engine.tick(parent.id)).kind).toBe('placed');
    expect(c.ownOpen()).toEqual(['order-1']);
  });

  it('a child fully matched in the engine just before a re-price is not bought again while its fills are on the way', async () => {
    const c = makeChase();
    const parent = c.engine.create(USER, c.input(), LOT);
    await c.engine.tick(parent.id);
    // A seller sweeps the bids: the engine matches the whole child, and the taker's settlement has not written fills.
    c.engineMatch('order-0', '1');
    c.book.otherBid = p('1.00');
    expect(await c.engine.tick(parent.id)).toEqual({ kind: 'idle', reason: 'awaiting_fills' });
    expect(c.cancels).toEqual(['order-0']);
    expect(c.placed).toHaveLength(1);
    expect(c.engine.get(parent.id)!.children[0]!.cancelRemainingQty).toBe(0n);
    // Later ticks keep waiting: the matched quantity is never placed again.
    c.advance(5_000);
    expect(await c.engine.tick(parent.id)).toEqual({ kind: 'idle', reason: 'awaiting_fills' });
    expect(c.placed).toHaveLength(1);
    // The fills land: the whole quantity is bought once and the chase completes with no second child.
    c.settle('order-0');
    expect(await c.engine.tick(parent.id)).toEqual({ kind: 'completed' });
    expect(c.placed).toHaveLength(1);
    expect(c.engine.get(parent.id)!.status).toBe('completed');
  });

  it('a partial engine match before a re-price waits for its fills, then rests only the engine remainder', async () => {
    const c = makeChase();
    const parent = c.engine.create(USER, c.input(), LOT);
    await c.engine.tick(parent.id);
    c.engineMatch('order-0', '0.4');
    c.book.otherBid = p('1.00');
    expect(await c.engine.tick(parent.id)).toEqual({ kind: 'idle', reason: 'awaiting_fills' });
    expect(c.engine.get(parent.id)!.children[0]!.cancelRemainingQty).toBe(p('0.6'));
    expect(c.placed).toHaveLength(1);
    c.settle('order-0');
    expect((await c.engine.tick(parent.id)).kind).toBe('placed');
    expect(c.placed.map((o) => [o.price, o.qty])).toEqual([
      [p('0.99'), p('1')],
      [p('1.00'), p('0.6')],
    ]);
    // Bought 0.4 + working 0.6: never more than the parent's quantity.
    expect(c.ownOpen()).toEqual(['order-1']);
  });

  it('the engine remainder survives a restart: a hydrated parent still waits for the matched fills', async () => {
    const c = makeChase();
    const parent = c.engine.create(USER, c.input(), LOT);
    await c.engine.tick(parent.id);
    c.engineMatch('order-0', '1');
    c.book.otherBid = p('1.00');
    await c.engine.tick(parent.id);
    const saved = c.engine.get(parent.id)!;
    const fresh = makeChase();
    for (const [id, o] of c.orders) fresh.orders.set(id, o);
    fresh.book.otherBid = p('1.00');
    fresh.engine.hydrate(saved, []);
    expect(await fresh.engine.tick(parent.id)).toEqual({ kind: 'idle', reason: 'awaiting_fills' });
    expect(fresh.placed).toHaveLength(0);
  });

  it('a paused chase still ends at its expiry, cancelling its resting child once', async () => {
    const c = makeChase();
    const parent = c.engine.create(USER, c.input(), LOT);
    await c.engine.tick(parent.id);
    c.engine.pause(USER, parent.id);
    c.advance(600_000);
    await c.engine.tickAll();
    const live = c.engine.get(parent.id)!;
    expect(live.status).toBe('halted');
    expect(live.haltReason).toBe(CHASE_EXPIRED_HALT);
    expect(c.cancels).toEqual(['order-0']);
    expect(c.ownOpen()).toEqual([]);
  });

  it('a paused chase does not re-price, but a move beyond its distance still stops it', async () => {
    const c = makeChase();
    const parent = c.engine.create(USER, c.input(), LOT);
    await c.engine.tick(parent.id);
    c.engine.pause(USER, parent.id);
    c.book.otherBid = p('1.005');
    await c.engine.tickAll();
    expect(c.engine.get(parent.id)!.status).toBe('paused');
    expect(c.placed).toHaveLength(1);
    expect(c.cancels).toEqual([]);
    c.book.otherBid = p('1.02');
    await c.engine.tickAll();
    expect(c.engine.get(parent.id)!.haltReason).toBe(CHASE_MAX_DISTANCE_HALT);
    expect(c.cancels).toEqual(['order-0']);
    expect(c.placed).toHaveLength(1);
  });

  it('a blank distance refuses with its typed code, and so do out-of-range or misplaced chase options', () => {
    const c = makeChase();
    expect(code(() => c.engine.prepare(USER, c.input({ chaseMaxDistanceBps: undefined }), LOT))).toBe('trade.algo_chase_distance_required');
    expect(code(() => c.engine.prepare(USER, c.input({ chaseMaxDistanceBps: 0 }), LOT))).toBe('trade.algo_invalid_schedule');
    expect(code(() => c.engine.prepare(USER, c.input({ chaseMaxDistanceBps: 10_001 }), LOT))).toBe('trade.algo_invalid_schedule');
    expect(code(() => c.engine.prepare(USER, c.input({ limitPrice: p('1') }), LOT))).toBe('trade.algo_invalid_schedule');
    expect(code(() => c.engine.prepare(USER, c.input({ chaseStartPrice: undefined }), LOT))).toBe('trade.algo_mark_missing');
    expect(code(() => c.engine.prepare(USER, c.input({ kind: 'twap' }), LOT))).toBe('trade.algo_invalid_schedule');
  });
});
