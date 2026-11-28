import { describe, expect, it } from 'vitest';
import {
  CANDLES_FILL_LIMIT_MAX,
  CandlesFillLimitUnsetError,
  publishedFillCandleLimit,
  queryCandlesFromFills,
  TRADE_CANDLES_FILL_LIMIT_UNSET,
} from './candles.js';

describe('queryCandlesFromFills limit unset refuse (no invented 500)', () => {
  it('blank / non-integer / out of 1..1000 throws trade.candles_fill_limit_unset', () => {
    for (const limit of [undefined, null, 0, -1, 1001, 1.5, Number.NaN]) {
      try {
        publishedFillCandleLimit(limit);
        expect.unreachable(`expected throw for limit=${String(limit)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(CandlesFillLimitUnsetError);
        expect((err as CandlesFillLimitUnsetError).code).toBe(TRADE_CANDLES_FILL_LIMIT_UNSET);
      }
    }
  });

  it('owner-explicit 500 and 1 are published windows', () => {
    expect(publishedFillCandleLimit(500)).toBe(500);
    expect(publishedFillCandleLimit(1)).toBe(1);
    expect(publishedFillCandleLimit(CANDLES_FILL_LIMIT_MAX)).toBe(1000);
  });

  it('queryCandlesFromFills refuses before SQL when limit is unset', async () => {
    const sql = Object.assign(() => {
      throw new Error('sql must not run when limit is unset');
    }, {}) as never;
    await expect(queryCandlesFromFills(sql, { marketId: 'm1', timeframe: '1m' })).rejects.toMatchObject({
      name: 'CandlesFillLimitUnsetError',
      code: TRADE_CANDLES_FILL_LIMIT_UNSET,
    });
  });
});
