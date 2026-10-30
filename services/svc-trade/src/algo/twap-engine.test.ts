import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import { TradeError } from '../spot/types.js';
import { assertParentHasNoMoneyFields, FORBIDDEN_PARENT_MONEY_KEYS, presentAlgoProgress } from './present.js';
import { planTwapSlices } from './schedule.js';
import { acceptableForAlgo, algoMarkMissing, withinPriceBand } from './mark-gate.js';
import { TwapEngine, type TwapEnginePorts } from './twap-engine.js';
import type { AlgoQuotedMark, CreateTwapInput } from './types.js';

const LOT = parseAmount('0.001');
const MARKET = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';

function baseInput(over: Partial<CreateTwapInput> = {}): CreateTwapInput {
  return {
    marketId: MARKET,
    symbol: 'BTC/USDT',
    side: 'buy',
    totalQty: parseAmount('0.010'),
    durationMs: 10_000,
    sliceIntervalMs: 2_000,
    limitPrice: parseAmount('100'),
    subAccountId: null,
    clientAlgoId: 'fixture-algo',
    ...over,
  };
}

function makePorts(over: Partial<TwapEnginePorts> = {}): TwapEnginePorts & {
  placed: string[];
  cancelled: string[];
  advance: (ms: number) => void;
} {
  const placed: string[] = [];
  const cancelled: string[] = [];
  let t = 1_700_000_000_000;
  const base: TwapEnginePorts = {
    now: () => new Date(t),
    randomId: () => `id-${placed.length}-${cancelled.length}-${t}`,
    placeChild: async (req) => {
      placed.push(req.clientOrderId);
      return { orderId: `order-${req.sliceIndex}` };
    },
    cancelChild: async (orderId) => {
      cancelled.push(orderId);
    },
    bestOpposingPrice: async () => parseAmount('50'),
    markFor: async (marketId): Promise<AlgoQuotedMark | null> => ({
      marketId,
      price: parseAmount('50'),
      asOf: new Date(t),
      quality: 'mid',
    }),
  };
  const ports = {
    ...base,
    ...over,
    placed,
    cancelled,
    advance: (ms: number) => {
      t += ms;
    },
  };
  // Keep now/markFor on the mutable clock unless the test replaced now.
  if (!over.now) ports.now = () => new Date(t);
  if (!over.markFor) {
    ports.markFor = async (marketId): Promise<AlgoQuotedMark | null> => ({
      marketId,
      price: parseAmount('50'),
      asOf: new Date(t),
      quality: 'mid',
    });
  }
  return ports;
}

describe('planTwapSlices', () => {
  it('splits total into equal lot-aligned slices', () => {
    const plan = planTwapSlices({
      totalQty: parseAmount('0.010'),
      durationMs: 10_000,
      sliceIntervalMs: 2_000,
      lotSize: LOT,
    });
    expect(plan.slices.length).toBe(5);
    const sum = plan.slices.reduce((a, b) => a + b, 0n);
    expect(sum).toBe(plan.plannedQty);
    expect(plan.plannedQty + plan.droppedQty).toBe(parseAmount('0.010'));
  });

  it('refuses non-positive qty', () => {
    expect(() => planTwapSlices({ totalQty: 0n, durationMs: 10_000, sliceIntervalMs: 2_000, lotSize: LOT })).toThrow(TradeError);
  });
});

