import { describe, expect, it } from 'vitest';
import {
  DATAFEED_ERROR_CODES,
  DATAFEED_INTERVALS,
  DatafeedError,
  barsFromFills,
  bucketStart,
  datafeedBarSchema,
  datafeedListingSchema,
  resolvedSymbolSchema,
  parseDatafeedInterval,
  resolveSymbol,
  type DatafeedListing,
} from './datafeed.js';
import { FX_GLOBAL } from './instruments.js';

const btc: DatafeedListing = {
  symbol: 'BTC/USDT',
  base: 'BTC',
  quote: 'USDT',
  type: 'spot',
  active: true,
  tickSize: '0.01',
  schedule: { kind: 'continuous' },
};

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof DatafeedError ? e.code : 'untyped';
  }
  return undefined;
}

describe('datafeed resolveSymbol (charts-desk-embed-feed-ops-002)', () => {
  it('returns hours 24/7, timezone and price format from tick size in one object', () => {
    const r = resolveSymbol('BTC/USDT', btc);
    expect(r).toMatchObject({
      symbol: 'BTC/USDT',
      listed: true,
      session: { kind: 'continuous', label: '24/7' },
      timezone: 'Etc/UTC',
      priceFormat: { pricePrecision: 2, minMove: '0.01' },
      hasTickCount: false,
    });
  });
  it('session listings carry the venue timezone', () => {
    const r = resolveSymbol('EUR/USD', { ...btc, symbol: 'EUR/USD', base: 'EUR', quote: 'USD', tickSize: '0.00001', schedule: FX_GLOBAL });
    expect(r.session.kind).toBe('sessions');
    expect(r.timezone).toBe('America/New_York');
    expect(r.priceFormat.pricePrecision).toBe(5);
  });
  it('hours not published → hours_not_published, never 24/7 by assumption', () => {
    const r = resolveSymbol('BTC/USDT', { ...btc, schedule: null });
    expect(r.session).toEqual({ kind: 'hours_not_published' });
    expect(r.timezone).toBeNull();
  });
  it('unknown symbol refuses typed (empty state)', () => {
    expect(code(() => resolveSymbol('NOPE/USDT', null))).toBe(DATAFEED_ERROR_CODES.unknownSymbol);
    expect(code(() => resolveSymbol('NOPE/USDT', btc))).toBe(DATAFEED_ERROR_CODES.unknownSymbol);
  });
  it('blank or zero tick size refuses, no invented precision', () => {
    expect(code(() => resolveSymbol('BTC/USDT', { ...btc, tickSize: null }))).toBe(DATAFEED_ERROR_CODES.tickSizeUnset);
    expect(code(() => resolveSymbol('BTC/USDT', { ...btc, tickSize: '0' }))).toBe(DATAFEED_ERROR_CODES.tickSizeUnset);
  });
  it('recovery: a refused resolve succeeds once the listing is present', () => {
    expect(code(() => resolveSymbol('BTC/USDT', undefined))).toBe(DATAFEED_ERROR_CODES.unknownSymbol);
    expect(resolveSymbol('BTC/USDT', btc).listed).toBe(true);
  });
});

describe('datafeed intervals (charts-desk-embed-feed-ops-003)', () => {
  it('accepts our identifiers', () => {
    for (const i of DATAFEED_INTERVALS) expect(parseDatafeedInterval(i)).toBe(i);
  });
  it.each(['1', '60', '1D', '2m', '', null])('refuses %p with the typed error and no fallback', (bad) => {
    expect(code(() => parseDatafeedInterval(bad))).toBe(DATAFEED_ERROR_CODES.intervalUnsupported);
  });
});

