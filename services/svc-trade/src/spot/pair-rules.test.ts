import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { marketSchema } from '@intafaced/exchange-contract';
import { parseAmount } from '@intafaced/ledger-client';
import type { RiskVersion } from '../admin/risk.js';
import { fakeMarket, presentCcxtMarket, registerPublicRest, type PublicRestDeps } from '../public-rest.js';
import { PAIR_RULE_NOT_SET, presentPairRules } from './pair-rules.js';

const market = fakeMarket({
  id: 'm-btc',
  symbol: 'BTC/USDT',
  tickSize: parseAmount('0.01'),
  lotSize: parseAmount('0.0001'),
  minQty: parseAmount('0.001'),
  minNotional: parseAmount('5'),
  maxQty: null,
});

const risk: RiskVersion = {
  marketId: 'm-btc',
  version: '3',
  collar: '150000',
  fatFinger: null,
  slippageCap: '50',
  throttle: '200',
  circuitBreaker: null,
  operatorId: 'op',
  approverId: 'ap',
  reason: 'r',
  approvalId: 'a',
  createdAt: new Date(0).toISOString(),
};

describe('SP-order-entry-03 pair rules in words', () => {
  it('shows a blank maxQty and every blank protection value as "not set", never a number', () => {
    const rules = presentPairRules(market, null);
    expect(rules).toEqual({
      tick: '0.01',
      lot: '0.0001',
      minQty: '0.001',
      minNotional: '5',
      maxQty: PAIR_RULE_NOT_SET,
      protection: {
        collar: 'not set',
        fatFinger: 'not set',
        slippageCapBps: 'not set',
        openOrdersPerMarket: 'not set',
      },
      riskVersion: '0',
    });
  });

  it('reads protection values from the approved operator risk version and keeps blanks "not set"', () => {
    const rules = presentPairRules({ ...market, maxQty: parseAmount('25') }, risk);
    expect(rules.maxQty).toBe('25');
    expect(rules.protection).toEqual({
      collar: '150000',
      fatFinger: 'not set',
      slippageCapBps: '50',
      openOrdersPerMarket: '200',
    });
    expect(rules.riskVersion).toBe('3');
    for (const v of [rules.tick, rules.lot, rules.minQty, rules.minNotional, rules.maxQty, ...Object.values(rules.protection)]) {
      expect(typeof v).toBe('string');
    }
  });

  it('keeps the CCXT market shape valid with pairRules attached, and null when no reader is mounted', () => {
    const withRules = presentCcxtMarket(market, 0, { pairRules: presentPairRules(market, risk) });
    expect(marketSchema.safeParse(withRules).success).toBe(true);
    expect(withRules.pairRules?.protection.collar).toBe('150000');
    expect(presentCcxtMarket(market, 0).pairRules).toBeNull();
  });

  async function get(overrides: Partial<PublicRestDeps>) {
    const app = Fastify();
    registerPublicRest(app, {
      markets: async () => [market],
      marketBySymbol: async () => market,
      depth: async () => ({ bids: [], asks: [], sequence: 0 }),
      publicTape: async () => [],
      candles: async () => [],
      now: () => 1_700_000_000_000,
      ...overrides,
    });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/v1/markets?limit=10' });
    await app.close();
    return res;
  }

  it('GET /api/v1/markets publishes the pair rules from the mounted reader', async () => {
    const seen: string[] = [];
    const res = await get({
      pairRulesForMarket: async (m) => {
        seen.push(m.id);
        return presentPairRules(m, risk);
      },
    });
    expect(res.statusCode).toBe(200);
    const [row] = res.json();
    expect(seen).toEqual(['m-btc']);
    expect(row.pairRules).toEqual({
      tick: '0.01',
      lot: '0.0001',
      minQty: '0.001',
      minNotional: '5',
      maxQty: 'not set',
      protection: { collar: '150000', fatFinger: 'not set', slippageCapBps: '50', openOrdersPerMarket: '200' },
      riskVersion: '3',
    });
  });

  it('GET /api/v1/markets says pairRules null (not invented) when no reader is mounted', async () => {
    const res = await get({});
    expect(res.statusCode).toBe(200);
    expect(res.json()[0].pairRules).toBeNull();
  });
});