describe('mark-gate (prices.ts vocabulary)', () => {
  it('refuses missing mark', () => {
    const c = algoMarkMissing(MARKET);
    expect(c.ok).toBe(false);
    expect(c.code).toBe('trade.algo_mark_missing');
  });

  it('refuses stale / non-positive / future marks', () => {
    const now = new Date('2026-08-07T12:00:00Z');
    expect(acceptableForAlgo({ marketId: MARKET, price: 0n, asOf: now, quality: 'mid' }, now).ok).toBe(false);
    expect(
      acceptableForAlgo({ marketId: MARKET, price: parseAmount('1'), asOf: new Date(now.getTime() - 400_000), quality: 'mid' }, now).ok,
    ).toBe(false);
    expect(
      acceptableForAlgo({ marketId: MARKET, price: parseAmount('1'), asOf: new Date(now.getTime() + 60_000), quality: 'mid' }, now).ok,
    ).toBe(false);
  });

  it('refuses invalid mark and current timestamps while accepting a finite current mark', () => {
    const now = new Date('2026-08-07T12:00:00Z');
    const mark = { marketId: MARKET, price: parseAmount('1'), asOf: now, quality: 'mid' as const };
    expect(acceptableForAlgo({ ...mark, asOf: new Date(Number.NaN) }, now)).toMatchObject({
      ok: false,
      code: 'trade.algo_mark_unusable',
    });
    expect(acceptableForAlgo(mark, new Date(Number.NaN))).toMatchObject({ ok: false, code: 'trade.algo_mark_unusable' });
    expect(acceptableForAlgo(mark, now)).toEqual({ ok: true });
  });

  it('price band: buy refuses above limit, sell refuses below', () => {
    expect(withinPriceBand('buy', parseAmount('101'), parseAmount('100'))).toBe(false);
    expect(withinPriceBand('buy', parseAmount('99'), parseAmount('100'))).toBe(true);
    expect(withinPriceBand('sell', parseAmount('99'), parseAmount('100'))).toBe(false);
    expect(withinPriceBand('sell', parseAmount('101'), parseAmount('100'))).toBe(true);
  });
});

