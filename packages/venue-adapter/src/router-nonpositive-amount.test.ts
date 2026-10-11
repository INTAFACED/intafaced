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
  quotes?: { n: number };
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
    quote: async (req: QuoteRequest) => {
      if (o.quotes) o.quotes.n += 1;
      return {
        venueId: o.id,
        symbol: req.symbol,
        side: req.side,
        amount: parseAmount(o.amount),
        price: parseAmount(o.price),
        feeBps: o.feeBps,
        expiresAt: new Date(now + 30_000),
      };
    },
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

const buy = (amount: string): QuoteRequest => ({ symbol: 'BTC/USDT', side: 'buy', amount: parseAmount(amount) });

describe('planRoute — non-positive amount is not an order (L1364)', () => {
  it('refuses parseAmount(\'0\') before any source quote', async () => {
    const quotes = { n: 0 };
    const source = venue({
      id: 'fresh',
      kind: 'external-cex',
      price: '100',
      amount: '10',
      feeBps: 0,
      quotes,
    });
    await expect(planRoute(buy('0'), [source])).rejects.toThrow('a non-positive amount is not an order');
    expect(quotes.n).toBe(0);
  });

  it('refuses parseAmount(\'-1\') before any source quote', async () => {
    const quotes = { n: 0 };
    const source = venue({
      id: 'fresh',
      kind: 'external-cex',
      price: '100',
      amount: '10',
      feeBps: 0,
      quotes,
    });
    const request: QuoteRequest = {
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: parseAmount('-1'),
    };
    await expect(planRoute(request, [source])).rejects.toThrow('a non-positive amount is not an order');
    expect(quotes.n).toBe(0);
  });

  it('routes a positive amount when one fresh venue can fill it', async () => {
    const amount = parseAmount('1');
    const plan = await planRoute(
      { symbol: 'BTC/USDT', side: 'buy', amount },
      [venue({ id: 'fresh', kind: 'external-cex', price: '100', amount: '10', feeBps: 0 })],
    );
    expect(plan.routedAmount).toBe(amount);
  });
});
