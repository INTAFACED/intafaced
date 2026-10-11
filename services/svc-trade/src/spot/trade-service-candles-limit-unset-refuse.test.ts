import { TradeService } from '../controls/test-admission.js';
/**
 * Unit card — TradeService.candles limit unset refuse (no invented 500)
 *
 * 1. Promise: omitted candles limit does not become 500. Owner/HTTP may pass 500.
 * 2. Break: `candles(..., limit = 500)` dressed a blank inner call as a chosen window
 *    (leftover after #4064 fill mill; HTTP already publishes limit — #4060).
 * 3. Done bar: no `limit = 500`; unset/null throw trade.candles_fill_limit_unset
 *    before SQL; explicit 500 is a published window at queryCandlesFromFills.
 * 4. Class N
 * 5. Paths: trade-service.ts TradeService.candles
 * 6. RED: omitting limit returns a 500-bucket series
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TRADE_CANDLES_FILL_LIMIT_UNSET } from './candles.js';

const HERE = dirname(fileURLToPath(import.meta.url));

function serviceWithUnreachableSql(): { trade: TradeService; sqlCalled: () => boolean } {
  let sqlCalled = false;
  const sql = Object.assign(() => {
    sqlCalled = true;
    throw new Error('sql must not run when candles limit is unset');
  }, {}) as never;
  const trade = new TradeService(sql, {} as never, {} as never, {} as never, {} as never);
  return { trade, sqlCalled: () => sqlCalled };
}

describe('TradeService.candles limit unset refuse (no invented 500)', () => {
  it('trade-service.ts does not invent 500 via default param', () => {
    const src = readFileSync(join(HERE, 'trade-service.ts'), 'utf8');
    expect(src).not.toMatch(/async candles\([^)]*limit = 500/);
    expect(src).toMatch(/async candles\(marketId: string, timeframe: Timeframe, limit: number/);
  });

  it('omitted / undefined / null limit refuses before SQL', async () => {
    for (const limit of [undefined, null] as unknown as number[]) {
      const { trade, sqlCalled } = serviceWithUnreachableSql();
      await expect(trade.candles('m1', '1m', limit)).rejects.toMatchObject({
        name: 'CandlesFillLimitUnsetError',
        code: TRADE_CANDLES_FILL_LIMIT_UNSET,
      });
      expect(sqlCalled()).toBe(false);
    }
  });
});