describe('datafeed bars from taker fills (charts-desk-embed-feed-ops-004)', () => {
  const mkt = { tickSize: '0.01', lotSize: '0.001' };
  const t0 = Date.UTC(2026, 9, 22, 4, 0, 0);
  const fills = [
    { atMs: t0 + 1_000, sequence: 1, price: '100', amount: '0.5' },
    { atMs: t0 + 5_000, sequence: 2, price: '101.5', amount: '0.25' },
    { atMs: t0 + 9_000, sequence: 3, price: '99.75', amount: '1' },
    { atMs: t0 + 20_000, sequence: 4, price: '100.10', amount: '0.1' },
    { atMs: t0 + 30_000, sequence: 5, price: '102.00', amount: '0.05' },
    { atMs: t0 + 45_000, sequence: 6, price: '98', amount: '2' },
    { atMs: t0 + 59_999, sequence: 7, price: '100.25', amount: '0.3' },
  ];
  it('1m bar from 7 fills matches OHLCV, formatted to tick/lot, no tick count', () => {
    const bars = barsFromFills('1m', [...fills].reverse(), mkt);
    expect(bars).toEqual([
      { time: t0, open: '100.00', high: '102.00', low: '98.00', close: '100.25', volume: '4.200', tickCount: null, spread: null },
    ]);
    expect(datafeedBarSchema.parse(bars[0])).toEqual(bars[0]);
  });
  it('open/close follow engine sequence, not wall time, inside one millisecond', () => {
    const [bar] = barsFromFills(
      '1m',
      [
        { atMs: t0, sequence: 9, price: '2', amount: '1' },
        { atMs: t0, sequence: 8, price: '1', amount: '1' },
      ],
      mkt,
    );
    expect(bar).toMatchObject({ open: '1.00', close: '2.00' });
  });
  it('output format does not depend on the batch', () => {
    const a = barsFromFills('1m', [{ atMs: t0, sequence: 1, price: '1.5', amount: '3' }], mkt);
    const b = barsFromFills('1m', [{ atMs: t0, sequence: 1, price: '1.50', amount: '3.000' }], mkt);
    expect(a).toEqual(b);
    expect(a[0]).toMatchObject({ open: '1.50', volume: '3.000' });
  });
  it('splits buckets in time order', () => {
    const bars = barsFromFills('1m', [...fills, { atMs: t0 + 60_000, sequence: 8, price: '1.5', amount: '3' }], mkt);
    expect(bars.map((b) => b.time)).toEqual([t0, t0 + 60_000]);
  });
  it('no fills → no bars (never an invented candle)', () => {
    expect(barsFromFills('1m', [], mkt)).toEqual([]);
  });
  it.each([
    { atMs: t0, sequence: 1, price: '1e3', amount: '1' },
    { atMs: t0, sequence: 1, price: '1.001', amount: '1' },
    { atMs: t0, sequence: 1, price: '1', amount: '0.0001' },
  ])('bad or over-precise fill refuses typed: %o', (f) => {
    expect(code(() => barsFromFills('1m', [f], mkt))).toBe(DATAFEED_ERROR_CODES.badFill);
  });
  it('1M is a fixed 30-day epoch-floor bucket like svc-trade, not a calendar month', () => {
    expect(bucketStart('1M', t0)).toBe(Math.floor(t0 / 2_592_000_000) * 2_592_000_000);
    expect(bucketStart('1M', t0)).not.toBe(Date.UTC(2026, 9, 1));
  });
});

describe('datafeed schemas', () => {
  it('listing schema is strict', () => {
    expect(datafeedListingSchema.safeParse({ ...btc, extra: 1 }).success).toBe(false);
    expect(datafeedListingSchema.safeParse(btc).success).toBe(true);
  });
  it('resolved symbol validates against its schema', () => {
    expect(resolvedSymbolSchema.safeParse(resolveSymbol('BTC/USDT', btc)).success).toBe(true);
    expect(resolvedSymbolSchema.safeParse(resolveSymbol('EUR/USD', { ...btc, symbol: 'EUR/USD', schedule: FX_GLOBAL })).success).toBe(true);
  });
  it('unknown symbol uses the market catalogue code', () => {
    expect(DATAFEED_ERROR_CODES.unknownSymbol).toBe('trade.market_not_found');
  });
});
