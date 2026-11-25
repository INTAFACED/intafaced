import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { TradeError } from '../spot/types.js';
import { algoApiState } from './present.js';
import { TwapEngine, type TwapEnginePorts } from './twap-engine.js';
import { MemoryTwapParentStore } from './parent-store.js';
import { persistAlgoAmend, persistAlgoMutation } from './hydrate-on-mutate.js';
import type { CreateTwapInput } from './types.js';

// SP-conditional-algo-04 (J-cex-spot-15 #6): a TWAP's quantity goes down, or its trigger moves while it waits; nothing
// else is amended, and the algo API's states are mapped from the parent's status and its children's fills.
const LOT = parseAmount('0.001');
const USER = '22222222-2222-2222-2222-222222222222';

function engine() {
  let t = 1_700_000_000_000;
  const placed: string[] = [];
  const ports: TwapEnginePorts = {
    now: () => new Date(t),
    randomId: () => `id-${t}`,
    placeChild: async (req) => {
      placed.push(req.clientOrderId);
      return { orderId: `order-${req.sliceIndex}` };
    },
    cancelChild: async () => {},
    bestOpposingPrice: async () => parseAmount('50'),
    markFor: async (marketId) => ({ marketId, price: parseAmount('50'), asOf: new Date(t), quality: 'mid' }),
  };
  return { e: new TwapEngine(ports), placed, advance: (ms: number) => (t += ms) };
}

const input = (over: Partial<CreateTwapInput> = {}): CreateTwapInput => ({
  marketId: 'm-1',
  symbol: 'BTC/USDT',
  side: 'buy',
  totalQty: parseAmount('0.010'),
  durationMs: 10_000,
  sliceIntervalMs: 2_000,
  limitPrice: parseAmount('100'),
  subAccountId: null,
  clientAlgoId: 'amend-1',
  ...over,
});

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return err instanceof TradeError ? err.code : String(err);
  }
  return null;
};

describe('TwapEngine.amend', () => {
  it('lowers the quantity: slices already placed stay, the rest is planned again over the slices left', async () => {
    const { e, advance } = engine();
    const p = e.create(USER, input(), LOT);
    expect(e.planOf(p.id)!.map(formatAmount)).toEqual(['0.002', '0.002', '0.002', '0.002', '0.002']);
    await e.tick(p.id);
    advance(2_000);
    await e.tick(p.id);
    const amended = e.amend(USER, p.id, { totalQty: parseAmount('0.007') });
    expect(formatAmount(amended.totalQty)).toBe('0.007');
    expect(e.planOf(p.id)!.map(formatAmount)).toEqual(['0.002', '0.002', '0.001', '0.001', '0.001']);
    expect(amended.slicesPlanned).toBe(5);
    expect(amended.nextSliceIndex).toBe(2);
    expect(amended.children).toHaveLength(2);
    // The same quantity again changes nothing.
    expect(e.amend(USER, p.id, { totalQty: parseAmount('0.007') })).toBe(amended);
  });

  it('refuses more quantity, no more than is scheduled, another kind, a finished order and another person', async () => {
    const { e } = engine();
    const p = e.create(USER, input(), LOT);
    await e.tick(p.id);
    expect(codeOf(() => e.amend(USER, p.id, { totalQty: parseAmount('0.011') }))).toBe('trade.amend_qty_up');
    expect(codeOf(() => e.amend(USER, p.id, { totalQty: parseAmount('0.002') }))).toBe('trade.algo_amend_below_placed');
    expect(codeOf(() => e.amend(USER, p.id, {}))).toBe('trade.algo_invalid_qty');
    expect(codeOf(() => e.amend('someone-else', p.id, { totalQty: parseAmount('0.005') }))).toBe('trade.not_owner');
    expect(formatAmount(e.get(p.id)!.totalQty)).toBe('0.01');
    await e.cancel(USER, p.id);
    expect(codeOf(() => e.amend(USER, p.id, { totalQty: parseAmount('0.005') }))).toBe('trade.algo_bad_state');
    const chase = e.create(
      USER,
      input({ kind: 'chase', clientAlgoId: 'c-1', limitPrice: null, chaseMaxDistanceBps: 50, chaseStartPrice: parseAmount('50') }),
      LOT,
    );
    expect(codeOf(() => e.amend(USER, chase.id, { totalQty: parseAmount('0.005') }))).toBe('trade.algo_params_immutable');
  });

  it('moves a trigger only while it waits; an order with none, or one already started, refuses', () => {
    const { e } = engine();
    const waiting = e.create(USER, input({ triggerPrice: parseAmount('80'), triggerAbove: true }), LOT);
    const moved = e.amend(USER, waiting.id, { triggerPrice: parseAmount('90'), triggerAbove: true });
    expect(formatAmount(moved.triggerPrice!)).toBe('90');
    expect(moved.triggeredAt).toBeNull();
    const plain = e.create(USER, input({ clientAlgoId: 'plain' }), LOT);
    expect(codeOf(() => e.amend(USER, plain.id, { triggerPrice: parseAmount('90'), triggerAbove: true }))).toBe('trade.algo_bad_state');
  });
});

describe('an amend in the parent store', () => {
  it('is written even before the first slice, where a changed schedule under the same id reads as a second create', async () => {
    const { e } = engine();
    const store = new MemoryTwapParentStore(() => true);
    const p = e.create(USER, input({ triggerPrice: parseAmount('80'), triggerAbove: true }), LOT);
    await persistAlgoMutation(e, store, p);
    const amended = e.amend(USER, p.id, { totalQty: parseAmount('0.005') });
    // The create's write reads this as another parent under the same id and refuses it: the reason amend has its own write.
    await expect(persistAlgoMutation(e, store, amended)).rejects.toMatchObject({ code: 'trade.algo_duplicate_id' });
    await persistAlgoAmend(e, store, amended);
    const back = await store.load(p.id);
    expect(formatAmount(back!.parent.totalQty)).toBe('0.005');
    expect(back!.plan.map(formatAmount)).toEqual(['0.001', '0.001', '0.001', '0.001', '0.001']);
    // Once stored, the same amended parent saves as usual (the scheduler's own saves on each tick).
    await persistAlgoMutation(e, store, amended);
  });

  it('refuses an amend of a parent the store does not hold', async () => {
    const { e } = engine();
    const p = e.create(USER, input(), LOT);
    await expect(persistAlgoAmend(e, new MemoryTwapParentStore(() => true), p)).rejects.toMatchObject({ code: 'trade.algo_not_found' });
  });
});

describe('algoApiState', () => {
  const total = parseAmount('1');
  it('maps every status, and a finished order by its fills', () => {
    expect(algoApiState('active', 0n, total)).toBe('live');
    expect(algoApiState('paused', 0n, total)).toBe('live');
    expect(algoApiState('cancelled', parseAmount('0.5'), total)).toBe('canceled');
    expect(algoApiState('halted', 0n, total)).toBe('order_failed');
    expect(algoApiState('completed', total, total)).toBe('effective');
    expect(algoApiState('completed', parseAmount('0.5'), total)).toBe('partially_effective');
    expect(algoApiState('completed', 0n, total)).toBe('order_failed');
  });
});
