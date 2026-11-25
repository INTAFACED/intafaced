import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  asOf,
  venueAccountModeSchema,
  venueAccountSummarySchema,
  venueBalanceSchema,
  venueBestPricesReadSchema,
  venueBookReadSchema,
  venueCandlesReadSchema,
  venueFillSchema,
  venueHistoryPageSchema,
  venueLeverageSchema,
  venueOrderSchema,
  venuePositionSchema,
  venueStatusSchema,
  venueTradesReadSchema,
} from '@intafaced/contracts/trade-venue-door';
import { DEMO_NOW, RECORDING, callKey, demoAnswer, recordedAnswer } from './index.mjs';

// The demo world is only worth its pictures while the app reads it: every answer a desk draws from is parsed here with
// the app's own schemas, so a schema change that would leave a picture's panel empty fails here first.
const read = (href) => demoAnswer(`http://x${href}`, 'GET', null, { signedIn: true, now: DEMO_NOW });
const SYMBOLS = RECORDING.calls.signedIn['GET /api/v1/venue/market-states'].json.value.markets.map((m) => m.symbol);

describe('the demo world', () => {
  it('is TEST, recorded with the venue on, and lists the venue markets it has a feed for', () => {
    expect(RECORDING.label).toBe('TEST');
    expect(Number.isFinite(DEMO_NOW)).toBe(true);
    expect(venueStatusSchema.parse(read('/api/v1/venue/status').json)).toMatchObject({ enabled: true, available: true, test: true });
    expect(SYMBOLS).toEqual(expect.arrayContaining(['BTC-PERP', 'ETH-PERP']));
  });

  it("answers every listed market's book, best prices, prints and candles in the door's own shape", () => {
    for (const symbol of SYMBOLS) {
      const book = venueBookReadSchema.parse(read(`/api/v1/venue/book?symbol=${symbol}&depth=10`).json);
      expect(book.value.symbol).toBe(symbol);
      venueBestPricesReadSchema.parse(read(`/api/v1/venue/best-prices?symbol=${symbol}`).json);
      venueTradesReadSchema.parse(read(`/api/v1/venue/trades?symbol=${symbol}&limit=30`).json);
      venueCandlesReadSchema.parse(read(`/api/v1/venue/candles?symbol=${symbol}&interval=15m&limit=240`).json);
    }
    for (const symbol of ['BTC-PERP', 'ETH-PERP']) {
      expect(read(`/api/v1/venue/book?symbol=${symbol}&depth=10`).json.value.bids.length).toBeGreaterThan(0);
      expect(read(`/api/v1/venue/trades?symbol=${symbol}&limit=30`).json.value.length).toBeGreaterThan(0);
      expect(read(`/api/v1/venue/candles?symbol=${symbol}&interval=15m&limit=240`).json.value.length).toBeGreaterThan(100);
    }
  });

  it("seeds the trader's balances, positions, orders, fills and history, and their marks agree with the recorded book", () => {
    const owner = '?owner=0x0000000000000000000000000000000000000001';
    expect(asOf(z.array(venueBalanceSchema)).parse(read(`/api/v1/venue/balances${owner}`).json).value.length).toBeGreaterThan(0);
    const positions = asOf(z.array(venuePositionSchema)).parse(read(`/api/v1/venue/positions${owner}`).json).value;
    expect(positions.map((p) => p.symbol)).toEqual(['BTC-PERP', 'ETH-PERP']);
    const best = read('/api/v1/venue/best-prices?symbol=BTC-PERP').json.value;
    const mark = Number(positions[0].markPrice);
    expect(mark).toBeGreaterThanOrEqual(Math.floor(Number(best.bid)));
    expect(mark).toBeLessThanOrEqual(Math.ceil(Number(best.ask)));
    expect(asOf(z.array(venueOrderSchema)).parse(read(`/api/v1/venue/orders/open${owner}`).json).value.length).toBe(3);
    expect(asOf(z.array(venueFillSchema)).parse(read(`/api/v1/venue/fills${owner}&since=2026-01-01T00:00:00Z`).json).value.length).toBe(5);
    expect(venueHistoryPageSchema.parse(read(`/api/v1/venue/orders/history${owner}`).json).orders.length).toBe(8);
    asOf(venueAccountSummarySchema).parse(read(`/api/v1/venue/account-summary${owner}`).json);
    asOf(venueAccountModeSchema).parse(read(`/api/v1/venue/account-mode${owner}`).json);
    expect(asOf(venueLeverageSchema.nullable()).parse(read(`/api/v1/venue/leverage${owner}&symbol=ETH-PERP`).json).value?.leverageBps).toBe(
      50_000,
    );
  });

  it('answers a read asked at another depth from the same market, and nothing for a market it never saw', () => {
    expect(callKey('GET', '/api/v1/venue/book?symbol=BTC-PERP&depth=10')).toBe('GET /api/v1/venue/book?depth=10&symbol=BTC-PERP');
    expect(recordedAnswer('/api/v1/venue/book?symbol=BTC-PERP&depth=7', 'GET', { signedIn: true })?.json.value.symbol).toBe('BTC-PERP');
    expect(recordedAnswer('/api/v1/venue/book?symbol=DOGE-PERP&depth=10', 'GET', { signedIn: true })).toBeNull();
    expect(recordedAnswer('/api/v1/venue/book?symbol=BTC-PERP&depth=10', 'POST', { signedIn: true })).toBeNull();
  });

  it('keeps nothing about the tester the recording was made with', () => {
    const text = JSON.stringify(RECORDING);
    expect(text).not.toMatch(/local-test\.invalid|zenyoda/i);
    expect(Object.keys(RECORDING.calls.signedIn).every((k) => k.startsWith('GET /api/v1/'))).toBe(true);
  });
});
