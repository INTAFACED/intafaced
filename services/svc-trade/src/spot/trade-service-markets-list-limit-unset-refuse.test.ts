import { TradeService } from '../controls/test-admission.js';
/**
 * Unit card — TradeService.markets list limit unset refuse (no invented 50)
 *
 * 1. Promise: omitted markets() limit does not dump trade.markets. Owner/query
 *    may pass 50.
 * 2. Break: `async markets()` SELECT with no LIMIT dressed the whole table as
 *    a chosen window (leftover after listClosed #4099).
 * 3. Done bar: no default 50/100 / no clamp; unset/null/out of 1..500 throw
 *    typed `trade.markets_limit_unset` before SQL; explicit 50 is a published window.
 * 4. Class N
 * 5. Paths: trade-service.ts TradeService.markets
 * 6. RED: omitting limit returns every trade.markets row
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MARKETS_LIMIT_MAX, MarketsLimitUnsetError, publishedMarketsLimit, TRADE_MARKETS_LIMIT_UNSET } from './trade-service.js';

const HERE = dirname(fileURLToPath(import.meta.url));

function serviceWithUnreachableSql(): { trade: TradeService; sqlCalled: () => boolean } {
  let sqlCalled = false;
  const sql = Object.assign(() => {
    sqlCalled = true;
    throw new Error('sql must not run when markets list limit is unset');
  }, {}) as never;
  const trade = new TradeService(sql, {} as never, {} as never, {} as never, {} as never);
  return { trade, sqlCalled: () => sqlCalled };
}

describe('TradeService.markets list limit unset refuse (no invented 50)', () => {
  it('trade-service.ts does not invent 50/100 via default or clamp', () => {
    const src = readFileSync(join(HERE, 'trade-service.ts'), 'utf8');
    expect(src).not.toMatch(/async markets\(\): Promise<Market\[\]>/);
    expect(src).toMatch(/async markets\(limit: number\)/);
    expect(src).toMatch(/publishedMarketsLimit\(limit\)/);
    expect(src).not.toMatch(/async markets[\s\S]{0,400}Math\.min\(Math\.max\(/);
  });

  it('blank / non-integer / out of 1..500 throws trade.markets_limit_unset', () => {
    for (const limit of [undefined, null, 0, -1, 501, 1.5, Number.NaN]) {
      try {
        publishedMarketsLimit(limit);
        expect.unreachable(`expected throw for limit=${String(limit)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(MarketsLimitUnsetError);
        expect((err as MarketsLimitUnsetError).code).toBe(TRADE_MARKETS_LIMIT_UNSET);
      }
    }
  });

  it('owner-explicit 50 and 1 are published windows', () => {
    expect(publishedMarketsLimit(50)).toBe(50);
    expect(publishedMarketsLimit(1)).toBe(1);
    expect(publishedMarketsLimit(MARKETS_LIMIT_MAX)).toBe(500);
  });

  it('omitted / undefined / null markets limit refuses before SQL', async () => {
    for (const limit of [undefined, null] as unknown as number[]) {
      const { trade, sqlCalled } = serviceWithUnreachableSql();
      await expect(trade.markets(limit)).rejects.toMatchObject({
        name: 'MarketsLimitUnsetError',
        code: TRADE_MARKETS_LIMIT_UNSET,
      });
      expect(sqlCalled()).toBe(false);
    }
  });
});
