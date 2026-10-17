import { describe, expect, it } from 'vitest';
import { parseAmount as amt, formatAmount } from '@intafaced/ledger-client';
import { armCancelAllAfter, expireCancelAllAfter, type CancelAllAfterOrder } from './cancel-all-after.js';
import { cancelAttachedToEntry, stopAfterMarket, type AttachedExit } from './attached-exits.js';
import { entryFromOpeningFills, storedEntryAfterFill } from './position-service.js';
import {
  HAIRCUT_CREDIT_SHORT,
  HAIRCUT_UNSET,
  checkPostedMarginCollateral,
  collateralCredit,
  decideOpenCredit,
  installCollateralHaircutOpen,
} from './collateral-haircut.js';
import { FuturesError, type OpenPositionInput, type PositionService } from './position-service.js';
import {
  cancelIncreasingOrdersBeforeRung,
  memoryLiquidationAttemptStore,
  orderIncreasesPosition,
  runLiquidationTick,
  type LiquidationPositionRow,
  type QuotedMarkSource,
} from './liquidation-tick.js';
import { memoryAcceptedMarkStore } from './accepted-mark.js';
import { deepFullCloseLadder } from './ladder-policy.test-harness.js';
import type { AccountRef, Amount, Balance, PostRequest } from '@intafaced/ledger-client';
import { LIQUIDATION_NOT_SCHEDULED, presentFuturesJobsHealth } from './futures-jobs-health.js';
import { startFuturesJobs } from './futures-jobs.js';

const PUBLISHED_TIMEOUTS = [0, 10, 120] as const;

describe('S07 haircut credit', () => {
  it('a blank haircut refuses trade.haircut_unset and does not invent 0 or 10', () => {
    const previous = process.env.TRADE_COLLATERAL_HAIRCUT_BPS;
    delete process.env.TRADE_COLLATERAL_HAIRCUT_BPS;
    try {
      expect(checkPostedMarginCollateral({})).toMatchObject({ ok: false, code: HAIRCUT_UNSET });
    } finally {
      if (previous === undefined) delete process.env.TRADE_COLLATERAL_HAIRCUT_BPS;
      else process.env.TRADE_COLLATERAL_HAIRCUT_BPS = previous;
    }
    expect(checkPostedMarginCollateral({ haircutBps: '' })).toMatchObject({ ok: false, code: HAIRCUT_UNSET });
    const blank = checkPostedMarginCollateral({ haircutBps: '   ' });
    expect(blank.ok).toBe(false);
    if (!blank.ok) expect(blank.reason).not.toMatch(/\b0 bps\b|\b10 bps\b/);
  });

  it('100 cash at 1000 bps credits 90, so initial margin 100 is refused and the lock stays 0', () => {
    expect(formatAmount(collateralCredit(amt('100'), 1000))).toBe('90');
    const decision = decideOpenCredit({ postedCash: amt('100'), initialMargin: amt('100'), haircutBps: 1000 });
    expect(decision).toMatchObject({ ok: false, code: HAIRCUT_CREDIT_SHORT, lockAmount: 0n });
  });

  it('a haircut that still covers the margin does not shrink the initial-margin lock', () => {
    const decision = decideOpenCredit({ postedCash: amt('100'), initialMargin: amt('90'), haircutBps: 1000 });
    expect(decision).toMatchObject({ ok: true, lockAmount: amt('90') });
    if (decision.ok) expect(formatAmount(decision.credit)).toBe('90');
  });

  it('a short credit refuses the open before the original open, so no margin is locked', async () => {
    const locks: string[] = [];
    class Book {
      sql = async () => [{ id: 'm1', quote_asset: 'USDT', kind: 'futures', status: 'active' }];
      ledger = { balance: async () => ({ amount: amt('100') }) };
      now = () => new Date('2026-10-17T00:00:00.000Z');
      async markFor() {
        return { price: amt('100') };
      }
      async open() {
        locks.push('lock');
        return { id: 'pos' };
      }
    }
    installCollateralHaircutOpen(Book as unknown as typeof PositionService);
    const book = new Book();
    const input = {
      userId: '11111111-1111-4111-8111-111111111111',
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      size: amt('1'),
      leverage: amt('1'),
      clientOpenId: 'haircut-short',
      haircutBps: '1000',
    } as OpenPositionInput;
    await expect(book.open(input)).rejects.toMatchObject({ name: 'FuturesError', code: HAIRCUT_CREDIT_SHORT });
    expect(locks).toEqual([]);
  });

  it('a blank haircut on the open wrapper does not call the original open', async () => {
    const locks: string[] = [];
    class Book {
      async open() {
        locks.push('lock');
        return { id: 'pos' };
      }
    }
    installCollateralHaircutOpen(Book as unknown as typeof PositionService);
    await expect(new Book().open({ haircutBps: '' } as OpenPositionInput)).rejects.toBeInstanceOf(FuturesError);
    expect(locks).toEqual([]);
  });
});

