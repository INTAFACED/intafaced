/**
 * MKT-0093 — an oversized candle window is refused, and no partial series comes back.
 *
 * Published cap is 300 points (Coinbase candle selection). A limit inside 1..1000
 * does not measure that range today; this test does.
 */
import { describe, expect, it } from 'vitest';
import { TradeService } from './trade-service.js';
import { CANDLE_RANGE_POINT_CAP, candleRangePointCount, queryCandlesFromFills, TRADE_CANDLES_RANGE_POINT_CAP } from './candles.js';

const MINUTE = 60_000;
const END_MS = 1_700_000_000_000;

describe('MKT-0093 candle range over the published cap', () => {
  it('publishes a 300-point cap', () => {
    expect(CANDLE_RANGE_POINT_CAP).toBe(300);
  });

  it('counts a 301-minute 1m window as 301 points and a 300-minute window as 300', () => {
    expect(candleRangePointCount('1m', END_MS - 301 * MINUTE, END_MS)).toBe(301);
    expect(candleRangePointCount('1m', END_MS - 300 * MINUTE, END_MS)).toBe(300);
  });

  it('rejects a granularity that would return more than 300 points and does not query', async () => {
    let sqlCalled = false;
    const sql = Object.assign(() => {
      sqlCalled = true;
      throw new Error('sql must not run for an over-cap candle window');
    }, {}) as never;
    const trade = new TradeService(sql, {} as never, {} as never, {} as never, {} as never, {
      now: () => new Date(END_MS),
    });

    await expect(trade.candles('m1', '1m', 10, END_MS - 301 * MINUTE)).rejects.toMatchObject({
      name: 'TradeError',
      code: TRADE_CANDLES_RANGE_POINT_CAP,
    });
    expect(sqlCalled).toBe(false);
  });

  it('a store failure rejects the request and does not return a partial series', async () => {
    const sql = Object.assign(() => {
      throw new Error('provider HTTP 500');
    }, {}) as never;
    await expect(
      queryCandlesFromFills(sql, {
        marketId: 'm1',
        timeframe: '1m',
        limit: 10,
        sinceMs: END_MS - 10 * MINUTE,
      }),
    ).rejects.toThrow(/provider HTTP 500/);
  });
});
