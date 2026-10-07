import { parseAmount, ZERO } from '@intafaced/ledger-client';
import type { VenueExecution } from '@intafaced/venue-adapter';
import { describe, expect, it } from 'vitest';
import { executeOmsArbAtomicLegs } from './oms-arb-execute-legs.js';
import { InMemoryEmsOrderStore } from './oms-ems-store.js';
import type { OmsSubmitFn } from './oms-trade-submit.js';

function executionFor(venueId: string, status: VenueExecution['status'] = 'filled'): VenueExecution {
  return {
    venueId,
    venueOrderId: `order-${venueId}`,
    filledAmount: parseAmount('1'),
    averagePrice: parseAmount(status === 'rejected' ? '0' : '100'),
    feeAmount: ZERO,
    feeAsset: 'USDT',
    status,
    executedAt: new Date('2026-08-24T00:00:00.000Z'),
  };
}

function input(overrides: Partial<Parameters<typeof executeOmsArbAtomicLegs>[0]> = {}) {
  return {
    parentClientOrderId: 'arb-parent-1',
    executionGroupId: 'arb-group-1',
    symbol: 'BTC/USDT',
    amount: '1',
    buyVenueId: 'binance-spot',
    sellVenueId: 'bybit-spot',
    buyLimitPrice: '100',
    sellLimitPrice: '101',
    inventory: { prePositionedByVenue: { 'binance-spot': true, 'bybit-spot': true } },
    ...overrides,
  };
}

