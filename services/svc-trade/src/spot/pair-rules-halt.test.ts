/**
 * SP-order-entry-03 automated-review fixes (review file
 * /workspace/reviews/auto-sp-order-entry-03-6206116da.md):
 *  1. circuit-breaker halt state is published from the operator risk row the
 *     order path enforces, so a halted pair never looks tradable;
 *  2. a failed risk read degrades the listing (pairRules/pairHalt null, logged),
 *     never fails GET /api/v1/markets;
 *  3. an out-of-range cap the order path would refuse is never published.
 */
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { marketSchema } from '@intafaced/exchange-contract';
import type { RiskVersion } from '../admin/risk.js';
import { fakeMarket, registerPublicRest, type PublicRestDeps } from '../public-rest.js';
import { effectiveSlippageCapBps, PAIR_HALT_CIRCUIT_BREAKER_CODE, presentPairHalt, presentPairRisk } from './pair-rules.js';

function risk(over: Partial<RiskVersion> = {}): RiskVersion {
  return {
    marketId: 'm-a',
    version: '4',
    collar: null,
    fatFinger: null,
    slippageCap: null,
    throttle: null,
    circuitBreaker: null,
    oiLimit: null,
    oiShareBps: null,
    priceRangeMax: null,
    priceRangeTrigger: null,
    priceRangeCadenceSeconds: null,
    operatorId: 'op',
    approverId: 'ap',
    reason: 'r',
    approvalId: 'a',
    createdAt: '2026-10-22T00:00:00.000Z',
    ...over,
  };
}

const a = fakeMarket({ id: 'm-a', symbol: 'BTC/USDT' });
const b = fakeMarket({ id: 'm-b', symbol: 'ETH/USDT' });

async function list(extra: Partial<PublicRestDeps>) {
  const app = Fastify();
  registerPublicRest(app, {
    markets: async () => [a, b],
    marketBySymbol: async () => null,
    depth: async () => ({ bids: [], asks: [], sequence: 0 }),
    publicTape: async () => [],
    candles: async () => [],
    ...extra,
  } as PublicRestDeps);
  await app.ready();
  const res = await app.inject({ method: 'GET', url: '/api/v1/markets?limit=10' });
  await app.close();
  return res;
}

describe('SP-order-entry-03 circuit-breaker halt state', () => {
  it('a set circuit breaker publishes refusesAllOrders with the order-path refusal code', () => {
    expect(presentPairHalt(risk({ circuitBreaker: '500' }))).toEqual({
      circuitBreaker: '500',
      refusesAllOrders: true,
      refusalCode: PAIR_HALT_CIRCUIT_BREAKER_CODE,
      riskVersion: '4',
    });
    expect(PAIR_HALT_CIRCUIT_BREAKER_CODE).toBe('trade.circuit_breaker_reference_unset');
  });
  it('no breaker (or no approved row) is "not set" and not halted', () => {
    expect(presentPairHalt(null)).toEqual({ circuitBreaker: 'not set', refusesAllOrders: false, refusalCode: null, riskVersion: '0' });
    expect(presentPairHalt(risk()).refusesAllOrders).toBe(false);
  });
  it('GET /api/v1/markets publishes pairHalt per market from the one batched read, and parses through the contract', async () => {
    const calls: string[][] = [];
    const res = await list({
      pairRiskForMarkets: async (ms) => {
        calls.push(ms.map((m) => m.id));
        return new Map([
          ['m-a', presentPairRisk(a, risk({ circuitBreaker: '500' }))],
          ['m-b', presentPairRisk(b, null)],
        ]);
      },
    });
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual([['m-a', 'm-b']]);
    const [rowA, rowB] = res.json();
    expect(rowA.pairHalt.refusesAllOrders).toBe(true);
    expect(rowA.pairHalt.refusalCode).toBe('trade.circuit_breaker_reference_unset');
    expect(rowB.pairHalt.refusesAllOrders).toBe(false);
    expect(rowA.pairRules.riskVersion).toBe('4');
    for (const row of [rowA, rowB]) {
      const parsed = marketSchema.safeParse(row);
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.pairHalt).toEqual(row.pairHalt);
    }
  });
});

describe('SP-order-entry-03 listing degrades on a failed risk read', () => {
  it('batched risk read throws: 200, every market listed with pairRules/pairHalt null, error logged', async () => {
    const logged: unknown[] = [];
    const res = await list({
      pairRiskForMarkets: async () => {
        throw new Error('relation "trade.operator_risk_limits" does not exist');
      },
      onPairRulesReadError: (err) => logged.push(err),
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json();
    expect(rows.map((r: { symbol: string }) => r.symbol)).toEqual(['BTC/USDT', 'ETH/USDT']);
    for (const r of rows) {
      expect(r.pairRules).toBeNull();
      expect(r.pairHalt).toBeNull();
    }
    expect(logged).toHaveLength(1);
  });
  it('rules-only batched reader throws: still 200 with pairRules null', async () => {
    const logged: unknown[] = [];
    const res = await list({
      pairRulesForMarkets: async () => {
        throw new Error('pool exhausted');
      },
      onPairRulesReadError: (err) => logged.push(err),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().every((r: { pairRules: unknown }) => r.pairRules === null)).toBe(true);
    expect(logged).toHaveLength(1);
  });
  it('without a sink the failure still does not fail the listing', async () => {
    const res = await list({
      pairRiskForMarkets: async () => {
        throw new Error('db down');
      },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('SP-order-entry-03 published cap is one the order path honours', () => {
  it('out-of-range env cap (0, 5001, non-integer) publishes "not set"', () => {
    expect(effectiveSlippageCapBps(null, 0)).toBe('not set');
    expect(effectiveSlippageCapBps(null, 5001)).toBe('not set');
    expect(effectiveSlippageCapBps(null, 1.5)).toBe('not set');
    expect(effectiveSlippageCapBps(null, 5000)).toBe('5000');
    expect(effectiveSlippageCapBps(null, 1)).toBe('1');
  });
  it('out-of-range integer operator cap publishes "not set" (the order path would refuse it)', () => {
    expect(effectiveSlippageCapBps(risk({ slippageCap: '9000' }), 150)).toBe('not set');
  });
});
