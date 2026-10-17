import { describe, expect, it, vi } from 'vitest';
import { MemorySharedRequestBudget, admitCountedOrder, rateLimitReadiness } from './hardening.js';
import { KillSwitchState, MemorySharedKillStore } from './kill-switch.js';
import { CallerOpenOrders, cancelAllWhileTradeMayBeKilled, placeWhileTradeMayBeKilled } from './trade-kill-release.js';
import { PrivateTradeWindow, TRADE_OWNER_REPLAY_WINDOW_SECONDS } from './trade-replay-window.js';
import { PLANE_FLAG_TIMEOUT_MS, TradingPlanes } from './trading-planes.js';

const OPERATOR = '11111111-1111-4111-8111-111111111111';
const CONFIRM = '44444444-4444-4444-8444-444444444444';
const USER = '77777777-7777-4777-8777-777777777777';
const WHY = 'incident 2026-10-18, stop new trade holds';

describe('TRD-0235 spot and futures plane flags', () => {
  it('refuses one operator token, leaves futures enabled, and records two distinct identities when a second confirms', async () => {
    const planes = new TradingPlanes();
    expect(planes.read()).toMatchObject({ spot: true, futures: true, audit: [] });

    const alone = await planes.turnOff({ plane: 'spot', operatorId: OPERATOR, confirmOperatorId: null });
    expect(alone).toEqual({ ok: false, code: 'missing_operator' });
    expect(planes.read()).toMatchObject({ spot: true, futures: true, audit: [] });

    const same = await planes.turnOff({ plane: 'spot', operatorId: OPERATOR, confirmOperatorId: OPERATOR });
    expect(same).toEqual({ ok: false, code: 'missing_operator' });
    expect(planes.read()).toMatchObject({ spot: true, futures: true, audit: [] });

    const confirmed = await planes.turnOff({ plane: 'spot', operatorId: OPERATOR, confirmOperatorId: CONFIRM });
    expect(confirmed).toEqual({ ok: true });
    expect(planes.read()).toEqual({
      spot: false,
      futures: true,
      audit: [{ plane: 'spot', enabled: false, operatorId: OPERATOR, confirmOperatorId: CONFIRM }],
    });
  });

  it('a 5 second timeout leaves the previous flag unchanged until a read confirms it', async () => {
    vi.useFakeTimers();
    try {
      let started!: () => void;
      const startedPromise = new Promise<void>((resolve) => {
        started = resolve;
      });
      const planes = new TradingPlanes({
        write: () => {
          started();
          return new Promise(() => {});
        },
      });
      const pending = planes.turnOff({ plane: 'spot', operatorId: OPERATOR, confirmOperatorId: CONFIRM });
      await startedPromise;
      await vi.advanceTimersByTimeAsync(PLANE_FLAG_TIMEOUT_MS - 1);
      expect(planes.read()).toMatchObject({ spot: true, futures: true, audit: [] });
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual({ ok: false, code: 'unknown' });
      expect(PLANE_FLAG_TIMEOUT_MS).toBe(5_000);
      expect(planes.read()).toEqual({ spot: true, futures: true, audit: [] });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('TRD-0236 cancel-all while trade is killed', () => {
  it('cancels both open orders and releases both remaining holds once', () => {
    const state = new KillSwitchState();
    const book = new CallerOpenOrders();
    book.open({ id: 'o1', userId: USER, originalHold: '1.25', remainingHold: '1.25' });
    book.open({ id: 'o2', userId: USER, originalHold: '0.40', remainingHold: '0.40' });
    state.set('trade', true, OPERATOR, WHY, CONFIRM);

    const first = cancelAllWhileTradeMayBeKilled(state, book, USER);
    expect(first).toEqual({
      refused: false,
      released: [
        { id: 'o1', amount: '1.25' },
        { id: 'o2', amount: '0.40' },
      ],
    });
    expect(book.status('o1')).toBe('cancelled');
    expect(book.status('o2')).toBe('cancelled');

    const again = cancelAllWhileTradeMayBeKilled(state, book, USER);
    expect(again).toEqual({ refused: false, released: [] });

    const placed = placeWhileTradeMayBeKilled(state, book, {
      id: 'o3',
      userId: USER,
      originalHold: '9.00',
      remainingHold: '9.00',
    });
    expect(placed).toEqual({ refused: true });
    expect(book.status('o3')).toBeNull();
    expect(state.decide('/api/trade/trpc/orders.create', 'POST')).toMatchObject({ refused: true, reason: 'module-killed' });
    expect(state.decide('/api/trade/trpc/orders.massCancel', 'POST')).toMatchObject({
      refused: false,
      reason: 'lets-the-user-out',
    });
  });

  it('releases only the remainder of a partly filled order', () => {
    const state = new KillSwitchState();
    const book = new CallerOpenOrders();
    book.open({ id: 'partial', userId: USER, originalHold: '2.00', remainingHold: '1.50' });
    state.set('trade', true, OPERATOR, WHY, CONFIRM);
    expect(cancelAllWhileTradeMayBeKilled(state, book, USER).released).toEqual([{ id: 'partial', amount: '1.50' }]);
  });
});

describe('TRD-0433 private trade replay window', () => {
  const now = new Date('2026-10-18T03:00:00.000Z');
  const nowSeconds = Math.floor(now.getTime() / 1000);

  it('refuses a signed place timestamped earlier than the owner window and opens nothing', () => {
    let opened = 0;
    const window = new PrivateTradeWindow(now, () => {
      opened += 1;
      return { orderId: 'ord-should-not-exist' };
    });
    const refused = window.submit({
      timestampSeconds: nowSeconds - TRADE_OWNER_REPLAY_WINDOW_SECONDS - 1,
      clientOrderId: 'cid-stale',
    });
    expect(refused).toEqual({ ok: false, code: 'timestamp_outside_window' });
    expect(opened).toBe(0);
    expect(window.count()).toBe(0);
  });

  it('returns the original order for the same client order id inside the window', () => {
    let opened = 0;
    const window = new PrivateTradeWindow(now, () => {
      opened += 1;
      return { orderId: 'ord-1' };
    });
    const first = window.submit({ timestampSeconds: nowSeconds - 10, clientOrderId: 'cid-1' });
    const again = window.submit({ timestampSeconds: nowSeconds - 3, clientOrderId: 'cid-1' });
    expect(first).toEqual({ ok: true, duplicate: false, order: { orderId: 'ord-1', clientOrderId: 'cid-1' } });
    expect(again).toEqual({ ok: true, duplicate: true, order: { orderId: 'ord-1', clientOrderId: 'cid-1' } });
    expect(opened).toBe(1);
    expect(window.count()).toBe(1);
  });
});

describe('TRD-0508 shared edge request budget', () => {
  it('refuses the third counted order across two replicas when each has admitted fewer than the maximum', () => {
    const budget = new MemorySharedRequestBudget(2, 60_000);
    const now = Date.parse('2026-10-18T03:00:00.000Z');
    const placed: string[] = [];
    const place = (replica: string) =>
      admitCountedOrder({
        budget,
        callerKey: 'key-1',
        nowMs: now,
        place: () => {
          placed.push(replica);
        },
      });

    expect(place('a')).toEqual({ admitted: true });
    expect(place('b')).toEqual({ admitted: true });
    const third = place('a');
    expect(third).toMatchObject({ admitted: false, code: 'edge.rate_limited' });
    expect(third.admitted).toBe(false);
    if (!third.admitted && third.code === 'edge.rate_limited') {
      expect(third.retryAfterSeconds).toBe(60);
    }
    expect(placed).toEqual(['a', 'b']);
    expect(rateLimitReadiness({ enabled: true, max: 2, windowMs: 60_000, trustProxy: true, sharedBudget: true }).multiReplicaShared).toBe(
      true,
    );
  });

  it('refuses the counted call when the shared counter cannot be read and does not place', () => {
    const budget = new MemorySharedRequestBudget(2, 60_000);
    budget.failReads(true);
    const placed: string[] = [];
    const result = admitCountedOrder({
      budget,
      callerKey: 'key-1',
      nowMs: Date.parse('2026-10-18T03:00:00.000Z'),
      place: () => {
        placed.push('no');
      },
    });
    expect(result).toEqual({ admitted: false, code: 'edge.rate_unreadable' });
    expect(placed).toEqual([]);
  });
});

describe('TRD-0512 fleet kill', () => {
  it('a kill committed on one replica refuses a new spot order on the other and posts no hold', () => {
    const store = new MemorySharedKillStore();
    const first = new KillSwitchState({ shared: store });
    const second = new KillSwitchState({ shared: store });
    const book = new CallerOpenOrders();
    book.open({ id: 'open-1', userId: USER, originalHold: '3.00', remainingHold: '3.00' });

    first.set('trade', true, OPERATOR, WHY, CONFIRM);
    expect(first.durability().multiReplicaShared).toBe(true);

    expect(second.decide('/api/v1/orders', 'POST')).toMatchObject({ module: 'trade', refused: true, reason: 'module-killed' });
    const placed = placeWhileTradeMayBeKilled(second, book, {
      id: 'new-1',
      userId: USER,
      originalHold: '8.00',
      remainingHold: '8.00',
    });
    expect(placed).toEqual({ refused: true });
    expect(book.status('new-1')).toBeNull();
    expect(second.decide('/api/trade/trpc/orders.cancel', 'POST')).toMatchObject({
      refused: false,
      reason: 'lets-the-user-out',
    });
    expect(book.status('open-1')).toBe('open');
  });

  it('a replica that cannot read the shared kill state refuses new holds and still allows a single-order cancel', () => {
    const store = new MemorySharedKillStore();
    const replica = new KillSwitchState({ shared: store });
    const book = new CallerOpenOrders();
    store.failReads(true);
    expect(replica.decide('/api/v1/orders', 'POST')).toMatchObject({ refused: true, reason: 'undecidable' });
    const placed = placeWhileTradeMayBeKilled(replica, book, {
      id: 'new-2',
      userId: USER,
      originalHold: '1.00',
      remainingHold: '1.00',
    });
    expect(placed).toEqual({ refused: true });
    expect(book.status('new-2')).toBeNull();
    expect(replica.decide('/api/trade/trpc/orders.cancel', 'POST')).toMatchObject({
      refused: false,
      reason: 'lets-the-user-out',
    });
  });
});
