import { TradeService } from '../controls/test-admission.js';
/**
 * Unit card — TradeService.publicTape limit unset refuse (no invented 100)
 *
 * 1. Promise: omitted tape limit does not become 100. Owner/HTTP may pass 100.
 * 2. Break: `publicTape(..., limit = 100)` dressed a blank inner call as a chosen
 *    window (leftover after #4060 HTTP mill; HTTP already publishes limit).
 * 3. Done bar: no `limit = 100`; unset/null/out of 1..500 throw
 *    trade.public_tape_limit_unset before SQL; explicit 100 is a published window.
 * 4. Class N
 * 5. Paths: trade-service.ts TradeService.publicTape
 * 6. RED: omitting limit returns a 100-print tape
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PUBLIC_TAPE_LIMIT_MAX,
  PublicTapeLimitUnsetError,
  publishedPublicTapeLimit,
  TRADE_PUBLIC_TAPE_LIMIT_UNSET,
} from './trade-service.js';

const HERE = dirname(fileURLToPath(import.meta.url));

function serviceWithUnreachableSql(): { trade: TradeService; sqlCalled: () => boolean } {
  let sqlCalled = false;
  const sql = Object.assign(() => {
    sqlCalled = true;
    throw new Error('sql must not run when public tape limit is unset');
  }, {}) as never;
  const trade = new TradeService(sql, {} as never, {} as never, {} as never, {} as never);
  return { trade, sqlCalled: () => sqlCalled };
}

describe('TradeService.publicTape limit unset refuse (no invented 100)', () => {
  it('trade-service.ts does not invent 100 via default param or clamp', () => {
    const src = readFileSync(join(HERE, 'trade-service.ts'), 'utf8');
    expect(src).not.toMatch(/async publicTape\([^)]*limit = 100/);
    expect(src).toMatch(/async publicTape\(marketId: string, limit: number/);
    expect(src).toMatch(/publishedPublicTapeLimit\(limit\)/);
    expect(src).not.toMatch(/Math\.min\(Math\.max\(Math\.floor\(limit\), 1\), 500\)/);
  });

  it('blank / non-integer / out of 1..500 throws trade.public_tape_limit_unset', () => {
    for (const limit of [undefined, null, 0, -1, 501, 1.5, Number.NaN]) {
      try {
        publishedPublicTapeLimit(limit);
        expect.unreachable(`expected throw for limit=${String(limit)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(PublicTapeLimitUnsetError);
        expect((err as PublicTapeLimitUnsetError).code).toBe(TRADE_PUBLIC_TAPE_LIMIT_UNSET);
      }
    }
  });

  it('owner-explicit 100 and 1 are published windows', () => {
    expect(publishedPublicTapeLimit(100)).toBe(100);
    expect(publishedPublicTapeLimit(1)).toBe(1);
    expect(publishedPublicTapeLimit(PUBLIC_TAPE_LIMIT_MAX)).toBe(500);
  });

  it('omitted / undefined / null limit refuses before SQL', async () => {
    for (const limit of [undefined, null] as unknown as number[]) {
      const { trade, sqlCalled } = serviceWithUnreachableSql();
      await expect(trade.publicTape('m1', limit)).rejects.toMatchObject({
        name: 'PublicTapeLimitUnsetError',
        code: TRADE_PUBLIC_TAPE_LIMIT_UNSET,
      });
      expect(sqlCalled()).toBe(false);
    }
  });
});