describe('TwapEngine — D-S-04 done bar', () => {
  it('parent has no balance-bearing / fill / pnl fields', () => {
    const ports = makePorts();
    const engine = new TwapEngine(ports);
    const parent = engine.create(USER, baseInput(), LOT);
    assertParentHasNoMoneyFields(parent);
    for (const key of FORBIDDEN_PARENT_MONEY_KEYS) {
      expect(Object.keys(parent)).not.toContain(key);
    }
  });

  it('empty book → zero progress + stated miss (never invent fill)', async () => {
    const ports = makePorts({
      bestOpposingPrice: async () => null,
    });
    const engine = new TwapEngine(ports);
    const parent = engine.create(USER, baseInput(), LOT);
    const tick = await engine.tick(parent.id);
    expect(tick.kind).toBe('miss');
    if (tick.kind !== 'miss') throw new Error('expected miss');
    expect(tick.miss.code).toBe('trade.algo_no_liquidity');
    expect(ports.placed).toHaveLength(0);

    const after = engine.get(parent.id)!;
    const progress = presentAlgoProgress(after, 0n);
    expect(progress.filledQty).toBe('0');
    expect(progress.missesRecorded).toBe(1);
    expect(progress.childrenEmitted).toBe(0);
  });

  it('blank mark feed → HALT (refuse invent)', async () => {
    const ports = makePorts({
      markFor: async () => null,
    });
    const engine = new TwapEngine(ports);
    const parent = engine.create(USER, baseInput(), LOT);
    const tick = await engine.tick(parent.id);
    expect(tick.kind).toBe('halted');
    expect(engine.get(parent.id)!.status).toBe('halted');
    expect(ports.placed).toHaveLength(0);
  });

  it('stale mark → HALT', async () => {
    const ports = makePorts({
      markFor: async (marketId) => ({
        marketId,
        price: parseAmount('50'),
        asOf: new Date(ports.now().getTime() - 400_000),
        quality: 'mid',
      }),
    });
    const engine = new TwapEngine(ports);
    const parent = engine.create(USER, baseInput(), LOT);
    const tick = await engine.tick(parent.id);
    expect(tick.kind).toBe('halted');
    if (tick.kind === 'halted') expect(tick.code).toBe('trade.algo_mark_unusable');
  });

  it('price outside band → miss, never widen', async () => {
    const ports = makePorts({
      bestOpposingPrice: async () => parseAmount('200'),
    });
    const engine = new TwapEngine(ports);
    const parent = engine.create(USER, baseInput({ limitPrice: parseAmount('100') }), LOT);
    const tick = await engine.tick(parent.id);
    expect(tick.kind).toBe('miss');
    if (tick.kind === 'miss') expect(tick.miss.code).toBe('trade.algo_price_band');
    expect(ports.placed).toHaveLength(0);
  });

  it('insufficient balance mid-schedule → HALT', async () => {
    const ports = makePorts({
      placeChild: async () => {
        throw new TradeError('not enough quote', 'trade.algo_insufficient_balance');
      },
    });
    const engine = new TwapEngine(ports);
    const parent = engine.create(USER, baseInput(), LOT);
    const tick = await engine.tick(parent.id);
    expect(tick.kind).toBe('halted');
    if (tick.kind === 'halted') expect(tick.code).toBe('trade.algo_insufficient_balance');
    expect(engine.get(parent.id)!.status).toBe('halted');
  });

  /**
   * The restart case: the schedule survived, the caller's authority did not.
   *
   * `algoPrincipals` is in-process and only written by `createTwap`, so after a
   * restart `tickAllAlgos` rehydrates parents that have no principal. Treated
   * as an ordinary child refusal this was a MISS — which ADVANCES the schedule
   * — so every surviving algo burned its whole remaining plan in
   * `sliceIntervalMs × N` and ended `completed` having placed nothing.
   *
   * It must halt instead, and the slice index must not move.
   */
  it('no authority to act halts the schedule and consumes no slice', async () => {
    const ports = makePorts({
      placeChild: async () => {
        throw new TradeError('this schedule outlived the session that authorised it', 'trade.algo_principal_unavailable');
      },
    });
    const engine = new TwapEngine(ports);
    const parent = engine.create(USER, baseInput(), LOT);

    const tick = await engine.tick(parent.id);
    expect(tick.kind).toBe('halted');
    if (tick.kind === 'halted') expect(tick.code).toBe('trade.algo_principal_unavailable');

    const after = engine.get(parent.id)!;
    expect(after.status).toBe('halted');
    // The whole point: the plan is intact and the user can still cancel it.
    expect(after.nextSliceIndex).toBe(0);
    expect(after.children).toHaveLength(0);

    // A further tick does not grind through the rest of the schedule either.
    await engine.tick(parent.id);
    expect(engine.get(parent.id)!.nextSliceIndex).toBe(0);
    expect(engine.get(parent.id)!.status).toBe('halted');
  });

  it('child place goes through placeChild port (ordinary order path)', async () => {
    const ports = makePorts();
    const engine = new TwapEngine(ports);
    const parent = engine.create(USER, baseInput(), LOT);
    const tick = await engine.tick(parent.id);
    expect(tick.kind).toBe('placed');
    expect(ports.placed).toEqual([`algo:${parent.id}:0`]);
    expect(engine.get(parent.id)!.children).toHaveLength(1);
  });

  it('pause emits no further children; resume does not re-run elapsed slices', async () => {
    const ports = makePorts();
    const engine = new TwapEngine(ports);
    const parent = engine.create(USER, baseInput(), LOT);
    await engine.tick(parent.id);
    expect(engine.get(parent.id)!.nextSliceIndex).toBe(1);

    engine.pause(USER, parent.id);
    const pausedTick = await engine.tick(parent.id);
    expect(pausedTick).toEqual({ kind: 'idle', reason: 'paused' });
    expect(ports.placed).toHaveLength(1);

    engine.resume(USER, parent.id);
    const resumed = engine.get(parent.id)!;
    expect(resumed.nextSliceIndex).toBe(1);
    expect(resumed.status).toBe('active');

    // Advance clock past slice 1 due time
    ports.advance(3_000);
    await engine.tick(parent.id);
    expect(ports.placed).toHaveLength(2);
    expect(ports.placed[1]).toBe(`algo:${parent.id}:1`);
  });

  it('cancel: no further children; in-flight children cancelled (one disposition)', async () => {
    const ports = makePorts();
    const engine = new TwapEngine(ports);
    const parent = engine.create(USER, baseInput(), LOT);
    await engine.tick(parent.id);
    const cancelled = await engine.cancel(USER, parent.id);
    expect(cancelled.status).toBe('cancelled');
    expect(ports.cancelled).toEqual(['order-0']);

    const after = await engine.tick(parent.id);
    expect(after).toEqual({ kind: 'idle', reason: 'cancelled' });
    expect(ports.placed).toHaveLength(1);
  });

  it('progress filledQty is only the sum supplied from real fills', () => {
    const ports = makePorts();
    const engine = new TwapEngine(ports);
    const parent = engine.create(USER, baseInput(), LOT);
    const view = presentAlgoProgress(parent, parseAmount('0.003'));
    expect(view.filledQty).toBe('0.003');
    // Parent still has no filledQty field
    expect('filledQty' in parent).toBe(false);
  });
});

