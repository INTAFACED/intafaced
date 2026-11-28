import { PositionService } from '../controls/test-admission.js';
/**
 * Unit card — listClosed limit unset refuse (no invented 100)
 *
 * 1. Promise: omitted PositionService.listClosed limit does not become 100.
 *    Owner/query may pass 100.
 * 2. Break: `input.limit` default plus clamp `Math.min(Math.max(..., 1), 500)`
 *    dressed a blank page as a chosen window (leftover after fills/history
 *    #4078 and adminOpenOrders #4081). REST already refused blank
 *    positions/closed.
 * 3. Done bar: no default 100 / no clamp; unset/null/out of 1..500 throw typed
 *    `trade.list_closed_limit_unset` before SQL; explicit 100 is a published window.
 * 4. Class N
 * 5. Paths: futures/position-service.ts listClosed
 * 6. RED: omitting limit returns a 100-row closed-positions page
 */
import { describe, expect, it } from 'vitest';
import {
  LIST_CLOSED_LIMIT_MAX,
  ListClosedLimitUnsetError,
  publishedListClosedLimit,
  TRADE_LIST_CLOSED_LIMIT_UNSET,
} from './position-service.js';

function serviceWithUnreachableSql(): { positions: PositionService; sqlCalled: () => boolean } {
  let sqlCalled = false;
  const sql = Object.assign(() => {
    sqlCalled = true;
    throw new Error('sql must not run when listClosed limit is unset');
  }, {}) as never;
  const positions = new PositionService(sql, {} as never, { marks: {} as never, profitSource: null });
  return { positions, sqlCalled: () => sqlCalled };
}

describe('listClosed limit unset refuse (no invented 100)', () => {
  it('position-service.ts does not invent 100 via default or clamp', async () => {
    // Out of range at the service is refused before SQL, not clamped into 1..500.
    for (const limit of [0, -1, 501, 1.5]) {
      const { positions, sqlCalled } = serviceWithUnreachableSql();
      await expect(positions.listClosed('alice', { limit }), String(limit)).rejects.toMatchObject({ code: TRADE_LIST_CLOSED_LIMIT_UNSET });
      expect(sqlCalled()).toBe(false);
    }
    // A published window reaches SQL as given.
    const values: unknown[][] = [];
    const sql = Object.assign((_strings: TemplateStringsArray, ...params: unknown[]) => {
      values.push(params);
      return Promise.resolve([]);
    }, {}) as never;
    const positions = new PositionService(sql, {} as never, { marks: {} as never, profitSource: null });
    expect(await positions.listClosed('alice', { limit: 7 })).toEqual([]);
    expect(values).toHaveLength(1);
    expect(values[0]).toContain(7);
    expect(values[0]).not.toContain(100);
  });

  it('blank / non-integer / out of 1..500 throws trade.list_closed_limit_unset', () => {
    for (const limit of [undefined, null, 0, -1, 501, 1.5, Number.NaN]) {
      try {
        publishedListClosedLimit(limit);
        expect.unreachable(`expected throw for limit=${String(limit)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(ListClosedLimitUnsetError);
        expect((err as ListClosedLimitUnsetError).code).toBe(TRADE_LIST_CLOSED_LIMIT_UNSET);
      }
    }
  });

  it('owner-explicit 100 and 1 are published windows', () => {
    expect(publishedListClosedLimit(100)).toBe(100);
    expect(publishedListClosedLimit(1)).toBe(1);
    expect(publishedListClosedLimit(LIST_CLOSED_LIMIT_MAX)).toBe(500);
  });

  it('omitted / undefined / null listClosed limit refuses before SQL', async () => {
    for (const limit of [undefined, null] as unknown as number[]) {
      const { positions, sqlCalled } = serviceWithUnreachableSql();
      await expect(positions.listClosed('alice', { limit })).rejects.toMatchObject({
        name: 'ListClosedLimitUnsetError',
        code: TRADE_LIST_CLOSED_LIMIT_UNSET,
      });
      expect(sqlCalled()).toBe(false);
    }
  });
});
