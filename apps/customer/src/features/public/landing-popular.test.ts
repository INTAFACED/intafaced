import { describe, expect, it } from 'vitest';
import { dec, str } from '../../data/decimal';
import { venueMarketRow, venueTickerRow } from '../../data';
import { coinName, exampleLong, linesOf, popularOf, sharedBases, type Line } from './HomePage';

const line = (symbol: string, last: string | undefined, volume: string) => ({
  symbol,
  ticker: last === undefined ? undefined : { last, quoteVolume24h: volume },
});

describe('the landing board’s Popular tab', () => {
  it('lists the markets with a last trade by 24h volume, and leaves a market with no print out', () => {
    const lines = [line('ETH/USDT', '3200.10', '500'), line('BTC/USDC', undefined, '0'), line('BTC/USDT', '67812.40', '900')];
    expect(popularOf(lines).map((l) => l.symbol)).toEqual(['BTC/USDT', 'ETH/USDT']);
  });

  it('leaves out a market whose ticker has no last price yet', () => {
    const lines = [line('SOL/USDT', '', '100'), line('XRP/USDT', '0.5230', '50')];
    expect(popularOf(lines).map((l) => l.symbol)).toEqual(['XRP/USDT']);
  });
});

describe('the landing’s example long', () => {
  const usd = (n: string) => dec(n)!;
  it('works every figure from the live price and the published taker rate', () => {
    const ex = exampleLong(usd('100000'), 7);
    // $1,000 of margin at 10x: $10,000 of size; stop 2.10% under, target 1.44% over; our fee taken on the way in and out.
    expect(str(ex.size)).toBe('10000');
    expect(str(ex.stop)).toBe('97900');
    expect(str(ex.target)).toBe('101440');
    expect(str(ex.fee!)).toBe('14');
    expect(str(ex.ifStopped!)).toBe('-224');
    expect(str(ex.ifTarget!)).toBe('130');
  });

  it('leaves the fee and both outcomes blank while no fee is published', () => {
    const ex = exampleLong(usd('100000'), null);
    expect(ex.fee).toBeNull();
    expect(ex.ifStopped).toBeNull();
    expect(ex.ifTarget).toBeNull();
  });
});

describe('the landing board on the one markets catalogue', () => {
  type VenueMarket = Parameters<typeof venueMarketRow>[0];
  const market = (symbol: string, kind: VenueMarket['kind']): VenueMarket => ({
    symbol,
    kind,
    baseAsset: symbol.split(/[-/]/)[0] ?? symbol,
    quoteAsset: 'USDC',
    tickSize: '0.01',
    lotSize: '0.001',
    status: 'trading',
    session: { known: false },
    listing: { opensAt: '2026-01-01T00:00:00.000Z', delistsAt: null, routing: 'show', open: true, delisted: false },
  });
  const ticker = (symbol: string, last: string | null) => ({
    symbol,
    last,
    high: null,
    low: null,
    baseVolume: '1',
    quoteVolume: '100',
    bid: null,
    ask: null,
    spread: null,
  });

  it('lists the open markets, then the open perpetuals, each priced only under its own symbol, and marks the perpetuals', () => {
    const rows = (...ms: VenueMarket[]) => ({ status: 'ready' as const, asOf: 1, data: ms.map(venueMarketRow) });
    const closed = { ...market('ETH/USDC', 'spot'), status: 'halted' as const };
    const lines = linesOf({
      markets: rows(market('BTC/USDC', 'spot'), closed),
      perpetuals: rows(market('XAU-PERP', 'perpetual')),
      tickers: { status: 'ready', asOf: 1, data: { 'XAU-PERP': venueTickerRow(ticker('XAU-PERP', '2400.5')) } },
    });
    expect(lines.map((l) => [l.market.symbol, l.ticker?.last ?? null, !!l.perp])).toEqual([
      ['BTC/USDC', null, false],
      ['XAU-PERP', '2400.5', true],
    ]);
  });

  it('lists no perpetuals where the catalogue has none (the venue door off)', () => {
    const lines = linesOf({ markets: { status: 'empty' }, perpetuals: { status: 'empty' }, tickers: { status: 'empty' } });
    expect(lines).toEqual([]);
  });
});

describe('the landing board’s names', () => {
  const at = (symbol: string, base: string, quote: string, perp = false): Line => ({
    market: { symbol, base, quote, orderable: true, tickSize: '0.01', lotSize: '0.01', minAmount: null, listedAt: null },
    ticker: undefined,
    perp,
  });

  it('marks only a coin the board lists more than once, so two markets of one coin never read as one', () => {
    const lines = [
      at('BTC/USDT', 'BTC', 'USDT'),
      at('BTC/USDC', 'BTC', 'USDC'),
      at('ETH/USDT', 'ETH', 'USDT'),
      at('BTC-PERP', 'BTC', 'USDC', true),
    ];
    expect([...sharedBases(lines)]).toEqual(['BTC']);
    expect([...sharedBases([at('ETH/USDT', 'ETH', 'USDT'), at('SOL/USDT', 'SOL', 'USDT')])]).toEqual([]);
  });

  it('names a coin from our launch catalogue, and leaves a coin it does not list unnamed', () => {
    expect(coinName('BTC')).toBe('Bitcoin');
    expect(coinName('ZZZ')).toBeUndefined();
  });
});
