import { describe, expect, it } from 'vitest';
import { moversOf } from './movers-model';
import { quoteFromCandles, shownUsd, standing, type PartInput, type VenueMarketQuotes } from './standing';

const PRICES = {
  published: true as const,
  test: true,
  source: 'TEST price list',
  asOf: '2026-11-14T08:00:00.000Z',
  prices: [
    { asset: 'USDC', usd: '1' },
    { asset: 'USDT', usd: '1' },
  ],
};
const wallet = (rows: PartInput['read']): PartInput => ({ id: 'wallet', label: 'Base Sepolia', read: rows });
const venue: PartInput = {
  id: 'venue',
  label: 'TEST venue',
  test: true,
  read: { state: 'read', asOf: '2026-11-14T08:01:00.000Z', rows: [{ asset: 'USDC', amount: '500.123456789012345678' }] },
};
const partner: PartInput = {
  id: 'partner',
  label: 'TEST partner bank',
  read: { state: 'read', asOf: '2026-11-14T08:02:00.000Z', rows: [{ asset: 'USDT', amount: '50' }] },
};

describe('where a person stands (J-home-ia-01 #1)', () => {
  it('J-portfolio-01 #1: every valued row carries its published price and its share of the total; an unpriced one carries neither', () => {
    const s = standing(
      [wallet({ state: 'read', asOf: '2026-11-14T07:59:00.000Z', rows: [{ asset: 'TESTUSD', amount: '100' }] }), venue, partner],
      PRICES,
      'USD',
    );
    const rows = s.parts.flatMap((part) => part.rows);
    expect(rows.map((row) => [row.asset, row.priceUsd, row.share])).toEqual([
      ['TESTUSD', null, null],
      // 500.123456789012345678 / 550.123456789012345678 = 90.911 %; 50 / 550.12 = 9.089 %
      ['USDC', '1', '90.91'],
      ['USDT', '1', '9.09'],
    ]);
  });

  it('adds what each source reports at its published price, each part named with its as-of time', () => {
    const s = standing(
      [
        wallet({
          state: 'read',
          asOf: '2026-11-14T07:59:00.000Z',
          rows: [
            { asset: 'TESTUSD', amount: '100' },
            { asset: 'ETH', amount: '0.5' },
          ],
        }),
        venue,
        partner,
      ],
      PRICES,
      'USD',
    );
    expect(s.totalUsd).toBe('550.12');
    expect(s.unpriced).toEqual(['TESTUSD', 'ETH']);
    expect(s.unread).toEqual([]);
    expect(s.parts.map((p) => [p.id, p.asOf, p.valueUsd])).toEqual([
      ['wallet', '2026-11-14T07:59:00.000Z', null],
      ['venue', '2026-11-14T08:01:00.000Z', '500.123456789012345678'],
      ['partner', '2026-11-14T08:02:00.000Z', '50'],
    ]);
    expect(s.prices).toEqual({ source: 'TEST price list', asOf: '2026-11-14T08:00:00.000Z', test: true });
  });

  it('names a source that cannot be read and leaves it out, never as zero', () => {
    const s = standing([wallet({ state: 'read', asOf: 'x', rows: [] }), venue, { ...partner, read: { state: 'unread' } }], PRICES, 'USD');
    expect(s.unread).toEqual(['partner']);
    expect(s.totalUsd).toBe('500.12');
    expect(s.parts[2]).toMatchObject({ state: 'unread', valueUsd: null, rows: [] });
  });

  it('has no total with no price published, and names every asset', () => {
    const s = standing([venue, partner], { published: false, code: 'valuation.prices_unset' }, 'USD');
    expect(s.totalUsd).toBeNull();
    expect(s.unpriced).toEqual(['USDC', 'USDT']);
    expect(s.prices).toBeNull();
  });

  it('keeps dollars in the BTC unit when BTC has no published price, and converts when it has', () => {
    expect(standing([venue], PRICES, 'BTC').btc).toEqual({ total: null, reason: 'no_btc_price' });
    const withBtc = { ...PRICES, prices: [...PRICES.prices, { asset: 'BTC', usd: '60000' }] };
    expect(standing([venue], withBtc, 'BTC').btc).toEqual({ total: '0.00833539' });
    expect(standing([], withBtc, 'BTC').btc).toEqual({ total: null, reason: 'nothing_priced' });
  });

  it('rounds half up to cents only when shown', () => {
    expect(shownUsd('0.005')).toBe('0.01');
    expect(shownUsd('0.004999999999999999')).toBe('0.00');
    expect(shownUsd('1234.5')).toBe('1234.50');
  });
});