describe('S08 entry, attached exits, cancel-all-after', () => {
  it('a long of 1 at 100 plus 1 at 120 stores entry 110, and a reducing fill leaves it', () => {
    const opened = entryFromOpeningFills(
      [
        { qty: amt('1'), price: amt('100') },
        { qty: amt('1'), price: amt('120') },
      ],
      amt('999'),
    );
    expect(formatAmount(opened.size)).toBe('2');
    expect(formatAmount(opened.entryPrice)).toBe('110');
    const reduced = storedEntryAfterFill(opened, { effect: 'reduce', qty: amt('0.5'), price: amt('80') });
    expect(formatAmount(reduced.size)).toBe('1.5');
    expect(formatAmount(reduced.entryPrice)).toBe('110');
  });

  it('a caller-supplied price with no fill is not stored as the entry', () => {
    expect(() => entryFromOpeningFills([], amt('100'))).toThrow(/not stored as the entry/);
  });

  it('cancelling an unfilled entry cancels its take-profit and stop-loss, and a later price cannot fire them', () => {
    const exits: AttachedExit[] = [
      { id: 'tp', kind: 'take_profit', trigger: amt('120'), qty: amt('1'), status: 'open' },
      { id: 'sl', kind: 'stop_loss', trigger: amt('90'), qty: amt('1'), status: 'open' },
    ];
    const first = cancelAttachedToEntry({ entryStatus: 'unfilled', filledQty: 0n as Amount, exits });
    expect(first.cancelledIds).toEqual(['tp', 'sl']);
    expect(first.exits.map((leg) => leg.status)).toEqual(['cancelled', 'cancelled']);
    const second = cancelAttachedToEntry({ entryStatus: 'unfilled', filledQty: 0n as Amount, exits: first.exits });
    expect(second.cancelledIds).toEqual([]);
    const stop = second.exits[1]!;
    const after = stopAfterMarket({
      trigger: stop.trigger,
      last: amt('80'),
      printedAtOrThroughTrigger: true,
      printPrice: amt('80'),
      positionSize: amt('1'),
      status: stop.status,
    });
    expect(after).toMatchObject({ status: 'open', positionSize: amt('1'), fillPrice: null });
  });

  it('a filled entry leaves the attached stop, and a partial fill keeps it sized to the fill', () => {
    const exits: AttachedExit[] = [
      { id: 'sl', kind: 'stop_loss', trigger: amt('90'), qty: amt('1'), status: 'open' },
    ];
    const filled = cancelAttachedToEntry({ entryStatus: 'filled', filledQty: amt('1'), exits });
    expect(filled.cancelledIds).toEqual([]);
    expect(filled.exits[0]!.status).toBe('open');
    const partial = cancelAttachedToEntry({ entryStatus: 'partial', filledQty: amt('0.4'), exits });
    expect(formatAmount(partial.exits[0]!.qty)).toBe('0.4');
    expect(partial.exits[0]!.status).toBe('open');
  });

  it('a stop at 90 with last 100 and no print through 90 stays open and the position is unchanged', () => {
    const after = stopAfterMarket({
      trigger: amt('90'),
      last: amt('100'),
      printedAtOrThroughTrigger: false,
      printPrice: null,
      positionSize: amt('1'),
      status: 'open',
    });
    expect(after).toEqual({ status: 'open', positionSize: amt('1'), fillPrice: null });
  });

  it('a print through the stop may fill away from the trigger', () => {
    const after = stopAfterMarket({
      trigger: amt('90'),
      last: amt('85'),
      printedAtOrThroughTrigger: true,
      printPrice: amt('85'),
      positionSize: amt('1'),
      status: 'open',
    });
    expect(after.fillPrice).toEqual(amt('85'));
    expect(after.fillPrice).not.toEqual(amt('90'));
  });

  it('cancel-all-after at the published minimum cancels only that caller, once', () => {
    const minimum = Math.min(...PUBLISHED_TIMEOUTS.filter((n) => n > 0));
    expect(minimum).toBe(10);
    const armed = armCancelAllAfter({
      callerId: 'alice',
      timeoutSec: minimum,
      publishedTimeouts: PUBLISHED_TIMEOUTS,
      nowMs: 0,
      countdownId: 'caa-1',
    });
    expect(armed.ok).toBe(true);
    if (!armed.ok || armed.armed == null) throw new Error('expected an armed countdown');
    const orders: CancelAllAfterOrder[] = [
      { orderId: 'alice-gtc', callerId: 'alice', status: 'open', holdAmount: amt('25') },
      { orderId: 'bob-gtc', callerId: 'bob', status: 'open', holdAmount: amt('40') },
    ];
    const first = expireCancelAllAfter({
      armed: armed.armed,
      nowMs: armed.armed.deadlineMs,
      orders,
      alreadyExpiredIds: new Set(),
    });
    expect(first.cancelledIds).toEqual(['alice-gtc']);
    expect(formatAmount(first.releasedHold)).toBe('25');
    expect(first.orders.find((order) => order.orderId === 'bob-gtc')!.status).toBe('open');
    const second = expireCancelAllAfter({
      armed: armed.armed,
      nowMs: armed.armed.deadlineMs + 1_000,
      orders,
      alreadyExpiredIds: new Set([armed.armed.countdownId]),
    });
    expect(second.cancelledIds).toEqual([]);
    expect(formatAmount(second.releasedHold)).toBe('0');
  });

  it('a timeout outside the published set is rejected and orders stay', () => {
    const orders: CancelAllAfterOrder[] = [
      { orderId: 'alice-gtc', callerId: 'alice', status: 'open', holdAmount: amt('25') },
    ];
    const armed = armCancelAllAfter({
      callerId: 'alice',
      timeoutSec: 7,
      publishedTimeouts: PUBLISHED_TIMEOUTS,
      nowMs: 0,
      countdownId: 'caa-bad',
    });
    expect(armed).toMatchObject({ ok: false, code: 'trade.cancel_all_after_rejected' });
    expect(orders[0]!.status).toBe('open');
  });

  it('timeout 0 does not cancel, including after the session drops', () => {
    const armed = armCancelAllAfter({
      callerId: 'alice',
      timeoutSec: 0,
      publishedTimeouts: PUBLISHED_TIMEOUTS,
      nowMs: 0,
      countdownId: 'caa-off',
    });
    expect(armed).toMatchObject({ ok: true, armed: null });
    if (!armed.ok) throw new Error('expected disarm');
    const expired = expireCancelAllAfter({
      armed: armed.armed,
      nowMs: 86_400_000,
      orders: [{ orderId: 'alice-gtc', callerId: 'alice', status: 'open', holdAmount: amt('25') }],
      alreadyExpiredIds: new Set(),
    });
    expect(expired.cancelledIds).toEqual([]);
    expect(expired.orders[0]!.status).toBe('open');
  });
});

