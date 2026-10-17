import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerFuturesTickerRest } from './futures-ticker-rest.js';

const market = { id: 'market-1', symbol: 'BTC/USDT-PERP', kind: 'futures' as const };

const storedFacts = {
  openInterest: '0',
  volume24h: '0',
  change24h: null,
  changeReason: 'mark_history_unavailable' as const,
};

describe('GET /api/v1/futures/ticker', () => {
  it('returns the accepted mark provenance and publisher-supplied funding period end', async () => {
    const app = Fastify();
    registerFuturesTickerRest(app, {
      marketBySymbol: async (symbol) => (symbol === market.symbol ? market : null),
      markForMarket: async () => ({ price: '50000.125', source: 'venue' }),
      fundingForMarket: () => ({
        marketId: market.id,
        rate: '0.0000125',
        periodId: 'market-1:2026-08-23T16:00:00.000Z',
        asOfMs: Date.parse('2026-08-23T16:01:00.000Z'),
        periodEndIso: '2026-08-23T17:00:00.000Z',
      }),
      factsForMarket: async () => storedFacts,
    });
    const response = await app.inject({ method: 'GET', url: `/api/v1/futures/ticker?symbol=${encodeURIComponent(market.symbol)}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      markPrice: '50000.125',
      markSource: 'venue',
      fundingRate: '0.0000125',
      fundingPeriodId: 'market-1:2026-08-23T16:00:00.000Z',
      nextFundingTime: '2026-08-23T17:00:00.000Z',
      openInterest: '0',
      volume24h: '0',
      change24h: null,
      changeReason: 'mark_history_unavailable',
    });
  });

  it('does not derive a funding deadline when the publisher omitted it', async () => {
    const app = Fastify();
    registerFuturesTickerRest(app, {
      marketBySymbol: async () => market,
      markForMarket: async () => ({ price: '50000', source: 'depth' }),
      fundingForMarket: () => ({
        marketId: market.id,
        rate: '-0.00001',
        periodId: 'market-1:publisher-period',
        asOfMs: Date.parse('2026-08-23T16:01:00.000Z'),
      }),
      factsForMarket: async () => storedFacts,
    });
    const response = await app.inject({ method: 'GET', url: `/api/v1/futures/ticker?symbol=${encodeURIComponent(market.symbol)}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ fundingRate: '-0.00001', fundingPeriodId: 'market-1:publisher-period', nextFundingTime: null });
  });

  it('returns nulls rather than fake ticks when neither book nor rate is published', async () => {
    const app = Fastify();
    registerFuturesTickerRest(app, {
      marketBySymbol: async () => market,
      markForMarket: async () => null,
      fundingForMarket: () => null,
      factsForMarket: async () => storedFacts,
    });
    const response = await app.inject({ method: 'GET', url: `/api/v1/futures/ticker?symbol=${encodeURIComponent(market.symbol)}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      markPrice: null,
      markSource: null,
      fundingRate: null,
      fundingPeriodId: null,
      nextFundingTime: null,
      openInterest: '0',
      volume24h: '0',
      change24h: null,
      changeReason: 'mark_history_unavailable',
    });
  });
});