/**
 * ADR 2026-08-08 — the interval is the promise.
 *
 * Done bar items 1–6. Item 1 / the measured defect: a 10-slice one-per-minute
 * TWAP paused 20 minutes and resumed placed 9 slices in ~8s on the unfixed
 * engine. These tests must fail if due-time reverts to startedAt-only.
 */
describe('TwapEngine — ADR 2026-08-08 overdue re-space', () => {
  const INTERVAL = 60_000;
  const DURATION = 600_000; // 10 slices
  const TOTAL = parseAmount('0.010'); // 10 lots of 0.001

  function overdueInput(over: Partial<CreateTwapInput> = {}): CreateTwapInput {
    return baseInput({
      totalQty: TOTAL,
      durationMs: DURATION,
      sliceIntervalMs: INTERVAL,
      ...over,
    });
  }

  it('1+6: overdue resume never places two children less than sliceIntervalMs apart (fails on startedAt-only due)', async () => {
    // Pause long enough that many slices are overdue under startedAt+index*interval
    // (old engine burst) but under 2× duration so resume is still legal.
    // ADR's 20-min pause on a 10-min order is refused by item 4 instead.
    const ports = makePorts();
    const engine = new TwapEngine(ports);
    const parent = engine.create(USER, overdueInput(), LOT);
    expect(parent.slicesPlanned).toBe(10);

    await engine.tick(parent.id); // slice 0
    expect(ports.placed).toHaveLength(1);

    engine.pause(USER, parent.id);
    ports.advance(5 * 60_000); // 5 minutes overdue — multi-interval, still ≤ 2×
    const resumed = engine.resume(USER, parent.id);
    expect(resumed.scheduleStretchReason).toBe('user_pause');

    // Burst window: many ticks in ~8s of wall clock — unfixed engine placed all due.
    for (let i = 0; i < 20; i++) {
      await engine.tick(parent.id);
      ports.advance(400);
    }
    // Exactly one more place (the resume instant), not a market-order burst.
    expect(ports.placed).toHaveLength(2);

    // After a full interval, one more is legal.
    ports.advance(INTERVAL);
    await engine.tick(parent.id);
    expect(ports.placed).toHaveLength(3);

    const children = engine.get(parent.id)!.children;
    for (let i = 1; i < children.length; i++) {
      const gap = children[i]!.placedAt.getTime() - children[i - 1]!.placedAt.getTime();
      expect(gap).toBeGreaterThanOrEqual(INTERVAL);
    }
  });

  it('2: overdue slices execute (not dropped) — full planned qty is still placed', async () => {
    const ports = makePorts();
    const engine = new TwapEngine(ports);
    const parent = engine.create(USER, overdueInput(), LOT);
    const plan = engine.planOf(parent.id)!;
    const plannedSum = plan.reduce((a, b) => a + b, 0n);

    await engine.tick(parent.id);
    engine.pause(USER, parent.id);
    ports.advance(5 * 60_000);
    engine.resume(USER, parent.id);

    // Drive remaining schedule with correct spacing.
    for (let i = 0; i < 30; i++) {
      await engine.tick(parent.id);
      ports.advance(INTERVAL);
    }

    const after = engine.get(parent.id)!;
    expect(after.status).toBe('completed');
    expect(after.children).toHaveLength(plan.length);
    const placedQty = after.children.reduce((a, c) => a + c.qty, 0n);
    expect(placedQty).toBe(plannedSum);
    expect(placedQty).toBe(TOTAL); // no drop on this lot-aligned total
  });

  it('3: resume returns a new projectedEndsAt that differs from the original after a pause', async () => {
    const ports = makePorts();
    const engine = new TwapEngine(ports);
    const parent = engine.create(USER, overdueInput(), LOT);
    const originalEnd = parent.projectedEndsAt.getTime();

    await engine.tick(parent.id);
    engine.pause(USER, parent.id);
    ports.advance(5 * 60_000);
    const resumed = engine.resume(USER, parent.id);

    expect(resumed.projectedEndsAt.getTime()).toBeGreaterThan(originalEnd);
    // Remaining 9 slices from resume instant: now + 9 * interval
    const expected = ports.now().getTime() + 9 * INTERVAL;
    expect(resumed.projectedEndsAt.getTime()).toBe(expected);
  });

  it('4: resume exceeding 2× original duration is refused; parent stays paused', async () => {
    const ports = makePorts();
    const engine = new TwapEngine(ports);
    // duration 60s, 2 slices @ 30s — pause long enough that remaining * interval from now
    // makes span from startedAt > 2 * durationMs.
    const parent = engine.create(
      USER,
      baseInput({
        totalQty: parseAmount('0.002'),
        durationMs: 60_000,
        sliceIntervalMs: 30_000,
      }),
      LOT,
    );
    // Do not place any slices — remaining = 2.
    // projectedEnd = now+pause + 2*30s; span = pause + 60s; need span > 120s → pause > 60s.
    // Actually: startedAt = t0, pause at t0, advance 90s, resume at t0+90s.
    // projectedEnd = t0+90s + 2*30s = t0+150s; span = 150s; 2*duration = 120s → refuse.
    engine.pause(USER, parent.id);
    ports.advance(90_000);

    expect(() => engine.resume(USER, parent.id)).toThrow(TradeError);
    try {
      engine.resume(USER, parent.id);
    } catch (err) {
      expect(err).toBeInstanceOf(TradeError);
      expect((err as TradeError).code).toBe('trade.algo_resume_extends_too_far');
    }
    expect(engine.get(parent.id)!.status).toBe('paused');
  });

  it('5: tick outage (no user pause) sets scheduleStretchReason tick_outage, not user_pause', async () => {
    const ports = makePorts();
    const engine = new TwapEngine(ports);
    const parent = engine.create(USER, overdueInput(), LOT);
    await engine.tick(parent.id);
    expect(engine.get(parent.id)!.scheduleStretchReason).toBeNull();

    // Advance past nextDueAt by more than one interval while still active.
    ports.advance(INTERVAL * 3 + 1_000);
    await engine.tick(parent.id);

    const after = engine.get(parent.id)!;
    expect(after.scheduleStretchReason).toBe('tick_outage');
    expect(after.children).toHaveLength(2);
    // Re-spaced: next due is now+interval, not a burst of remaining slices.
    const placedBefore = ports.placed.length;
    await engine.tick(parent.id);
    expect(ports.placed).toHaveLength(placedBefore);
  });

  it('6: due check uses nextDueAt — startedAt far past with future nextDueAt stays idle', async () => {
    const ports = makePorts();
    const engine = new TwapEngine(ports);
    const parent = engine.create(USER, overdueInput(), LOT);
    const plan = engine.planOf(parent.id)!;
    const now = ports.now();

    // Simulate a hydrate that would place under startedAt-only formula
    // (startedAt epoch + index*interval is long past) but nextDueAt is future.
    engine.hydrate(
      {
        ...parent,
        startedAt: new Date(0),
        nextDueAt: new Date(now.getTime() + INTERVAL),
        nextSliceIndex: 1,
        children: [
          {
            sliceIndex: 0,
            orderId: 'order-0',
            clientOrderId: `algo:${parent.id}:0`,
            qty: plan[0]!,
            placedAt: now,
          },
        ],
        projectedEndsAt: new Date(now.getTime() + 9 * INTERVAL),
        scheduleStretchReason: null,
      },
      plan,
    );

    const tick = await engine.tick(parent.id);
    expect(tick).toEqual({ kind: 'idle', reason: 'ahead_of_schedule' });
    expect(ports.placed).toHaveLength(0);
  });
});

