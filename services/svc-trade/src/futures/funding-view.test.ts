import { describe, expect, it } from 'vitest';
import { annualisedRate, presentFundingRate } from './funding-view.js';
import { bookMid, testIndexFeedEnabled, testSpotBookIndexFeed, TEST_SPOT_BOOK_SOURCE } from './test-index-feed.js';
import { indexReasonOf, presentFundingHistory } from './funding-history.js';
import type { FundingRatePeriodRecord } from './funding-rate-computer.js';

const published: FundingRatePeriodRecord = {
  periodId: 'm1:2026-01-01T00:01:30.000Z',
  marketId: 'm1',
  periodStart: '2026-01-01T00:01:30.000Z',
  periodEnd: '2026-01-01T00:03:00.000Z',
  status: 'published',
  code: null,
  message: null,
  rate: '0.000100001',
  premium: '0.000000001',
  baseComponent: '0.0001',
  cap: '0.003',
  clamped: false,
  paramsVersion: '1',
  inputs: { closingMark: '100.5', closingIndex: '100.4999999' },
  attempts: 1,
  computedAt: '2026-01-01T00:03:01.000Z',
};

describe('presentFundingRate (J-derivatives-08 #1, #2)', () => {
  it('serves a computed period with every input it was built from', () => {
    const view = presentFundingRate({
      snapshot: { published, last: published, indexNow: { price: '100.6', reason: null }, periodSeconds: 90 },
      s2s: null,
      liveMark: '101',
    });
    expect(view).toMatchObject({
      fundingRate: '0.000100001',
      premium: '0.000000001',
      interestComponent: '0.0001',
      cap: '0.003',
      clamped: false,
      markPrice: '100.5',
      indexPrice: '100.4999999',
      periodId: published.periodId,
      fundingTimestamp: Date.parse(published.periodEnd!),
      nextFundingTimestamp: Date.parse(published.periodEnd!) + 90_000,
      indexNow: { price: '100.6', reason: null },
      lastPeriod: { periodId: published.periodId, status: 'published', code: null },
    });
    expect(view?.annualisedRate).toBe('35.0403504');
  });

  it('keeps the published rate and names an unpublished index and the refused period, inventing nothing', () => {
    const refused: FundingRatePeriodRecord = {
      ...published,
      periodId: 'm1:2026-01-01T00:03:00.000Z',
      periodStart: '2026-01-01T00:03:00.000Z',
      periodEnd: '2026-01-01T00:04:30.000Z',
      status: 'refused',
      code: 'trade.index_params_unset',
      message: 'trade.index_params_unset: minSources blank',
      rate: null,
    };
    const view = presentFundingRate({
      snapshot: { published, last: refused, indexNow: { price: null, reason: 'trade.index_params_unset' }, periodSeconds: 90 },
      s2s: null,
      liveMark: null,
    });
    expect(view?.fundingRate).toBe(published.rate);
    expect(view?.indexNow).toEqual({ price: null, reason: 'trade.index_params_unset' });
    expect(view?.lastPeriod).toMatchObject({ status: 'refused', code: 'trade.index_params_unset' });
  });

  it('serves nothing when no rate was ever published, and a bare S2S rate without invented inputs', () => {
    const blank = { published: null, last: null, indexNow: { price: null, reason: 'feed.market' }, periodSeconds: null };
    expect(presentFundingRate({ snapshot: blank, s2s: null, liveMark: '1' })).toBeNull();
    const s2s = presentFundingRate({
      snapshot: blank,
      s2s: { marketId: 'm1', periodId: 'p', rate: '0.0001', asOfMs: 5 },
      liveMark: '1',
    });
    expect(s2s).toMatchObject({ fundingRate: '0.0001', premium: null, interestComponent: null, cap: null, indexPrice: null, markPrice: '1' });
  });

  it('annualises only a period length that divides a year', () => {
    expect(annualisedRate('-0.0002', 28_800)).toBe('-0.219');
    expect(annualisedRate('0.0001', 7)).toBeNull();
    expect(annualisedRate('0.0001', null)).toBeNull();
  });
});

