/**
 * SP-order-entry-03 fix round: the slippage cap shown is the EFFECTIVE cap the
 * order path enforces (operator cap, else owner env cap, else "not set"), and
 * GET /api/v1/markets reads rules for all markets in one batched call.
 */
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { marketSchema } from '@intafaced/exchange-contract';
import { parseAmount } from '@intafaced/ledger-client';
import type { RiskVersion } from '../admin/risk.js';
import { fakeMarket, registerPublicRest } from '../public-rest.js';
import { effectiveSlippageCapBps, presentPairRules } from './pair-rules.js';

const market = fakeMarket({ id: 'm-a', symbol: 'BTC/USDT', maxQty: parseAmount('2') });

function risk(slippageCap: string | null): RiskVersion {
  return {
    marketId: 'm-a',
    version: '1',
    collar: null,
    fatFinger: null,
    slippageCap,
    throttle: null,
    circuitBreaker: null,
    operatorId: 'op',
    approverId: 'ap',
    reason: 'r',
    approvalId: 'a',
    createdAt: '2026-10-22T00:00:00.000Z',
  };
}

describe('SP-order-entry-03 effective slippage cap', () => {
  it('env cap set and no operator row: shows the env cap, not "not set"', () => {
    expect(presentPairRules(market, null, 150).protection.slippageCapBps).toBe('150');
  });
  it('env cap set and operator row with a blank cap: shows the env cap', () => {
    expect(presentPairRules(market, risk(null), 150).protection.slippageCapBps).toBe('150');
  });
  it('operator cap wins over the env cap', () => {
    expect(presentPairRules(market, risk('40'), 150).protection.slippageCapBps).toBe('40');
  });
  it('non-integer operator cap falls back to env, as the order path does', () => {
    expect(effectiveSlippageCapBps(risk('4.5'), 150)).toBe('150');
  });
  it('neither set: "not set"', () => {
    expect(presentPairRules(market, null, null).protection.slippageCapBps).toBe('not set');
  });
});

describe('SP-order-entry-03 batched markets reader', () => {
  it('calls the batched reader once for all markets and parses through the contract', async () => {
    const a = fakeMarket({ id: 'm-a', symbol: 'BTC/USDT' });
    const b = fakeMarket({ id: 'm-b', symbol: 'ETH/USDT' });
    const calls: string[][] = [];
    const app = Fastify();
    registerPublicRest(app, {
      markets: async () => [a, b],
      marketBySymbol: async () => null,
      depth: async () => ({ bids: [], asks: [], sequence: 0 }),
      publicTape: async () => [],
      candles: async () => [],
      now: () => 1_700_000_000_000,
      pairRulesForMarket: async () => {
        throw new Error('per-market reader must not be used when the batch reader is mounted');
      },
      pairRulesForMarkets: async (ms) => {
        calls.push(ms.map((m) => m.id));
        return new Map([[a.id, presentPairRules(a, null, 150)]]);
      },
    });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/v1/markets?limit=10' });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual([['m-a', 'm-b']]);
    const rows = res.json();
    expect(rows[0].pairRules.protection.slippageCapBps).toBe('150');
    expect(rows[1].pairRules).toBeNull();
    const parsed = marketSchema.parse(rows[0]);
    expect(parsed.pairRules?.protection.slippageCapBps).toBe('150');
    expect(marketSchema.parse(rows[1]).pairRules).toBeNull();
  });
});