describe('venue spot quotes, valuation note and movers (J-portfolio-01 #2 #7)', () => {
  const AS_OF = '2026-11-24T12:00:00.000Z';

  it('quoteFromCandles reads last trade and 24h open from hourly candles without guessing', () => {
    expect(quoteFromCandles('BTC-USDC', [], AS_OF)).toEqual({
      symbol: 'BTC-USDC',
      last: null,
      open: null,
      windowStart: null,
    });
    expect(quoteFromCandles('BTC-USDC', [{ openAt: '2026-11-24T11:00:00.000Z', openPrice: '60100', closePrice: '60100' }], AS_OF)).toEqual({
      symbol: 'BTC-USDC',
      last: '60100',
      open: '60100',
      windowStart: Date.parse('2026-11-24T11:00:00.000Z'),
    });
    expect(
      quoteFromCandles(
        'UP-USDC',
        [
          { openAt: '2026-11-24T10:00:00.000Z', openPrice: '100', closePrice: '110' },
          { openAt: '2026-11-24T11:00:00.000Z', openPrice: '110', closePrice: '120' },
        ],
        AS_OF,
      ),
    ).toEqual({
      symbol: 'UP-USDC',
      last: '120',
      open: '100',
      windowStart: Date.parse('2026-11-24T10:00:00.000Z'),
    });
    // Full 24h window: a candle before the 24h cutoff gives the 24h open price and windowStart is null.
    expect(
      quoteFromCandles(
        'DOWN-USDC',
        [
          { openAt: '2026-11-23T10:00:00.000Z', openPrice: '210', closePrice: '200' },
          { openAt: '2026-11-24T11:00:00.000Z', openPrice: '190', closePrice: '170' },
        ],
        AS_OF,
      ),
    ).toEqual({
      symbol: 'DOWN-USDC',
      last: '170',
      open: '200',
      windowStart: null,
    });
    // Only prints older than 24h: still priced at last trade, but no 24h move.
    expect(quoteFromCandles('OLD-USDC', [{ openAt: '2026-11-20T10:00:00.000Z', openPrice: '50', closePrice: '55' }], AS_OF)).toEqual({
      symbol: 'OLD-USDC',
      last: '55',
      open: null,
      windowStart: null,
    });
  });

  it('values venue-traded holdings from venue quotes, keeps unpriced coins with their reason, and feeds movers from the same valuation', () => {
    const venueQuotes: VenueMarketQuotes = {
      venueName: 'TEST venue simulator',
      test: true,
      asOf: AS_OF,
      byAsset: new Map([
        ['UP', { symbol: 'UP-USDC', last: '120', open: '100', windowStart: Date.parse('2026-11-24T11:00:00.000Z') }],
        ['DOWN', { symbol: 'DOWN-USDC', last: '170', open: '200', windowStart: Date.parse('2026-11-24T11:00:00.000Z') }],
        ['BTC', { symbol: 'BTC-USDC', last: '60100', open: '60100', windowStart: Date.parse('2026-11-24T11:00:00.000Z') }],
        ['QUIET', { symbol: 'QUIET-USDC', last: null, open: null, windowStart: null }],
        ['OLD', { symbol: 'OLD-USDC', last: '10', open: null, windowStart: null }],
      ]),
    };
    const s = standing(
      [
        wallet({
          state: 'read',
          asOf: AS_OF,
          rows: [
            { asset: 'TESTUSD', amount: '90' },
            { asset: 'QUIET', amount: '2' },
          ],
        }),
        {
          id: 'venue',
          label: 'TEST venue simulator',
          test: true,
          read: {
            state: 'read',
            asOf: AS_OF,
            rows: [
              { asset: 'USDC', amount: '100' },
              { asset: 'UP', amount: '0.5' },
              { asset: 'DOWN', amount: '0.5' },
              { asset: 'BTC', amount: '0.001' },
              { asset: 'OLD', amount: '1' },
            ],
          },
        },
        partner,
      ],
      PRICES,
      'USD',
      venueQuotes,
    );
    // 100 USDC + 60 UP + 85 DOWN + 60.10 BTC + 10 OLD + 50 USDT = 365.10
    expect(s.totalUsd).toBe('365.10');
    expect(s.unpriced).toEqual(['TESTUSD', 'QUIET']);
    expect(s.valuation).not.toBeNull();
    expect(s.valuation!.unpricedReasons).toEqual({
      TESTUSD: 'no_market',
      QUIET: 'no_price_yet',
    });
    const byAsset = new Map(s.valuation!.rows.map((r) => [r.asset, r]));
    expect(byAsset.get('USDC')).toMatchObject({ class: 'cash', priceUsd: '1', usdValue: '100', priceSymbol: null });
    expect(byAsset.get('USDT')).toMatchObject({ class: 'cash', priceUsd: '1', usdValue: '50', priceSymbol: null });
    expect(byAsset.get('UP')).toMatchObject({
      class: 'crypto',
      priceUsd: '120',
      usdValue: '60',
      usdChange24h: '10',
      changeRatio: '0.2',
      priceSymbol: 'UP-USDC',
    });
    expect(byAsset.get('DOWN')).toMatchObject({
      class: 'crypto',
      priceUsd: '170',
      usdValue: '85',
      usdChange24h: '-15',
      changeRatio: '-0.15',
      priceSymbol: 'DOWN-USDC',
    });
    expect(byAsset.get('TESTUSD')).toMatchObject({ priceUsd: null, usdValue: null, share: null });
    expect(byAsset.get('QUIET')).toMatchObject({ priceUsd: null, usdValue: null, share: null });

    const movers = moversOf(s.valuation!);
    expect(movers.best.map((r) => r.asset)).toEqual(['UP']);
    expect(movers.worst.map((r) => r.asset)).toEqual(['DOWN']);
    expect(movers.flat.map((r) => r.asset)).toEqual(['BTC']);
    expect(movers.unranked).toEqual(['OLD']);
  });

  it('ignores venue quotes when valuation.prices is unpublished (J-wallet-01 #4)', () => {
    const venueQuotes: VenueMarketQuotes = {
      venueName: 'TEST venue simulator',
      test: true,
      asOf: AS_OF,
      byAsset: new Map([['BTC', { symbol: 'BTC-USDC', last: '60100', open: '60000', windowStart: null }]]),
    };
    const s = standing(
      [
        {
          id: 'venue',
          label: 'TEST venue simulator',
          test: true,
          read: {
            state: 'read',
            asOf: AS_OF,
            rows: [
              { asset: 'BTC', amount: '1' },
              { asset: 'USDC', amount: '100' },
            ],
          },
        },
      ],
      { published: false, code: 'valuation.prices_unset' },
      'USD',
      venueQuotes,
    );
    expect(s.totalUsd).toBeNull();
    expect(s.prices).toBeNull();
    expect(s.valuation).toBeNull();
    expect(s.unpriced).toEqual(['BTC', 'USDC']);
  });
});
