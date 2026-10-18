/**
 * MKT-0093 — an oversized candle window is refused, and no partial series comes back.
 *
 * The published cap is the request's own limit, at most 720. A since→now
 * window longer than that limit is refused, and a limit over 720 is refused,
 * both before SQL.
 */
import { describe, expect, it } from 'vitest';
import { TradeService } from './trade-service.js';
import { candleRangePointCount, queryCandlesFromFills, TRADE_CANDLES_RANGE_POINT_CAP } from './candles.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const END_MS = 1_700_000_000_000;

function recordingSql(refuse: boolean): { sql: never; called: () => boolean } {
  let sqlCalled = false;
  const sql = Object.assign(() => {
    sqlCalled = true;
    if (refuse) throw new Error('sql must not run for a refused candle window');
    return [];
  }, {}) as never;
  return { sql, called: () => sqlCalled };
}

function tradeAt(sql: never): TradeService {
  return new TradeService(sql, {} as never, {} as never, {} as never, {} as never, {
    now: () => new Date(END_MS),
  });
}

describe('MKT-0093 candle range over the published cap', () => {
  it('counts a 301-minute 1m window as 301 points and a 300-minute window as 300', () => {
    expect(candleRangePointCount('1m', END_MS - 301 * MINUTE, END_MS)).toBe(301);
    expect(candleRangePointCount('1m', END_MS - 300 * MINUTE, END_MS)).toBe(300);
  });

  it('answers a 470-hour 1h window when the limit is 500 and queries', async () => {
    const stub = recordingSql(false);
    const trade = tradeAt(stub.sql);

    await expect(trade.candles('m1', '1h', 500, END_MS - 470 * HOUR)).resolves.toEqual([]);
    expect(stub.called()).toBe(true);
  });

  it('refuses a limit over 720 with no since and does not query', async () => {
    const stub = recordingSql(true);
    const trade = tradeAt(stub.sql);

    await expect(trade.candles('m1', '1m', 1000)).rejects.toMatchObject({
      name: 'TradeError',
      code: TRADE_CANDLES_RANGE_POINT_CAP,
    });
    expect(stub.called()).toBe(false);
  });

  it('refuses a 301-minute 1m window when the limit is 10 and does not query', async () => {
    const stub = recordingSql(true);
    const trade = tradeAt(stub.sql);

    await expect(trade.candles('m1', '1m', 10, END_MS - 301 * MINUTE)).rejects.toMatchObject({
      name: 'TradeError',
      code: TRADE_CANDLES_RANGE_POINT_CAP,
    });
    expect(stub.called()).toBe(false);
  });

  it('answers the two-bucket 1m poll and does not refuse', async () => {
    const stub = recordingSql(false);
    const trade = tradeAt(stub.sql);
    const since = Math.floor(END_MS / MINUTE) * MINUTE - MINUTE;

    await expect(trade.candles('m1', '1m', 2, since)).resolves.toEqual([]);
    expect(stub.called()).toBe(true);
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
