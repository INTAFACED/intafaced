import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import { TradeError } from '../spot/types.js';
import { MemoryTwapParentStore } from './parent-store.js';
import { hydrateAlgoFromStore, hydrateAlgoIfMissing, persistAlgoCancelAttempt, persistAlgoMutation } from './hydrate-on-mutate.js';
import { CANCEL_INCOMPLETE_HALT, TwapEngine, type TwapEnginePorts } from './twap-engine.js';
import type { AlgoQuotedMark, CreateTwapInput } from './types.js';

const LOT = parseAmount('0.001');
const USER = '22222222-2222-4222-8222-222222222222';
const OTHER = '44444444-4444-4444-8444-444444444444';

function baseInput(): CreateTwapInput {
  return {
    marketId: '11111111-1111-4111-8111-111111111111',
    symbol: 'BTC/USDT',
    side: 'buy',
    totalQty: parseAmount('0.004'),
    durationMs: 8_000,
    sliceIntervalMs: 2_000,
    limitPrice: parseAmount('100'),
    subAccountId: null,
    clientAlgoId: 'fixture-algo',
  };
}

function ports(): TwapEnginePorts {
  const t = 1_700_000_000_000;
  return {
    now: () => new Date(t),
    randomId: () => 'algo-restart-1',
    placeChild: async () => ({ orderId: 'order-0' }),
    cancelChild: async () => undefined,
    bestOpposingPrice: async () => parseAmount('50'),
    markFor: async (marketId): Promise<AlgoQuotedMark | null> => ({
      marketId,
      price: parseAmount('50'),
      asOf: new Date(t),
      quality: 'mid',
    }),
  };
}

