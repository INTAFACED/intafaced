import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import { TradeError } from '../spot/types.js';
import { presentScheduleHonesty, SCHEDULER_FLAG_OFF } from './present.js';
import { MAX_ALGO_SEED, planTwapSlices } from './schedule.js';
import { TRIGGER_EXPIRED_HALT, TwapEngine, triggerReached, type TwapEngineOptions, type TwapEnginePorts } from './twap-engine.js';
import type { TwapParent } from './types.js';
import type { AlgoQuotedMark, CreateTwapInput } from './types.js';

const LOT = parseAmount('0.0001');
const MARKET = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';

const plan = (seed: number | null, total = '0.003') =>
  planTwapSlices({ totalQty: parseAmount(total), durationMs: 300_000, sliceIntervalMs: 30_000, lotSize: LOT, randomSeed: seed });

function refusal(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof TradeError) return err.code;
    throw err;
  }
  return undefined;
}

describe('random TWAP slice sizes fixed by a seed', () => {
  it('sums exactly to the total, every slice at least one lot', () => {
    const { slices, plannedQty, droppedQty } = plan(2310);
    expect(slices).toHaveLength(10);
    expect(slices.reduce((a, q) => a + q, 0n)).toBe(parseAmount('0.003'));
    expect(plannedQty).toBe(parseAmount('0.003'));
    expect(droppedQty).toBe(0n);
    for (const q of slices) {
      expect(q >= LOT).toBe(true);
      expect(q % LOT).toBe(0n);
    }
  });

  it('gives the same sizes for the same seed and different sizes for another seed', () => {
    expect(plan(2310).slices).toEqual(plan(2310).slices);
    expect(plan(2311).slices).not.toEqual(plan(2310).slices);
    // Random means not all equal, unlike the even plan.
    expect(new Set(plan(2310).slices.map(String)).size).toBeGreaterThan(1);
    expect(new Set(plan(null).slices.map(String)).size).toBe(1);
  });

  it('accepts the seed bounds and refuses a seed outside them', () => {
    expect(plan(0).slices).toHaveLength(10);
    expect(plan(MAX_ALGO_SEED).slices).toHaveLength(10);
    expect(refusal(() => plan(-1))).toBe('trade.algo_invalid_schedule');
    expect(refusal(() => plan(MAX_ALGO_SEED + 1))).toBe('trade.algo_invalid_schedule');
    expect(refusal(() => plan(1.5))).toBe('trade.algo_invalid_schedule');
  });

  it('refuses when the total has fewer lots than slices', () => {
    expect(refusal(() => plan(2310, '0.0009'))).toBe('trade.algo_invalid_qty');
  });
});

function makeEngine(markPrice: { value: string | null; stale?: boolean }, options: TwapEngineOptions = {}) {
  let t = 1_700_000_000_000;
  const placed: number[] = [];
  const ports: TwapEnginePorts = {
    now: () => new Date(t),
    randomId: () => `id-${placed.length}-${t}`,
    placeChild: async (req) => {
      placed.push(req.sliceIndex);
      return { orderId: `order-${req.sliceIndex}` };
    },
    cancelChild: async () => {},
    bestOpposingPrice: async () => parseAmount('50'),
    markFor: async (marketId): Promise<AlgoQuotedMark | null> =>
      markPrice.value === null
        ? null
        : { marketId, price: parseAmount(markPrice.value), asOf: new Date(markPrice.stale ? t - 3_600_000 : t), quality: 'mid' },
  };
  return { engine: new TwapEngine(ports, options), placed, advance: (ms: number) => (t += ms), now: () => new Date(t) };
}

const input = (over: Partial<CreateTwapInput> = {}): CreateTwapInput => ({
  marketId: MARKET,
  symbol: 'BTC/USDT',
  side: 'buy',
  totalQty: parseAmount('0.003'),
  durationMs: 300_000,
  sliceIntervalMs: 30_000,
  limitPrice: null,
  subAccountId: null,
  clientAlgoId: 'trigger-fixture',
  ...over,
});

