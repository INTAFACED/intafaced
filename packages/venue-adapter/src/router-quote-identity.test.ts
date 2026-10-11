import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import { planRoute } from './router.js';
import type { LiquiditySource, QuoteRequest, VenueHealth } from './source.js';

interface FakeOpts {
  id: string;
  kind: LiquiditySource['kind'];
  price: string;
  amount: string;
  feeBps: number;
  symbol: string;
  side: 'buy' | 'sell';
  latencyMs?: number;
}

function venue(o: FakeOpts): LiquiditySource {
  const now = Date.now();
  const health: VenueHealth = {
    healthy: true,
    latencyMs: o.latencyMs ?? 10,
    lastUpdate: new Date(now),
  };
  return {
    id: o.id,
    kind: o.kind,
    capabilities: ['quote', 'orderbook', 'submit'],
    health: () => health,
    markets: async () => [],
    quote: async (_req: QuoteRequest) => ({
      venueId: o.id,
      symbol: o.symbol,
      side: o.side,
      amount: parseAmount(o.amount),
      price: parseAmount(o.price),
      feeBps: o.feeBps,
      expiresAt: new Date(now + 30_000),
    }),
    orderBook: async () => ({
      symbol: 'BTC/USDT',
      bids: [[o.price, o.amount]],
      asks: [[o.price, o.amount]],
      timestamp: now,
      datetime: new Date(now).toISOString(),
      nonce: 1,
    }),
    submit: async () => ({
      venueId: o.id,
      venueOrderId: 'v-1',
      filledAmount: parseAmount(o.amount),
      averagePrice: parseAmount(o.price),
      feeAmount: parseAmount('0'),
      feeAsset: 'USDT',
      status: 'filled' as const,
      executedAt: new Date(),
    }),
  };
}

const buy = (amount: string): QuoteRequest => ({
  symbol: 'BTC/USDT',
  side: 'buy',
  amount: parseAmount(amount),
});

describe('planRoute — quote symbol and side must match the request (L1365)', () => {
  it('rejects a quote for another symbol and routes the matching venue', async () => {
    const amount = parseAmount('1');
    const plan = await planRoute(buy('1'), [
      venue({
        id: 'other-market',
        kind: 'external-cex',
        price: '1',
        amount: '10',
        feeBps: 0,
        symbol: 'ETH/USDT',
        side: 'buy',
      }),
      venue({
        id: 'match',
        kind: 'external-cex',
        price: '100',
        amount: '10',
        feeBps: 0,
        symbol: 'BTC/USDT',
        side: 'buy',
      }),
    ]);

    expect(plan.legs.map((leg) => leg.venueId)).toEqual(['match']);
    expect(plan.routedAmount).toBe(amount);
    expect(plan.symbol).toBe('BTC/USDT');
    expect(plan.side).toBe('buy');
    const rejected = plan.rejected.find((row) => row.venueId === 'other-market');
    expect(rejected?.reason).toBe('no_quote');
    expect(rejected?.detail).toBe('quote symbol ETH/USDT side buy does not match the request');
  });

  it('rejects a quote for the other side and does not put it on a leg', async () => {
    const plan = await planRoute(buy('1'), [
      venue({
        id: 'other-side',
        kind: 'external-cex',
        price: '100',
        amount: '10',
        feeBps: 0,
        symbol: 'BTC/USDT',
        side: 'sell',
      }),
    ]);

    expect(plan.legs).toHaveLength(0);
    expect(plan.routedAmount).toBe(0n);
    const rejected = plan.rejected.find((row) => row.venueId === 'other-side');
    expect(rejected?.reason).toBe('no_quote');
    expect(rejected?.detail).toBe('quote symbol BTC/USDT side sell does not match the request');
  });

  it('routes a quote whose symbol and side equal the request', async () => {
    const amount = parseAmount('1');
    const plan = await planRoute(buy('1'), [
      venue({
        id: 'match',
        kind: 'external-cex',
        price: '100',
        amount: '10',
        feeBps: 0,
        symbol: 'BTC/USDT',
        side: 'buy',
      }),
    ]);

    expect(plan.legs.map((leg) => leg.venueId)).toEqual(['match']);
    expect(plan.routedAmount).toBe(amount);
    expect(plan.rejected.find((row) => row.venueId === 'match')).toBeUndefined();
  });
});
