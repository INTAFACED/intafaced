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
  latencyMs?: number;
  /** First health() is the gather read. Later calls throw. */
  throwOnLaterHealth?: boolean;
}

function venue(o: FakeOpts): LiquiditySource & { healthCalls: number } {
  const now = Date.now();
  const health: VenueHealth = {
    healthy: true,
    latencyMs: o.latencyMs ?? 10,
    lastUpdate: new Date(now),
  };
  let healthCalls = 0;
  const source: LiquiditySource & { healthCalls: number } = {
    id: o.id,
    kind: o.kind,
    capabilities: ['quote', 'orderbook', 'submit'],
    health: () => {
      healthCalls += 1;
      source.healthCalls = healthCalls;
      if (o.throwOnLaterHealth && healthCalls > 1) {
        throw new Error('health down');
      }
      return health;
    },
    markets: async () => [],
    quote: async (req: QuoteRequest) => ({
      venueId: o.id,
      symbol: req.symbol,
      side: req.side,
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
    healthCalls: 0,
  };
  return source;
}

const buy = (amount: string): QuoteRequest => ({
  symbol: 'BTC/USDT',
  side: 'buy',
  amount: parseAmount(amount),
});

describe('planRoute — health throw during rank (L1366)', () => {
  it('routes the other venue when a later health() throws', async () => {
    const amount = parseAmount('1');
    const throwing = venue({
      id: 'throws-on-rank',
      kind: 'external-cex',
      price: '100',
      amount: '10',
      feeBps: 0,
      throwOnLaterHealth: true,
    });
    const steady = venue({
      id: 'steady',
      kind: 'external-cex',
      price: '100',
      amount: '10',
      feeBps: 0,
    });

    const plan = await planRoute(buy('1'), [throwing, steady]);

    expect(throwing.healthCalls).toBe(2);
    expect(plan.legs.map((leg) => leg.venueId)).toEqual(['steady']);
    expect(plan.routedAmount).toBe(amount);
    expect(plan.legs.some((leg) => leg.venueId === 'throws-on-rank')).toBe(false);
    expect(plan.rejected).toEqual([
      {
        venueId: 'throws-on-rank',
        reason: 'unhealthy',
        detail: 'health threw during rank',
      },
    ]);
  });

  it('resolves an empty plan when the only candidate throws during rank', async () => {
    const only = venue({
      id: 'only',
      kind: 'external-cex',
      price: '100',
      amount: '10',
      feeBps: 0,
      throwOnLaterHealth: true,
    });

    const plan = await planRoute(buy('1'), [only]);

    expect(only.healthCalls).toBe(2);
    expect(plan.legs).toEqual([]);
    expect(plan.routedAmount).toBe(0n);
    expect(plan.unfilledAmount).toBe(parseAmount('1'));
    expect(plan.averageEffectivePrice).toBeNull();
    expect(plan.rejected).toEqual([
      {
        venueId: 'only',
        reason: 'unhealthy',
        detail: 'health threw during rank',
      },
    ]);
  });

  it('tie-breaks equal prices by the smaller latencyMs', async () => {
    const plan = await planRoute(buy('1'), [
      venue({
        id: 'slower',
        kind: 'external-cex',
        price: '100',
        amount: '10',
        feeBps: 0,
        latencyMs: 10,
      }),
      venue({
        id: 'faster',
        kind: 'external-cex',
        price: '100',
        amount: '10',
        feeBps: 0,
        latencyMs: 1,
      }),
    ]);

    expect(plan.legs[0]?.venueId).toBe('faster');
    expect(plan.rejected.some((row) => row.reason === 'unhealthy')).toBe(false);
  });
});