describe('S08 liquidation pulls increasing orders before the rung posts', () => {
  const user = '11111111-1111-4111-8111-111111111111';

  function underwater(): LiquidationPositionRow {
    return {
      positionId: 'pos-1',
      userId: user,
      side: 'long',
      size: amt('1'),
      entryPrice: amt('100'),
      margin: amt('10'),
      marginAsset: 'USDT',
      marketId: 'm1',
      symbol: 'BTC/USDT-PERP',
    };
  }

  function marks(price: string): QuotedMarkSource {
    return {
      async markPrice() {
        return price;
      },
      async quote({ marketId, symbol, at }) {
        return { marketId, symbol, price: amt(price), asOf: at, quality: 'mid' };
      },
    };
  }

  function ledger() {
    const posts: PostRequest[] = [];
    return {
      posts,
      ledger: {
        async post(req: PostRequest) {
          posts.push(req);
          return { id: `tx-${posts.length}`, idempotencyKey: req.idempotencyKey } as never;
        },
        async balance(ref: AccountRef): Promise<Balance> {
          const amount = ref.ownerType === 'house' && ref.ownerId === 'insurance-fund' ? amt('1000000') : amt('1000000');
          return { account: ref, accountId: 'acct', amount };
        },
      },
    };
  }

  it('a resting buy is cancelled and its hold released; a reduce-only sell stays', async () => {
    expect(orderIncreasesPosition('long', { side: 'buy' })).toBe(true);
    expect(orderIncreasesPosition('long', { side: 'sell', reduceOnly: true })).toBe(false);
    const released: string[] = [];
    const { posts, ledger: book } = ledger();
    const result = await runLiquidationTick({
      marks: marks('80'),
      positions: { async listOpen() { return [underwater()]; } },
      closer: { async markLiquidated() {} },
      attempts: memoryLiquidationAttemptStore(),
      acceptedMarks: memoryAcceptedMarkStore(),
      ledger: book,
      ladder: deepFullCloseLadder(),
      increasingOrders: {
        async list() {
          return [
            { orderId: 'bid', side: 'buy' },
            { orderId: 'stop-sell', side: 'sell', reduceOnly: true },
          ];
        },
        async cancelAndRelease(_marketId, orderId) {
          released.push(orderId);
          return 'released';
        },
      },
    });
    expect(released).toEqual(['bid']);
    expect(result.liquidated).toBe(1);
    expect(posts.length).toBeGreaterThan(0);
  });

  it('a cancel timeout leaves the rung unposted', async () => {
    const { posts, ledger: book } = ledger();
    const result = await runLiquidationTick({
      marks: marks('80'),
      positions: { async listOpen() { return [underwater()]; } },
      closer: { async markLiquidated() { throw new Error('rung posted'); } },
      attempts: memoryLiquidationAttemptStore(),
      acceptedMarks: memoryAcceptedMarkStore(),
      ledger: book,
      ladder: deepFullCloseLadder(),
      increasingOrders: {
        async list() {
          return [{ orderId: 'bid', side: 'buy' }];
        },
        async cancelAndRelease() {
          return 'timeout';
        },
      },
    });
    expect(result.liquidated).toBe(0);
    expect(result.items[0]).toMatchObject({
      outcome: 'errored',
      reason: 'trade.liquidation_increasing_cancel_timeout',
    });
    expect(posts).toHaveLength(0);
    const pulled = await cancelIncreasingOrdersBeforeRung(
      {
        async list() {
          return [{ orderId: 'bid', side: 'buy' }];
        },
        async cancelAndRelease() {
          return 'timeout';
        },
      },
      { marketId: 'm1', userId: user, side: 'long' },
    );
    expect(pulled.ok).toBe(false);
  });
});

