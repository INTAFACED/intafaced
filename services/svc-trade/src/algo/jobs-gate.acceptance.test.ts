/**
 * TRD-0522. TRADE_ALGO_ENABLED does not run the slice scheduler.
 * Create must refuse while TRADE_ALGO_JOBS_ENABLED is false, and must not
 * leave an active parent row.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import { MemoryTwapParentStore } from './parent-store.js';
import { TwapEngine, type TwapEnginePorts } from './twap-engine.js';
import { admitFreshActiveAlgoParent, readTradeAlgoJobsEnabled } from './jobs-gate.js';
import type { AlgoQuotedMark, CreateTwapInput } from './types.js';

const LOT = parseAmount('0.001');
const USER = '22222222-2222-4222-8222-222222222222';
const MARKET = '11111111-1111-4111-8111-111111111111';

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
    clientAlgoId: 'sched-1',
    ...over,
  };
}

function ports(): TwapEnginePorts {
  const t = Date.parse('2026-10-18T00:00:00.000Z');
  return {
    now: () => new Date(t),
    randomId: () => 'unused-random-id',
    placeChild: async () => ({ orderId: 'child-1' }),
    cancelChild: async () => {},
    bestOpposingPrice: async () => parseAmount('100'),
    markFor: async (marketId): Promise<AlgoQuotedMark> => ({
      marketId,
      price: parseAmount('100'),
      asOf: new Date(t),
      quality: 'mid',
    }),
  };
}

const previousJobs = process.env.TRADE_ALGO_JOBS_ENABLED;
const previousEnabled = process.env.TRADE_ALGO_ENABLED;

afterEach(() => {
  if (previousJobs === undefined) delete process.env.TRADE_ALGO_JOBS_ENABLED;
  else process.env.TRADE_ALGO_JOBS_ENABLED = previousJobs;
  if (previousEnabled === undefined) delete process.env.TRADE_ALGO_ENABLED;
  else process.env.TRADE_ALGO_ENABLED = previousEnabled;
});

describe('TRD-0522 algo create while the scheduler is off', () => {
  it('refuses a TWAP parent when jobs are off and algo create is on, and stores no active row', async () => {
    process.env.TRADE_ALGO_ENABLED = 'true';
    process.env.TRADE_ALGO_JOBS_ENABLED = 'false';
    expect(readTradeAlgoJobsEnabled()).toBe(false);

    const store = new MemoryTwapParentStore();
    const engine = new TwapEngine(ports());
    const { parent, plan } = engine.prepare(USER, baseInput(), LOT);

    await expect(store.save({ parent, plan })).rejects.toMatchObject({ code: 'trade.algo_jobs_disabled' });
    expect(await store.listActive()).toEqual([]);
    expect(await store.load(parent.id)).toBeNull();
  });

  it('does not leave an active parent when the flag read fails after a row was stored', async () => {
    const rows = new Map<string, 'active'>();
    await expect(
      admitFreshActiveAlgoParent({
        readJobs: () => {
          rows.set('parent-1', 'active');
          throw new Error('flag store unreadable');
        },
        isActive: async () => rows.get('parent-1') === 'active',
        persist: async () => {
          rows.set('parent-1', 'active');
        },
        abandon: async () => {
          rows.delete('parent-1');
        },
      }),
    ).rejects.toMatchObject({ code: 'trade.algo_jobs_unknown' });
    expect(rows.has('parent-1')).toBe(false);
  });

  it('does not store a second parent for the same client algo id', async () => {
    process.env.TRADE_ALGO_ENABLED = 'true';
    process.env.TRADE_ALGO_JOBS_ENABLED = 'true';
    const store = new MemoryTwapParentStore();
    const firstEngine = new TwapEngine(ports());
    const first = firstEngine.prepare(USER, baseInput({ clientAlgoId: 'same-client', totalQty: parseAmount('0.010') }), LOT);
    await store.save({ parent: first.parent, plan: first.plan });

    const restarted = new TwapEngine(ports());
    const second = restarted.prepare(USER, baseInput({ clientAlgoId: 'same-client', totalQty: parseAmount('0.020') }), LOT);
    expect(second.parent.id).toBe(first.parent.id);

    await expect(store.save({ parent: second.parent, plan: second.plan })).rejects.toMatchObject({
      code: 'trade.algo_duplicate_id',
    });
    const stored = await store.load(first.parent.id);
    expect(await store.listActive()).toHaveLength(1);
    expect(stored?.parent.totalQty).toBe(parseAmount('0.010'));
  });
});
