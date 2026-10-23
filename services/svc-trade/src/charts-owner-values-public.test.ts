/**
 * C-ops-04 public read: GET /api/v1/charts/owner-values. Plain JSON, no envelope, no auth, like /api/v1/ohlcv.
 * A count that is not set is null. Without ?symbol the dataClass is null. An unknown symbol is trade.market_not_found.
 */
import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { exchangeErrorSchema } from '@intafaced/exchange-contract';
import { fakeMarket, registerPublicRest, type PublicRestDeps } from './public-rest.js';
import type { ChartDataClass, ChartOwnerValuesPublicReader, ChartValues } from './admin/chart-owner-values.js';

const BLANK: ChartValues = {
  compareCap: null,
  chartCountLimit: null,
  drawingCap: null,
  brushPointCap: null,
  delayedBoundarySeconds: null,
};

function deps(overrides: Partial<PublicRestDeps> = {}): PublicRestDeps {
  const market = fakeMarket({ symbol: 'BTC/USDT' });
  return {
    markets: async () => [market],
    marketBySymbol: async (symbol) => (symbol === 'BTC/USDT' ? market : null),
    depth: async () => ({ bids: [], asks: [], sequence: 1 }),
    publicTape: async () => [],
    candles: async () => [],
    now: () => 1_700_000_000_000,
    ...overrides,
  };
}

function reader(
  values: Partial<ChartValues> = {},
  dataClassFor: (symbol: string) => Promise<ChartDataClass | null> = async () => null,
): ChartOwnerValuesPublicReader {
  return {
    scalars: async () => ({ ...BLANK, ...values }),
    dataClassFor: vi.fn(dataClassFor),
  };
}

async function build(d: PublicRestDeps) {
  const app = Fastify();
  registerPublicRest(app, d);
  await app.ready();
  return app;
}

describe('GET /api/v1/charts/owner-values', () => {
  it('answers every count as not set (null) and dataClass null when nothing is set and no symbol is asked', async () => {
    const app = await build(deps({ chartOwnerValues: reader() }));
    const res = await app.inject({ method: 'GET', url: '/api/v1/charts/owner-values' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ...BLANK, dataClass: null });
    await app.close();
  });

  it('answers the set counts as whole numbers with no envelope', async () => {
    const app = await build(
      deps({
        chartOwnerValues: reader({ compareCap: 3, chartCountLimit: 4, drawingCap: 50, brushPointCap: 2000, delayedBoundarySeconds: 30 }),
      }),
    );
    const body = (await app.inject({ method: 'GET', url: '/api/v1/charts/owner-values' })).json() as Record<string, unknown>;
    expect(body).toEqual({
      compareCap: 3,
      chartCountLimit: 4,
      drawingCap: 50,
      brushPointCap: 2000,
      delayedBoundarySeconds: 30,
      dataClass: null,
    });
    expect(body).not.toHaveProperty('data');
    expect(body).not.toHaveProperty('result');
    await app.close();
  });

  it('answers the data class for the asked symbol, with a CCXT-style percent-encoded symbol', async () => {
    const r = reader({ compareCap: 3 }, async (symbol) => (symbol === 'BTC/USDT' ? 'real_time' : null));
    const app = await build(deps({ chartOwnerValues: r }));
    const res = await app.inject({ method: 'GET', url: '/api/v1/charts/owner-values?symbol=BTC%2FUSDT' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ...BLANK, compareCap: 3, dataClass: 'real_time' });
    expect(r.dataClassFor).toHaveBeenCalledWith('BTC/USDT');
    await app.close();
  });

  it('answers a null dataClass for a listed symbol that has none set', async () => {
    const app = await build(deps({ chartOwnerValues: reader() }));
    const res = await app.inject({ method: 'GET', url: '/api/v1/charts/owner-values?symbol=BTC%2FUSDT' });
    expect(res.json()).toMatchObject({ dataClass: null });
    await app.close();
  });

  it('without ?symbol, dataClass is null and the data class is not read', async () => {
    const r = reader({}, async () => 'delayed');
    const app = await build(deps({ chartOwnerValues: r }));
    const res = await app.inject({ method: 'GET', url: '/api/v1/charts/owner-values' });
    expect(res.json()).toMatchObject({ dataClass: null });
    expect(r.dataClassFor).not.toHaveBeenCalled();
    await app.close();
  });

  it('an unknown symbol is trade.market_not_found in the CCXT error shape', async () => {
    const r = reader();
    const app = await build(deps({ chartOwnerValues: r }));
    const res = await app.inject({ method: 'GET', url: '/api/v1/charts/owner-values?symbol=NOPE%2FUSDT' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      code: 'BadSymbol',
      message: 'market NOPE/USDT not found',
      intafacedCode: 'trade.market_not_found',
    });
    expect(exchangeErrorSchema.safeParse(res.json()).success).toBe(true);
    expect(r.dataClassFor).not.toHaveBeenCalled();
    await app.close();
  });

  it('a symbol over 64 characters is the same bad-symbol refusal, and the market lookup is never reached', async () => {
    const long = 'A'.repeat(65);
    const lookup = vi.fn(async () => null);
    const r = reader({ compareCap: 3 });
    const app = await build(deps({ chartOwnerValues: r, marketBySymbol: lookup }));
    const res = await app.inject({ method: 'GET', url: `/api/v1/charts/owner-values?symbol=${long}` });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'BadSymbol', intafacedCode: 'trade.market_not_found' });
    expect(lookup).not.toHaveBeenCalled();
    expect(r.dataClassFor).not.toHaveBeenCalled();
    await app.close();
  });

  it('an unwired reader refuses 503 and never answers with a default', async () => {
    const app = await build(deps());
    const res = await app.inject({ method: 'GET', url: '/api/v1/charts/owner-values' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'ExchangeNotAvailable', intafacedCode: 'trade.charts_owner_values_unconfigured' });
    await app.close();
  });

  it('a read that fails is not swallowed into a default', async () => {
    const failing: ChartOwnerValuesPublicReader = {
      scalars: async () => {
        throw new Error('db down');
      },
      dataClassFor: async () => null,
    };
    const app = await build(deps({ chartOwnerValues: failing }));
    const res = await app.inject({ method: 'GET', url: '/api/v1/charts/owner-values' });
    expect(res.statusCode).toBe(500);
    await app.close();
  });
});