describe('TRADEV4-0005 liquidation off alert', () => {
  it('jobs disabled raises an alert that futures.liquidation is not scheduled', () => {
    const health = presentFuturesJobsHealth({
      enabled: false,
      fundingMarketCount: 0,
      fundingMaxAbsRateConfigured: false,
    });
    expect(health.liquidationArmed).toBe(false);
    expect(health.alerts).toEqual([{ name: 'futures.liquidation', message: LIQUIDATION_NOT_SCHEDULED }]);
    expect(health.alerts[0]!.message).toContain('futures.liquidation is not scheduled');
  });

  it('the explicit off switch stays off in the jobs handle, and enabling clears the alert', () => {
    const off = startFuturesJobs({
      sql: {} as never,
      ledger: { post: async () => ({}) as never, balance: async () => ({}) as never },
      matching: { depth: async () => ({ bids: [], asks: [], sequence: 1 }) } as never,
      bus: null,
      config: {
        enabled: false,
        liqIntervalMs: 15_000,
        fundingIntervalMs: null,
        fundingMarketIds: [],
        fundingMaxAbsRate: null,
      },
    });
    expect(off.host.list()).toEqual([]);
    expect(off.alerts.map((alert) => alert.message)).toEqual([LIQUIDATION_NOT_SCHEDULED]);
    off.stop();

    const on = startFuturesJobs({
      sql: {} as never,
      ledger: { post: async () => ({}) as never, balance: async () => ({}) as never },
      matching: { depth: async () => ({ bids: [], asks: [], sequence: 1 }) } as never,
      bus: null,
      config: {
        enabled: true,
        liqIntervalMs: 60_000,
        fundingIntervalMs: null,
        fundingMarketIds: [],
        fundingMaxAbsRate: null,
      },
      setIntervalFn: (() => 0) as unknown as typeof setInterval,
      clearIntervalFn: (() => undefined) as unknown as typeof clearInterval,
    });
    expect(on.host.list()).toContain('futures.liquidation');
    expect(on.alerts).toEqual([]);
    on.stop();
  });
});