describe('trade.algo — hydrate on mutate after restart', () => {
  const previousJobs = process.env.TRADE_ALGO_JOBS_ENABLED;
  beforeEach(() => {
    process.env.TRADE_ALGO_JOBS_ENABLED = 'true';
  });
  afterEach(() => {
    if (previousJobs === undefined) delete process.env.TRADE_ALGO_JOBS_ENABLED;
    else process.env.TRADE_ALGO_JOBS_ENABLED = previousJobs;
  });

  it('pause after cold engine loads store and persists paused', async () => {
    const store = new MemoryTwapParentStore();
    const live = new TwapEngine(ports(), { onChange: (parent, plan) => store.save({ parent, plan }) });
    const parent = live.create(USER, baseInput(), LOT);
    await store.save({ parent, plan: live.planOf(parent.id) ?? [] });

    const cold = new TwapEngine(ports());
    expect(cold.get(parent.id)).toBeUndefined();

    await hydrateAlgoIfMissing(cold, store, USER, parent.id);
    const paused = await persistAlgoMutation(cold, store, cold.pause(USER, parent.id));
    expect(paused.status).toBe('paused');

    const loaded = await store.load(parent.id);
    expect(loaded?.parent.status).toBe('paused');
  });

  it('resume after cold engine loads paused parent and persists active', async () => {
    const store = new MemoryTwapParentStore();
    const live = new TwapEngine(ports());
    const parent = live.create(USER, baseInput(), LOT);
    const paused = live.pause(USER, parent.id);
    await persistAlgoMutation(live, store, paused);

    const cold = new TwapEngine(ports());
    expect(cold.get(parent.id)).toBeUndefined();
    await hydrateAlgoIfMissing(cold, store, USER, parent.id);
    const resumed = await persistAlgoMutation(cold, store, cold.resume(USER, parent.id));
    expect(resumed.status).toBe('active');
    expect(resumed.haltReason).toBeNull();

    const loaded = await store.load(parent.id);
    expect(loaded?.parent.status).toBe('active');
  });

  it('cancel after cold engine loads store and persists cancelled', async () => {
    const store = new MemoryTwapParentStore();
    const live = new TwapEngine(ports());
    const parent = live.create(USER, baseInput(), LOT);
    await persistAlgoMutation(live, store, parent);

    const cold = new TwapEngine(ports());
    expect(cold.get(parent.id)).toBeUndefined();
    await hydrateAlgoIfMissing(cold, store, USER, parent.id);
    const cancelled = await persistAlgoCancelAttempt(cold, store, USER, parent.id);
    expect(cancelled.status).toBe('cancelled');

    const loaded = await store.load(parent.id);
    expect(loaded?.parent.status).toBe('cancelled');
  });

  it('cancel_incomplete after restart still refuses resume', async () => {
    const store = new MemoryTwapParentStore();
    const p: TwapEnginePorts = {
      ...ports(),
      cancelChild: async () => {
        throw new TradeError('matching down mid-cancel', 'trade.algo_child_cancel_failed');
      },
    };
    const live = new TwapEngine(p);
    const parent = live.create(USER, baseInput(), LOT);
    await live.tick(parent.id);
    await persistAlgoMutation(live, store, live.get(parent.id)!);

    await expect(persistAlgoCancelAttempt(live, store, USER, parent.id)).rejects.toMatchObject({
      code: 'trade.algo_child_cancel_failed',
    });
    expect((await store.load(parent.id))?.parent.haltReason).toBe(CANCEL_INCOMPLETE_HALT);

    const cold = new TwapEngine(p);
    await hydrateAlgoIfMissing(cold, store, USER, parent.id);
    expect(() => cold.resume(USER, parent.id)).toThrow(TradeError);
    try {
      cold.resume(USER, parent.id);
      throw new Error('expected resume refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(TradeError);
      expect((e as TradeError).code).toBe('trade.algo_cancel_incomplete');
    }
    expect((await store.load(parent.id))?.parent.status).toBe('paused');
  });

  it('wrong owner after restart still 404s (does not hydrate stranger)', async () => {
    const store = new MemoryTwapParentStore();
    const live = new TwapEngine(ports());
    const parent = live.create(USER, baseInput(), LOT);
    await store.save({ parent, plan: live.planOf(parent.id) ?? [] });

    const cold = new TwapEngine(ports());
    await expect(hydrateAlgoIfMissing(cold, store, OTHER, parent.id)).rejects.toMatchObject({
      code: 'trade.algo_not_found',
    });
    expect(cold.get(parent.id)).toBeUndefined();
  });

  it('missing id throws TradeError not found', async () => {
    const store = new MemoryTwapParentStore();
    const cold = new TwapEngine(ports());
    await expect(hydrateAlgoIfMissing(cold, store, USER, 'missing')).rejects.toBeInstanceOf(TradeError);
  });

  it('tick after restart hydrates from store and awaits save of the miss', async () => {
    const dry = { ...ports(), bestOpposingPrice: async () => null };
    const store = new MemoryTwapParentStore();
    const live = new TwapEngine(dry);
    const parent = live.create(USER, baseInput(), LOT);
    await store.save({ parent, plan: live.planOf(parent.id) ?? [] });
    expect((await store.load(parent.id))?.parent.misses).toHaveLength(0);

    const cold = new TwapEngine(dry);
    await hydrateAlgoFromStore(cold, store, parent.id);
    const tick = await cold.tick(parent.id);
    expect(tick.kind).toBe('miss');
    const after = cold.get(parent.id)!;
    await persistAlgoMutation(cold, store, after);

    const loaded = await store.load(parent.id);
    expect(loaded?.parent.misses).toHaveLength(1);
    expect(loaded?.parent.nextSliceIndex).toBe(1);
  });

  it('cancel-fail persists paused parent so the store is not still active', async () => {
    const store = new MemoryTwapParentStore();
    const p: TwapEnginePorts = {
      ...ports(),
      cancelChild: async () => {
        throw new TradeError('matching down mid-cancel', 'trade.algo_child_cancel_failed');
      },
    };
    const live = new TwapEngine(p);
    const parent = live.create(USER, baseInput(), LOT);
    await live.tick(parent.id);
    await persistAlgoMutation(live, store, live.get(parent.id)!);
    expect((await store.load(parent.id))?.parent.status).toBe('active');

    await expect(persistAlgoCancelAttempt(live, store, USER, parent.id)).rejects.toMatchObject({
      code: 'trade.algo_child_cancel_failed',
    });

    const parked = await store.load(parent.id);
    expect(parked?.parent.status).not.toBe('active');
    expect(parked?.parent.status).toBe('paused');
    expect(parked?.parent.haltReason).toBe('cancel_incomplete');
    expect(await store.listActive()).toHaveLength(0);

    const cold = new TwapEngine(p);
    await hydrateAlgoFromStore(cold, store, parent.id);
    const tick = await cold.tick(parent.id);
    expect(tick).toEqual({ kind: 'idle', reason: 'paused' });
    expect(cold.get(parent.id)!.status).not.toBe('active');
  });

  it('hydrateAlgoFromStore 404s when the store has no row', async () => {
    const store = new MemoryTwapParentStore();
    const cold = new TwapEngine(ports());
    await expect(hydrateAlgoFromStore(cold, store, 'missing')).rejects.toMatchObject({
      code: 'trade.algo_not_found',
    });
  });
});
