import { describe, expect, it } from 'vitest';
import type { MarketData, TickerRow } from './deps';
import {
  anyListed,
  entriesFor,
  marketTarget,
  matchesQuery,
  nextSort,
  priceText,
  quotesOf,
  rangePosition,
  topCards,
  visibleEntries,
  volumeText,
  type FilterState,
} from './select';

const market = (base: string, quote = 'USDT', extra: Partial<MarketData> = {}): MarketData => ({
  symbol: `${base}-${quote}`,
  base,
  quote,
  orderable: true,
  tickSize: '0.01',
  lotSize: '0.0001',
  minAmount: null,
  listedAt: null,
  ...extra,
});
const ticker = (symbol: string, last: string, pct: string | null, volume: string | null, extra: Partial<TickerRow> = {}): TickerRow => ({
  symbol,
  last,
  bid: null,
  ask: null,
  open24h: null,
  high24h: null,
  low24h: null,
  change24h: null,
  changePct24h: pct,
  baseVolume24h: null,
  quoteVolume24h: volume,
  windowStart: null,
  source: 'server',
  ...extra,
});

const markets = [
  market('BTC'),
  market('ETH'),
  market('SOL'),
  market('DOGE'),
  market('BTC', 'USDC'),
  market('SIM', 'USDT', { orderable: false }),
];
const tickers = {
  'BTC-USDT': ticker('BTC-USDT', '67812.40', '0.0275', '9000000'),
  'ETH-USDT': ticker('ETH-USDT', '3200.10', '0.0159', '4000000'),
  'SOL-USDT': ticker('SOL-USDT', '142.55', '-0.0100', null),
  'DOGE-USDT': ticker('DOGE-USDT', '0.12345', '-0.0494', '70000'),
  'BTC-USDC': ticker('BTC-USDC', '67800.00', '0.0270', '1000'),
};
const entries = entriesFor(markets, tickers);
const base: FilterState = { tab: 'spot', chip: 'all', quote: null, query: '', sort: null, favorites: [] };
const symbols = (rows: ReturnType<typeof visibleEntries>) => rows.map((row) => row.market.symbol);

describe('entriesFor', () => {
  it('drops markets that are not orderable', () => {
    expect(entries.map((entry) => entry.market.symbol)).not.toContain('SIM-USDT');
    expect(entries).toHaveLength(5);
  });
});

describe('visibleEntries', () => {
  it('lists the most traded first and keeps markets without volume after, in the service order', () => {
    expect(symbols(visibleEntries(entries, base))).toEqual(['BTC-USDT', 'ETH-USDT', 'DOGE-USDT', 'BTC-USDC', 'SOL-USDT']);
  });
  it('filters by currency', () => {
    expect(symbols(visibleEntries(entries, { ...base, quote: 'USDC' }))).toEqual(['BTC-USDC']);
  });
  it('Gainers shows only markets that are up, biggest first; Losers the biggest fall first', () => {
    expect(symbols(visibleEntries(entries, { ...base, chip: 'gainers' }))).toEqual(['BTC-USDT', 'BTC-USDC', 'ETH-USDT']);
    expect(symbols(visibleEntries(entries, { ...base, chip: 'losers' }))).toEqual(['DOGE-USDT', 'SOL-USDT']);
  });
  it('a market with no change figure is neither a gainer nor a loser', () => {
    const rows = entriesFor([market('NEW')], { 'NEW-USDT': ticker('NEW-USDT', '1', null, null) });
    expect(visibleEntries(rows, { ...base, chip: 'gainers' })).toEqual([]);
    expect(visibleEntries(rows, { ...base, chip: 'losers' })).toEqual([]);
  });
  it('New needs a listing date and shows the newest first', () => {
    const dated = entriesFor(
      [
        market('OLD', 'USDT', { listedAt: '2026-01-01T00:00:00Z' }),
        market('FRESH', 'USDT', { listedAt: '2026-10-01T00:00:00Z' }),
        market('NODATE'),
      ],
      {},
    );
    expect(anyListed(dated)).toBe(true);
    expect(anyListed(entries)).toBe(false);
    expect(symbols(visibleEntries(dated, { ...base, chip: 'new' }))).toEqual(['FRESH-USDT', 'OLD-USDT']);
  });
  it('Favorites shows only starred markets, in the order they were starred', () => {
    const rows = visibleEntries(entries, { ...base, tab: 'favorites', favorites: ['SOL-USDT', 'BTC-USDT', 'GONE-USDT'] });
    expect(symbols(rows)).toEqual(['SOL-USDT', 'BTC-USDT']);
  });
  it('sorts by price and puts unknown values last in either direction', () => {
    const withGap = entriesFor(markets, { ...tickers, 'ETH-USDT': { ...tickers['ETH-USDT'], last: null } });
    expect(symbols(visibleEntries(withGap, { ...base, sort: { key: 'price', dir: 'desc' } }))).toEqual([
      'BTC-USDT',
      'BTC-USDC',
      'SOL-USDT',
      'DOGE-USDT',
      'ETH-USDT',
    ]);
    expect(symbols(visibleEntries(withGap, { ...base, sort: { key: 'price', dir: 'asc' } })).at(-1)).toBe('ETH-USDT');
  });
  it('sorts by name, change and volume', () => {
    expect(symbols(visibleEntries(entries, { ...base, sort: { key: 'name', dir: 'asc' } }))).toEqual([
      'BTC-USDC',
      'BTC-USDT',
      'DOGE-USDT',
      'ETH-USDT',
      'SOL-USDT',
    ]);
    expect(symbols(visibleEntries(entries, { ...base, sort: { key: 'change', dir: 'asc' } }))[0]).toBe('DOGE-USDT');
    expect(symbols(visibleEntries(entries, { ...base, sort: { key: 'volume', dir: 'asc' } }))[0]).toBe('BTC-USDC');
  });
  it('searches by ticker, pair and plain name', () => {
    expect(symbols(visibleEntries(entries, { ...base, query: 'btc' }))).toEqual(['BTC-USDT', 'BTC-USDC']);
    expect(symbols(visibleEntries(entries, { ...base, query: 'eth/usdt' }))).toEqual(['ETH-USDT']);
    expect(symbols(visibleEntries(entries, { ...base, query: 'ethereum' }, (b) => (b === 'ETH' ? 'Ethereum' : null)))).toEqual([
      'ETH-USDT',
    ]);
    expect(visibleEntries(entries, { ...base, query: 'zzz' })).toEqual([]);
  });
});