describe('executeOmsArbAtomicLegs', () => {
  it('submits both legs with deterministic parent/group-bound child IDs', async () => {
    const calls: string[] = [];
    const submit: OmsSubmitFn = async (req) => {
      calls.push(`${req.side}:${req.clientOrderId}`);
      return executionFor(req.side === 'buy' ? 'binance-spot' : 'bybit-spot');
    };
    const result = await executeOmsArbAtomicLegs(input(), { 'binance-spot': submit, 'bybit-spot': submit });
    expect(result).toMatchObject({ ok: true, parentClientOrderId: 'arb-parent-1', executionGroupId: 'arb-group-1' });
    if (!result.ok) return;
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatch(/^buy:arb-parent-1\/client\/leg-0-0-[0-9a-f]{24}$/);
    expect(calls[1]).toMatch(/^sell:arb-parent-1\/client\/leg-1-0-[0-9a-f]{24}$/);
    expect(result.children.map((child) => child.outcome)).toEqual(['APPLIED', 'APPLIED']);
    expect(result.executions).toHaveLength(2);
    expect(result.children[0]?.childOrderId).not.toBe(result.children[1]?.childOrderId);
  });

  it('returns explicit empty arrays for a planning refusal', async () => {
    const result = await executeOmsArbAtomicLegs(
      input({ inventory: { prePositionedByVenue: { 'binance-spot': true, 'bybit-spot': false } } }),
      {},
    );
    expect(result).toMatchObject({ ok: false, reason: 'inventory_missing', executions: [], children: [] });
  });

  it('turns a first-leg throw into SUBMIT_UNKNOWN and fences its retry', async () => {
    const store = new InMemoryEmsOrderStore();
    let calls = 0;
    const submit: OmsSubmitFn = async () => {
      calls += 1;
      throw new Error('venue timeout');
    };
    const first = await executeOmsArbAtomicLegs(input(), { 'binance-spot': submit, 'bybit-spot': submit }, store);
    expect(first).toMatchObject({ ok: false, reason: 'submit_failed', outcome: 'OUTCOME_UNKNOWN', state: 'SUBMIT_UNKNOWN' });
    if (first.ok || first.reason !== 'submit_failed') throw new Error('expected unknown');
    expect(first.executions).toEqual([]);
    expect(first.children).toMatchObject([{ outcome: 'OUTCOME_UNKNOWN', state: 'SUBMIT_UNKNOWN', execution: null }]);
    expect(first.reconciliationKey).toBe(`lookup:${first.children[0]!.clientOrderId}`);

    const retry = await executeOmsArbAtomicLegs(input(), { 'binance-spot': submit, 'bybit-spot': submit }, store);
    expect(retry).toMatchObject({ ok: false, outcome: 'OUTCOME_UNKNOWN', state: 'SUBMIT_UNKNOWN' });
    expect(calls).toBe(1);
  });

  it('retains the completed first leg when a later leg is unknown and fences both on retry', async () => {
    const store = new InMemoryEmsOrderStore();
    let calls = 0;
    const submit: OmsSubmitFn = async (req) => {
      calls += 1;
      if (req.side === 'sell') throw new Error('second venue timeout');
      return executionFor('binance-spot');
    };
    const first = await executeOmsArbAtomicLegs(input(), { 'binance-spot': submit, 'bybit-spot': submit }, store);
    expect(first).toMatchObject({ ok: false, outcome: 'OUTCOME_UNKNOWN' });
    if (first.ok || first.reason !== 'submit_failed') throw new Error('expected unknown');
    expect(first.children.map((child) => child.outcome)).toEqual(['APPLIED', 'OUTCOME_UNKNOWN']);
    expect(first.executions).toHaveLength(1);

    const retry = await executeOmsArbAtomicLegs(input(), { 'binance-spot': submit, 'bybit-spot': submit }, store);
    expect(retry).toMatchObject({ ok: false, outcome: 'OUTCOME_UNKNOWN' });
    expect(calls).toBe(2);
  });

  it('records a rejected child as REFUSED with explicit completed arrays and fences retry', async () => {
    const store = new InMemoryEmsOrderStore();
    let calls = 0;
    const submit: OmsSubmitFn = async (req) => {
      calls += 1;
      return executionFor(req.side === 'buy' ? 'binance-spot' : 'bybit-spot', req.side === 'sell' ? 'rejected' : 'filled');
    };
    const first = await executeOmsArbAtomicLegs(input(), { 'binance-spot': submit, 'bybit-spot': submit }, store);
    expect(first).toMatchObject({ ok: false, outcome: 'REFUSED', state: 'ENGINE_REJECTED' });
    if (first.ok || first.reason !== 'submit_failed') throw new Error('expected refusal');
    expect(first.children.map((child) => child.outcome)).toEqual(['APPLIED', 'REFUSED']);
    expect(first.executions).toHaveLength(2);
    const retry = await executeOmsArbAtomicLegs(input(), { 'binance-spot': submit, 'bybit-spot': submit }, store);
    expect(retry).toMatchObject({ ok: false, outcome: 'REFUSED' });
    expect(calls).toBe(2);
  });

  it('records an unwired child as UNWIRED with explicit completed arrays and fences retry', async () => {
    const store = new InMemoryEmsOrderStore();
    let calls = 0;
    const submit: OmsSubmitFn = async () => {
      calls += 1;
      return executionFor('binance-spot');
    };
    const first = await executeOmsArbAtomicLegs(input(), { 'binance-spot': submit }, store);
    expect(first).toMatchObject({ ok: false, outcome: 'REFUSED', state: 'ENGINE_REJECTED' });
    if (first.ok || first.reason !== 'submit_failed') throw new Error('expected unwired refusal');
    expect(first.children.map((child) => child.outcome)).toEqual(['APPLIED', 'UNWIRED']);
    expect(first.children[1]?.execution).toBeNull();
    expect(first.executions).toHaveLength(1);
    const retry = await executeOmsArbAtomicLegs(input(), { 'binance-spot': submit }, store);
    expect(retry).toMatchObject({ ok: false, outcome: 'REFUSED' });
    expect(calls).toBe(1);
  });

  it('refuses a blank or whitespace parent before plan or submit', async () => {
    const store = new InMemoryEmsOrderStore();
    let submits = 0;
    const submit: OmsSubmitFn = async (req) => {
      submits += 1;
      return executionFor(req.side === 'buy' ? 'binance-spot' : 'bybit-spot');
    };
    const venues = { 'binance-spot': submit, 'bybit-spot': submit };

    const whitespace = await executeOmsArbAtomicLegs(input({ parentClientOrderId: ' \t ', executionGroupId: ' \n ' }), venues, store);
    const empty = await executeOmsArbAtomicLegs(input({ parentClientOrderId: '', executionGroupId: '' }), venues, store);
    const unplanned = await executeOmsArbAtomicLegs(
      input({
        parentClientOrderId: '   ',
        executionGroupId: '   ',
        inventory: { prePositionedByVenue: { 'binance-spot': true, 'bybit-spot': false } },
      }),
      venues,
      store,
    );

    expect(whitespace).toMatchObject({
      ok: false,
      reason: 'missing_identity',
      parentClientOrderId: '',
      executionGroupId: '',
      executions: [],
      children: [],
    });
    expect(empty).toMatchObject({
      ok: false,
      reason: 'missing_identity',
      parentClientOrderId: '',
      executionGroupId: '',
      executions: [],
      children: [],
    });
    expect(unplanned).toMatchObject({
      ok: false,
      reason: 'missing_identity',
      parentClientOrderId: '',
      executionGroupId: '',
      executions: [],
      children: [],
    });
    expect(unplanned).not.toMatchObject({ reason: 'inventory_missing' });
    expect(submits).toBe(0);
    expect(store.list()).toEqual([]);
    expect(whitespace).not.toMatchObject({ reason: 'submit_failed' });
    expect(empty).not.toMatchObject({ reason: 'submit_failed' });
    const childIds = [...whitespace.children, ...empty.children].map((child) => child.clientOrderId);
    expect(childIds.filter((id) => id.startsWith('oms/'))).toEqual([]);
    expect(new Set(childIds).size).toBe(childIds.length);
  });

  it('refuses a blank, non-numeric, or non-positive amount before submit and does not fence a corrected retry', async () => {
    const cases = [
      { amount: '', label: 'blank' },
      { amount: '   ', label: 'whitespace' },
      { amount: 'not-a-number', label: 'non-numeric' },
      { amount: '0', label: 'zero' },
      { amount: '-1', label: 'negative' },
    ] as const;

    for (const { amount, label } of cases) {
      const store = new InMemoryEmsOrderStore();
      const seen: { side: string; amount: ReturnType<typeof parseAmount>; limitPrice: ReturnType<typeof parseAmount> }[] = [];
      let submits = 0;
      const submit: OmsSubmitFn = async (req) => {
        submits += 1;
        seen.push({ side: req.side, amount: req.amount, limitPrice: req.limitPrice });
        return executionFor(req.side === 'buy' ? 'binance-spot' : 'bybit-spot');
      };
      const venues = { 'binance-spot': submit, 'bybit-spot': submit };
      const parentClientOrderId = `arb-amount-${label}`;

      const refused = await executeOmsArbAtomicLegs(input({ amount, parentClientOrderId }), venues, store);
      expect(refused.ok).toBe(false);
      expect(refused).not.toMatchObject({ reason: 'submit_failed' });
      expect(refused).not.toMatchObject({ outcome: 'OUTCOME_UNKNOWN', state: 'SUBMIT_UNKNOWN' });
      if (!refused.ok) {
        expect(refused.children).toEqual([]);
        expect(refused.executions).toEqual([]);
      }
      expect(submits).toBe(0);
      expect(store.list()).toEqual([]);

      const retried = await executeOmsArbAtomicLegs(input({ amount: '1.5', parentClientOrderId }), venues, store);
      expect(retried.ok).toBe(true);
      expect(submits).toBe(2);
      expect(seen).toEqual([
        { side: 'buy', amount: parseAmount('1.5'), limitPrice: parseAmount('100') },
        { side: 'sell', amount: parseAmount('1.5'), limitPrice: parseAmount('101') },
      ]);
    }
  });

  it('checks the sell limit before the buy is sent', async () => {
    const cases = [
      { field: 'sell' as const, price: '', label: 'blank-sell' },
      { field: 'sell' as const, price: '   ', label: 'whitespace-sell' },
      { field: 'sell' as const, price: 'not-a-price', label: 'non-numeric-sell' },
      { field: 'buy' as const, price: '', label: 'blank-buy' },
      { field: 'buy' as const, price: 'not-a-price', label: 'non-numeric-buy' },
    ];

    for (const { field, price, label } of cases) {
      const store = new InMemoryEmsOrderStore();
      const seen: { side: string; amount: ReturnType<typeof parseAmount>; limitPrice: ReturnType<typeof parseAmount> }[] = [];
      const submit: OmsSubmitFn = async (req) => {
        seen.push({ side: req.side, amount: req.amount, limitPrice: req.limitPrice });
        return executionFor(req.side === 'buy' ? 'binance-spot' : 'bybit-spot');
      };
      const venues = { 'binance-spot': submit, 'bybit-spot': submit };
      const parentClientOrderId = `arb-limit-${label}`;
      const limits = field === 'sell' ? { sellLimitPrice: price } : { buyLimitPrice: price };

      const refused = await executeOmsArbAtomicLegs(input({ amount: '1.5', parentClientOrderId, ...limits }), venues, store);
      expect(seen).toEqual([]);
      expect(refused).toMatchObject({
        ok: false,
        reason: 'invalid_limit',
        parentClientOrderId,
        executions: [],
        children: [],
      });
      expect(refused).not.toMatchObject({ reason: 'submit_failed' });
      expect(refused).not.toMatchObject({ outcome: 'OUTCOME_UNKNOWN', state: 'SUBMIT_UNKNOWN' });
      expect(store.list()).toEqual([]);

      const retried = await executeOmsArbAtomicLegs(input({ amount: '1.5', parentClientOrderId }), venues, store);
      expect(retried.ok).toBe(true);
      expect(seen).toEqual([
        { side: 'buy', amount: parseAmount('1.5'), limitPrice: parseAmount('100') },
        { side: 'sell', amount: parseAmount('1.5'), limitPrice: parseAmount('101') },
      ]);
    }
  });

  it('keeps identities deterministic and collision-resistant across parent/group/leg combinations', async () => {
    const submit: OmsSubmitFn = async (req) => executionFor(req.side === 'buy' ? 'binance-spot' : 'bybit-spot');
    const a = await executeOmsArbAtomicLegs(input(), { 'binance-spot': submit, 'bybit-spot': submit });
    const b = await executeOmsArbAtomicLegs(input({ parentClientOrderId: 'arb-parent-2', executionGroupId: 'arb-group-2' }), {
      'binance-spot': submit,
      'bybit-spot': submit,
    });
    if (!a.ok || !b.ok) throw new Error('expected successful legs');
    expect(a.children.map((child) => child.clientOrderId)).not.toEqual(b.children.map((child) => child.clientOrderId));
    expect(a.children[0]?.clientOrderId).not.toBe(a.children[1]?.clientOrderId);
    expect(a.children.every((child) => child.parentClientOrderId === 'arb-parent-1')).toBe(true);
    expect(a.children.every((child) => child.executionGroupId === 'arb-group-1')).toBe(true);
  });
});