describe('the TEST index feed (feed.market stand-in)', () => {
  it('is refused outside dev or test, and off unless asked for', () => {
    expect(testIndexFeedEnabled({})).toBe(false);
    expect(testIndexFeedEnabled({ TRADE_FUTURES_TEST_INDEX_FEED: 'off', APP_ENV: 'production' })).toBe(false);
    expect(testIndexFeedEnabled({ TRADE_FUTURES_TEST_INDEX_FEED: 'spot-book', APP_ENV: 'test' })).toBe(true);
    expect(() => testIndexFeedEnabled({ TRADE_FUTURES_TEST_INDEX_FEED: 'spot-book', APP_ENV: 'production' })).toThrow(/refused/);
    expect(() => testIndexFeedEnabled({ TRADE_FUTURES_TEST_INDEX_FEED: 'spot-book' })).toThrow(/refused/);
    expect(() => testIndexFeedEnabled({ TRADE_FUTURES_TEST_INDEX_FEED: 'on', APP_ENV: 'test' })).toThrow(/must be/);
  });

  it('quotes the book mid, and nothing for an empty, one-sided or crossed book', async () => {
    expect(bookMid({ bids: [['100', '1']], asks: [['101', '2']], sequence: 1 })).toBe(100_500_000_000_000_000_000n);
    expect(bookMid({ bids: [], asks: [['101', '2']], sequence: 1 })).toBeNull();
    expect(bookMid({ bids: [['102', '1']], asks: [['101', '2']], sequence: 1 })).toBeNull();
    expect(bookMid(null)).toBeNull();
    const at = new Date('2026-01-01T00:00:00Z');
    const feed = testSpotBookIndexFeed({ readBook: async () => ({ bids: [['100', '1']], asks: [['102', '1']], sequence: 1 }), now: () => at });
    expect(await feed.read({ marketId: 'm1', sourceIds: [TEST_SPOT_BOOK_SOURCE], at })).toEqual({
      connected: true,
      quotes: [{ sourceId: TEST_SPOT_BOOK_SOURCE, price: 101_000_000_000_000_000_000n, observedAt: at }],
    });
    // A source it does not stand in for is never quoted.
    expect(await feed.read({ marketId: 'm1', sourceIds: ['binance'], at })).toEqual({ connected: true, quotes: [] });
  });
});

describe('public funding history (J-derivatives-08 #4, #6)', () => {
  it('carries premium, annualised rate, index and settlement, null where absent', () => {
    const presented = presentFundingHistory({
      symbol: 'BTC/USDT:USDT',
      market: { id: 'm1', symbol: 'BTC/USDT:USDT', kind: 'futures', futuresContractStyle: 'perpetual' },
      rows: [
        { marketId: 'm1', periodId: 's2s', periodTimestamp: 1, fundingRate: '0.0001', markPrice: null },
        {
          marketId: 'm1',
          periodId: 'c',
          periodTimestamp: 2,
          fundingRate: '0.0001',
          markPrice: '1',
          indexPrice: '1',
          premium: '0',
          interestComponent: '0.0001',
          cap: '0.003',
          annualisedRate: '0.0365',
          settlement: { legs: 2, paid: '0.5', received: '0.5' },
        },
      ],
    });
    const rates = presented.body.rates as Array<Record<string, unknown>>;
    expect(rates[0]).toMatchObject({ periodId: 's2s', premium: null, index_price: null, settlement: null });
    expect(rates[1]).toMatchObject({ periodId: 'c', index_price: '1', annualisedRate: '0.0365', settlement: { paid: '0.5', received: '0.5' } });
  });

  it('names why an index point is null', () => {
    expect(indexReasonOf('1', null)).toBeNull();
    expect(indexReasonOf(null, 'mark_unavailable+trade.index_params_unset')).toBe('trade.index_params_unset');
    expect(indexReasonOf(null, 'feed.market')).toBe('feed.market');
    expect(indexReasonOf(null, null)).toBe('trade.index_not_recorded');
  });
});