describe('a TWAP that waits for its trigger price', () => {
  it('places nothing while the mark is below an above trigger, then starts when it is reached', async () => {
    const mark = { value: '50' as string | null };
    const { engine, placed, advance, now } = makeEngine(mark);
    const parent = engine.create(USER, input({ triggerPrice: parseAmount('100'), triggerAbove: true, randomSeed: 2310 }), LOT);
    expect(parent.triggeredAt).toBeNull();
    expect(presentScheduleHonesty(parent, SCHEDULER_FLAG_OFF).nextSliceAt).toBeNull();

    advance(60_000);
    expect(await engine.tick(parent.id)).toEqual({ kind: 'idle', reason: 'awaiting_trigger' });
    expect(placed).toEqual([]);
    expect(engine.get(parent.id)!.children).toHaveLength(0);
    expect(engine.get(parent.id)!.misses).toHaveLength(0);

    mark.value = '100';
    advance(1_000);
    const reachedAt = now().getTime();
    const result = await engine.tick(parent.id);
    expect(result.kind).toBe('placed');
    expect(placed).toEqual([0]);
    const started = engine.get(parent.id)!;
    expect(started.triggeredAt?.getTime()).toBe(reachedAt);
    // Re-spaced from the trigger instant: the slice after it is one interval later, the end ten intervals on.
    expect(started.projectedEndsAt.getTime()).toBe(reachedAt + 10 * 30_000);
    expect(started.nextDueAt.getTime()).toBe(reachedAt + 30_000);
    // The planned sizes are the seed's.
    expect(engine.planOf(parent.id)).toEqual(plan(2310).slices);
  });

  it('a stale or blank mark at the trigger never starts it', async () => {
    const mark = { value: '200' as string | null, stale: true };
    const { engine, placed, advance } = makeEngine(mark);
    const parent = engine.create(USER, input({ triggerPrice: parseAmount('100'), triggerAbove: true }), LOT);
    advance(1_000);
    expect(await engine.tick(parent.id)).toEqual({ kind: 'idle', reason: 'awaiting_trigger' });
    mark.value = null;
    mark.stale = false;
    expect(await engine.tick(parent.id)).toEqual({ kind: 'idle', reason: 'awaiting_trigger' });
    expect(placed).toEqual([]);
    expect(engine.get(parent.id)!.status).toBe('active');
    expect(engine.get(parent.id)!.triggeredAt).toBeNull();
  });

  it('a below trigger waits for the mark to fall to it', () => {
    expect(triggerReached({ triggerPrice: parseAmount('40'), triggerAbove: false }, parseAmount('41'))).toBe(false);
    expect(triggerReached({ triggerPrice: parseAmount('40'), triggerAbove: false }, parseAmount('40'))).toBe(true);
    expect(triggerReached({ triggerPrice: parseAmount('100'), triggerAbove: true }, parseAmount('99'))).toBe(false);
    expect(triggerReached({ triggerPrice: parseAmount('100'), triggerAbove: true }, parseAmount('100'))).toBe(true);
  });

  it('pausing and resuming while waiting keeps it waiting and never refuses for span', async () => {
    const mark = { value: '50' as string | null };
    const { engine, placed, advance } = makeEngine(mark);
    const parent = engine.create(USER, input({ triggerPrice: parseAmount('100'), triggerAbove: true }), LOT);
    engine.pause(USER, parent.id);
    // Longer than twice the duration: a started schedule would refuse to resume; a waiting one has not started.
    advance(700_000);
    const resumed = engine.resume(USER, parent.id);
    expect(resumed.status).toBe('active');
    expect(resumed.triggeredAt).toBeNull();
    expect(await engine.tick(parent.id)).toEqual({ kind: 'idle', reason: 'awaiting_trigger' });
    expect(placed).toEqual([]);
  });

  it('refuses a trigger or seed on a kind other than TWAP, and a non-positive trigger', () => {
    const { engine } = makeEngine({ value: '50' });
    expect(
      refusal(() =>
        engine.create(USER, input({ kind: 'pov', participationBps: 100, triggerPrice: parseAmount('1'), triggerAbove: true }), LOT),
      ),
    ).toBe('trade.algo_invalid_schedule');
    expect(refusal(() => engine.create(USER, input({ triggerPrice: 0n, triggerAbove: true }), LOT))).toBe('trade.algo_invalid_schedule');
  });
});

describe('a waiting schedule ends, and its saves land in order', () => {
  it('halts as expired once it has waited longer than the longest schedule, placing nothing', async () => {
    const mark = { value: '50' as string | null };
    const { engine, placed, advance } = makeEngine(mark, { maxDurationMs: 600_000 });
    const parent = engine.create(USER, input({ triggerPrice: parseAmount('100'), triggerAbove: true }), LOT);
    advance(600_000);
    expect(await engine.tick(parent.id)).toEqual({ kind: 'idle', reason: 'awaiting_trigger' });
    advance(1);
    expect(await engine.tick(parent.id)).toEqual({ kind: 'idle', reason: 'halted' });
    const halted = engine.get(parent.id)!;
    expect(halted.status).toBe('halted');
    expect(halted.haltReason).toBe(TRIGGER_EXPIRED_HALT);
    expect(halted.triggeredAt).toBeNull();
    // Reaching the price afterwards starts nothing.
    mark.value = '100';
    advance(1_000);
    await engine.tick(parent.id);
    expect(placed).toEqual([]);
    expect(engine.get(parent.id)!.children).toHaveLength(0);
  });

  it('a slow first save cannot be overtaken by a later one for the same schedule', async () => {
    const stored: TwapParent[] = [];
    let release: () => void = () => {};
    const firstSave = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    const { engine, advance } = makeEngine(
      { value: '100' },
      {
        onChange: async (parent) => {
          calls += 1;
          if (calls === 1) await firstSave;
          stored.push(parent);
        },
      },
    );
    const parent = engine.create(USER, input({ triggerPrice: parseAmount('100'), triggerAbove: true }), LOT);
    advance(1_000);
    await engine.tick(parent.id);
    engine.pause(USER, parent.id);
    // Nothing written while the first save hangs: the later ones wait behind it.
    await new Promise((r) => setTimeout(r, 10));
    expect(stored).toHaveLength(0);
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(stored.length).toBeGreaterThan(1);
    // The store's last write is the newest state.
    expect(stored.at(-1)!.status).toBe('paused');
    expect(stored.at(-1)!.triggeredAt).not.toBeNull();
  });
});