describe('TwapEngine — cancel honesty (engineering defects A/B)', () => {
  it('A: status stays non-cancelled when any child cancel throws; both cancels still attempted', async () => {
    const attempted: string[] = [];
    const ports = makePorts({
      cancelChild: async (orderId) => {
        attempted.push(orderId);
        if (orderId === 'order-1') {
          throw new TradeError('matching down mid-cancel', 'trade.algo_child_cancel_failed');
        }
      },
    });
    const engine = new TwapEngine(ports);
    const parent = engine.create(USER, baseInput({ totalQty: parseAmount('0.004'), durationMs: 8_000, sliceIntervalMs: 2_000 }), LOT);
    await engine.tick(parent.id);
    ports.advance(2_000);
    await engine.tick(parent.id);
    expect(engine.get(parent.id)!.children).toHaveLength(2);

    await expect(engine.cancel(USER, parent.id)).rejects.toMatchObject({
      code: 'trade.algo_child_cancel_failed',
    });
    expect(engine.get(parent.id)!.status).not.toBe('cancelled');
    // W4 C1: partial cancel pauses so the next tick cannot place more children.
    expect(engine.get(parent.id)!.status).not.toBe('active');
    expect(engine.get(parent.id)!.status).toBe('paused');
    expect(engine.get(parent.id)!.haltReason).toBe('cancel_incomplete');
    // Collect-all: both children were asked before the flip decision.
    expect(attempted.sort()).toEqual(['order-0', 'order-1']);

    ports.advance(2_000);
    const after = await engine.tick(parent.id);
    expect(after).toEqual({ kind: 'idle', reason: 'paused' });
    expect(ports.placed).toHaveLength(2); // no third child

    // Resume refused until re-cancel succeeds (adversarial Class M).
    try {
      engine.resume(USER, parent.id);
      throw new Error('expected resume refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(TradeError);
      expect((e as TradeError).code).toBe('trade.algo_cancel_incomplete');
    }
    // Pause is refused with the same code: the only way forward is another cancel.
    expect(() => engine.pause(USER, parent.id)).toThrow(expect.objectContaining({ code: 'trade.algo_cancel_incomplete' }));
    expect(engine.get(parent.id)!.status).toBe('paused');
    expect(engine.get(parent.id)!.haltReason).toBe('cancel_incomplete');
  });

  it('cancel-fail does not look like the parent died: still gettable, children live, not cancelled', async () => {
    let durable: { status: string; haltReason: string | null } | undefined;
    const ports = makePorts({
      cancelChild: async () => {
        throw new TradeError('matching down mid-cancel', 'trade.algo_child_cancel_failed');
      },
    });
    const engine = new TwapEngine(ports, {
      onChange: async (parent) => {
        await new Promise((r) => setTimeout(r, 15));
        durable = { status: parent.status, haltReason: parent.haltReason };
      },
    });
    const parent = engine.create(USER, baseInput({ totalQty: parseAmount('0.004'), durationMs: 8_000, sliceIntervalMs: 2_000 }), LOT);
    await engine.tick(parent.id);
    expect(engine.get(parent.id)!.children).toHaveLength(1);

    await expect(engine.cancel(USER, parent.id)).rejects.toMatchObject({
      code: 'trade.algo_child_cancel_failed',
    });

    const live = engine.get(parent.id);
    expect(live).toBeDefined();
    expect(live!.status).not.toBe('cancelled');
    expect(live!.status).not.toBe('completed');
    expect(live!.status).not.toBe('active');
    expect(live!.children).toHaveLength(1);
    // Awaited onChange: durable park landed before the refuse, so a job host
    // cannot still list this parent as active after cancel failed.
    expect(durable).toEqual({ status: 'paused', haltReason: 'cancel_incomplete' });
  });

  it('A: parent flips cancelled only after every child cancel succeeds', async () => {
    const order: string[] = [];
    const ports = makePorts({
      cancelChild: async (orderId) => {
        order.push(`cancel:${orderId}`);
      },
    });
    const engine = new TwapEngine(ports);
    const parent = engine.create(USER, baseInput({ totalQty: parseAmount('0.004'), durationMs: 8_000, sliceIntervalMs: 2_000 }), LOT);
    await engine.tick(parent.id);
    ports.advance(2_000);
    await engine.tick(parent.id);

    const cancelled = await engine.cancel(USER, parent.id);
    expect(cancelled.status).toBe('cancelled');
    expect(order).toContain('cancel:order-0');
    expect(order).toContain('cancel:order-1');
  });
});

describe('TwapEngine — tickAll isolation (W4 C2)', () => {
  it('one parent throw does not starve the next active parent', async () => {
    let n = 0;
    const ports = makePorts({
      randomId: () => {
        n += 1;
        return `algo-${n}`;
      },
      markFor: async (marketId) => {
        if (marketId === 'm-bad') throw new Error('mark feed down');
        return {
          marketId,
          price: parseAmount('50'),
          asOf: new Date(1_700_000_000_000),
          quality: 'mid' as const,
        };
      },
    });
    const engine = new TwapEngine(ports);
    engine.create(
      USER,
      baseInput({
        totalQty: parseAmount('0.004'),
        durationMs: 8_000,
        sliceIntervalMs: 2_000,
        marketId: 'm-bad',
        symbol: 'BAD/USDT',
        clientAlgoId: 'bad',
      }),
      LOT,
    );
    const good = engine.create(
      USER,
      baseInput({
        totalQty: parseAmount('0.004'),
        durationMs: 8_000,
        sliceIntervalMs: 2_000,
        marketId: 'm-good',
        symbol: 'GOOD/USDT',
        clientAlgoId: 'good',
      }),
      LOT,
    );
    await engine.tickAll();
    // Bad parent threw; good parent still placed one child.
    expect(engine.get(good.id)!.children).toHaveLength(1);
    expect(ports.placed.length).toBe(1);
  });
});

describe('VWAP and POV engines', () => {
  it('VWAP sizes children from observed volume, not equal TWAP slices', async () => {
    const ports = makePorts();
    const engine = new TwapEngine(ports);
    const parent = engine.create(
      USER,
      baseInput({
        kind: 'vwap',
        volumeProfile: [parseAmount('1'), parseAmount('3'), parseAmount('1'), parseAmount('1'), parseAmount('0')],
      }),
      LOT,
    );
    expect(parent.kind).toBe('vwap');
    const plan = engine.planOf(parent.id)!;
    expect(plan[0]).not.toBe(plan[1]);
    const first = await engine.tick(parent.id);
    expect(first.kind).toBe('placed');
    if (first.kind === 'placed') expect(first.child.qty).toBe(plan[0]);
  });

  it('VWAP refuses an all-zero lookback rather than inventing equal slices', () => {
    const engine = new TwapEngine(makePorts());
    expect(() => engine.create(USER, baseInput({ kind: 'vwap', volumeProfile: [0n, 0n, 0n, 0n, 0n] }), LOT)).toThrow(/immature/);
  });

  it('POV places participation of observed interval volume; zero tape is a miss', async () => {
    const ports = makePorts({
      intervalTakerVolume: async () => parseAmount('1'),
    });
    const engine = new TwapEngine(ports);
    const parent = engine.create(
      USER,
      baseInput({ kind: 'pov', participationBps: 1_000, durationMs: 10_000, sliceIntervalMs: 2_000 }),
      LOT,
    );
    expect(parent.kind).toBe('pov');
    expect(parent.participationBps).toBe(1_000);
    const placed = await engine.tick(parent.id);
    expect(placed.kind).toBe('placed');
    if (placed.kind === 'placed') {
      // 1.0 * 1000bps = 0.10, remaining 0.010 → 0.010
      expect(placed.child.qty).toBe(parseAmount('0.010'));
    }

    const quiet = makePorts({ intervalTakerVolume: async () => 0n });
    const quietEngine = new TwapEngine(quiet);
    const quietParent = quietEngine.create(USER, baseInput({ kind: 'pov', participationBps: 1_000, clientAlgoId: 'quiet' }), LOT);
    const miss = await quietEngine.tick(quietParent.id);
    expect(miss.kind).toBe('miss');
    if (miss.kind === 'miss') expect(miss.miss.code).toBe('trade.algo_no_volume');
    expect(quiet.placed).toHaveLength(0);
  });
});