describe('matchesQuery', () => {
  it('ignores case, spaces and separators', () => {
    expect(matchesQuery(market('BTC'), '  b t c - usdt ', null)).toBe(true);
    expect(matchesQuery(market('BTC'), 'eth', null)).toBe(false);
    expect(matchesQuery(market('BTC'), '', null)).toBe(true);
  });
});

describe('nextSort', () => {
  it('numbers go high to low, then low to high, then back to the default order', () => {
    const first = nextSort(null, 'price');
    expect(first).toEqual({ key: 'price', dir: 'desc' });
    const second = nextSort(first, 'price');
    expect(second).toEqual({ key: 'price', dir: 'asc' });
    expect(nextSort(second, 'price')).toBeNull();
  });
  it('Name goes A to Z first, and another column starts afresh', () => {
    expect(nextSort(null, 'name')).toEqual({ key: 'name', dir: 'asc' });
    expect(nextSort({ key: 'name', dir: 'asc' }, 'change')).toEqual({ key: 'change', dir: 'desc' });
  });
});

describe('topCards', () => {
  it('gives Popular and Top gainers, and leaves New listings out when nothing has a date', () => {
    const cards = topCards(entries);
    expect(cards.map((card) => card.id)).toEqual(['popular', 'gainers']);
    expect(symbols(cards[0]!.entries)).toEqual(['BTC-USDT', 'ETH-USDT', 'DOGE-USDT']);
    expect(symbols(cards[1]!.entries)).toEqual(['BTC-USDT', 'ETH-USDT']); // BTC/USDC is the same coin again
  });
  it('adds New listings when markets carry dates', () => {
    const dated = entriesFor([...markets.slice(0, 4), market('NEW', 'USDT', { listedAt: '2026-10-10T00:00:00Z' })], tickers);
    expect(topCards(dated).map((card) => card.id)).toContain('new');
  });
  it('shows no cards for a short list', () => {
    expect(topCards(entries.slice(0, 3))).toEqual([]);
  });
});

describe('marketTarget', () => {
  const btc = market('BTC');
  it('Pro opens the desk for the pair', () => {
    expect(marketTarget(btc, 'pro', () => false)).toBe('/trade/spot/BTC-USDT');
  });
  it('writes the desk pair with a dash although the service names it with a slash', () => {
    expect(marketTarget(market('BTC', 'USDT', { symbol: 'BTC/USDT' }), 'pro', () => false)).toBe('/trade/spot/BTC-USDT');
  });
  it('Simple opens the coin page once it is live', () => {
    expect(marketTarget(btc, 'simple', () => false)).toBe('/coin/BTC');
  });
  it('Simple opens the Buy card while the coin page is hidden', () => {
    expect(marketTarget(btc, 'simple', (path) => path === '/coin/:asset')).toBe('/trade/buy?asset=BTC');
  });
  it('Simple falls back to the desk while both are hidden', () => {
    expect(marketTarget(btc, 'simple', (path) => path === '/coin/:asset' || path === '/trade/buy')).toBe('/trade/spot/BTC-USDT');
  });
});

describe('text helpers', () => {
  it('prices carry the dollar sign on a dollar market and the unit otherwise; unknown is a bare dash', () => {
    expect(priceText(market('BTC'), '67812.4')).toBe('$67,812.40');
    expect(priceText(market('ETH', 'BTC', { tickSize: '0.0001' }), '0.0475')).toBe('0.0475 BTC');
    expect(priceText(market('BTC'), null)).toBe('—');
  });
  it('volume is compact dollars on a dollar market and a dash when unknown', () => {
    expect(volumeText(market('BTC'), ticker('BTC-USDT', '1', null, '1234567'))).toBe('$1.2M');
    expect(volumeText(market('BTC'), ticker('BTC-USDT', '1', null, null))).toBe('—');
    expect(volumeText(market('BTC'), undefined)).toBe('—');
  });
  it('places the last price between the low and the high', () => {
    expect(rangePosition(ticker('X', '150', null, null, { low24h: '100', high24h: '200' }))).toBe(50);
    expect(rangePosition(ticker('X', '250', null, null, { low24h: '100', high24h: '200' }))).toBe(100);
    expect(rangePosition(ticker('X', '150', null, null, { low24h: '100', high24h: '100' }))).toBeNull();
    expect(rangePosition(ticker('X', '150', null, null))).toBeNull();
  });
  it('lists USDT and USDC first', () => {
    expect(quotesOf([market('A', 'EUR'), market('B', 'USDC'), market('C', 'USDT')])).toEqual(['USDT', 'USDC', 'EUR']);
  });
});
